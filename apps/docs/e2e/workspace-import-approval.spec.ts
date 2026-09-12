import { expect, test, type Page } from "@playwright/test";

import { createWorkbookUpload } from "./fixtures";

async function installDelayedResolveWorker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    class DelayedResolveWorker extends EventTarget {
      readonly worker: Worker;

      constructor(url: string | URL, options?: WorkerOptions) {
        super();
        this.worker = new NativeWorker(url, options);
        this.worker.addEventListener("message", (event) => {
          const message: unknown = event.data;
          const delay =
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "importResolved"
              ? 500
              : 0;
          window.setTimeout(() => {
            this.dispatchEvent(new MessageEvent("message", { data: message }));
          }, delay);
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
      value: DelayedResolveWorker,
    });
  });
}

async function prepareReadyImport(page: Page): Promise<void> {
  await page.goto("/workspace");
  await page.getByTestId("workspace-new-name").fill("approval.sqlite");
  await page.getByTestId("workspace-new").click();
  await page
    .getByTestId("workspace-import-input")
    .setInputFiles(
      await createWorkbookUpload("approval.xlsx", [
        { name: "Records", rows: [["Original"], ["Preserved value"]] },
      ]),
    );
  await page.getByTestId("workspace-import-prepare").click();
  await expect(page.getByTestId("workspace-import-review")).toBeVisible();
  await page.getByTestId("workspace-import-resolve").click();
  await expect(page.getByTestId("workspace-import-resolve")).toBeDisabled();
  await expect(page.getByTestId("workspace-import-resolve")).toBeEnabled();
  await expect(page.getByTestId("workspace-import-review")).toContainText(
    "ready",
  );
}

test("requires a new review after route edits before applying", async ({
  page,
}, testInfo) => {
  await installDelayedResolveWorker(page);
  await prepareReadyImport(page);

  const apply = page.getByTestId("workspace-import-apply");
  const resolve = page.getByTestId("workspace-import-resolve");
  const route = page.getByTestId("workspace-import-route");
  const table = page.getByTestId("workspace-import-table");
  const destination = page.getByLabel("Original destination");
  const type = page.getByLabel("Original type");
  const approvedTable = await table.inputValue();
  const approvedDestination = await destination.inputValue();
  const approvedType = await type.inputValue();

  await expect(apply).toBeEnabled();
  await route.selectOption("append");
  await expect(apply).toBeDisabled();
  await route.selectOption("create");
  await expect(apply).toBeEnabled();

  await table.fill("TemporaryRecords");
  await expect(apply).toBeDisabled();
  await table.fill(approvedTable);
  await expect(apply).toBeEnabled();

  await destination.fill("TemporaryColumn");
  await expect(apply).toBeDisabled();
  await destination.fill(approvedDestination);
  await expect(apply).toBeEnabled();

  await type.selectOption(approvedType === "text" ? "integer" : "text");
  await expect(apply).toBeDisabled();
  await type.selectOption(approvedType);
  await expect(apply).toBeEnabled();

  await destination.fill("Renamed");
  await expect(apply).toBeDisabled();
  await testInfo.attach("dirty-import-approval", {
    body: await page.screenshot(),
    contentType: "image/png",
  });

  await resolve.click();
  await expect(destination).toBeDisabled();
  await expect(apply).toBeDisabled();
  await expect(resolve).toBeDisabled();
  await expect(resolve).toBeEnabled();
  await expect(destination).toHaveValue("Renamed");
  await expect(apply).toBeEnabled();

  await page.getByTestId("workspace-delivery-vendor").fill("Vendor A");
  await page.getByTestId("workspace-delivery-entity").fill("Entity North");
  await page.getByTestId("workspace-delivery-phase").fill("Iteration 1");
  await page.getByTestId("workspace-import-apply").click();
  await expect(page.getByTestId("workspace-import-result")).toContainText(
    "Added 1 row",
  );
  await expect(page.getByTestId("workspace-table")).toContainText(
    "Renamed (text)",
  );
  await expect(page.getByTestId("workspace-table")).not.toContainText(
    "Original (text)",
  );

  await page.reload();
  await page.getByTestId("workspace-reopen").first().click();
  await expect(page.getByTestId("workspace-table")).toContainText(
    "Renamed (text)",
  );
});
