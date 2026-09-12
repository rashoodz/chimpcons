import { copyFile, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, expect, test } from "vitest";

import { engineOf, inspectDatabase } from "../src/database.js";
import { NodeDuckDbEngine } from "../src/engines/duckdb/node.js";
import { NodeSqliteEngine } from "../src/engines/sqlite/node.js";
import type { DatabaseEngine } from "../src/internal/engine.js";
import {
  APPLICATION_TABLE,
  CAPTURE_ROW_TABLE,
  CAPTURE_TABLE,
  COUNTERS_TABLE,
  DATABASE_METADATA_TABLE,
  DELIVERY_MEMBERSHIP_TABLE,
  DELIVERY_TABLE,
  IMPORT_REQUEST_TABLE,
  PLAN_TABLE,
  SOURCE_CONTENT_TABLE,
  SOURCE_FILE_TABLE,
  SOURCE_NAME_TABLE,
  TABLE_REGISTRY_TABLE,
} from "../src/metadata.js";
import { createDatabase, openDatabase } from "../src/node.js";
import type { DatabaseFormat } from "../src/schema.js";

const directories: string[] = [];
let templateDirectory: string;
let templates: Record<DatabaseFormat, string>;

const requiredTables = [
  DATABASE_METADATA_TABLE,
  TABLE_REGISTRY_TABLE,
  COUNTERS_TABLE,
  SOURCE_CONTENT_TABLE,
  SOURCE_FILE_TABLE,
  SOURCE_NAME_TABLE,
  CAPTURE_TABLE,
  PLAN_TABLE,
  CAPTURE_ROW_TABLE,
  APPLICATION_TABLE,
  IMPORT_REQUEST_TABLE,
  DELIVERY_TABLE,
  DELIVERY_MEMBERSHIP_TABLE,
] as const;

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

beforeAll(async () => {
  templateDirectory = await mkdtemp(path.join(tmpdir(), "cc-db-templates-"));
  templates = {
    sqlite: await createTemplate(templateDirectory, "sqlite"),
    duckdb: await createTemplate(templateDirectory, "duckdb"),
  };
});

afterAll(async () => {
  await rm(templateDirectory, { recursive: true, force: true });
});

async function openEngine(
  filePath: string,
  format: DatabaseFormat,
): Promise<DatabaseEngine> {
  return format === "sqlite"
    ? NodeSqliteEngine.open(filePath)
    : NodeDuckDbEngine.create(filePath);
}

async function createTemplate(
  directory: string,
  format: DatabaseFormat,
): Promise<string> {
  const filePath = path.join(directory, `template.${format}`);
  const { database } = await createDatabase({ path: filePath, format });
  await engineOf(database).execute("CREATE TABLE sentinel (value VARCHAR)");
  await engineOf(database).execute("INSERT INTO sentinel VALUES (?)", [
    "preserved",
  ]);
  await database.checkpoint();
  await database.close();
  return filePath;
}

async function expectSentinel(filePath: string, format: DatabaseFormat) {
  const engine = await openEngine(filePath, format);
  try {
    await expect(engine.query("SELECT value FROM sentinel")).resolves.toEqual([
      { value: "preserved" },
    ]);
  } finally {
    await engine.close();
  }
}

const missingTableCases = (["sqlite", "duckdb"] as const).flatMap((format) =>
  ([false, true] as const).flatMap((readonly) =>
    requiredTables.map((table) => ({ format, readonly, table })),
  ),
);

test.each(missingTableCases)(
  "$format: readonly=$readonly rejects missing $table without changing data",
  async ({ format, readonly, table }) => {
    const directory = await mkdtemp(path.join(tmpdir(), "cc-db-layout-"));
    directories.push(directory);
    const damaged = path.join(directory, `missing.${format}`);
    await copyFile(templates[format], damaged);
    const engine = await openEngine(damaged, format);
    await engine.execute(`DROP TABLE ${table}`);
    await engine.close();
    const before = await readFile(damaged);

    await expect(
      openDatabase({ path: damaged, readonly }),
    ).rejects.toMatchObject({
      code:
        table === DATABASE_METADATA_TABLE
          ? "DB_NOT_A_DATABASE"
          : "DB_CORRUPT_DATABASE",
    });
    expect(await readFile(damaged)).toEqual(before);
    const moved = `${damaged}.moved`;
    await rename(damaged, moved);
    await rename(moved, damaged);
    await expectSentinel(damaged, format);
  },
);

for (const format of ["sqlite", "duckdb"] as const) {
  test(`${format}: rejects missing internal columns without changing data`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cc-db-columns-"));
    directories.push(directory);
    const damaged = path.join(directory, `missing-column.${format}`);
    await copyFile(templates[format], damaged);
    const engine = await openEngine(damaged, format);
    await engine.execute(
      `ALTER TABLE ${CAPTURE_TABLE} DROP COLUMN columns_json`,
    );
    await engine.close();
    const before = await readFile(damaged);

    await expect(
      openDatabase({ path: damaged, readonly: true }),
    ).rejects.toMatchObject({ code: "DB_CORRUPT_DATABASE" });
    expect(await readFile(damaged)).toEqual(before);
    await expectSentinel(damaged, format);
  });

  test(`${format}: leaves valid databases unaffected by inspection`, async () => {
    const template = templates[format];
    const validBefore = await readFile(template);
    const valid = await openDatabase({ path: template, readonly: true });
    expect(await inspectDatabase({ database: valid })).toMatchObject({
      format,
      revision: 0n,
      tables: [],
    });
    await expect(
      engineOf(valid).query("SELECT value FROM sentinel"),
    ).resolves.toEqual([{ value: "preserved" }]);
    await valid.close();
    expect(await readFile(template)).toEqual(validBefore);
  });

  test(`${format}: reports a future version before validating its changed layout`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cc-db-future-"));
    directories.push(directory);
    const filePath = path.join(directory, `future.${format}`);
    await copyFile(templates[format], filePath);
    const engine = await openEngine(filePath, format);
    await engine.execute(
      `UPDATE ${DATABASE_METADATA_TABLE} SET format_version = 2`,
    );
    await engine.execute(`DROP TABLE ${TABLE_REGISTRY_TABLE}`);
    await engine.close();
    const before = await readFile(filePath);

    await expect(
      openDatabase({ path: filePath, readonly: true }),
    ).rejects.toMatchObject({
      code: "DB_UNSUPPORTED_FORMAT_VERSION",
      details: { fileVersion: "2", supportedVersion: 1 },
    });
    expect(await readFile(filePath)).toEqual(before);
    await expectSentinel(filePath, format);
  });

  test(`${format}: rejects a view substituted for an internal table`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cc-db-view-"));
    directories.push(directory);
    const filePath = path.join(directory, `view.${format}`);
    await copyFile(templates[format], filePath);
    const engine = await openEngine(filePath, format);
    const movedCaptureTable = `${CAPTURE_TABLE}_damaged`;
    await engine.execute(
      `ALTER TABLE ${CAPTURE_TABLE} RENAME TO ${movedCaptureTable}`,
    );
    await engine.execute(
      `CREATE VIEW ${CAPTURE_TABLE} AS SELECT * FROM ${movedCaptureTable}`,
    );
    await engine.close();
    const before = await readFile(filePath);

    await expect(
      openDatabase({ path: filePath, readonly: true }),
    ).rejects.toMatchObject({
      code: "DB_CORRUPT_DATABASE",
      details: { missingTables: [CAPTURE_TABLE] },
    });
    expect(await readFile(filePath)).toEqual(before);
    await expectSentinel(filePath, format);
  });
}
