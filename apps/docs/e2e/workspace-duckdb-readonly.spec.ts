import { expect, test } from "@playwright/test";

test("exports, closes, and reopens a read-only DuckDB workspace", async ({
  context,
  page,
}) => {
  await page.goto("/workspace");
  await page.getByTestId("workspace-new-format").selectOption("sqlite");
  await page
    .getByTestId("workspace-new-name")
    .fill(`worker-${crypto.randomUUID()}.sqlite`);
  await page.getByTestId("workspace-new").click();
  await expect(page.getByTestId("workspace-summary")).toBeVisible();
  const workerUrl = page.workers()[0]?.url();
  expect(workerUrl).toBeDefined();
  await page.close();
  await new Promise((resolve) => setTimeout(resolve, 500));

  const direct = await context.newPage();
  await direct.goto("/workspace");
  const result = await direct.evaluate(async (url) => {
    const worker = new Worker(url);
    let nextId = 1;
    const request = (command: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(
          () => reject(new Error("Direct workspace worker timed out")),
          20_000,
        );
        const receive = (event: MessageEvent<Record<string, unknown>>) => {
          if (event.data["id"] !== id || event.data["type"] === "progress") {
            return;
          }
          clearTimeout(timer);
          worker.removeEventListener("message", receive);
          resolve(event.data);
        };
        worker.addEventListener("message", receive);
        worker.postMessage({ ...command, id });
      });
    const sourceName = `readonly-${crypto.randomUUID()}.duckdb`;
    const copyName = `copy-${crypto.randomUUID()}.duckdb`;
    try {
      const created = await request({
        type: "create",
        name: sourceName,
        format: "duckdb",
        schema: {
          version: 1,
          tables: [
            {
              name: "Inventory",
              recordId: { prefix: "INV", padding: 6 },
              columns: [{ name: "value", type: "text" }],
            },
          ],
        },
      });
      const initialClose = await request({ type: "close" });
      const readonlyOpen = await request({
        type: "reopen",
        name: sourceName,
        readonly: true,
      });
      const exported = await request({ type: "export", format: "duckdb" });
      const readonlyClose = await request({ type: "close" });
      const copyOpen = await request({
        type: "open",
        name: copyName,
        file: exported["file"],
      });
      const copyClose = await request({ type: "close" });
      return {
        created,
        initialClose,
        readonlyOpen,
        exported: {
          type: exported["type"],
          size: exported["file"] instanceof File ? exported["file"].size : 0,
        },
        readonlyClose,
        copyOpen,
        copyClose,
      };
    } finally {
      worker.terminate();
    }
  }, workerUrl!);
  await direct.close();

  expect(result.created, JSON.stringify(result.created)).toMatchObject({
    type: "ready",
    summary: { format: "duckdb", tables: [{ name: "Inventory" }] },
  });
  expect(result.initialClose).toMatchObject({ type: "closed" });
  expect(result.readonlyOpen).toMatchObject({
    type: "ready",
    summary: { format: "duckdb", tables: [{ name: "Inventory" }] },
  });
  expect(result.exported).toMatchObject({
    type: "exported",
    size: expect.any(Number),
  });
  expect(result.exported.size).toBeGreaterThan(100);
  expect(result.readonlyClose).toMatchObject({ type: "closed" });
  expect(result.copyOpen).toMatchObject({
    type: "ready",
    summary: { format: "duckdb", tables: [{ name: "Inventory" }] },
  });
  expect(result.copyClose).toMatchObject({ type: "closed" });
});
