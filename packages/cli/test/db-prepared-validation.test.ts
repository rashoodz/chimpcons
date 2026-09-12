import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, expect, test } from "vitest";
import Sqlite from "better-sqlite3";

import { createDatabase, createPreparedImport } from "@consultchimps/db/node";

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

test.each([
  "_consultchimps_prepared_captures",
  "_consultchimps_prepared_bindings",
])("db inspect reports a damaged plan missing %s", async (missingTable) => {
  const directory = await mkdtemp(path.join(tmpdir(), "cc-cli-plan-damage-"));
  directories.push(directory);
  const databasePath = path.join(directory, "workspace.sqlite");
  const planPath = path.join(directory, "private-review.ccplan");
  const { database } = await createDatabase({
    path: databasePath,
    format: "sqlite",
  });
  const plan = await createPreparedImport({
    path: planPath,
    database,
    recipe: { version: 1, routes: [] },
    baselineRevision: 0n,
  });
  const planId = plan.id;
  await plan.close();
  await database.close();
  const sqlite = new Sqlite(planPath);
  sqlite.exec(`DROP TABLE ${missingTable}`);
  sqlite.close();

  const jsonFailure = await runFailure(["--json", "db", "inspect", planPath]);
  const expectedJson = {
    ok: false,
    error: {
      code: "DB_INVALID_PREPARED_IMPORT",
      message:
        "This import plan is incomplete or damaged. Prepare the workbook again or restore a verified plan copy.",
    },
  };
  expect(JSON.parse(jsonFailure.stdout)).toEqual(expectedJson);
  expect(JSON.parse(jsonFailure.stderr)).toEqual(expectedJson);

  const humanFailure = await runFailure(["db", "inspect", planPath]);
  expect(humanFailure.stdout).toBe("");
  expect(humanFailure.stderr).toContain(expectedJson.error.message);
  expect(humanFailure.stderr).toContain("DB_INVALID_PREPARED_IMPORT");

  for (const output of [
    jsonFailure.stdout,
    jsonFailure.stderr,
    humanFailure.stderr,
  ]) {
    expect(output).not.toContain(planPath);
    expect(output).not.toContain(path.basename(planPath));
    expect(output).not.toContain(planId);
    expect(output).not.toContain(missingTable);
    expect(output).not.toContain("no such table");
    expect(output).not.toContain("SQLITE_ERROR");
  }
});
