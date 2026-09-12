import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { executeConversion, planConversion } from "../src/conversion.js";
import { engineOf, type Database } from "../src/database.js";
import { NodeDuckDbEngine } from "../src/engines/duckdb/node.js";
import { createDatabase } from "../src/node.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "cc-temporal-convert-"));
  directories.push(directory);
  return directory;
}

test("DuckDB queries preserve temporal, decimal, and blob values", async () => {
  const directory = await temporaryDirectory();
  const engine = await NodeDuckDbEngine.create(
    path.join(directory, "values.duckdb"),
  );
  try {
    await engine.execute(
      "CREATE TABLE values_table (observed_on DATE, observed_at TIMESTAMP, amount DECIMAL(38,9), payload BLOB)",
    );
    await engine.bulkInsert({
      table: "values_table",
      columns: ["observed_on", "observed_at", "amount", "payload"],
      rows: [
        [
          "2024-01-02",
          "2024-01-02 03:04:05.123456",
          "12345678901234567890123456789.123456789",
          new Uint8Array([0, 127, 255]),
        ],
      ],
    });

    expect(
      await engine.query(
        "SELECT observed_on, observed_at, amount, payload FROM values_table",
      ),
    ).toEqual([
      {
        observed_on: "2024-01-02",
        observed_at: "2024-01-02 03:04:05.123456",
        amount: "12345678901234567890123456789.123456789",
        payload: new Uint8Array([0, 127, 255]),
      },
    ]);
  } finally {
    await engine.close();
  }
});

test("converts DuckDB dates and microsecond timestamps through SQLite and back", async () => {
  const directory = await temporaryDirectory();
  const schema = {
    version: 1 as const,
    tables: [
      {
        name: "observations",
        recordId: { prefix: "OBS", padding: 4 },
        columns: [
          { name: "observed_on", type: "date" as const, nullable: false },
          {
            name: "observed_at",
            type: "timestamp" as const,
            nullable: false,
          },
          {
            name: "amount",
            type: "decimal" as const,
            precision: 38,
            scale: 9,
            nullable: false,
          },
        ],
      },
    ],
  };
  const { database: duckdb } = await createDatabase({
    path: path.join(directory, "source.duckdb"),
    format: "duckdb",
    schema,
  });
  let sqlite: Database | undefined;
  let roundtrip: Database | undefined;
  try {
    const duckdbEngine = engineOf(duckdb);
    await duckdbEngine.execute(
      "INSERT INTO observations (record_id, _imported_row_id, observed_on, observed_at, amount) VALUES (?, ?, ?, ?, ?)",
      [
        "OBS-0001",
        1n,
        "2024-01-02",
        "2024-01-02 03:04:05.123456",
        "12345678901234567890123456789.123456789",
      ],
    );

    ({ database: sqlite } = await createDatabase({
      path: path.join(directory, "converted.sqlite"),
      format: "sqlite",
    }));
    const toSqlite = await planConversion({
      database: duckdb,
      format: "sqlite",
    });
    await executeConversion({ source: duckdb, target: sqlite, plan: toSqlite });
    expect(
      await engineOf(sqlite).query(
        "SELECT observed_on, observed_at, amount, typeof(observed_on) AS date_storage, typeof(observed_at) AS timestamp_storage FROM observations",
      ),
    ).toEqual([
      {
        observed_on: "2024-01-02",
        observed_at: "2024-01-02 03:04:05.123456",
        amount: "12345678901234567890123456789.123456789",
        date_storage: "text",
        timestamp_storage: "text",
      },
    ]);

    ({ database: roundtrip } = await createDatabase({
      path: path.join(directory, "roundtrip.duckdb"),
      format: "duckdb",
    }));
    const toDuckdb = await planConversion({
      database: sqlite,
      format: "duckdb",
    });
    await executeConversion({
      source: sqlite,
      target: roundtrip,
      plan: toDuckdb,
    });
    expect(
      await engineOf(roundtrip).query(
        "SELECT observed_on::VARCHAR AS observed_on, observed_at::VARCHAR AS observed_at, amount::VARCHAR AS amount, typeof(observed_on) AS date_storage, typeof(observed_at) AS timestamp_storage FROM observations",
      ),
    ).toEqual([
      {
        observed_on: "2024-01-02",
        observed_at: "2024-01-02 03:04:05.123456",
        amount: "12345678901234567890123456789.123456789",
        date_storage: "DATE",
        timestamp_storage: "TIMESTAMP",
      },
    ]);
  } finally {
    await Promise.all([duckdb.close(), sqlite?.close(), roundtrip?.close()]);
  }
});
