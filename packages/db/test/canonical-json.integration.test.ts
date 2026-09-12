import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { engineOf } from "../src/database.js";
import {
  applyImport,
  prepareImport,
  resolveImport,
} from "../src/import/operations.js";
import { listDeliveries } from "../src/import/deliveries.js";
import type {
  DeliveryContext,
  ImportRecipe,
  ImportSource,
} from "../src/import/types.js";
import {
  createDatabase,
  createPreparedImport,
  openPreparedImport,
} from "../src/node.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function importSource(): ImportSource {
  const bytes = new TextEncoder().encode("synthetic optional fields");
  return {
    key: "submission",
    readerVersion: "synthetic-optional-fields-1",
    bytes: {
      name: "submission.xlsx",
      size: bytes.length,
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
            columns: ["Value"],
            async *batches() {
              yield [
                {
                  sourceRow: 2,
                  cells: {
                    Value: { kind: "string" as const, value: "North" },
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

for (const format of ["sqlite", "duckdb"] as const) {
  test(`${format}: optional undefined fields survive plan persistence and idempotent delivery replay`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cc-canonical-json-"));
    directories.push(directory);
    const { database } = await createDatabase({
      path: path.join(directory, `workspace.${format}`),
      format,
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
              name: "Inventory",
              columns: [{ name: "Value", type: "text", nullable: undefined }],
              recordId: {
                prefix: "INV",
                padding: 6,
                separator: undefined,
              },
              foreignKeys: undefined,
            },
          },
          columns: [{ source: "Value", target: "Value", type: "text" }],
        },
      ],
    };
    const planPath = path.join(directory, "review.ccplan");
    let prepared = await createPreparedImport({
      path: planPath,
      database,
      recipe,
      baselineRevision: 0n,
    });
    try {
      await prepareImport({
        database,
        prepared,
        recipe,
        sources: [importSource()],
      });
      await prepared.close();
      prepared = await openPreparedImport({ path: planPath });

      const approved = await resolveImport({
        database,
        prepared,
        decisions: [],
      });
      expect(approved.state).toBe("ready");
      if (approved.state !== "ready") throw new Error("Plan not ready");

      const deliveryWithUndefined: DeliveryContext = {
        label: "Synthetic delivery",
        effectiveDate: undefined,
        receivedDate: undefined,
        scope: { kind: "full" },
      };
      const applied = await applyImport({
        database,
        prepared,
        approved,
        requestId: `${format}-optional-fields`,
        delivery: deliveryWithUndefined,
      });
      const replayed = await applyImport({
        database,
        prepared,
        approved,
        requestId: `${format}-optional-fields`,
        delivery: {
          label: "Synthetic delivery",
          scope: { kind: "full" },
        },
      });

      expect(replayed.importIds).toEqual(applied.importIds);
      expect(replayed.captureIds).toEqual(applied.captureIds);
      expect(replayed.deliveryId).toBe(applied.deliveryId);
      expect(
        await engineOf(database).query(
          'SELECT "Value" FROM "Inventory" ORDER BY record_id',
        ),
      ).toEqual([{ Value: "North" }]);
      expect(await listDeliveries({ database, limit: 10 })).toEqual({
        deliveries: [
          {
            id: applied.deliveryId,
            requestId: `${format}-optional-fields`,
            context: {
              label: "Synthetic delivery",
              scope: { kind: "full" },
            },
            captureIds: applied.captureIds,
            reusedCaptureIds: [],
          },
        ],
      });
    } finally {
      await prepared.close();
      await database.close();
    }
  });
}
