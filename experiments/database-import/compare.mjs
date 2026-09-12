import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DuckDBInstance } from "@duckdb/node-api";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";

await mkdir("dist", { recursive: true });
const output = await mkdtemp(join("dist", "comparison-"));
const dbPath = join(output, "native.duckdb");
const sqlitePath = join(output, "compat.sqlite");
const db = await DuckDBInstance.create(dbPath, {
  threads: "4",
  memory_limit: "1GB",
});
const connection = await db.connect();
const results = [];
async function query(label, sql) {
  const start = performance.now();
  const rows = (await connection.runAndReadAll(sql)).getRowObjectsJson();
  const result = {
    label,
    milliseconds: Math.round(performance.now() - start),
    rows,
  };
  results.push(result);
  process.stdout.write(JSON.stringify(result) + "\n");
  return rows;
}
try {
  await query("version", "SELECT version() AS version");
  await query(
    "native-load",
    "CREATE TABLE observations AS SELECT i AS row_id, (i//700000)::INTEGER AS source_file_id, (i%100000)::INTEGER AS dataset_id, 'attribute_'||(i%1000000) AS attribute_name, i%10=0 AS is_cde, ((i%100000)/100)::DECIMAL(18,2) AS amount FROM range(7000000) t(i)",
  );
  await query(
    "datasets",
    "CREATE TABLE datasets AS SELECT i::INTEGER AS dataset_id, (i%20)::INTEGER AS domain_id FROM range(100000) t(i)",
  );
  await query("checkpoint", "CHECKPOINT");
  await query("sqlite-extension", "INSTALL sqlite; LOAD sqlite");
  const escaped = sqlitePath.replaceAll("'", "''");
  await query("sqlite-attach", `ATTACH '${escaped}' AS compat (TYPE SQLITE)`);
  await query(
    "sqlite-export",
    "CREATE TABLE compat.observations AS SELECT * FROM observations; CREATE TABLE compat.datasets AS SELECT * FROM datasets",
  );
  await query("sqlite-types", "DESCRIBE compat.observations");
  for (const source of ["native", "sqlite"]) {
    const prefix = source === "sqlite" ? "compat." : "";
    for (const run of [1, 2]) {
      const rows = await query(
        `${source}-join-${run}`,
        `SELECT d.domain_id, count(*) AS n, sum(CAST(o.amount AS DECIMAL(18,2))*1.05) AS calculated FROM ${prefix}observations o JOIN ${prefix}datasets d USING(dataset_id) WHERE source_file_id=9 GROUP BY d.domain_id ORDER BY d.domain_id`,
      );
      assert.equal(rows.length, 20);
      assert.equal(rows[0].n, "35000");
      assert.equal(Number(rows[1].calculated), 18371692.5);
    }
  }
  await query("sqlite-detach", "DETACH compat");
  const sqlite = new DatabaseSync(sqlitePath);
  const indexStart = performance.now();
  try {
    sqlite.exec(
      "CREATE INDEX observations_source ON observations(source_file_id); CREATE INDEX datasets_id ON datasets(dataset_id)",
    );
  } finally {
    sqlite.close();
  }
  results.push({
    label: "sqlite-indexes",
    milliseconds: Math.round(performance.now() - indexStart),
  });
  await query("sqlite-reattach", `ATTACH '${escaped}' AS compat (TYPE SQLITE)`);
  for (const run of [1, 2]) {
    const rows = await query(
      `sqlite-indexed-join-${run}`,
      "SELECT d.domain_id, count(*) AS n, sum(CAST(o.amount AS DECIMAL(18,2))*1.05) AS calculated FROM compat.observations o JOIN compat.datasets d USING(dataset_id) WHERE source_file_id=9 GROUP BY d.domain_id ORDER BY d.domain_id",
    );
    assert.equal(rows.length, 20);
    assert.equal(rows[0].n, "35000");
    assert.equal(Number(rows[1].calculated), 18371692.5);
  }
  await query("sqlite-final-detach", "DETACH compat");
  results.push({
    sizes: {
      duckdb: (await stat(dbPath)).size,
      sqlite: (await stat(sqlitePath)).size,
    },
  });
} finally {
  await writeFile(
    join(output, "results.json"),
    JSON.stringify(results, null, 2) + "\n",
  );
  connection.closeSync();
  db.closeSync();
}
