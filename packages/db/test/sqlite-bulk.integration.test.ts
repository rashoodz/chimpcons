import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { NodeSqliteEngine } from "../src/engines/sqlite/node.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("native SQLite bulk insertion preserves typed values across reopen", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cc-sqlite-bulk-"));
  directories.push(directory);
  const databasePath = path.join(directory, "typed.sqlite");
  const engine = NodeSqliteEngine.create(databasePath);
  await engine.execute(
    "CREATE TABLE typed_values (id INTEGER PRIMARY KEY, enabled INTEGER NOT NULL, payload BLOB NOT NULL, label TEXT NOT NULL, optional INTEGER)",
  );
  await engine.bulkInsert({
    table: "typed_values",
    columns: ["id", "enabled", "payload", "label", "optional"],
    rows: [
      [
        9_007_199_254_740_993n,
        true,
        new Uint8Array([0, 127, 255]),
        "first",
        null,
      ],
      [-9_007_199_254_740_993n, false, new Uint8Array([4, 5]), "second", 7n],
    ],
  });

  const expected = [
    {
      id: 9_007_199_254_740_993n,
      enabled: 1n,
      payload: new Uint8Array([0, 127, 255]),
      label: "first",
      optional: null,
    },
    {
      id: -9_007_199_254_740_993n,
      enabled: 0n,
      payload: new Uint8Array([4, 5]),
      label: "second",
      optional: 7n,
    },
  ];
  expect(
    await engine.query(
      "SELECT id, enabled, payload, label, optional FROM typed_values ORDER BY label",
    ),
  ).toEqual(expected);

  await expect(
    engine.transaction((transaction) =>
      transaction.bulkInsert({
        table: "typed_values",
        columns: ["id", "enabled", "payload", "label", "optional"],
        rows: [
          [3n, true, new Uint8Array([3]), "temporary", null],
          [3n, false, new Uint8Array([4]), "duplicate", null],
        ],
      }),
    ),
  ).rejects.toThrow();

  const controller = new AbortController();
  controller.abort("synthetic cancellation");
  await expect(
    engine.transaction((transaction) =>
      transaction.bulkInsert({
        table: "typed_values",
        columns: ["id", "enabled", "payload", "label", "optional"],
        rows: [[4n, true, new Uint8Array([4]), "cancelled", null]],
        signal: controller.signal,
      }),
    ),
  ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
  expect(
    await engine.query("SELECT count(*) AS count FROM typed_values"),
  ).toEqual([{ count: 2n }]);
  await engine.close();

  const reopened = NodeSqliteEngine.open(databasePath, true);
  try {
    expect(
      await reopened.query(
        "SELECT id, enabled, payload, label, optional FROM typed_values ORDER BY label",
      ),
    ).toEqual(expected);
  } finally {
    await reopened.close();
  }
});
