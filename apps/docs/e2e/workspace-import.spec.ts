import { expect, test, type Page } from "@playwright/test";

import { createWorkbookUpload, type UploadFile } from "./fixtures";

function inventoryWorkbook(
  name = "inventory.xlsx",
  extraRows: ReadonlyArray<readonly (number | string)[]> = [],
): Promise<UploadFile> {
  return createWorkbookUpload(name, [
    {
      name: "Inventory",
      rows: [
        ["Dataset", "Attribute", "CDE"],
        ["Customers", "Customer ID", "true"],
        ["Orders", "Order ID", "false"],
        ...extraRows,
      ],
    },
  ]);
}

function mappingWorkbook(): Promise<UploadFile> {
  return createWorkbookUpload("mappings.xlsx", [
    {
      name: "Mappings",
      rows: [
        ["Attribute", "CDE name"],
        ["Customer ID", "Customer identifier"],
      ],
    },
  ]);
}

function singleColumnWorkbook(
  fileName: string,
  sheetName: string,
  header: string,
  values: readonly string[],
): Promise<UploadFile> {
  return createWorkbookUpload(fileName, [
    {
      name: sheetName,
      rows: [[header], ...values.map((value) => [value])],
    },
  ]);
}

function cancellableWorkbook(): Promise<UploadFile> {
  return createWorkbookUpload("large.xlsx", [
    {
      name: "CapturedFirst",
      rows: [
        ["Dataset", "Attribute", "CDE"],
        ["Customers", "Customer ID", "true"],
      ],
    },
    {
      name: "CancelSecond",
      rows: [["Dataset", "Attribute", "CDE"], ...generatedRows(15_000)],
    },
  ]);
}

function generatedRows(count: number): ReadonlyArray<readonly string[]> {
  return Array.from({ length: count }, (_, index) => [
    `Dataset ${String(index)}`,
    `Attribute ${String(index)}`,
    index % 2 === 0 ? "true" : "false",
  ]);
}

async function installLostImportReplyWorker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    class RecoverableWorker extends EventTarget {
      readonly worker: Worker;

      constructor(url: string | URL, options?: WorkerOptions) {
        super();
        this.worker = new NativeWorker(url, options);
        this.worker.addEventListener("message", (event) => {
          const message: unknown = event.data;
          if (
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "importApplied" &&
            window.localStorage.getItem("drop-import-applied") === "yes"
          ) {
            window.localStorage.setItem("drop-import-applied", "done");
            this.worker.terminate();
            this.dispatchEvent(new Event("error"));
            return;
          }
          this.dispatchEvent(new MessageEvent("message", { data: message }));
        });
        this.worker.addEventListener("error", () => {
          this.dispatchEvent(new Event("error"));
        });
        this.worker.addEventListener("messageerror", () => {
          this.dispatchEvent(new MessageEvent("messageerror"));
        });
      }

      postMessage(
        message: unknown,
        options?: StructuredSerializeOptions | Transferable[],
      ): void {
        if (Array.isArray(options)) {
          this.worker.postMessage(message, options);
        } else {
          this.worker.postMessage(message, options);
        }
      }

      terminate(): void {
        this.worker.terminate();
      }
    }
    Object.defineProperty(window, "Worker", {
      configurable: true,
      value: RecoverableWorker,
    });
  });
}

async function create(page: Page, format: "duckdb" | "sqlite"): Promise<void> {
  await page.goto("/workspace");
  await page.getByTestId("workspace-new-format").selectOption(format);
  await page.getByTestId("workspace-new-name").fill(`imports.${format}`);
  await page.getByTestId("workspace-new").click();
  await expect(page.getByTestId("workspace-summary")).toBeVisible();
}

async function prepare(
  page: Page,
  files: readonly UploadFile[],
): Promise<void> {
  await page.getByTestId("workspace-import-input").setInputFiles(files);
  await expect(page.getByTestId("workspace-import-source")).toHaveCount(
    files.length,
  );
  await page
    .getByTestId("workspace-import-source")
    .first()
    .getByTestId("workspace-import-role")
    .fill("inventory");
  await page
    .getByTestId("workspace-import-source")
    .first()
    .getByTestId("workspace-import-revision")
    .fill("Iteration 1");
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
  await page.getByTestId("workspace-delivery-coverage").selectOption("partial");
  await page.getByTestId("workspace-import-apply").click();
  await expect(page.getByTestId("workspace-import-result")).toContainText(
    "Added",
  );
}

test.describe("reviewed workbook imports", () => {
  for (const format of ["sqlite", "duckdb"] as const) {
    test(`imports multiple workbooks into ${format}`, async ({ page }) => {
      await create(page, format);
      await prepare(page, [await inventoryWorkbook(), await mappingWorkbook()]);
      await expect(page.getByTestId("workspace-import-region")).toHaveCount(2);
      await page.getByTestId("workspace-import-preview").first().click();
      await expect(
        page.getByTestId("workspace-import-preview-page"),
      ).toContainText("Customers");
      await resolveAndApply(page);
      await expect(page.getByTestId("workspace-table")).toHaveCount(2);
      await expect(page.getByTestId("workspace-table").nth(0)).toContainText(
        "2 rows",
      );
      await expect(page.getByTestId("workspace-table").nth(1)).toContainText(
        "1 row",
      );
      await page.getByTestId("workspace-deliveries-refresh").click();
      await expect(page.getByTestId("workspace-delivery")).toHaveCount(1);
    });

    test(`resumes a saved ${format} review after reload without Excel`, async ({
      page,
    }) => {
      await create(page, format);
      await prepare(page, [await inventoryWorkbook()]);

      await page.reload();
      await page.getByTestId("workspace-reopen").first().click();
      await expect(page.getByTestId("workspace-import-resume")).toHaveCount(1);
      await page.getByTestId("workspace-import-resume").click();
      await expect(page.getByTestId("workspace-import-review")).toContainText(
        "inventory.xlsx",
      );
      await resolveAndApply(page);
      await expect(page.getByTestId("workspace-import-result")).toContainText(
        "Added 2 rows",
      );
      await expect(page.getByTestId("workspace-table")).toHaveCount(1);
      await expect(page.getByTestId("workspace-table")).toContainText("2 rows");

      await page.reload();
      await page.getByTestId("workspace-reopen").first().click();
      await expect(page.getByTestId("workspace-import-resume")).toHaveCount(0);
    });
  }

  test("recovers a committed import when its worker reply is lost", async ({
    page,
  }) => {
    await installLostImportReplyWorker(page);

    await create(page, "sqlite");
    await prepare(page, [await inventoryWorkbook()]);
    await page.getByTestId("workspace-import-resolve").click();
    await expect(page.getByTestId("workspace-import-review")).toContainText(
      "ready",
    );
    await page.getByTestId("workspace-delivery-vendor").fill("Vendor A");
    await page.evaluate(() => {
      window.localStorage.setItem("drop-import-applied", "yes");
    });
    await page.getByTestId("workspace-import-apply").click();
    await expect(page.getByTestId("workspace-error")).toContainText(
      "worker is no longer available",
    );

    await page.reload();
    await page.getByTestId("workspace-reopen").first().click();
    await expect(page.getByTestId("workspace-import-resume")).toContainText(
      "Finish recovery",
    );
    await page.getByTestId("workspace-import-resume").click();
    await expect(page.getByTestId("workspace-delivery-vendor")).toHaveValue(
      "Vendor A",
    );
    await page.getByTestId("workspace-import-apply").click();
    await expect(page.getByTestId("workspace-import-result")).toContainText(
      "already applied",
    );
    await expect(page.getByTestId("workspace-table")).toContainText("2 rows");
    await page.getByTestId("workspace-deliveries-refresh").click();
    await expect(page.getByTestId("workspace-delivery")).toHaveCount(1);
  });

  test("skips a repeat capture and can record another delivery", async ({
    page,
  }) => {
    await installLostImportReplyWorker(page);
    await create(page, "sqlite");
    const workbook = await inventoryWorkbook();
    await prepare(page, [workbook]);
    await resolveAndApply(page);

    await prepare(page, [workbook]);
    await expect(page.getByTestId("workspace-import-duplicate")).toBeVisible();
    await expect(page.getByTestId("workspace-import-review")).toContainText(
      "Review 2 source rows",
    );
    await page.getByTestId("workspace-delivery-vendor").fill("Vendor A");
    await page.getByTestId("workspace-delivery-phase").fill("Iteration 2");
    const pendingRequestId = await page.getByLabel("Request ID").inputValue();
    await page.evaluate(() => {
      window.localStorage.setItem("drop-import-applied", "yes");
    });
    await page.getByTestId("workspace-delivery-record-reuse").click();
    await expect(page.getByTestId("workspace-error")).toContainText(
      "worker is no longer available",
    );

    await page.reload();
    await page.getByTestId("workspace-reopen").first().click();
    await expect(page.getByTestId("workspace-delivery-count")).toHaveText("2");
    await expect(page.getByTestId("workspace-import-resume")).toContainText(
      "Finish recovery",
    );
    await page.getByTestId("workspace-import-resume").click();
    await expect(page.getByLabel("Request ID")).toHaveValue(pendingRequestId);
    await expect(page.getByTestId("workspace-delivery-phase")).toHaveValue(
      "Iteration 2",
    );
    await page.getByTestId("workspace-delivery-record-reuse").click();
    await expect(page.getByTestId("workspace-import-result")).toContainText(
      "reused the captured rows",
    );
    await expect(page.getByTestId("workspace-delivery-count")).toHaveText("2");
    await page.getByTestId("workspace-deliveries-refresh").click();
    await expect(page.getByTestId("workspace-delivery")).toHaveCount(2);
    await expect(page.getByTestId("workspace-delivery").last()).toContainText(
      "Reused captured data",
    );

    await expect(page.getByLabel("Request ID")).toHaveValue(pendingRequestId);
    await page.getByTestId("workspace-delivery-record-reuse").click();
    await expect(page.getByTestId("workspace-delivery-count")).toHaveText("3");
    await expect(page.getByTestId("workspace-table")).toContainText("2 rows");
    await page.getByTestId("workspace-deliveries-refresh").click();
    await expect(page.getByTestId("workspace-delivery")).toHaveCount(3);

    const secondRequestId = await page.getByLabel("Request ID").inputValue();
    expect(secondRequestId).not.toBe(pendingRequestId);
    await page.evaluate(() => {
      window.localStorage.setItem("drop-import-applied", "yes");
    });
    await page.getByTestId("workspace-delivery-record-reuse").click();
    await expect(page.getByTestId("workspace-error")).toContainText(
      "worker is no longer available",
    );
    const recoveredDeliveryRequestId = await page
      .getByLabel("Request ID")
      .inputValue();
    expect(recoveredDeliveryRequestId).not.toBe(secondRequestId);

    await page.reload();
    await page.getByTestId("workspace-reopen").first().click();
    await expect(page.getByTestId("workspace-delivery-count")).toHaveText("4");
    await expect(page.getByTestId("workspace-import-resume")).toContainText(
      "Finish recovery",
    );
    await page.getByTestId("workspace-import-resume").click();
    await expect(page.getByLabel("Request ID")).toHaveValue(
      recoveredDeliveryRequestId,
    );
    await page.getByTestId("workspace-delivery-record-reuse").click();
    await expect(page.getByTestId("workspace-import-result")).toContainText(
      "already recorded",
    );
    await expect(page.getByTestId("workspace-delivery-count")).toHaveText("4");
    await expect(page.getByTestId("workspace-table")).toContainText("2 rows");
    await page.getByTestId("workspace-deliveries-refresh").click();
    await expect(page.getByTestId("workspace-delivery")).toHaveCount(4);
    await expect(page.getByLabel("Request ID")).toHaveValue(
      recoveredDeliveryRequestId,
    );

    await page.getByLabel("Request ID").fill(pendingRequestId);
    await page.getByTestId("workspace-delivery-vendor").fill("Vendor B");
    await page.getByTestId("workspace-delivery-record-reuse").click();
    await expect(page.getByTestId("workspace-error")).toContainText(
      "request ID",
    );
    await expect(page.getByTestId("workspace-delivery-count")).toHaveText("4");

    await page.getByLabel("Request ID").fill("corrected-delivery-request");
    await page.getByTestId("workspace-delivery-record-reuse").click();
    await expect(page.getByTestId("workspace-import-result")).toContainText(
      "Recorded a separate delivery event",
    );
    await expect(page.getByTestId("workspace-delivery-count")).toHaveText("5");
    await expect(page.getByTestId("workspace-table")).toContainText("2 rows");

    await page.getByTestId("workspace-delivery-vendor").fill("Vendor A");
    await page.getByLabel("Request ID").fill(pendingRequestId);
    await page.getByTestId("workspace-delivery-record-reuse").click();
    await expect(page.getByTestId("workspace-import-result")).toContainText(
      "already recorded",
    );
    await expect(page.getByTestId("workspace-import-result")).toContainText(
      "reused the captured rows",
    );
    await expect(page.getByTestId("workspace-delivery-count")).toHaveText("5");
    await expect(page.getByTestId("workspace-table")).toContainText("2 rows");
    await page.getByTestId("workspace-deliveries-refresh").click();
    await expect(page.getByTestId("workspace-delivery")).toHaveCount(5);
  });

  test("counts fresh and reused regions in the review total", async ({
    page,
  }) => {
    await create(page, "sqlite");
    const inventory = await inventoryWorkbook();
    await prepare(page, [inventory]);
    await resolveAndApply(page);

    await prepare(page, [inventory, await mappingWorkbook()]);
    await expect(page.getByTestId("workspace-import-region")).toHaveCount(2);
    await expect(page.getByTestId("workspace-import-review")).toContainText(
      "Review 3 source rows",
    );
    await expect(
      page.getByTestId("workspace-import-region").first(),
    ).toContainText("2 rows");
    await expect(
      page.getByTestId("workspace-import-region").last(),
    ).toContainText("1 rows");
  });

  test("keeps an earlier pending review after preparing another", async ({
    page,
  }) => {
    await create(page, "sqlite");
    await prepare(page, [await inventoryWorkbook("first-review.xlsx")]);
    await prepare(page, [await mappingWorkbook()]);
    await expect(page.getByTestId("workspace-import-resume")).toHaveCount(2);

    await page
      .getByTestId("workspace-import-resume")
      .filter({ hasText: "first-review.xlsx" })
      .click();
    await expect(page.getByTestId("workspace-import-review")).toContainText(
      "first-review.xlsx",
    );
    await resolveAndApply(page);
    await expect(page.getByTestId("workspace-table")).toContainText("2 rows");
    await expect(page.getByTestId("workspace-import-resume")).toHaveCount(1);
    await expect(page.getByTestId("workspace-import-resume")).toContainText(
      "mappings.xlsx",
    );
  });

  test("clears the active review when switching databases", async ({
    page,
  }) => {
    await create(page, "sqlite");
    await prepare(page, [await inventoryWorkbook("switch-review.xlsx")]);
    await page.getByTestId("workspace-import-preview").click();
    await expect(
      page.getByTestId("workspace-import-preview-page"),
    ).toBeVisible();

    await page.getByTestId("workspace-new-name").fill("second.sqlite");
    await page.getByTestId("workspace-new").click();
    await expect(page.getByTestId("workspace-summary")).toContainText(
      "second.sqlite",
    );
    await expect(page.getByTestId("workspace-import-review")).toHaveCount(0);
    await expect(page.getByTestId("workspace-import-source")).toHaveCount(0);
    await expect(page.getByTestId("workspace-import-result")).toHaveCount(0);

    await page
      .getByTestId("workspace-reopen")
      .filter({ hasText: "imports.sqlite" })
      .click();
    await expect(page.getByTestId("workspace-import-resume")).toContainText(
      "switch-review.xlsx",
    );
  });

  test("reloads a saved review when working copies share a database ID", async ({
    page,
  }, testInfo) => {
    await create(page, "sqlite");
    await prepare(page, [await inventoryWorkbook("same-id-review.xlsx")]);

    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("workspace-export-same").click();
    const download = await downloadPromise;
    const exportedPath = testInfo.outputPath("same-id.sqlite");
    await download.saveAs(exportedPath);

    await page.getByTestId("workspace-open-input").setInputFiles(exportedPath);
    await expect(page.getByTestId("workspace-summary")).toContainText(
      "same-id-",
    );
    await expect(page.getByTestId("workspace-import-review")).toHaveCount(0);
    await expect(page.getByTestId("workspace-import-resume")).toHaveCount(1);
    await page.getByTestId("workspace-import-resume").click();
    await page.getByTestId("workspace-import-preview").click();
    await expect(
      page.getByTestId("workspace-import-preview-page"),
    ).toContainText("Customers");

    await page.getByTestId("workspace-reopen").first().click();
    await expect(page.getByTestId("workspace-summary")).toContainText(
      "same-id-",
    );
    await expect(page.getByTestId("workspace-import-review")).toHaveCount(0);
    await expect(page.getByTestId("workspace-import-resume")).toHaveCount(1);
    await page.getByTestId("workspace-import-resume").click();
    await page.getByTestId("workspace-import-preview").click();
    await expect(
      page.getByTestId("workspace-import-preview-page"),
    ).toContainText("Customers");

    await page
      .getByTestId("workspace-reopen")
      .filter({ hasText: "imports.sqlite" })
      .click();
    await expect(page.getByTestId("workspace-summary")).toContainText(
      "imports.sqlite",
    );
    await expect(page.getByTestId("workspace-import-review")).toHaveCount(0);
    await expect(page.getByTestId("workspace-import-resume")).toHaveCount(1);
    await page.getByTestId("workspace-import-resume").click();
    await resolveAndApply(page);
    await expect(page.getByTestId("workspace-table")).toContainText("2 rows");
  });

  test("keeps source columns after a renamed destination review is resumed", async ({
    page,
  }) => {
    await create(page, "sqlite");
    await prepare(page, [
      await singleColumnWorkbook(
        "renamed-column.xlsx",
        "Source Data",
        "Original",
        ["Preserved value"],
      ),
    ]);
    await page.getByLabel("Original destination").fill("Renamed");
    await page.getByTestId("workspace-import-resolve").click();
    await expect(page.getByTestId("workspace-import-review")).toContainText(
      "ready",
    );

    await page.reload();
    await page.getByTestId("workspace-reopen").first().click();
    await page.getByTestId("workspace-import-resume").click();
    await expect(page.getByLabel("Original destination")).toHaveValue(
      "Renamed",
    );
    await page.getByTestId("workspace-import-preview").click();
    await expect(
      page.getByTestId("workspace-import-preview-page"),
    ).toContainText("Original");
    await expect(
      page.getByTestId("workspace-import-preview-page"),
    ).toContainText("Preserved value");
    await resolveAndApply(page);
    await expect(page.getByTestId("workspace-table")).toContainText("1 row");
    await expect(page.getByTestId("workspace-table")).toContainText(
      "Renamed (text)",
    );
  });

  test("preserves exact numeric preview text after resume", async ({
    page,
  }) => {
    await create(page, "sqlite");
    await prepare(page, [
      await createWorkbookUpload("precise-numbers.xlsx", [
        {
          name: "Precise Numbers",
          rows: [
            ["Integer", "Decimal", "Formula"],
            [
              { numericText: "9007199254740993" },
              { numericText: "1234567890.123456789" },
              {
                formula: "A2/10",
                cachedNumber: "900719925474099.3",
              },
            ],
          ],
        },
      ]),
    ]);
    await page.getByTestId("workspace-import-preview").click();
    await expect(
      page.getByTestId("workspace-import-preview-page"),
    ).toContainText("9007199254740993");
    await expect(
      page.getByTestId("workspace-import-preview-page"),
    ).toContainText("1234567890.123456789");
    await expect(
      page.getByTestId("workspace-import-preview-page"),
    ).toContainText("900719925474099.3");

    await page.reload();
    await page.getByTestId("workspace-reopen").first().click();
    await page.getByTestId("workspace-import-resume").click();
    await page.getByTestId("workspace-import-preview").click();
    await expect(
      page.getByTestId("workspace-import-preview-page"),
    ).toContainText("9007199254740993");
    await expect(
      page.getByTestId("workspace-import-preview-page"),
    ).toContainText("1234567890.123456789");
    await expect(
      page.getByTestId("workspace-import-preview-page"),
    ).toContainText("900719925474099.3");
  });

  test("appends a changed submission to an existing table", async ({
    page,
  }) => {
    await create(page, "sqlite");
    await prepare(page, [await inventoryWorkbook()]);
    await resolveAndApply(page);

    await prepare(page, [
      await inventoryWorkbook("inventory-v2.xlsx", [
        ["Payments", "Payment ID", "true"],
      ]),
    ]);
    await page.getByTestId("workspace-import-route").selectOption("append");
    await page.getByTestId("workspace-import-table").fill("Inventory");
    await resolveAndApply(page);
    await expect(page.getByTestId("workspace-table").first()).toContainText(
      "5 rows",
    );
  });

  test("pages delivery history and resets it when the database changes", async ({
    page,
  }) => {
    await create(page, "sqlite");
    const workbook = await inventoryWorkbook();
    await prepare(page, [workbook]);
    await resolveAndApply(page);

    for (let delivery = 2; delivery <= 26; delivery += 1) {
      await prepare(page, [workbook]);
      await expect(
        page.getByTestId("workspace-import-duplicate"),
      ).toBeVisible();
      await page.getByTestId("workspace-delivery-vendor").fill("Vendor A");
      await page.getByLabel("Request ID").fill(`delivery-${String(delivery)}`);
      await page
        .getByTestId("workspace-delivery-phase")
        .fill(`Delivery ${String(delivery)}`);
      await page.getByTestId("workspace-delivery-record-reuse").click();
      await expect(page.getByTestId("workspace-delivery-count")).toHaveText(
        String(delivery),
      );
    }

    await prepare(page, [
      await inventoryWorkbook("fresh-capture.xlsx", [
        ["Payments", "Payment ID", "true"],
      ]),
    ]);
    await page.getByTestId("workspace-import-resolve").click();
    await expect(page.getByTestId("workspace-import-review")).toContainText(
      "ready",
    );
    await page.getByTestId("workspace-delivery-vendor").fill("Vendor B");
    await page.getByTestId("workspace-delivery-phase").fill("Fresh capture");
    await page.getByTestId("workspace-import-apply").click();
    await expect(page.getByTestId("workspace-delivery-count")).toHaveText("27");

    await page.getByTestId("workspace-deliveries-refresh").click();
    await expect(page.getByTestId("workspace-delivery")).toHaveCount(25);
    await expect(page.getByTestId("workspace-delivery").first()).toContainText(
      "Iteration 1",
    );
    await expect(
      page.getByTestId("workspace-delivery").first(),
    ).not.toContainText("Reused captured data");
    await expect(page.getByTestId("workspace-delivery").last()).toContainText(
      "Reused captured data",
    );
    await page.getByTestId("workspace-deliveries-next").click();
    await expect(page.getByTestId("workspace-delivery")).toHaveCount(2);
    await expect(page.getByTestId("workspace-delivery").first()).toContainText(
      "Delivery 26",
    );
    await expect(page.getByTestId("workspace-delivery").first()).toContainText(
      "Reused captured data",
    );
    await expect(page.getByTestId("workspace-delivery").last()).toContainText(
      "Fresh capture",
    );
    await expect(
      page.getByTestId("workspace-delivery").last(),
    ).not.toContainText("Reused captured data");

    await page.getByTestId("workspace-deliveries-refresh").click();
    await expect(page.getByTestId("workspace-delivery")).toHaveCount(25);
    await expect(page.getByTestId("workspace-delivery").first()).toContainText(
      "Iteration 1",
    );

    await page.getByTestId("workspace-new-name").fill("second.sqlite");
    await page.getByTestId("workspace-new").click();
    await expect(page.getByTestId("workspace-summary")).toContainText(
      "second.sqlite",
    );
    await expect(page.getByTestId("workspace-delivery")).toHaveCount(0);
    await expect(page.getByTestId("workspace-deliveries-next")).toHaveCount(0);
  });

  for (const locale of ["en-US", "tr-TR"] as const) {
    test.describe(`identifier behavior in ${locale}`, () => {
      test.use({ locale });

      test("routes case variants and generates stable record prefixes", async ({
        page,
      }) => {
        await create(page, "sqlite");
        await prepare(page, [
          await singleColumnWorkbook(
            "inventory-first.xlsx",
            "inventory",
            "Name",
            ["Parent A"],
          ),
        ]);
        await resolveAndApply(page);

        await prepare(page, [
          await singleColumnWorkbook(
            "inventory-second.xlsx",
            "Inventory",
            "Name",
            ["Parent B"],
          ),
        ]);
        await expect(page.getByTestId("workspace-import-route")).toHaveValue(
          "append",
        );
        await expect(page.getByTestId("workspace-import-table")).toHaveValue(
          "inventory",
        );
        await resolveAndApply(page);
        await expect(page.getByTestId("workspace-table").first()).toContainText(
          "2 rows",
        );

        await page.getByTestId("workspace-schema-input").fill(
          JSON.stringify({
            version: 1,
            tables: [
              {
                name: "Children",
                recordId: { prefix: "CHILD", padding: 6 },
                columns: [{ name: "ParentId", type: "text", nullable: false }],
                foreignKeys: [
                  { column: "ParentId", referencesTable: "inventory" },
                ],
              },
            ],
          }),
        );
        await page.getByTestId("workspace-schema-plan").click();
        await page.getByTestId("workspace-schema-apply").click();
        await expect(page.getByTestId("workspace-table")).toHaveCount(2);

        await prepare(page, [
          await singleColumnWorkbook("children.xlsx", "Children", "ParentId", [
            "INVENTOR-000001",
          ]),
        ]);
        await expect(page.getByTestId("workspace-import-route")).toHaveValue(
          "append",
        );
        await resolveAndApply(page);
        await expect(
          page.getByTestId("workspace-table").filter({ hasText: "Children" }),
        ).toContainText("1 row");
      });
    });
  }

  test("cancels preparation without publishing rows", async ({ page }) => {
    await create(page, "sqlite");
    await page
      .getByTestId("workspace-import-input")
      .setInputFiles(await cancellableWorkbook());
    await page.getByTestId("workspace-import-prepare").click();
    await expect(page.getByTestId("workspace-progress")).toContainText(
      "sheet2.xml",
    );
    await page.getByTestId("workspace-cancel").click();
    await expect(page.getByTestId("workspace-notice")).toContainText(
      "Cancelled",
    );
    await expect(page.getByTestId("workspace-table")).toHaveCount(0);

    await page.reload();
    await page.getByTestId("workspace-reopen").first().click();
    await expect(page.getByTestId("workspace-import-resume")).toHaveCount(0);
  });

  test("cancels a SQLite apply and rolls back its table", async ({ page }) => {
    await create(page, "sqlite");
    await prepare(page, [
      await inventoryWorkbook("large-apply.xlsx", generatedRows(2_500)),
    ]);
    await page.getByTestId("workspace-import-resolve").click();
    await expect(page.getByTestId("workspace-import-review")).toContainText(
      "ready",
    );
    await page.getByTestId("workspace-import-apply").click();
    await page.getByTestId("workspace-cancel").click();
    await expect(page.getByTestId("workspace-notice")).toContainText(
      "Cancelled",
    );
    await expect(page.getByTestId("workspace-table")).toHaveCount(0);

    await page.reload();
    await page.getByTestId("workspace-reopen").first().click();
    await expect(page.getByTestId("workspace-import-resume")).toHaveCount(1);
    await page.getByTestId("workspace-import-resume").click();
    await page.getByTestId("workspace-import-apply").click();
    await expect(page.getByTestId("workspace-import-result")).toContainText(
      "Added 2,502 rows",
    );
    await expect(page.getByTestId("workspace-table")).toContainText(
      "2,502 rows",
    );
  });
});
