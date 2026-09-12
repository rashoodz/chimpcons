import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { clearInterval, setInterval } from "node:timers";

import { DuckDBInstance } from "@duckdb/node-api";

import {
  applyImport,
  createWorkbookImportSource,
  draftImportRecipe,
  inspectDatabase,
  prepareImport,
  resolveImport,
} from "../../packages/db/dist/index.js";
import {
  createDatabase,
  createPreparedImport,
  exportDatabase,
  openDatabase,
} from "../../packages/db/dist/node.js";
import {
  createScratchDirectory,
  openRandomAccessSource,
} from "../../packages/files/dist/index.js";

const ROW_COUNTS = process.argv.slice(2).map(Number);
const rowCounts = ROW_COUNTS.length === 0 ? [100_000, 1_000_000] : ROW_COUNTS;
for (const rowCount of rowCounts) {
  if (!Number.isSafeInteger(rowCount) || rowCount < 1) {
    throw new Error("Row counts must be positive safe integers");
  }
}

function elapsed(started) {
  return Math.round(performance.now() - started);
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function instrumentSource(source, measurements) {
  return {
    ...source,
    bytes: {
      ...source.bytes,
      async readAt(offset, length, signal) {
        const started = performance.now();
        try {
          const bytes = await source.bytes.readAt(offset, length, signal);
          measurements.bytesRead += bytes.length;
          measurements.readCalls += 1;
          return bytes;
        } finally {
          measurements.sourceReadMilliseconds += performance.now() - started;
        }
      },
    },
    selections: source.selections.map((selection) => ({
      ...selection,
      async open(options) {
        const reader = await selection.open(options);
        return {
          ...reader,
          async *batches(batchOptions) {
            const batches = reader.batches(batchOptions);
            const iterator = batches[Symbol.asyncIterator]();
            try {
              while (true) {
                const started = performance.now();
                const next = await iterator.next();
                measurements.parseMilliseconds += performance.now() - started;
                if (next.done) break;
                measurements.rowsParsed += next.value.length;
                yield next.value;
              }
            } finally {
              await iterator.return?.();
            }
          },
        };
      },
    })),
  };
}

function startMemoryMonitor() {
  const phases = new Map();
  let phase = "setup";
  function sample() {
    const current = process.memoryUsage();
    const previous = phases.get(phase) ?? {
      rss: 0,
      heapUsed: 0,
      external: 0,
    };
    phases.set(phase, {
      rss: Math.max(previous.rss, current.rss),
      heapUsed: Math.max(previous.heapUsed, current.heapUsed),
      external: Math.max(previous.external, current.external),
    });
  }
  const interval = setInterval(sample, 20);
  interval.unref();
  sample();
  return {
    phase(name) {
      phase = name;
      sample();
    },
    stop() {
      sample();
      clearInterval(interval);
      return Object.fromEntries(phases);
    },
  };
}

async function timedQuery(connection, sql) {
  const started = performance.now();
  const rows = (await connection.runAndReadAll(sql)).getRowObjectsJson();
  return { milliseconds: elapsed(started), rows };
}

async function planOperators(connection, sql) {
  const rows = (
    await connection.runAndReadAll(`EXPLAIN ${sql}`)
  ).getRowObjectsJson();
  const plan = rows.map((row) => row.explain_value ?? "").join("\n");
  return [
    "COLUMN_DATA_SCAN",
    "TABLE_SCAN",
    "SEQ_SCAN",
    "FILTER",
    "HASH_GROUP_BY",
    "PERFECT_HASH_GROUP_BY",
    "HASH_JOIN",
  ].filter((operator) => plan.includes(operator));
}

async function run(rowCount) {
  const fixture = join("dist", `attributes-${rowCount}.xlsx`);
  const sourceStat = await stat(fixture);
  const workspace = await mkdtemp(join(tmpdir(), "cc-pipeline-benchmark-"));
  const targetPath = join(workspace, "observations.duckdb");
  const preparedPath = join(workspace, "review.ccplan");
  const replayPreparedPath = join(workspace, "replay.ccplan");
  const convertedPath = join(workspace, "observations.sqlite");
  const monitor = startMemoryMonitor();
  const measurements = {
    bytesRead: 0,
    readCalls: 0,
    sourceReadMilliseconds: 0,
    parseMilliseconds: 0,
    rowsParsed: 0,
  };
  let database;
  let prepared;
  let replayPrepared;
  let converted;
  let randomSource;
  let scratch;
  let workbook;
  try {
    randomSource = await openRandomAccessSource(fixture);
    scratch = await createScratchDirectory(workspace);
    monitor.phase("inspect");
    const inspectStarted = performance.now();
    workbook = await createWorkbookImportSource({
      key: `attributes_${rowCount}`,
      bytes: randomSource,
      scratch,
      selection: { sheet: "Sheet1", headerRow: 1 },
      verifyUnchanged: randomSource.verifyUnchanged,
    });
    const inspectMilliseconds = elapsed(inspectStarted);
    const source = instrumentSource(workbook.source, measurements);
    const recipe = await draftImportRecipe({ sources: [source] });
    const created = await createDatabase({
      path: targetPath,
      format: "duckdb",
    });
    database = created.database;
    const before = await inspectDatabase({ database });
    prepared = await createPreparedImport({
      path: preparedPath,
      database,
      recipe,
      baselineRevision: before.revision,
      protectedInputPaths: [fixture],
    });

    monitor.phase("prepare");
    const prepareStarted = performance.now();
    const captured = await prepareImport({
      database,
      prepared,
      sources: [source],
      recipe,
    });
    const prepareMilliseconds = elapsed(prepareStarted);
    assert.equal(captured.result.metrics.rowsCaptured, rowCount);
    const preparedBytes = (await stat(preparedPath)).size;

    monitor.phase("resolve");
    const resolveStarted = performance.now();
    const approved = await resolveImport({
      database,
      prepared,
      decisions: [],
    });
    const resolveMilliseconds = elapsed(resolveStarted);
    assert.equal(approved.state, "ready");
    if (approved.state !== "ready") throw new Error("Import did not resolve");

    monitor.phase("apply");
    const applyStarted = performance.now();
    const applied = await applyImport({
      database,
      prepared,
      approved,
      requestId: `pipeline-${rowCount}`,
    });
    const applyMilliseconds = elapsed(applyStarted);
    assert.equal(applied.metrics.rowsImported, rowCount);
    await database.checkpoint();
    const inspection = await inspectDatabase({ database });
    assert.equal(inspection.tables[0]?.rowCount, BigInt(rowCount));
    const table = inspection.tables[0]?.name;
    assert.ok(table);
    const targetBytes = (await stat(targetPath)).size;
    await prepared.close();
    prepared = undefined;

    const replaySource = {
      ...workbook.source,
      key: `attributes_${rowCount}_replay`,
    };
    const replayRecipe = await draftImportRecipe({
      sources: [replaySource],
      into: `${table}_replay`,
    });
    const replayBaseline = await inspectDatabase({ database });
    replayPrepared = await createPreparedImport({
      path: replayPreparedPath,
      database,
      recipe: replayRecipe,
      baselineRevision: replayBaseline.revision,
      protectedInputPaths: [fixture],
    });
    monitor.phase("replay");
    const replayPrepareStarted = performance.now();
    const replayCaptured = await prepareImport({
      database,
      prepared: replayPrepared,
      sources: [replaySource],
      recipe: replayRecipe,
    });
    const replayPrepareMilliseconds = elapsed(replayPrepareStarted);
    assert.equal(replayCaptured.result.metrics.rowsCaptured, 0);
    assert.equal(replayCaptured.result.metrics.sourcesReused, 1);
    const replayApproved = await resolveImport({
      database,
      prepared: replayPrepared,
      decisions: [],
    });
    assert.equal(replayApproved.state, "ready");
    if (replayApproved.state !== "ready") {
      throw new Error("Replay import did not resolve");
    }
    const replayApplyStarted = performance.now();
    const replayApplied = await applyImport({
      database,
      prepared: replayPrepared,
      approved: replayApproved,
      requestId: `pipeline-${rowCount}-replay`,
    });
    const replayApplyMilliseconds = elapsed(replayApplyStarted);
    assert.equal(replayApplied.metrics.rowsImported, rowCount);
    await database.checkpoint();
    const replayInspection = await inspectDatabase({ database });
    assert.deepEqual(
      replayInspection.tables.map((entry) => entry.rowCount),
      [BigInt(rowCount), BigInt(rowCount)],
    );
    const replayTargetBytes = (await stat(targetPath)).size;
    await replayPrepared.close();
    replayPrepared = undefined;

    monitor.phase("conversion");
    const conversionStarted = performance.now();
    const conversion = await exportDatabase({
      database,
      output: convertedPath,
      format: "sqlite",
      protectedInputPaths: [fixture, preparedPath, replayPreparedPath],
    });
    const conversionMilliseconds = elapsed(conversionStarted);
    assert.equal(conversion.metrics.rowsConverted, rowCount * 2);
    const convertedBytes = (await stat(convertedPath)).size;
    converted = await openDatabase({ path: convertedPath, readonly: true });
    const convertedInspection = await inspectDatabase({ database: converted });
    assert.deepEqual(
      convertedInspection.tables.map((entry) => entry.rowCount),
      [BigInt(rowCount), BigInt(rowCount)],
    );
    await converted.close();
    converted = undefined;

    await database.close();
    database = undefined;

    monitor.phase("queries");
    const instance = await DuckDBInstance.create(targetPath);
    const connection = await instance.connect();
    let queries;
    let storage;
    try {
      const quotedTable = quoteIdentifier(table);
      const count = await timedQuery(
        connection,
        `SELECT count(*) AS rows FROM ${quotedTable}`,
      );
      const grouped = await timedQuery(
        connection,
        `SELECT is_cde, count(*) AS rows FROM ${quotedTable} GROUP BY is_cde ORDER BY is_cde`,
      );
      await connection.run(
        `CREATE TEMP TABLE synthetic_datasets AS SELECT DISTINCT dataset_id, dataset_id % 20 AS domain_id FROM ${quotedTable}`,
      );
      const joined = await timedQuery(
        connection,
        `SELECT d.domain_id, count(*) AS rows FROM ${quotedTable} o JOIN synthetic_datasets d USING (dataset_id) WHERE o.is_cde GROUP BY d.domain_id ORDER BY d.domain_id`,
      );
      const plans = {
        grouped: await planOperators(
          connection,
          `SELECT is_cde, count(*) AS rows FROM ${quotedTable} GROUP BY is_cde`,
        ),
        joined: await planOperators(
          connection,
          `SELECT d.domain_id, count(*) AS rows FROM ${quotedTable} o JOIN synthetic_datasets d USING (dataset_id) WHERE o.is_cde GROUP BY d.domain_id`,
        ),
      };
      storage = (
        await connection.runAndReadAll(
          "SELECT database_size, block_size, total_blocks, used_blocks, free_blocks FROM pragma_database_size()",
        )
      ).getRowObjectsJson()[0];
      const memory = (
        await connection.runAndReadAll(
          "SELECT tag, memory_usage_bytes, temporary_storage_bytes FROM duckdb_memory() WHERE memory_usage_bytes > 0 OR temporary_storage_bytes > 0 ORDER BY tag",
        )
      ).getRowObjectsJson();
      const constraints = (
        await connection.runAndReadAll(
          "SELECT table_name, constraint_type, constraint_text FROM duckdb_constraints() WHERE schema_name = 'main' AND constraint_type IN ('PRIMARY KEY', 'UNIQUE') ORDER BY table_name, constraint_index",
        )
      ).getRowObjectsJson();
      const indexes = (
        await connection.runAndReadAll(
          "SELECT table_name, index_name, is_primary, is_unique FROM duckdb_indexes() ORDER BY table_name, index_name",
        )
      ).getRowObjectsJson();
      queries = { count, grouped, joined, plans };
      storage = { ...storage, memory, constraints, indexes };
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
    assert.equal(queries.count.rows[0].rows, String(rowCount));
    assert.equal(
      queries.grouped.rows.reduce((sum, row) => sum + Number(row.rows), 0),
      rowCount,
    );

    return {
      rowCount,
      sourceBytes: sourceStat.size,
      preparedBytes,
      targetBytes,
      inspectMilliseconds,
      prepareMilliseconds,
      parseMilliseconds: Math.round(measurements.parseMilliseconds),
      captureOverheadMilliseconds: Math.max(
        0,
        Math.round(prepareMilliseconds - measurements.parseMilliseconds),
      ),
      resolveMilliseconds,
      applyMilliseconds,
      replay: {
        prepareMilliseconds: replayPrepareMilliseconds,
        applyMilliseconds: replayApplyMilliseconds,
        targetBytes: replayTargetBytes,
      },
      conversion: {
        milliseconds: conversionMilliseconds,
        rows: conversion.metrics.rowsConverted,
        bytes: convertedBytes,
      },
      throughput: {
        prepareRowsPerSecond: Math.round(
          (rowCount * 1000) / prepareMilliseconds,
        ),
        parseRowsPerSecond: Math.round(
          (rowCount * 1000) / measurements.parseMilliseconds,
        ),
        applyRowsPerSecond: Math.round((rowCount * 1000) / applyMilliseconds),
      },
      sourceReads: {
        calls: measurements.readCalls,
        bytes: measurements.bytesRead,
        milliseconds: Math.round(measurements.sourceReadMilliseconds),
      },
      storage,
      queries,
      memory: monitor.stop(),
    };
  } finally {
    await workbook?.close().catch(() => undefined);
    await randomSource?.close().catch(() => undefined);
    await scratch?.close().catch(() => undefined);
    await prepared?.close().catch(() => undefined);
    await replayPrepared?.close().catch(() => undefined);
    await converted?.close().catch(() => undefined);
    await database?.close().catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
  }
}

const results = [];
for (const rowCount of rowCounts) {
  const result = await run(rowCount);
  results.push(result);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
const resultPath = join("results", "pipeline.json");
let previous = [];
try {
  const stored = JSON.parse(await readFile(resultPath, "utf8"));
  if (Array.isArray(stored.results)) {
    previous = stored.results.map((result) => ({
      ...result,
      storage: {
        ...result.storage,
        constraints: result.storage.constraints.filter((constraint) =>
          ["PRIMARY KEY", "UNIQUE"].includes(constraint.constraint_type),
        ),
      },
    }));
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const merged = new Map(previous.map((result) => [result.rowCount, result]));
for (const result of results) merged.set(result.rowCount, result);
await writeFile(
  resultPath,
  `${JSON.stringify(
    {
      environment: {
        node: process.version,
        duckdbNodeApi: "1.5.5-r.4",
      },
      results: [...merged.values()].sort(
        (left, right) => left.rowCount - right.rowCount,
      ),
    },
    null,
    2,
  )}\n`,
);
