import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { inspectDatabase, valueAsBigInt } from "../src/database.js";
import { prepareImport } from "../src/import/operations.js";
import type { ImportRecipe, ImportSource } from "../src/import/types.js";
import { createDatabase, createPreparedImport } from "../src/node.js";
import {
  PREPARED_BINDING_TABLE,
  PREPARED_CAPTURE_TABLE,
  PREPARED_ROW_TABLE,
  preparedEngineOf,
  type PreparedImport,
} from "../src/prepared.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function recipe(...selections: readonly string[]): ImportRecipe {
  return {
    version: 1,
    routes: selections.map((selection) => ({
      source: "submission",
      selection,
      destination: { kind: "existing-table", table: selection },
      columns: [{ source: "Value", target: "Value", type: "text" }],
    })),
  };
}

function source(options: {
  readonly selections: readonly string[];
  readonly failBatch?: Error | undefined;
  readonly failClose?: (selection: string) => Error | undefined;
}): ImportSource {
  const bytes = new TextEncoder().encode("synthetic reader close failure");
  return {
    key: "submission",
    readerVersion: "reader-close-test-1",
    bytes: {
      name: "submission.xlsx",
      size: bytes.byteLength,
      async readAt(offset, length) {
        return bytes.slice(offset, offset + length);
      },
    },
    selections: options.selections.map((selection, selectionIndex) => ({
      key: selection,
      label: selection,
      async open() {
        return {
          columns: ["Value"],
          async *batches() {
            yield [
              {
                sourceRow: 2,
                cells: {
                  Value: {
                    kind: "string" as const,
                    value: `${selection} row 1`,
                  },
                },
              },
            ];
            if (selectionIndex > 0 || options.selections.length === 1) {
              yield [
                {
                  sourceRow: 3,
                  cells: {
                    Value: {
                      kind: "string" as const,
                      value: `${selection} row 2`,
                    },
                  },
                },
              ];
              if (options.failBatch !== undefined) throw options.failBatch;
            }
          },
          async close() {
            const failure = options.failClose?.(selection);
            if (failure !== undefined) throw failure;
          },
        };
      },
    })),
  };
}

async function stagingState(prepared: PreparedImport): Promise<{
  readonly bindings: readonly string[];
  readonly captures: readonly string[];
  readonly rows: bigint;
}> {
  const engine = preparedEngineOf(prepared);
  const [captures, bindings, rows] = await Promise.all([
    engine.query(
      `SELECT selection_key FROM ${PREPARED_CAPTURE_TABLE} ORDER BY selection_key`,
    ),
    engine.query(
      `SELECT selection_key FROM ${PREPARED_BINDING_TABLE} ORDER BY selection_key`,
    ),
    engine.query(`SELECT COUNT(*) AS total FROM ${PREPARED_ROW_TABLE}`),
  ]);
  return {
    captures: captures.map((row) => String(row["selection_key"])),
    bindings: bindings.map((row) => String(row["selection_key"])),
    rows: valueAsBigInt(rows[0]?.["total"], "staged row count"),
  };
}

async function fixture(
  format: "sqlite" | "duckdb",
  selections: readonly string[],
) {
  const directory = await mkdtemp(path.join(tmpdir(), "cc-reader-close-"));
  directories.push(directory);
  const { database } = await createDatabase({
    path: path.join(directory, `workspace.${format}`),
    format,
    schema: {
      version: 1,
      tables: selections.map((name) => ({
        name,
        columns: [{ name: "Value", type: "text", nullable: false }],
        recordId: { prefix: name.toUpperCase(), padding: 6 },
      })),
    },
  });
  const importRecipe = recipe(...selections);
  const prepared = await createPreparedImport({
    path: path.join(directory, "review.ccplan"),
    database,
    recipe: importRecipe,
    baselineRevision: (await inspectDatabase({ database })).revision,
  });
  return { database, importRecipe, prepared };
}

for (const format of ["sqlite", "duckdb"] as const) {
  test(`${format}: a close failure removes committed rows from only the failed capture`, async () => {
    const { database, importRecipe, prepared } = await fixture(format, [
      "First",
      "Second",
    ]);
    const closeFailure = new Error("synthetic close failure");
    let shouldFailClose = true;
    const submission = source({
      selections: ["First", "Second"],
      failClose: (selection) =>
        selection === "Second" && shouldFailClose ? closeFailure : undefined,
    });
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(
          prepareImport({
            database,
            prepared,
            recipe: importRecipe,
            sources: [submission],
          }),
        ).rejects.toBe(closeFailure);
        expect(await stagingState(prepared)).toEqual({
          captures: ["First"],
          bindings: ["First"],
          rows: 1n,
        });
      }

      shouldFailClose = false;
      const outcome = await prepareImport({
        database,
        prepared,
        recipe: importRecipe,
        sources: [submission],
      });
      expect(outcome.prepared.state).toBe("ready");
      expect(await stagingState(prepared)).toEqual({
        captures: ["First", "Second"],
        bindings: ["First", "Second"],
        rows: 3n,
      });
    } finally {
      await prepared.close();
      await database.close();
    }
  });

  test(`${format}: batch and close failures are both preserved`, async () => {
    const { database, importRecipe, prepared } = await fixture(format, [
      "Inventory",
    ]);
    const batchFailure = new Error("synthetic batch failure");
    const closeFailure = new Error("synthetic close failure");
    try {
      let caught: unknown;
      try {
        await prepareImport({
          database,
          prepared,
          recipe: importRecipe,
          sources: [
            source({
              selections: ["Inventory"],
              failBatch: batchFailure,
              failClose: () => closeFailure,
            }),
          ],
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AggregateError);
      expect((caught as AggregateError).errors).toEqual([
        batchFailure,
        closeFailure,
      ]);
      expect(await stagingState(prepared)).toEqual({
        captures: [],
        bindings: [],
        rows: 0n,
      });
    } finally {
      await prepared.close();
      await database.close();
    }
  });
}
