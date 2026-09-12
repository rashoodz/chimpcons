import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import {
  inspectImport,
  prepareImport,
  resolveImport,
} from "../src/import/operations.js";
import { draftImportRecipe } from "../src/import/recipe.js";
import type { ImportSource } from "../src/import/types.js";
import { createDatabase, createPreparedImport } from "../src/node.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("infers decimal capacity from integer digits and scale", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cc-decimal-import-"));
  directories.push(directory);
  const { database } = await createDatabase({
    path: path.join(directory, "decimal.sqlite"),
    format: "sqlite",
  });
  const bytes = new TextEncoder().encode("decimal inference source");
  const source: ImportSource = {
    key: "amounts",
    readerVersion: "synthetic-1",
    bytes: {
      name: "amounts.xlsx",
      size: bytes.length,
      async readAt(offset, length) {
        return bytes.slice(offset, offset + length);
      },
    },
    selections: [
      {
        key: "amounts",
        label: "Amounts",
        async open() {
          return {
            columns: ["Amount"],
            async *batches() {
              yield [
                {
                  sourceRow: 2,
                  cells: { Amount: { kind: "number", raw: "10000" } },
                },
                {
                  sourceRow: 3,
                  cells: { Amount: { kind: "number", raw: "0.123" } },
                },
              ];
            },
            async close() {},
          };
        },
      },
    ],
  };
  const recipe = await draftImportRecipe({ sources: [source] });
  const prepared = await createPreparedImport({
    path: path.join(directory, "decimal.ccplan"),
    database,
    recipe,
    baselineRevision: 0n,
  });
  try {
    await prepareImport({ database, prepared, sources: [source], recipe });
    const inspection = await inspectImport({ prepared, page: { limit: 1 } });
    expect(inspection.routes[0]?.inferredColumns).toEqual([
      { name: "Amount", type: "decimal", precision: 8, scale: 3 },
    ]);
    const narrowed = await resolveImport({
      database,
      prepared,
      decisions: [
        {
          kind: "route",
          source: "amounts",
          selection: "amounts",
          destination: {
            kind: "new-table",
            schema: {
              name: "amounts",
              recordId: { prefix: "AMOUNT", padding: 6 },
              columns: [
                {
                  name: "Amount",
                  type: "decimal",
                  precision: 7,
                  scale: 2,
                },
              ],
            },
          },
          columns: [{ source: "Amount", target: "Amount", type: "decimal" }],
        },
      ],
    });
    expect(narrowed.state).toBe("needs-review");
    expect(
      (await inspectImport({ prepared, page: { limit: 1 } })).conflicts,
    ).toEqual([expect.objectContaining({ kind: "decimal-capacity" })]);
  } finally {
    await prepared.close();
    await database.close();
  }
});
