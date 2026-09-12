import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { inspectDatabase } from "../src/database.js";
import { inspectImport } from "../src/import/inspection.js";
import {
  applyImport,
  prepareImport,
  resolveImport,
} from "../src/import/operations.js";
import type {
  ImportCell,
  ImportRecipe,
  ImportSource,
} from "../src/import/types.js";
import { createDatabase, createPreparedImport } from "../src/node.js";
import {
  PREPARED_BINDING_TABLE,
  PREPARED_CAPTURE_TABLE,
  PREPARED_ROW_TABLE,
  preparedEngineOf,
} from "../src/prepared.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function sourceWithSelections(
  values: readonly (readonly [string, ImportCell])[],
  verifyUnchanged?: () => Promise<void>,
): ImportSource {
  const bytes = new TextEncoder().encode("synthetic atomic import");
  return {
    key: "submission",
    readerVersion: "synthetic-1",
    bytes: {
      name: "submission.xlsx",
      size: bytes.length,
      async readAt(offset, length) {
        return bytes.slice(offset, offset + length);
      },
    },
    ...(verifyUnchanged === undefined ? {} : { verifyUnchanged }),
    selections: values.map(([key, value]) => ({
      key,
      label: key,
      async open() {
        return {
          columns: ["Value"],
          async *batches() {
            yield [{ sourceRow: 2, cells: { Value: value } }];
          },
          async close() {},
        };
      },
    })),
  };
}

function recipeFor(...selections: readonly string[]): ImportRecipe {
  return {
    version: 1,
    routes: selections.map((selection) => ({
      source: "submission",
      selection,
      destination: {
        kind: "new-table",
        schema: {
          name: selection,
          columns: [{ name: "Value", type: "text" }],
          recordId: { prefix: selection.toUpperCase(), padding: 6 },
          foreignKeys: [],
        },
      },
      columns: [{ source: "Value", target: "Value", type: "text" }],
    })),
  };
}

function multiBatchSource(options: {
  readonly shouldFail: () => boolean;
  readonly failure: Error;
}): ImportSource {
  const source = sourceWithSelections([
    ["Inventory", { kind: "string", value: "unused" }],
  ]);
  return {
    ...source,
    selections: [
      {
        key: "Inventory",
        label: "Inventory",
        async open() {
          return {
            columns: ["Value"],
            async *batches() {
              yield Array.from({ length: 2_000 }, (_, index) => ({
                sourceRow: index + 2,
                cells: {
                  Value: { kind: "string" as const, value: `Row ${index + 1}` },
                },
              }));
              if (options.shouldFail()) throw options.failure;
              yield [
                {
                  sourceRow: 2_002,
                  cells: { Value: { kind: "string", value: "Final row" } },
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

for (const format of ["sqlite", "duckdb"] as const) {
  test(`${format}: a row failure rolls back the complete import`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cc-import-rollback-"));
    directories.push(directory);
    const { database } = await createDatabase({
      path: path.join(directory, `workspace.${format}`),
      format,
    });
    const recipe = recipeFor("Good", "Bad");
    const prepared = await createPreparedImport({
      path: path.join(directory, "review.data"),
      database,
      recipe,
      baselineRevision: 0n,
    });
    try {
      await prepareImport({
        database,
        prepared,
        recipe,
        sources: [
          sourceWithSelections([
            ["Good", { kind: "string", value: "kept only on success" }],
            ["Bad", { kind: "string", value: "valid during review" }],
          ]),
        ],
      });
      const approved = await resolveImport({
        database,
        prepared,
        decisions: [],
      });
      expect(approved.state).toBe("ready");
      if (approved.state !== "ready") throw new Error("Plan failed review");
      await preparedEngineOf(prepared).execute(
        `UPDATE ${PREPARED_ROW_TABLE} SET values_json = ? WHERE values_json LIKE ?`,
        [
          JSON.stringify({ Value: { kind: "error", error: "#VALUE!" } }),
          "%valid during review%",
        ],
      );
      await expect(
        applyImport({
          database,
          prepared,
          approved,
          requestId: "atomic-apply",
        }),
      ).rejects.toMatchObject({ code: "DB_IMPORT_ERROR_CELL" });
      const inspection = await inspectDatabase({ database });
      expect(inspection.tables).toEqual([]);
      expect(inspection.captures).toBe(0n);
      expect(inspection.completedImports).toBe(0n);
      expect(inspection.revision).toBe(0n);
    } finally {
      await prepared.close();
      await database.close();
    }
  });

  test(`${format}: a later capture batch failure removes earlier committed batches and permits retry`, async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "cc-capture-batch-rollback-"),
    );
    directories.push(directory);
    const { database } = await createDatabase({
      path: path.join(directory, `workspace.${format}`),
      format,
    });
    const recipe = recipeFor("Inventory");
    const prepared = await createPreparedImport({
      path: path.join(directory, "review.data"),
      database,
      recipe,
      baselineRevision: 0n,
    });
    const failure = new Error("synthetic later-batch failure");
    let fail = true;
    const source = multiBatchSource({ shouldFail: () => fail, failure });
    try {
      await expect(
        prepareImport({ database, prepared, recipe, sources: [source] }),
      ).rejects.toBe(failure);

      const preparedEngine = preparedEngineOf(prepared);
      for (const table of [
        PREPARED_ROW_TABLE,
        PREPARED_CAPTURE_TABLE,
        PREPARED_BINDING_TABLE,
      ]) {
        await expect(
          preparedEngine.query(`SELECT count(*) AS count FROM ${table}`),
        ).resolves.toEqual([{ count: 0n }]);
      }
      expect(await inspectDatabase({ database })).toMatchObject({
        revision: 0n,
        tables: [],
        captures: 0n,
        completedImports: 0n,
      });

      fail = false;
      const retried = await prepareImport({
        database,
        prepared,
        recipe,
        sources: [source],
      });
      expect(retried.prepared.state).toBe("ready");
      expect(retried.result.metrics.rowsCaptured).toBe(2_001);
      if (retried.prepared.state !== "ready") {
        throw new Error("Retried plan failed review");
      }
      await applyImport({
        database,
        prepared,
        approved: retried.prepared,
        requestId: `${format}-capture-batch-retry`,
      });
      expect((await inspectDatabase({ database })).tables).toMatchObject([
        { name: "Inventory", rowCount: 2_001n },
      ]);
    } finally {
      await prepared.close();
      await database.close();
    }
  });
}

test("source mutation after parsing removes staged rows", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cc-import-mutation-"));
  directories.push(directory);
  const { database } = await createDatabase({
    path: path.join(directory, "workspace.sqlite"),
    format: "sqlite",
  });
  const recipe = recipeFor("Inventory");
  const prepared = await createPreparedImport({
    path: path.join(directory, "review.data"),
    database,
    recipe,
    baselineRevision: 0n,
  });
  let verificationCount = 0;
  try {
    await expect(
      prepareImport({
        database,
        prepared,
        recipe,
        sources: [
          sourceWithSelections(
            [["Inventory", { kind: "string", value: "North" }]],
            async () => {
              verificationCount += 1;
              if (verificationCount === 2) {
                throw new Error("source changed after parsing");
              }
            },
          ),
        ],
      }),
    ).rejects.toThrow("source changed after parsing");
    const inspection = await inspectImport({
      prepared,
      page: { limit: 10 },
    });
    expect(inspection.examples).toEqual([]);
    expect(inspection.routes).toEqual([]);
    expect(inspection.capturedRows).toBe(0n);
  } finally {
    await prepared.close();
    await database.close();
  }
});

test("reusing a prepared binding rejects changed source content", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cc-import-rebind-"));
  directories.push(directory);
  const { database } = await createDatabase({
    path: path.join(directory, "workspace.sqlite"),
    format: "sqlite",
  });
  const recipe = recipeFor("Inventory");
  const prepared = await createPreparedImport({
    path: path.join(directory, "review.data"),
    database,
    recipe,
    baselineRevision: 0n,
  });
  try {
    const original = sourceWithSelections([
      ["Inventory", { kind: "string", value: "North" }],
    ]);
    await prepareImport({
      database,
      prepared,
      recipe,
      sources: [original],
    });
    const changedBytes = new TextEncoder().encode("changed submission bytes");
    await expect(
      prepareImport({
        database,
        prepared,
        recipe,
        sources: [
          {
            ...original,
            bytes: {
              name: "submission.xlsx",
              size: changedBytes.length,
              async readAt(offset, length) {
                return changedBytes.slice(offset, offset + length);
              },
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "DB_PREPARED_SOURCE_CHANGED" });
  } finally {
    await prepared.close();
    await database.close();
  }
});
