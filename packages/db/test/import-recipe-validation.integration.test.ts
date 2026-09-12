import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { inspectDatabase } from "../src/database.js";
import { applyImport } from "../src/import/apply.js";
import type { ImportRecipe, ImportSource } from "../src/import/types.js";
import {
  PREPARED_METADATA_TABLE,
  preparedEngineOf,
  preparedRef,
  readPreparedRecipe,
  updatePreparedPlan,
} from "../src/prepared.js";
import { parseDatabaseSchema, parseImportRecipe } from "../src/validators.js";
import {
  createDatabase,
  createPreparedImport,
  openPreparedImport,
  prepareImportFile,
} from "../src/node.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const duplicateTargetRecipe: ImportRecipe = {
  version: 1,
  routes: [
    {
      source: "submission",
      selection: "Inventory",
      destination: { kind: "existing-table", table: "Inventory" },
      columns: [
        { source: "Primary", target: "Value", type: "text" },
        { source: "Secondary", target: "value", type: "text" },
      ],
    },
  ],
};

const unsafeInferredRecipe: ImportRecipe = {
  version: 1,
  routes: [
    {
      source: "submission",
      selection: "Inventory",
      destination: {
        kind: "new-table-infer",
        name: "_consultchimps_internal",
        recordId: { prefix: "INV", padding: 6 },
      },
      columns: [],
    },
  ],
};

function unreadSource(counters: {
  reads: number;
  opens: number;
}): ImportSource {
  const bytes = new TextEncoder().encode("source bytes must remain unread");
  return {
    key: "submission",
    readerVersion: "validation-test-1",
    bytes: {
      name: "submission.xlsx",
      size: bytes.length,
      async readAt(offset, length) {
        counters.reads += 1;
        return bytes.slice(offset, offset + length);
      },
    },
    selections: [
      {
        key: "Inventory",
        label: "Inventory",
        async open() {
          counters.opens += 1;
          return {
            columns: ["Primary", "Secondary"],
            async *batches() {
              yield [];
            },
            async close() {},
          };
        },
      },
    ],
  };
}

test("JSON recipes reject unsafe inferred tables, Record IDs, and duplicate normalized targets", () => {
  expect(() => parseImportRecipe(unsafeInferredRecipe)).toThrowError(
    expect.objectContaining({ code: "DB_INVALID_IDENTIFIER" }),
  );
  expect(() =>
    parseImportRecipe({
      version: 1,
      routes: [
        {
          source: "submission",
          selection: "Inventory",
          destination: {
            kind: "new-table-infer",
            name: "Inventory",
            recordId: { prefix: "INV", padding: 19 },
          },
          columns: [],
        },
      ],
    }),
  ).toThrowError(
    expect.objectContaining({ code: "DB_INVALID_RECORD_ID_CONFIG" }),
  );
  expect(() =>
    parseImportRecipe({
      version: 1,
      routes: [
        {
          source: "submission",
          selection: "Inventory",
          destination: {
            kind: "new-table-infer",
            name: "Inventory",
            recordId: { prefix: "INV", padding: 6, separator: 1 },
          },
          columns: [],
        },
      ],
    }),
  ).toThrowError(expect.objectContaining({ code: "DB_INVALID_RECIPE" }));
  expect(() =>
    parseDatabaseSchema({
      version: 1,
      tables: [
        {
          name: "Inventory",
          columns: [],
          recordId: { prefix: "INV", padding: 6, separator: 1 },
        },
      ],
    }),
  ).toThrowError(expect.objectContaining({ code: "DB_INVALID_DOCUMENT" }));
  expect(() => parseImportRecipe(duplicateTargetRecipe)).toThrowError(
    expect.objectContaining({
      code: "DB_INVALID_RECIPE",
      details: {
        source: "submission",
        selection: "Inventory",
        target: "value",
        firstSource: "Primary",
        secondSource: "Secondary",
      },
    }),
  );
});

describe.each(["sqlite", "duckdb"] as const)(
  "%s recipe validation",
  (format) => {
    test("rejects invalid typed recipes before source reads or plan publication", async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "cc-recipe-check-"));
      directories.push(directory);
      const { database } = await createDatabase({
        path: path.join(directory, `workspace.${format}`),
        format,
      });
      const baselineRevision = (await inspectDatabase({ database })).revision;
      const invalidCreatePath = path.join(directory, "invalid-create.ccplan");
      await expect(
        createPreparedImport({
          path: invalidCreatePath,
          database,
          recipe: duplicateTargetRecipe,
          baselineRevision,
        }),
      ).rejects.toMatchObject({ code: "DB_INVALID_RECIPE" });
      await expect(access(invalidCreatePath)).rejects.toMatchObject({
        code: "ENOENT",
      });

      const planPath = path.join(directory, "review.ccplan");
      const original = await createPreparedImport({
        path: planPath,
        database,
        recipe: { version: 1, routes: [] },
        baselineRevision,
      });
      const originalId = original.id;
      await original.close();
      const originalBytes = await readFile(planPath);
      const counters = { reads: 0, opens: 0 };

      try {
        await expect(
          prepareImportFile({
            path: planPath,
            database,
            sources: [unreadSource(counters)],
            recipe: duplicateTargetRecipe,
            baselineRevision,
            overwrite: true,
          }),
        ).rejects.toMatchObject({ code: "DB_INVALID_RECIPE" });
        expect(counters).toEqual({ reads: 0, opens: 0 });
        expect(await readFile(planPath)).toEqual(originalBytes);

        const unsafePath = path.join(directory, "unsafe.ccplan");
        await expect(
          prepareImportFile({
            path: unsafePath,
            database,
            sources: [unreadSource(counters)],
            recipe: unsafeInferredRecipe,
            baselineRevision,
          }),
        ).rejects.toMatchObject({ code: "DB_INVALID_IDENTIFIER" });
        expect(counters).toEqual({ reads: 0, opens: 0 });
        await expect(access(unsafePath)).rejects.toMatchObject({
          code: "ENOENT",
        });

        const reopened = await openPreparedImport({ path: planPath });
        try {
          expect(reopened.id).toBe(originalId);
          await expect(
            updatePreparedPlan({
              prepared: reopened,
              recipe: duplicateTargetRecipe,
              conflicts: [],
              ready: true,
            }),
          ).rejects.toMatchObject({ code: "DB_INVALID_RECIPE" });
          expect((await readPreparedRecipe(reopened)).recipe.routes).toEqual(
            [],
          );

          await preparedEngineOf(reopened).execute(
            `UPDATE ${PREPARED_METADATA_TABLE} SET state = 'ready', recipe_json = ?`,
            [JSON.stringify(duplicateTargetRecipe)],
          );
          const approved = await preparedRef(reopened);
          if (approved.state !== "ready") throw new Error("Plan not ready");
          await expect(
            applyImport({
              database,
              prepared: reopened,
              approved,
              requestId: `request-${format}`,
            }),
          ).rejects.toMatchObject({ code: "DB_INVALID_RECIPE" });
          expect((await inspectDatabase({ database })).completedImports).toBe(
            0n,
          );
        } finally {
          await reopened.close();
        }
      } finally {
        await database.close();
      }
    });
  },
);
