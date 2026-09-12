import { expect, test } from "@playwright/test";

import {
  applyImport,
  prepareImport,
  recordDelivery,
  resolveImport,
  type ImportRecipe,
  type ImportSource,
} from "@consultchimps/db";
import { createDatabase, createPreparedImport } from "@consultchimps/db/node";

test("shows changes baselines and partial descriptions from an opened database", async ({
  page,
}, testInfo) => {
  const databasePath = testInfo.outputPath("delivery-scopes.sqlite");
  const planPath = testInfo.outputPath("delivery-scopes.ccplan");
  const { database } = await createDatabase({
    path: databasePath,
    format: "sqlite",
  });
  const bytes = new TextEncoder().encode("synthetic delivery scope source");
  const source: ImportSource = {
    key: "synthetic-source",
    readerVersion: "synthetic-1",
    bytes: {
      name: "synthetic.xlsx",
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
                    Value: { kind: "string" as const, value: "Synthetic" },
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
  const recipe: ImportRecipe = {
    version: 1,
    routes: [
      {
        source: source.key,
        selection: "Inventory",
        destination: {
          kind: "new-table",
          schema: {
            name: "Inventory",
            recordId: { prefix: "INV", padding: 6 },
            columns: [{ name: "Value", type: "text" }],
            foreignKeys: [],
          },
        },
        columns: [{ source: "Value", target: "Value", type: "text" }],
      },
    ],
  };
  const prepared = await createPreparedImport({
    path: planPath,
    database,
    recipe,
    baselineRevision: 0n,
  });
  try {
    await prepareImport({ database, prepared, sources: [source], recipe });
    const approved = await resolveImport({
      database,
      prepared,
      decisions: [],
    });
    if (approved.state !== "ready") {
      throw new Error("Synthetic delivery import did not become ready");
    }
    const applied = await applyImport({
      database,
      prepared,
      approved,
      requestId: "changes-delivery",
      delivery: {
        label: "Changes delivery",
        scope: { kind: "changes", baseline: "DEL-BASELINE-42" },
        attributes: {
          vendor: "Vendor A",
          entity: "Entity North",
          phase: "Changes",
        },
      },
    });
    await recordDelivery({
      database,
      captureIds: applied.captureIds,
      requestId: "partial-delivery",
      context: {
        label: "Partial delivery",
        scope: {
          kind: "partial",
          description: "Selected business units",
        },
        attributes: {
          vendor: "Vendor B",
          entity: "Entity South",
          phase: "Partial",
        },
      },
    });
    await recordDelivery({
      database,
      captureIds: applied.captureIds,
      requestId: "label-only-delivery",
      context: {
        label: "September client handoff",
        scope: { kind: "full" },
      },
    });
  } finally {
    await prepared.close();
    await database.close();
  }

  await page.goto("/workspace");
  await page.getByTestId("workspace-open-input").setInputFiles(databasePath);
  await expect(page.getByTestId("workspace-summary")).toBeVisible();
  await page.getByTestId("workspace-deliveries-refresh").click();
  const deliveries = page.getByTestId("workspace-delivery");
  await expect(deliveries).toHaveCount(3);
  await expect(deliveries.nth(0)).toContainText("Changes delivery");
  await expect(deliveries.nth(0)).toContainText("Vendor A");
  await expect(deliveries.nth(0)).toContainText(
    "Changes since DEL-BASELINE-42",
  );
  await expect(deliveries.nth(1)).toContainText("Partial delivery");
  await expect(deliveries.nth(1)).toContainText("Vendor B");
  await expect(deliveries.nth(1)).toContainText(
    "Partial coverage: Selected business units",
  );
  await expect(deliveries.nth(2)).toContainText("September client handoff");
  await expect(deliveries.nth(2)).toContainText("Unspecified vendor");
  await expect(deliveries.nth(2)).toContainText("Full coverage");
  const screenshotPath = testInfo.outputPath("delivery-history-labels.png");
  await page
    .getByTestId("workspace-deliveries")
    .screenshot({ path: screenshotPath });
  await testInfo.attach("delivery-history-labels", {
    path: screenshotPath,
    contentType: "image/png",
  });
});
