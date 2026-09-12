import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { engineOf, inspectDatabase } from "../src/database.js";
import { listDeliveries, recordDelivery } from "../src/import/deliveries.js";
import {
  applyImport,
  prepareImport,
  resolveImport,
} from "../src/import/operations.js";
import type {
  DeliveryContext,
  ImportRecipe,
  ImportSource,
} from "../src/import/types.js";
import { IMPORT_REQUEST_TABLE } from "../src/metadata.js";
import { createDatabase, createPreparedImport } from "../src/node.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const invalidContexts: ReadonlyArray<{
  readonly label: string;
  readonly value: unknown;
}> = [
  { label: "blank label", value: { label: " ", scope: { kind: "full" } } },
  {
    label: "blank partial description",
    value: { label: "Delivery", scope: { kind: "partial", description: "" } },
  },
  {
    label: "blank changes baseline",
    value: { label: "Delivery", scope: { kind: "changes", baseline: "\t" } },
  },
  {
    label: "invalid effective date value",
    value: { label: "Delivery", scope: { kind: "full" }, effectiveDate: 42 },
  },
  {
    label: "invalid received date value",
    value: { label: "Delivery", scope: { kind: "full" }, receivedDate: null },
  },
  {
    label: "non-finite attribute",
    value: {
      label: "Delivery",
      scope: { kind: "full" },
      attributes: { ratio: Number.NaN },
    },
  },
];

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
          columns: [{ name: "Value", type: "text" }],
          recordId: { prefix: "ITEM", padding: 4 },
          foreignKeys: [],
        },
      },
      columns: [{ source: "Value", target: "Value", type: "text" }],
    },
  ],
};

function source(): ImportSource {
  const bytes = new TextEncoder().encode("synthetic delivery fixture");
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

async function receiptCount(
  database: Parameters<typeof engineOf>[0],
): Promise<bigint> {
  const rows = await engineOf(database).query(
    `SELECT count(*) AS count FROM ${IMPORT_REQUEST_TABLE}`,
  );
  const count = rows[0]?.["count"];
  if (typeof count !== "bigint") throw new Error("Missing receipt count");
  return count;
}

for (const format of ["sqlite", "duckdb"] as const) {
  test(`${format}: invalid delivery contexts cannot poison import or delivery history`, async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "cc-delivery-context-"),
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
      baselineRevision: 0n,
    });
    try {
      const captured = await prepareImport({
        database,
        prepared,
        recipe,
        sources: [source()],
      });
      expect(captured.prepared.state).toBe("ready");
      const approved = await resolveImport({
        database,
        prepared,
        decisions: [],
      });
      if (approved.state !== "ready") throw new Error("Plan failed review");
      const beforeApply = await inspectDatabase({ database });

      for (const invalid of invalidContexts) {
        await expect(
          applyImport({
            database,
            prepared,
            approved,
            requestId: `invalid-apply-${invalid.label}`,
            delivery: invalid.value as DeliveryContext,
          }),
          invalid.label,
        ).rejects.toMatchObject({ code: "DB_INVALID_DELIVERY_CONTEXT" });
        expect(await inspectDatabase({ database })).toEqual(beforeApply);
        await expect(receiptCount(database)).resolves.toBe(0n);
      }

      const parsedContext = {
        label: "Initial delivery",
        effectiveDate: "As received",
        scope: { kind: "full" as const },
        attributes: { reportedCount: 1 },
      };
      const contextWithUnknownField = {
        ...parsedContext,
        ignoredByVersionOne: "synthetic extension",
      } as DeliveryContext;
      const applied = await applyImport({
        database,
        prepared,
        approved,
        requestId: `valid-apply-${format}`,
        delivery: contextWithUnknownField,
      });
      const retriedApply = await applyImport({
        database,
        prepared,
        approved,
        requestId: `valid-apply-${format}`,
        delivery: parsedContext,
      });
      expect(retriedApply.deliveryId).toBe(applied.deliveryId);
      expect(retriedApply.metrics.deliveriesRecorded).toBe(0);
      expect(await receiptCount(database)).toBe(1n);

      const afterEquivalentRetry = await inspectDatabase({ database });
      await expect(
        applyImport({
          database,
          prepared,
          approved,
          requestId: `valid-apply-${format}`,
        }),
      ).rejects.toMatchObject({ code: "DB_REQUEST_ID_CONFLICT" });
      expect(await inspectDatabase({ database })).toEqual(afterEquivalentRetry);
      expect(await receiptCount(database)).toBe(1n);

      const emptyRecipe: ImportRecipe = { version: 1, routes: [] };
      const noDeliveryPlan = await createPreparedImport({
        path: path.join(directory, "without-delivery.ccplan"),
        database,
        recipe: emptyRecipe,
        baselineRevision: afterEquivalentRetry.revision,
      });
      try {
        const noDeliveryPrepared = await prepareImport({
          database,
          prepared: noDeliveryPlan,
          recipe: emptyRecipe,
          sources: [],
        });
        expect(noDeliveryPrepared.prepared.state).toBe("ready");
        const noDeliveryApproved = await resolveImport({
          database,
          prepared: noDeliveryPlan,
          decisions: [],
        });
        if (noDeliveryApproved.state !== "ready") {
          throw new Error("Empty plan failed review");
        }
        const withoutDelivery = await applyImport({
          database,
          prepared: noDeliveryPlan,
          approved: noDeliveryApproved,
          requestId: `without-delivery-${format}`,
        });
        expect(withoutDelivery.deliveryId).toBeUndefined();
        expect(withoutDelivery.metrics.deliveriesRecorded).toBe(0);
        const beforeAddedDelivery = await inspectDatabase({ database });
        await expect(
          applyImport({
            database,
            prepared: noDeliveryPlan,
            approved: noDeliveryApproved,
            requestId: `without-delivery-${format}`,
            delivery: parsedContext,
          }),
        ).rejects.toMatchObject({ code: "DB_REQUEST_ID_CONFLICT" });
        expect(await inspectDatabase({ database })).toEqual(
          beforeAddedDelivery,
        );
      } finally {
        await noDeliveryPlan.close();
      }
      expect(await receiptCount(database)).toBe(2n);
      const beforeRecord = await inspectDatabase({ database });

      for (const invalid of invalidContexts) {
        await expect(
          recordDelivery({
            database,
            captureIds: applied.captureIds,
            context: invalid.value as DeliveryContext,
            requestId: `invalid-record-${invalid.label}`,
          }),
          invalid.label,
        ).rejects.toMatchObject({ code: "DB_INVALID_DELIVERY_CONTEXT" });
        expect(await inspectDatabase({ database })).toEqual(beforeRecord);
        await expect(receiptCount(database)).resolves.toBe(2n);
      }

      const recorded = await recordDelivery({
        database,
        captureIds: applied.captureIds,
        context: {
          ...contextWithUnknownField,
          label: "Recorded separately",
        },
        requestId: `valid-record-${format}`,
      });
      const retriedRecord = await recordDelivery({
        database,
        captureIds: applied.captureIds,
        context: { ...parsedContext, label: "Recorded separately" },
        requestId: `valid-record-${format}`,
      });
      expect(retriedRecord.delivery).toEqual(recorded.delivery);
      expect(retriedRecord.metrics.deliveriesRecorded).toBe(0);
      await expect(
        listDeliveries({ database, limit: 10 }),
      ).resolves.toMatchObject({
        deliveries: [
          { context: parsedContext },
          {
            context: { ...parsedContext, label: "Recorded separately" },
          },
        ],
      });
    } finally {
      await prepared.close();
      await database.close();
    }
  });
}
