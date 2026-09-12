import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { engineOf, inspectDatabase } from "../src/database.js";
import { listDeliveries, recordDelivery } from "../src/import/deliveries.js";
import { applyImport, prepareImport } from "../src/import/operations.js";
import type { DeliveryContext, ImportRecipe } from "../src/import/types.js";
import { DELIVERY_TABLE } from "../src/metadata.js";
import { createDatabase, createPreparedImport } from "../src/node.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

for (const format of ["sqlite", "duckdb"] as const) {
  test(`${format}: damaged stored delivery context has a stable error on reads and retries`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cc-stored-delivery-"));
    directories.push(directory);
    const { database } = await createDatabase({
      path: path.join(directory, `workspace.${format}`),
      format,
    });
    const recipe: ImportRecipe = { version: 1, routes: [] };
    const prepared = await createPreparedImport({
      path: path.join(directory, "review.ccplan"),
      database,
      recipe,
      baselineRevision: 0n,
    });
    const context: DeliveryContext = {
      label: "Synthetic delivery",
      scope: { kind: "unknown" },
    };
    try {
      const result = await prepareImport({
        database,
        prepared,
        recipe,
        sources: [],
      });
      const approved = result.prepared;
      if (approved.state !== "ready") throw new Error("Fixture needs review");
      const request = {
        database,
        prepared,
        approved,
        requestId: "synthetic-request",
        delivery: context,
      };
      const applied = await applyImport(request);
      const before = await inspectDatabase({ database });

      for (const damaged of [
        "{",
        "null",
        JSON.stringify({ label: "", scope: { kind: "unknown" } }),
      ]) {
        await engineOf(database).execute(
          `UPDATE ${DELIVERY_TABLE} SET context_json = ?`,
          [damaged],
        );
        const failure = { code: "DB_CORRUPT_DATABASE" };
        await expect(
          listDeliveries({ database, limit: 10 }),
        ).rejects.toMatchObject(failure);
        await expect(applyImport(request)).rejects.toMatchObject(failure);
        await expect(
          recordDelivery({
            database,
            requestId: request.requestId,
            context,
            captureIds: ["synthetic-capture"],
          }),
        ).rejects.toMatchObject(failure);
        expect(await inspectDatabase({ database })).toEqual(before);
        expect(
          await engineOf(database).query(
            `SELECT context_json FROM ${DELIVERY_TABLE}`,
          ),
        ).toEqual([{ context_json: damaged }]);
      }

      await engineOf(database).execute(
        `UPDATE ${DELIVERY_TABLE} SET context_json = ?`,
        [JSON.stringify(context, null, 2)],
      );
      const retried = await applyImport(request);
      expect(retried.deliveryId).toBe(applied.deliveryId);
      expect(retried.metrics.deliveriesRecorded).toBe(0);
      await expect(
        listDeliveries({ database, limit: 10 }),
      ).resolves.toMatchObject({
        deliveries: [{ context }],
      });
      expect(await inspectDatabase({ database })).toEqual(before);
    } finally {
      await prepared.close();
      await database.close();
    }
  });
}
