import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { DuckDBInstance } from "@duckdb/node-api";

const mode = process.argv[2] ?? "storage";
assert.ok(
  ["storage", "excel", "excel-small"].includes(mode),
  "Use storage, excel, or excel-small",
);
await mkdir("dist", { recursive: true });
const output = await mkdtemp(join("dist", `${mode}-`));
const require = createRequire(import.meta.url);
const dist = dirname(require.resolve("@duckdb/duckdb-wasm"));
const bundlePath = join(output, "browser.js");
await build({
  entryPoints: ["browser.mjs"],
  outfile: bundlePath,
  bundle: true,
  format: "esm",
  platform: "browser",
});
const exportedPath = join(output, "observations.duckdb");
const allowed = new Map([
  ["/browser.js", bundlePath],
  ...["duckdb-browser-eh.worker.js", "duckdb-eh.wasm"].map((name) => [
    `/dist/${name}`,
    join(dist, name),
  ]),
]);
const server = createServer(async (request, response) => {
  try {
    if (request.url === "/export" && request.method === "POST") {
      await pipeline(request, createWriteStream(exportedPath, { flags: "wx" }));
      response.end("Saved");
      return;
    }
    if (request.url === "/" && request.method === "GET") {
      response.setHeader("Content-Type", "text/html");
      response.end(
        '<input type="file"><script type="module" src="/browser.js"></script>',
      );
      return;
    }
    const file = allowed.get(request.url);
    if (file === undefined || request.method !== "GET") {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader(
      "Content-Type",
      file.endsWith(".wasm") ? "application/wasm" : "text/javascript",
    );
    response.setHeader("Content-Length", (await stat(file)).size);
    await pipeline(createReadStream(file), response);
  } catch (error) {
    response.statusCode = 500;
    response.end(String(error));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address !== null && typeof address !== "string");
let browser;
const results = [];
function record(label, result) {
  const entry = { label, ...result };
  results.push(entry);
  process.stdout.write(JSON.stringify(entry) + "\n");
}
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  page.on("pageerror", (error) =>
    record("page-error", { error: error.message }),
  );
  const query = async (label, sql) => {
    const result = await page.evaluate(
      (sql) => globalThis.experiment.query(sql),
      sql,
    );
    record(label, result);
    return result.rows;
  };
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.waitForFunction(() => globalThis.experiment);
  record("environment", {
    browser: browser.version(),
    node: process.version,
    mode,
  });
  await query(
    "version",
    "SELECT version() AS version, current_setting('threads') AS threads",
  );
  const expectedRows = mode === "excel-small" ? "300000" : "70000000";
  if (mode === "storage") {
    await query(
      "create",
      "CREATE TABLE observations (row_id BIGINT, source_file_id INTEGER, source_row INTEGER, dataset_id INTEGER, entity_id INTEGER, attribute_name VARCHAR, is_cde BOOLEAN, amount DECIMAL(18,2))",
    );
    for (const count of [300000, 7000000, 70000000]) {
      await query(
        `load-${count}`,
        `INSERT INTO observations SELECT i, (i//7000000)::INTEGER, (i%7000000+2)::INTEGER, (i%100000)::INTEGER, (i%13)::INTEGER, 'attribute_'||(i%1000000), i%10=0, (i%100000)/100 FROM range((SELECT count(*) FROM observations), ${count}) t(i)`,
      );
      await query(`checkpoint-${count}`, "CHECKPOINT");
      const rows = await query(
        `cdes-${count}`,
        "SELECT count(*) FILTER (WHERE is_cde) AS cdes FROM observations",
      );
      assert.equal(rows[0].cdes, String(count / 10));
    }
    await query(
      "datasets",
      "CREATE TABLE datasets AS SELECT i::INTEGER AS dataset_id, (i%20)::INTEGER AS domain_id FROM range(100000) t(i)",
    );
    for (const run of [1, 2]) {
      const rows = await query(
        `join-${run}`,
        "SELECT d.domain_id, count(*) AS n, sum(o.amount*1.05)::VARCHAR AS calculated FROM observations o JOIN datasets d USING(dataset_id) WHERE source_file_id=9 GROUP BY d.domain_id ORDER BY d.domain_id",
      );
      assert.equal(rows.length, 20);
      assert.equal(rows[0].n, "350000");
      assert.equal(Number(rows[0].calculated), 183713250);
    }
  } else {
    await page
      .locator("input")
      .setInputFiles(
        mode === "excel-small"
          ? "dist/attributes-300000.xlsx"
          : "dist/seven-million.xlsx",
      );
    record("source", {
      bytes: await page.evaluate(() =>
        globalThis.experiment.registerWorkbook(),
      ),
    });
    await query("extension", "LOAD excel");
    await query(
      "create",
      "CREATE TABLE observations (source_file_id INTEGER, source_sheet INTEGER, attribute_id BIGINT, attribute_name VARCHAR, is_cde BOOLEAN, dataset_id BIGINT)",
    );
    const files = mode === "excel-small" ? 1 : 10;
    const sheets = mode === "excel-small" ? 1 : 7;
    for (let file = 0; file < files; file++) {
      const start = performance.now();
      for (let sheet = 1; sheet <= sheets; sheet++) {
        await query(
          `file-${file}-sheet-${sheet}`,
          `INSERT INTO observations SELECT ${file}, ${sheet}, * FROM read_xlsx('source.xlsx', sheet='Sheet${sheet}', stop_at_empty=false)`,
        );
      }
      record(`workbook-${file}`, {
        milliseconds: Math.round(performance.now() - start),
      });
      await query(`checkpoint-${file}`, "CHECKPOINT");
    }
  }
  await page.evaluate(() => globalThis.experiment.close());
  await page.reload();
  await page.waitForFunction(() => globalThis.experiment);
  const reopened = await query(
    "reopened",
    "SELECT count(*) AS n, count(*) FILTER (WHERE is_cde) AS cdes FROM observations",
  );
  assert.equal(reopened[0].n, expectedRows);
  assert.equal(reopened[0].cdes, String(Number(expectedRows) / 10));
  await query(
    "curation",
    "CREATE TABLE curation (row_id BIGINT, approved BOOLEAN); INSERT INTO curation VALUES (1,true)",
  );
  await page.evaluate(() => globalThis.experiment.close());
  const start = performance.now();
  record("export", {
    bytes: await page.evaluate(() => globalThis.experiment.export()),
    milliseconds: Math.round(performance.now() - start),
  });
  const native = await DuckDBInstance.create(exportedPath, {
    access_mode: "READ_ONLY",
  });
  const connection = await native.connect();
  try {
    const rows = (
      await connection.runAndReadAll(
        "SELECT count(*) AS n, count(*) FILTER (WHERE is_cde) AS cdes FROM observations",
      )
    ).getRowObjectsJson();
    assert.equal(rows[0].n, expectedRows);
    assert.equal(rows[0].cdes, String(Number(expectedRows) / 10));
    assert.deepEqual(
      (
        await connection.runAndReadAll("SELECT * FROM curation")
      ).getRowObjectsJson(),
      [{ row_id: "1", approved: true }],
    );
    record("native-verification", { rows });
  } finally {
    connection.closeSync();
    native.closeSync();
  }
} catch (error) {
  record("failure", { error: String(error) });
  process.exitCode = 1;
} finally {
  await writeFile(
    join(output, "results.json"),
    JSON.stringify(results, null, 2) + "\n",
  );
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
