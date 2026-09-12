import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { engineOf, inspectDatabase } from "../src/database.js";
import { applyImport, prepareImport } from "../src/import/operations.js";
import type { ImportRecipe, ImportSource } from "../src/import/types.js";
import { createDatabase, createPreparedImport } from "../src/node.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function source(): ImportSource {
  const bytes = new TextEncoder().encode("synthetic implicit mapping");
  return {
    key: "submission",
    readerVersion: "implicit-mapping-test-1",
    bytes: {
      name: "submission.xlsx",
      size: bytes.byteLength,
      async readAt(offset, length) {
        return bytes.slice(offset, offset + length);
      },
    },
    selections: [
      {
        key: "Inventory",
        label: "Inventory",
        async open() {
          return {
            columns: ["Value", "value"],
            async *batches() {
              yield [
                {
                  sourceRow: 2,
                  cells: {
                    Value: { kind: "string" as const, value: "Primary" },
                    value: { kind: "string" as const, value: "Secondary" },
                  },
                },
              ];
            },
            async close() {},
          };
        },
      },
    ],
  };
}

function recipe(
  columns: ImportRecipe["routes"][number]["columns"],
): ImportRecipe {
  return {
    version: 1,
    routes: [
      {
        source: "submission",
        selection: "Inventory",
        destination: { kind: "existing-table", table: "Inventory" },
        columns,
      },
    ],
  };
}

for (const format of ["sqlite", "duckdb"] as const) {
  test(`${format}: implicit mappings cannot target one normalized column twice`, async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "cc-implicit-mapping-"),
    );
    directories.push(directory);
    const { database } = await createDatabase({
      path: path.join(directory, `workspace.${format}`),
      format,
      schema: {
        version: 1,
        tables: [
          {
            name: "Inventory",
            columns: [
              { name: "Value", type: "text", nullable: false },
              { name: "Secondary", type: "text", nullable: false },
            ],
            recordId: { prefix: "INV", padding: 6 },
          },
        ],
      },
    });
    const baselineRevision = (await inspectDatabase({ database })).revision;
    const implicitRecipe = recipe([]);
    const prepared = await createPreparedImport({
      path: path.join(directory, "review.ccplan"),
      database,
      recipe: implicitRecipe,
      baselineRevision,
    });
    try {
      await expect(
        prepareImport({
          database,
          prepared,
          recipe: implicitRecipe,
          sources: [source()],
        }),
      ).rejects.toMatchObject({ code: "DB_INVALID_RECIPE" });
      expect(await engineOf(database).query("SELECT * FROM Inventory")).toEqual(
        [],
      );

      const explicitRecipe = recipe([
        { source: "Value", target: "Value", type: "text" },
        { source: "value", target: "Secondary", type: "text" },
      ]);
      const outcome = await prepareImport({
        database,
        prepared,
        recipe: explicitRecipe,
        sources: [source()],
      });
      expect(outcome.prepared.state).toBe("ready");
      if (outcome.prepared.state !== "ready") {
        throw new Error("The explicit mapping did not become ready");
      }
      await applyImport({
        database,
        prepared,
        approved: outcome.prepared,
        requestId: `implicit-mapping-${format}`,
      });
      expect(
        await engineOf(database).query(
          "SELECT Value, Secondary FROM Inventory",
        ),
      ).toEqual([{ Value: "Primary", Secondary: "Secondary" }]);
    } finally {
      await prepared.close();
      await database.close();
    }
  });
}
