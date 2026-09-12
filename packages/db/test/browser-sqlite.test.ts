import { beforeAll, describe, expect, test } from "vitest";
import sqlite3InitModule, { type Sqlite3Static } from "@sqlite.org/sqlite-wasm";

import { BrowserSqliteEngine } from "../src/engines/sqlite/browser.js";

let sqlite: Sqlite3Static;

beforeAll(async () => {
  sqlite = await sqlite3InitModule();
});

function createEngine(): BrowserSqliteEngine {
  return new BrowserSqliteEngine(sqlite, new sqlite.oo1.DB(":memory:"));
}

describe("browser SQLite engine", () => {
  test("preserves large integers and blobs through prepared batches", async () => {
    const engine = createEngine();
    try {
      await engine.execute(
        "CREATE TABLE values_table (id INTEGER, payload BLOB, label TEXT)",
      );
      await engine.bulkInsert({
        table: "values_table",
        columns: ["id", "payload", "label"],
        rows: [
          [9_007_199_254_740_993n, new Uint8Array([0, 127, 255]), "first"],
          [-9_007_199_254_740_993n, new Uint8Array([4, 5]), "second"],
        ],
      });

      const rows = await engine.query(
        "SELECT id, payload, label FROM values_table ORDER BY label",
      );
      expect(rows).toEqual([
        {
          id: 9_007_199_254_740_993n,
          payload: new Uint8Array([0, 127, 255]),
          label: "first",
        },
        {
          id: -9_007_199_254_740_993n,
          payload: new Uint8Array([4, 5]),
          label: "second",
        },
      ]);
    } finally {
      await engine.close();
    }
  });

  test("rolls back a failed transaction", async () => {
    const engine = createEngine();
    try {
      await engine.execute("CREATE TABLE events (value TEXT NOT NULL)");
      await expect(
        engine.transaction(async (transaction) => {
          await transaction.execute("INSERT INTO events (value) VALUES (?)", [
            "temporary",
          ]);
          throw new Error("stop");
        }),
      ).rejects.toThrow("stop");
      expect(
        await engine.query("SELECT count(*) AS count FROM events"),
      ).toEqual([{ count: 0 }]);
    } finally {
      await engine.close();
    }
  });

  test("yields to cancellation and rolls back a bounded batch", async () => {
    const engine = createEngine();
    const controller = new AbortController();
    try {
      await engine.execute("CREATE TABLE observations (value INTEGER)");
      const inserting = engine.transaction((transaction) =>
        transaction.bulkInsert({
          table: "observations",
          columns: ["value"],
          rows: Array.from({ length: 2_000 }, (_, value) => [value]),
          signal: controller.signal,
        }),
      );
      globalThis.setTimeout(() => controller.abort(), 0);

      await expect(inserting).rejects.toMatchObject({
        code: "OPERATION_ABORTED",
      });
      expect(
        await engine.query("SELECT count(*) AS count FROM observations"),
      ).toEqual([{ count: 0 }]);
    } finally {
      await engine.close();
    }
  });

  test("serializes concurrent work and refuses work after close", async () => {
    const engine = createEngine();
    await engine.execute("CREATE TABLE ordered_values (value INTEGER)");
    const inserting = engine.bulkInsert({
      table: "ordered_values",
      columns: ["value"],
      rows: Array.from({ length: 1_000 }, (_, value) => [value]),
    });
    const counting = engine.query(
      "SELECT count(*) AS count FROM ordered_values",
    );
    await inserting;
    await expect(counting).resolves.toEqual([{ count: 1_000 }]);

    await engine.checkpoint();
    await engine.close();
    await expect(engine.execute("SELECT 1")).rejects.toThrow(
      "SQLite engine is closed",
    );
  });
});
