import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { inspectDatabase } from "../src/database.js";
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

function source(...selectionKeys: readonly string[]): ImportSource {
  const bytes = new TextEncoder().encode("one stable synthetic workbook");
  return {
    key: "submission",
    readerVersion: "prepare-metrics-1",
    bytes: {
      name: "submission.xlsx",
      size: bytes.byteLength,
      async readAt(offset, length) {
        return bytes.slice(offset, offset + length);
      },
    },
    selections: selectionKeys.map((key, index) => ({
      key,
      label: key,
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
                    value: `Value ${String(index + 1)}`,
                  },
                },
              },
            ];
          },
          async close() {},
        };
      },
    })),
  };
}

function recipe(...selectionKeys: readonly string[]): ImportRecipe {
  return {
    version: 1,
    routes: selectionKeys.map((selection) => ({
      source: "submission",
      selection,
      destination: {
        kind: "new-table" as const,
        schema: {
          name: `Table_${selection}`,
          columns: [{ name: "Value", type: "text" as const }],
          recordId: { prefix: selection.toUpperCase(), padding: 4 },
        },
      },
      columns: [{ source: "Value", target: "Value", type: "text" as const }],
    })),
  };
}

describe.each(["sqlite", "duckdb"] as const)(
  "%s preparation source metrics",
  (format) => {
    test("counts source inputs once across fresh, reused, and mixed selections", async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "cc-source-metrics-"),
      );
      directories.push(directory);
      const { database } = await createDatabase({
        path: path.join(directory, `workspace.${format}`),
        format,
      });
      const initialRecipe = recipe("one", "two", "three");
      const first = await createPreparedImport({
        path: path.join(directory, "first.ccplan"),
        database,
        recipe: initialRecipe,
        baselineRevision: (await inspectDatabase({ database })).revision,
      });
      try {
        const captured = await prepareImport({
          database,
          prepared: first,
          sources: [source("one", "two", "three")],
          recipe: initialRecipe,
        });
        expect(captured.result.metrics).toMatchObject({
          sourcesRead: 1,
          sourcesReused: 0,
          rowsCaptured: 3,
        });
        expect(captured.prepared.state).toBe("ready");

        const retry = await prepareImport({
          database,
          prepared: first,
          sources: [source("one", "two", "three")],
          recipe: initialRecipe,
        });
        expect(retry.result.metrics).toMatchObject({
          sourcesRead: 0,
          sourcesReused: 0,
          rowsCaptured: 0,
        });
        if (captured.prepared.state !== "ready") {
          throw new Error("The initial import did not become ready");
        }
        await applyImport({
          database,
          prepared: first,
          approved: captured.prepared,
          requestId: `prepare-metrics-${format}`,
        });

        const repeated = await createPreparedImport({
          path: path.join(directory, "repeated.ccplan"),
          database,
          recipe: initialRecipe,
          baselineRevision: (await inspectDatabase({ database })).revision,
        });
        try {
          const reused = await prepareImport({
            database,
            prepared: repeated,
            sources: [source("one", "two", "three")],
            recipe: initialRecipe,
          });
          expect(reused.result.metrics).toMatchObject({
            sourcesRead: 0,
            sourcesReused: 1,
            rowsCaptured: 0,
          });
        } finally {
          await repeated.close();
        }

        const mixedRecipe = recipe("one", "four");
        const mixed = await createPreparedImport({
          path: path.join(directory, "mixed.ccplan"),
          database,
          recipe: mixedRecipe,
          baselineRevision: (await inspectDatabase({ database })).revision,
        });
        try {
          const outcome = await prepareImport({
            database,
            prepared: mixed,
            sources: [source("one", "four")],
            recipe: mixedRecipe,
          });
          expect(outcome.result.metrics).toMatchObject({
            sourcesRead: 1,
            sourcesReused: 1,
            rowsCaptured: 1,
          });
        } finally {
          await mixed.close();
        }
      } finally {
        await first.close();
        await database.close();
      }
    });
  },
);
