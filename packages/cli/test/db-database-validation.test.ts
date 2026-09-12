import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { DuckDBInstance } from "@duckdb/node-api";
import Sqlite from "better-sqlite3";
import { afterEach, expect, test } from "vitest";

import { createDatabase } from "@consultchimps/db/node";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function runFailure(args: readonly string[]): Promise<{
  readonly stdout: string;
  readonly stderr: string;
}> {
  try {
    await execute(process.execPath, [cli, ...args], { encoding: "utf8" });
  } catch (error) {
    if (
      error instanceof Error &&
      "stdout" in error &&
      typeof error.stdout === "string" &&
      "stderr" in error &&
      typeof error.stderr === "string"
    ) {
      return { stdout: error.stdout, stderr: error.stderr };
    }
    throw error;
  }
  throw new Error("The command unexpectedly succeeded");
}

async function alterFixture(
  databasePath: string,
  format: "sqlite" | "duckdb",
  sql: string,
): Promise<void> {
  if (format === "sqlite") {
    const sqlite = new Sqlite(databasePath);
    try {
      sqlite.exec(sql);
    } finally {
      sqlite.close();
    }
  } else {
    const instance = await DuckDBInstance.create(databasePath);
    try {
      const connection = await instance.connect();
      try {
        await connection.run(sql);
      } finally {
        connection.closeSync();
      }
    } finally {
      instance.closeSync();
    }
  }
}

test.each(["sqlite", "duckdb"] as const)(
  "db inspect reports damaged %s managed metadata",
  async (format) => {
    const directory = await mkdtemp(path.join(tmpdir(), "cc-cli-db-damage-"));
    directories.push(directory);
    const databasePath = path.join(directory, `private-workspace.${format}`);
    const { database } = await createDatabase({ path: databasePath, format });
    await database.close();

    await alterFixture(
      databasePath,
      format,
      "DROP TABLE _consultchimps_captures",
    );

    const failure = await runFailure(["--json", "db", "inspect", databasePath]);
    const expected = {
      ok: false,
      error: {
        code: "DB_CORRUPT_DATABASE",
        message:
          "The database is incomplete or damaged. Restore a verified database copy before retrying.",
      },
    };
    expect(JSON.parse(failure.stdout)).toEqual(expected);
    expect(JSON.parse(failure.stderr)).toEqual(expected);
    expect(failure.stdout).not.toContain(databasePath);
    expect(failure.stderr).not.toContain(databasePath);
    expect(failure.stdout).not.toContain("_consultchimps_captures");
    expect(failure.stderr).not.toContain("_consultchimps_captures");
  },
);

test.each(["sqlite", "duckdb"] as const)(
  "db deliveries reports damaged %s history with a stable error",
  async (format) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "cc-cli-delivery-damage-"),
    );
    directories.push(directory);
    const databasePath = path.join(directory, `history.${format}`);
    const { database } = await createDatabase({ path: databasePath, format });
    await database.close();
    await alterFixture(
      databasePath,
      format,
      "INSERT INTO _consultchimps_delivery_events VALUES ('DEL-000001', 'synthetic-request', '{')",
    );

    const failure = await runFailure([
      "--json",
      "db",
      "deliveries",
      databasePath,
    ]);
    const expected = {
      ok: false,
      error: {
        code: "DB_CORRUPT_DATABASE",
        message:
          "The recorded delivery details are damaged. Restore a verified database copy before retrying.",
      },
    };
    expect(JSON.parse(failure.stdout)).toEqual(expected);
    expect(JSON.parse(failure.stderr)).toEqual(expected);
    expect(failure.stdout).not.toContain(databasePath);
    expect(failure.stderr).not.toContain("SyntaxError");
  },
);
