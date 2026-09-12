import { expect, test, type TestInfo } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve(
  import.meta.dirname,
  "../../../packages/cli/dist/index.js",
);

async function sqliteFixture(
  testInfo: TestInfo,
  directory: string,
  table: string,
): Promise<string> {
  const fixtureDirectory = testInfo.outputPath(directory);
  const schemaPath = path.join(fixtureDirectory, "schema.json");
  const databasePath = path.join(fixtureDirectory, "report.sqlite");
  await mkdir(fixtureDirectory, { recursive: true });
  await writeFile(
    schemaPath,
    JSON.stringify({
      version: 1,
      tables: [
        {
          name: table,
          recordId: { prefix: table.slice(0, 8).toUpperCase(), padding: 4 },
          columns: [{ name: "value", type: "text" }],
        },
      ],
    }),
  );
  await execFileAsync(process.execPath, [
    CLI_PATH,
    "db",
    "create",
    "--output",
    databasePath,
    "--format",
    "sqlite",
    "--schema",
    schemaPath,
  ]);
  return databasePath;
}

async function expectOnlyTable(
  page: import("@playwright/test").Page,
  table: string,
): Promise<void> {
  await expect(page.getByTestId("workspace-table")).toHaveCount(1);
  await expect(page.getByTestId("workspace-table")).toContainText(table);
}

test("opens files under an explicit working-copy name and replaces only when selected", async ({
  page,
}, testInfo) => {
  const baseline = await sqliteFixture(testInfo, "baseline", "baseline_data");
  const alternate = await sqliteFixture(
    testInfo,
    "alternate",
    "alternate_data",
  );
  const replacement = await sqliteFixture(
    testInfo,
    "replacement",
    "replacement_data",
  );

  await page.goto("/workspace");
  await expect(page.getByTestId("workspace-open-overwrite")).not.toBeChecked();
  await page.getByTestId("workspace-open-name").fill("report.sqlite");
  await page.getByTestId("workspace-open-input").setInputFiles(baseline);
  await expectOnlyTable(page, "baseline_data");
  await expect(page.getByTestId("workspace-summary")).toContainText(
    "report.sqlite",
  );

  await page.getByTestId("workspace-open-input").setInputFiles(replacement);
  await expect(page.getByTestId("workspace-error")).toContainText(
    /already exists/iu,
  );
  await expectOnlyTable(page, "baseline_data");

  await page.getByTestId("workspace-open-name").fill("alternate.sqlite");
  await page.getByTestId("workspace-open-input").setInputFiles(alternate);
  await expectOnlyTable(page, "alternate_data");
  await expect(page.getByTestId("workspace-summary")).toContainText(
    "alternate.sqlite",
  );

  await page.getByTestId("workspace-open-name").fill("report.sqlite");
  await page.getByTestId("workspace-open-overwrite").check();
  await page.getByTestId("workspace-open-input").setInputFiles(replacement);
  await expectOnlyTable(page, "replacement_data");

  await page
    .getByTestId("workspace-reopen")
    .filter({ hasText: "alternate.sqlite" })
    .click();
  await expectOnlyTable(page, "alternate_data");

  await page.getByTestId("workspace-open-input").setInputFiles({
    name: "report.sqlite",
    mimeType: "application/vnd.sqlite3",
    buffer: Buffer.from("not a database\n", "utf8"),
  });
  await expect(page.getByTestId("workspace-error")).toContainText(
    /database|SQLite/iu,
  );
  await expectOnlyTable(page, "alternate_data");

  await page
    .getByTestId("workspace-reopen")
    .filter({ hasText: "report.sqlite" })
    .click();
  await expectOnlyTable(page, "replacement_data");
});
