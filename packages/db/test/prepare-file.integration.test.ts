import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConsultChimpsError } from "@consultchimps/core";
import { afterEach, expect, test } from "vitest";

import { inspectDatabase } from "../src/database.js";
import { inspectImport } from "../src/import/inspection.js";
import type { ImportRecipe, ImportSource } from "../src/import/types.js";
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

const recipe: ImportRecipe = {
  version: 1,
  routes: [
    {
      source: "submission",
      selection: "Inventory",
      destination: {
        kind: "new-table",
        schema: {
          name: "inventory",
          columns: [{ name: "Name", type: "text" }],
          recordId: { prefix: "INV", padding: 6 },
          foreignKeys: [],
        },
      },
      columns: [{ source: "Name", target: "Name", type: "text" }],
    },
  ],
};

function source(verifyUnchanged: () => Promise<void>): ImportSource {
  const bytes = new TextEncoder().encode("synthetic prepared file source");
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
    verifyUnchanged,
    selections: [
      {
        key: "Inventory",
        label: "Inventory",
        async open() {
          return {
            columns: ["Name"],
            async *batches() {
              yield [
                {
                  sourceRow: 2,
                  cells: { Name: { kind: "string" as const, value: "North" } },
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

async function existingPlan() {
  const directory = await mkdtemp(path.join(tmpdir(), "cc-prepare-file-"));
  directories.push(directory);
  const databasePath = path.join(directory, "inventory.sqlite");
  const planPath = path.join(directory, "review.ccplan");
  const { database } = await createDatabase({
    path: databasePath,
    format: "sqlite",
  });
  const baselineRevision = (await inspectDatabase({ database })).revision;
  const prepared = await createPreparedImport({
    path: planPath,
    database,
    recipe: { version: 1, routes: [] },
    baselineRevision,
  });
  const preparedId = prepared.id;
  await prepared.close();
  return {
    database,
    directory,
    planPath,
    baselineRevision,
    preparedId,
    bytes: await readFile(planPath),
  };
}

async function expectOriginalPlan(
  options: Awaited<ReturnType<typeof existingPlan>>,
) {
  expect(await readFile(options.planPath)).toEqual(options.bytes);
  expect(
    (await readdir(options.directory)).filter(
      (name) => name.includes(".cc-prepare-") || name.includes(".cc-plan-"),
    ),
  ).toEqual([]);
  const reopened = await openPreparedImport({ path: options.planPath });
  try {
    expect(reopened.id).toBe(options.preparedId);
    expect(
      (await inspectImport({ prepared: reopened, page: { limit: 1 } }))
        .capturedRows,
    ).toBe(0n);
  } finally {
    await reopened.close();
  }
}

test("cancellation after capture does not publish a replacement plan", async () => {
  const fixture = await existingPlan();
  const controller = new AbortController();
  let verifications = 0;
  try {
    await expect(
      prepareImportFile({
        path: fixture.planPath,
        database: fixture.database,
        sources: [
          source(async () => {
            verifications += 1;
            if (verifications === 2) controller.abort("test cancellation");
          }),
        ],
        recipe,
        baselineRevision: fixture.baselineRevision,
        overwrite: true,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
    expect(verifications).toBe(2);
    await expectOriginalPlan(fixture);
  } finally {
    await fixture.database.close();
  }
});

test("source verification failure after capture does not publish a replacement plan", async () => {
  const fixture = await existingPlan();
  let verifications = 0;
  try {
    await expect(
      prepareImportFile({
        path: fixture.planPath,
        database: fixture.database,
        sources: [
          source(async () => {
            verifications += 1;
            if (verifications === 2) {
              throw new ConsultChimpsError(
                "FILES_SOURCE_CHANGED",
                "The source changed during the test.",
              );
            }
          }),
        ],
        recipe,
        baselineRevision: fixture.baselineRevision,
        overwrite: true,
      }),
    ).rejects.toMatchObject({ code: "FILES_SOURCE_CHANGED" });
    expect(verifications).toBe(2);
    await expectOriginalPlan(fixture);
  } finally {
    await fixture.database.close();
  }
});
