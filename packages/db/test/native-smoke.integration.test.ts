import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { inspectDatabase } from "../src/database.js";
import {
  createDatabase,
  createPreparedImport,
  openDatabase,
  openPreparedImport,
} from "../src/node.js";
import { draftImportRecipe } from "../src/import/recipe.js";
import {
  applyImport,
  inspectImport,
  prepareImport,
  resolveImport,
} from "../src/import/operations.js";
import type { ImportSource } from "../src/import/types.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

for (const format of ["sqlite", "duckdb"] as const) {
  test(`${format}: async disposal releases files and preserves a saved review`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cc-dispose-"));
    directories.push(directory);
    const databasePath = path.join(directory, `inventory.${format}`);
    const planPath = path.join(directory, "review.ccplan");
    const { database } = await createDatabase({ path: databasePath, format });
    const prepared = await createPreparedImport({
      path: planPath,
      database,
      recipe: { version: 1, routes: [] },
      baselineRevision: (await inspectDatabase({ database })).revision,
    });
    const id = prepared.id;
    await prepared[Symbol.asyncDispose]();
    await database[Symbol.asyncDispose]();
    await expect(inspectDatabase({ database })).rejects.toThrow();
    await expect(
      inspectImport({ prepared, page: { limit: 1 } }),
    ).rejects.toThrow();
    const reopened = await openDatabase({ path: databasePath });
    const reopenedPlan = await openPreparedImport({ path: planPath });
    try {
      expect(reopenedPlan.id).toBe(id);
      expect(reopenedPlan.databaseId).toBe(reopened.id);
      expect(
        (await inspectImport({ prepared: reopenedPlan, page: { limit: 1 } }))
          .capturedRows,
      ).toBe(0n);
    } finally {
      await reopenedPlan.close();
      await reopened.close();
    }
  });

  test(`${format}: native persistent capture and apply roundtrip`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cc-native-smoke-"));
    directories.push(directory);
    const databasePath = path.join(directory, `inventory.${format}`);
    const { database } = await createDatabase({ path: databasePath, format });
    try {
      const payload = new TextEncoder().encode(
        "synthetic import fixture version 1",
      );
      const source: ImportSource = {
        key: "inventory",
        readerVersion: "synthetic-1",
        bytes: {
          name: "inventory.xlsx",
          size: payload.length,
          async readAt(offset, length) {
            return payload.slice(offset, offset + length);
          },
        },
        selections: [
          {
            key: "inventory",
            label: "Inventory",
            async open() {
              return {
                columns: ["Name", "Count"],
                async *batches() {
                  yield [
                    {
                      sourceRow: 2,
                      cells: {
                        Name: { kind: "string", value: "North" },
                        Count: { kind: "number", raw: "12" },
                      },
                    },
                    {
                      sourceRow: 3,
                      cells: {
                        Name: { kind: "string", value: "South" },
                        Count: { kind: "number", raw: "9" },
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
      const recipe = await draftImportRecipe({ sources: [source] });
      const before = await inspectDatabase({ database });
      const prepared = await createPreparedImport({
        path: path.join(directory, "review.ccplan"),
        database,
        recipe,
        baselineRevision: before.revision,
      });
      try {
        const captured = await prepareImport({
          database,
          prepared,
          sources: [source],
          recipe,
        });
        expect(captured.result.metrics.rowsCaptured).toBe(2);
        expect((await inspectDatabase({ database })).tables).toHaveLength(0);
        const approved = await resolveImport({
          database,
          prepared,
          decisions: [],
        });
        expect(approved.state).toBe("ready");
        if (approved.state !== "ready") throw new Error("Plan failed review.");
        const applied = await applyImport({
          database,
          prepared,
          approved,
          requestId: "synthetic-apply-1",
        });
        expect(applied.metrics.rowsImported).toBe(2);
      } finally {
        await prepared.close();
      }
      const duplicate: ImportSource = {
        ...source,
        bytes: { ...source.bytes, name: "renamed.xlsx" },
        selections: source.selections.map((selection) => ({
          ...selection,
          async open() {
            throw new Error(
              "An exact duplicate must not parse its rows again.",
            );
          },
        })),
      };
      const latest = await inspectDatabase({ database });
      const repeatedPlan = await createPreparedImport({
        path: path.join(directory, "repeat.ccplan"),
        database,
        recipe,
        baselineRevision: latest.revision,
      });
      try {
        const repeated = await prepareImport({
          database,
          prepared: repeatedPlan,
          sources: [duplicate],
          recipe,
        });
        expect(repeated.result.metrics.sourcesReused).toBe(1);
        expect(repeated.result.metrics.rowsCaptured).toBe(0);
        const approved = await resolveImport({
          database,
          prepared: repeatedPlan,
          decisions: [],
        });
        expect(approved.state).toBe("ready");
        if (approved.state !== "ready")
          throw new Error("Duplicate plan failed review.");
        const applied = await applyImport({
          database,
          prepared: repeatedPlan,
          approved,
          requestId: "synthetic-apply-2",
        });
        expect(applied.metrics.rowsImported).toBe(0);
        expect(applied.metrics.rowsReused).toBe(2);
        const retried = await applyImport({
          database,
          prepared: repeatedPlan,
          approved,
          requestId: "synthetic-apply-2",
        });
        expect(retried.importIds).toEqual(applied.importIds);
        expect(retried.captureIds).toEqual(applied.captureIds);
        expect(retried.metrics).toEqual(applied.metrics);
      } finally {
        await repeatedPlan.close();
      }
    } finally {
      await database.close();
    }
    expect((await readFile(databasePath)).byteLength).toBeGreaterThan(0);
    const reopened = await openDatabase({ path: databasePath });
    try {
      const inspected = await inspectDatabase({ database: reopened });
      expect(inspected.format).toBe(format);
      expect(inspected.tables).toHaveLength(1);
      expect(inspected.tables[0]?.rowCount).toBe(2n);
    } finally {
      await reopened.close();
    }
  });
}
