import { expect, test, type Page } from "@playwright/test";

import { createWorkbookUpload, type UploadFile } from "./fixtures";

async function createWorkspace(page: Page, name: string): Promise<void> {
  await page.goto("/workspace");
  await page.getByTestId("workspace-new-name").fill(name);
  await page.getByTestId("workspace-new").click();
  await expect(page.getByTestId("workspace-summary")).toBeVisible();
}

async function prepareSameNamedSources(
  page: Page,
  sources: readonly UploadFile[],
): Promise<void> {
  await page.getByTestId("workspace-import-input").setInputFiles(sources);
  const sourceCards = page.getByTestId("workspace-import-source");
  await expect(sourceCards).toHaveCount(sources.length);
  for (let index = 0; index < sources.length; index += 1) {
    await sourceCards
      .nth(index)
      .getByTestId("workspace-import-role")
      .fill("inventory");
    await sourceCards
      .nth(index)
      .getByTestId("workspace-import-revision")
      .fill("Iteration 1");
  }
  await page.getByTestId("workspace-import-prepare").click();
  await expect(page.getByTestId("workspace-import-review")).toBeVisible();
}

async function resolveAndApply(page: Page): Promise<void> {
  await page.getByTestId("workspace-import-resolve").click();
  await expect(page.getByTestId("workspace-import-review")).toContainText(
    "ready",
  );
  await page.getByTestId("workspace-delivery-vendor").fill("Vendor A");
  await page.getByTestId("workspace-delivery-entity").fill("Entity North");
  await page.getByTestId("workspace-delivery-phase").fill("Iteration 1");
  await page.getByTestId("workspace-delivery-coverage").selectOption("full");
  await page.getByTestId("workspace-import-apply").click();
  await expect(page.getByTestId("workspace-import-result")).toBeVisible();
}

test("captures and routes different workbooks that have the same filename", async ({
  page,
}) => {
  const north = await createWorkbookUpload("report.xlsx", [
    { name: "North", rows: [["Value"], ["North value"]] },
  ]);
  const south = await createWorkbookUpload("report.xlsx", [
    { name: "South", rows: [["Value"], ["South value"]] },
  ]);
  await createWorkspace(page, "same-name-distinct.sqlite");

  await prepareSameNamedSources(page, [north, south]);
  await expect(page.getByTestId("workspace-import-region")).toHaveCount(2);
  await expect(page.getByTestId("workspace-import-review")).toContainText(
    "Review 2 source rows",
  );

  await page.getByTestId("workspace-import-preview").nth(0).click();
  await expect(page.getByTestId("workspace-import-preview-page")).toContainText(
    "North value",
  );
  await page.getByTestId("workspace-import-preview").nth(1).click();
  await expect(page.getByTestId("workspace-import-preview-page")).toContainText(
    "South value",
  );

  await resolveAndApply(page);
  await expect(page.getByTestId("workspace-table")).toHaveCount(2);
  await expect(
    page.getByTestId("workspace-table").filter({ hasText: "North" }),
  ).toContainText("1 row");
  await expect(
    page.getByTestId("workspace-table").filter({ hasText: "South" }),
  ).toContainText("1 row");
});

test("retains both provenances while applying identical same-named content once", async ({
  page,
}) => {
  const first = await createWorkbookUpload("report.xlsx", [
    { name: "Inventory", rows: [["Value"], ["Shared value"]] },
  ]);
  const second: UploadFile = {
    ...first,
    buffer: Buffer.from(first.buffer),
  };
  await createWorkspace(page, "same-name-identical.sqlite");

  await prepareSameNamedSources(page, [first, second]);
  await expect(page.getByTestId("workspace-import-region")).toHaveCount(2);
  await expect(page.getByTestId("workspace-import-review")).toContainText(
    "Review 1 source rows",
  );

  await page.reload();
  await page.getByTestId("workspace-reopen").first().click();
  await expect(page.getByTestId("workspace-import-resume")).toHaveCount(1);
  await page.getByTestId("workspace-import-resume").click();
  await expect(page.getByTestId("workspace-import-region")).toHaveCount(2);
  await expect(page.getByTestId("workspace-import-review")).toContainText(
    "report.xlsx",
  );
  for (let index = 0; index < 2; index += 1) {
    await page.getByTestId("workspace-import-preview").nth(index).click();
    await expect(
      page.getByTestId("workspace-import-preview-page"),
    ).toContainText("Shared value");
  }

  await resolveAndApply(page);
  await expect(page.getByTestId("workspace-import-result")).toContainText(
    "Added 1 row",
  );
  await expect(page.getByTestId("workspace-table")).toHaveCount(1);
  await expect(page.getByTestId("workspace-table")).toContainText("1 row");
});
