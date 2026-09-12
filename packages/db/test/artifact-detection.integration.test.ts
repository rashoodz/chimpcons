import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { inspectDatabase } from "../src/database.js";
import { NodeDuckDbEngine } from "../src/engines/duckdb/node.js";
import { NodeSqliteEngine } from "../src/engines/sqlite/node.js";
import { inspectImport } from "../src/import/inspection.js";
import { DATABASE_METADATA_TABLE } from "../src/metadata.js";
import {
  createDatabase,
  createPreparedImport,
  inspectFileKind,
  openDatabase,
  openPreparedImport,
} from "../src/node.js";
import { PREPARED_METADATA_TABLE } from "../src/prepared.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("detects databases and renamed prepared imports by content", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cc-artifact-kind-"));
  directories.push(directory);
  const databasePath = path.join(directory, "workspace.data");
  const planPath = path.join(directory, "review.data");
  const { database } = await createDatabase({
    path: databasePath,
    format: "sqlite",
  });
  try {
    const inspection = await inspectDatabase({ database });
    const prepared = await createPreparedImport({
      path: planPath,
      database,
      recipe: { version: 1, routes: [] },
      baselineRevision: inspection.revision,
    });
    await prepared.close();
    await expect(
      inspectFileKind({ path: databasePath }),
    ).resolves.toMatchObject({
      kind: "database",
      format: "sqlite",
      databaseId: database.id,
    });
    await expect(inspectFileKind({ path: planPath })).resolves.toMatchObject({
      kind: "prepared-import",
      format: "sqlite",
      databaseId: database.id,
    });
  } finally {
    await database.close();
  }
});

test("describes unmanaged SQLite files without adopting them", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cc-artifact-invalid-"));
  directories.push(directory);
  const unmanagedPath = path.join(directory, "unmanaged.sqlite");
  const unmanaged = NodeSqliteEngine.create(unmanagedPath);
  await unmanaged.execute(
    "CREATE TABLE example (id INTEGER PRIMARY KEY, value VARCHAR NOT NULL, note TEXT)",
  );
  await unmanaged.close();
  const original = await readFile(unmanagedPath);
  await expect(
    openDatabase({ path: unmanagedPath, readonly: true }),
  ).rejects.toMatchObject({ code: "DB_NOT_A_DATABASE" });
  expect(await readFile(unmanagedPath)).toEqual(original);
  await expect(inspectFileKind({ path: unmanagedPath })).resolves.toEqual({
    kind: "unmanaged-database",
    format: "sqlite",
    tables: [
      {
        name: "example",
        columns: [
          { name: "id", storageType: "INTEGER", nullable: false },
          { name: "value", storageType: "VARCHAR", nullable: false },
          { name: "note", storageType: "TEXT", nullable: true },
        ],
      },
    ],
  });

  const reopened = NodeSqliteEngine.open(unmanagedPath, true);
  await expect(
    reopened.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '_consultchimps_%'",
    ),
  ).resolves.toEqual([]);
  await reopened.close();
});

test("describes unmanaged DuckDB files without adopting them", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cc-artifact-duckdb-"));
  directories.push(directory);
  const unmanagedPath = path.join(directory, "unmanaged.duckdb");
  const unmanaged = await NodeDuckDbEngine.create(unmanagedPath);
  await unmanaged.execute(
    "CREATE TABLE example (id INTEGER PRIMARY KEY, value VARCHAR NOT NULL, note VARCHAR)",
  );
  await unmanaged.close();
  const original = await readFile(unmanagedPath);
  await expect(
    openDatabase({ path: unmanagedPath, readonly: true }),
  ).rejects.toMatchObject({ code: "DB_NOT_A_DATABASE" });
  expect(await readFile(unmanagedPath)).toEqual(original);

  await expect(inspectFileKind({ path: unmanagedPath })).resolves.toEqual({
    kind: "unmanaged-database",
    format: "duckdb",
    tables: [
      {
        name: "example",
        columns: [
          { name: "id", storageType: "INTEGER", nullable: false },
          { name: "value", storageType: "VARCHAR", nullable: false },
          { name: "note", storageType: "VARCHAR", nullable: true },
        ],
      },
    ],
  });
});

test.each(["sqlite", "duckdb"] as const)(
  "does not disguise a corrupt %s metadata table as an unmanaged file",
  async (format) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "cc-artifact-corrupt-"),
    );
    directories.push(directory);
    const databasePath = path.join(directory, `corrupt.${format}`);
    const engine =
      format === "sqlite"
        ? NodeSqliteEngine.create(databasePath)
        : await NodeDuckDbEngine.create(databasePath);
    await engine.execute(
      `CREATE TABLE ${DATABASE_METADATA_TABLE} (unexpected VARCHAR)`,
    );
    await engine.close();
    const original = await readFile(databasePath);

    await expect(
      openDatabase({ path: databasePath, readonly: true }),
    ).rejects.not.toMatchObject({ code: "DB_NOT_A_DATABASE" });
    expect(await readFile(databasePath)).toEqual(original);
  },
);

test("rejects unsupported prepared versions", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cc-artifact-invalid-"));
  directories.push(directory);

  const databasePath = path.join(directory, "workspace.sqlite");
  const planPath = path.join(directory, "review.bin");
  const { database } = await createDatabase({
    path: databasePath,
    format: "sqlite",
  });
  try {
    const inspection = await inspectDatabase({ database });
    const prepared = await createPreparedImport({
      path: planPath,
      database,
      recipe: { version: 1, routes: [] },
      baselineRevision: inspection.revision,
    });
    await prepared.close();
  } finally {
    await database.close();
  }
  const corrupt = NodeSqliteEngine.open(planPath);
  await corrupt.execute(
    `UPDATE ${PREPARED_METADATA_TABLE} SET format_version = 2`,
  );
  await corrupt.close();
  await expect(openPreparedImport({ path: planPath })).rejects.toMatchObject({
    code: "DB_UNSUPPORTED_PREPARED_IMPORT_VERSION",
  });

  const invalidState = NodeSqliteEngine.open(planPath);
  await invalidState.execute(
    `UPDATE ${PREPARED_METADATA_TABLE} SET format_version = 1, state = 'unknown'`,
  );
  await invalidState.close();
  const statePlan = await openPreparedImport({ path: planPath });
  try {
    await expect(
      inspectImport({ prepared: statePlan, page: { limit: 1 } }),
    ).rejects.toMatchObject({ code: "DB_INVALID_PREPARED_IMPORT" });
  } finally {
    await statePlan.close();
  }

  const invalidJson = NodeSqliteEngine.open(planPath);
  await invalidJson.execute(
    `UPDATE ${PREPARED_METADATA_TABLE} SET state = 'needs-review', recipe_json = 'not-json'`,
  );
  await invalidJson.close();
  const jsonPlan = await openPreparedImport({ path: planPath });
  try {
    await expect(
      inspectImport({ prepared: jsonPlan, page: { limit: 1 } }),
    ).rejects.toMatchObject({ code: "DB_INVALID_PREPARED_IMPORT" });
  } finally {
    await jsonPlan.close();
  }
});
