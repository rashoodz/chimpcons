import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { engineOf, inspectDatabase } from "../src/database.js";
import {
  applyImport,
  prepareImport,
  resolveImport,
} from "../src/import/operations.js";
import type { ImportRecipe, ImportSource } from "../src/import/types.js";
import { preparedRef, readPreparedRecipe } from "../src/prepared.js";
import { createDatabase, createPreparedImport } from "../src/node.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function reservedHeadingSource(): ImportSource {
  const bytes = new TextEncoder().encode("synthetic reserved heading");
  return {
    key: "submission",
    readerVersion: "inferred-schema-mapping-1",
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
            columns: ["record_id"],
            async *batches() {
              yield [
                {
                  sourceRow: 2,
                  cells: {
                    record_id: { kind: "string" as const, value: "vendor-7" },
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

function inferredRecipe(
  columns: ImportRecipe["routes"][number]["columns"],
): ImportRecipe {
  return {
    version: 1,
    routes: [
      {
        source: "submission",
        selection: "Inventory",
        destination: {
          kind: "new-table-infer",
          name: "Inventory",
          recordId: { prefix: "INV", padding: 6 },
        },
        columns,
      },
    ],
  };
}

async function fixture(
  format: "sqlite" | "duckdb",
  recipe: ImportRecipe,
  suffix: string,
) {
  const directory = await mkdtemp(
    path.join(tmpdir(), `cc-inferred-${suffix}-`),
  );
  directories.push(directory);
  const { database } = await createDatabase({
    path: path.join(directory, `workspace.${format}`),
    format,
  });
  const prepared = await createPreparedImport({
    path: path.join(directory, "review.ccplan"),
    database,
    recipe,
    baselineRevision: (await inspectDatabase({ database })).revision,
  });
  return { database, prepared };
}

describe.each(["sqlite", "duckdb"] as const)(
  "%s inferred schema mappings",
  (format) => {
    test("keeps an explicit rename through review and apply", async () => {
      const recipe = inferredRecipe([
        { source: "record_id", target: "vendor_id", type: "text" },
      ]);
      const { database, prepared } = await fixture(format, recipe, "rename");
      try {
        const outcome = await prepareImport({
          database,
          prepared,
          recipe,
          sources: [reservedHeadingSource()],
        });
        expect(outcome.prepared.state).toBe("needs-review");
        expect((await readPreparedRecipe(prepared)).conflicts).toContainEqual({
          kind: "inferred-schema",
          source: "submission",
          selection: "Inventory",
          schema: {
            name: "Inventory",
            columns: [{ name: "vendor_id", type: "text" }],
            recordId: { prefix: "INV", padding: 6 },
            foreignKeys: [],
          },
        });

        const approved = await resolveImport({
          database,
          prepared,
          decisions: [],
        });
        expect(approved.state).toBe("ready");
        if (approved.state !== "ready") throw new Error("Plan not ready");
        await applyImport({
          database,
          prepared,
          approved,
          requestId: `inferred-rename-${format}`,
        });
        expect(
          await engineOf(database).query(
            'SELECT record_id, vendor_id FROM "Inventory"',
          ),
        ).toEqual([{ record_id: "INV-000001", vendor_id: "vendor-7" }]);
      } finally {
        await prepared.close();
        await database.close();
      }
    });

    test("rejects an inferred reserved target without corrupting review metadata", async () => {
      const recipe = inferredRecipe([]);
      const { database, prepared } = await fixture(format, recipe, "reserved");
      try {
        await expect(
          prepareImport({
            database,
            prepared,
            recipe,
            sources: [reservedHeadingSource()],
          }),
        ).rejects.toMatchObject({
          code: "DB_DUPLICATE_COLUMN",
          details: { table: "Inventory", column: "record_id" },
        });
        expect(await preparedRef(prepared)).toMatchObject({
          state: "needs-review",
          planRevision: 1n,
        });
        expect(await readPreparedRecipe(prepared)).toEqual({
          recipe,
          conflicts: [],
          decisions: [],
        });
      } finally {
        await prepared.close();
        await database.close();
      }
    });

    test("stores a missing source mapping as a readable review conflict", async () => {
      const recipe = inferredRecipe([
        { source: "missing", target: "vendor_id", type: "text" },
      ]);
      const { database, prepared } = await fixture(format, recipe, "missing");
      try {
        const outcome = await prepareImport({
          database,
          prepared,
          recipe,
          sources: [reservedHeadingSource()],
        });
        expect(outcome.prepared.state).toBe("needs-review");
        expect((await readPreparedRecipe(prepared)).conflicts).toEqual([
          {
            kind: "source-column-not-found",
            source: "submission",
            selection: "Inventory",
            column: "missing",
          },
        ]);
      } finally {
        await prepared.close();
        await database.close();
      }
    });
  },
);
