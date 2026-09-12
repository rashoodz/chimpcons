import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, expect, test } from "vitest";

import { engineOf, inspectDatabase } from "../src/database.js";
import { NodeDuckDbEngine } from "../src/engines/duckdb/node.js";
import { NodeSqliteEngine } from "../src/engines/sqlite/node.js";
import type { DatabaseEngine } from "../src/internal/engine.js";
import {
  COUNTERS_TABLE,
  DATABASE_METADATA_TABLE,
  TABLE_REGISTRY_TABLE,
} from "../src/metadata.js";
import { createDatabase, openDatabase } from "../src/node.js";
import { applySchema, planSchema } from "../src/records.js";
import type { DatabaseFormat, DatabaseSchema } from "../src/schema.js";

const directories: string[] = [];
let templateDirectory: string;
let templates: Record<DatabaseFormat, string>;

beforeAll(async () => {
  templateDirectory = await mkdtemp(
    path.join(tmpdir(), "cc-registered-template-"),
  );
  templates = {
    sqlite: await createTemplate(templateDirectory, "sqlite"),
    duckdb: await createTemplate(templateDirectory, "duckdb"),
  };
});

afterAll(async () => {
  await rm(templateDirectory, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const schema: DatabaseSchema = {
  version: 1,
  tables: [
    {
      name: "inventory",
      recordId: { prefix: "INV", padding: 4 },
      columns: [{ name: "label", type: "text" }],
    },
  ],
};

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
  const { database } = await createDatabase({ path: filePath, format, schema });
  await engineOf(database).execute(
    "INSERT INTO inventory (record_id, label) VALUES ('INV-0001', 'Synthetic')",
  );
  await database.checkpoint();
  await database.close();
  return filePath;
}

async function workspace(format: DatabaseFormat): Promise<{
  readonly directory: string;
  readonly filePath: string;
}> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cc-registered-storage-"),
  );
  directories.push(directory);
  const filePath = path.join(directory, `template.${format}`);
  await copyFile(templates[format], filePath);
  return { directory, filePath };
}

async function damagedCopy(
  source: { readonly directory: string; readonly filePath: string },
  format: DatabaseFormat,
  suffix: string,
  mutate: (engine: DatabaseEngine) => Promise<void>,
): Promise<string> {
  const copy = path.join(source.directory, `${suffix}.${format}`);
  await copyFile(source.filePath, copy);
  const engine = await openEngine(copy, format);
  try {
    await mutate(engine);
  } finally {
    await engine.close();
  }
  return copy;
}

const scalarCorruptions = [
  {
    suffix: "blank-id",
    mutate: (engine: DatabaseEngine) =>
      engine.execute(`UPDATE ${DATABASE_METADATA_TABLE} SET database_id = ''`),
  },
  {
    suffix: "negative-revision",
    mutate: (engine: DatabaseEngine) =>
      engine.execute(`UPDATE ${DATABASE_METADATA_TABLE} SET revision = -1`),
  },
  {
    suffix: "zero-counter",
    mutate: (engine: DatabaseEngine) =>
      engine.execute(
        `UPDATE ${COUNTERS_TABLE} SET next_value = 0 WHERE counter_name = 'import'`,
      ),
  },
  {
    suffix: "zero-schema-version",
    mutate: (engine: DatabaseEngine) =>
      engine.execute(`UPDATE ${TABLE_REGISTRY_TABLE} SET schema_version = 0`),
  },
  {
    suffix: "zero-record-counter",
    mutate: (engine: DatabaseEngine) =>
      engine.execute(`UPDATE ${TABLE_REGISTRY_TABLE} SET next_record_id = 0`),
  },
] as const;

for (const format of ["sqlite", "duckdb"] as const) {
  test(`${format}: managed tables must retain their declared base table and columns`, async () => {
    const created = await workspace(format);
    const dropped = await damagedCopy(created, format, "dropped", (engine) =>
      engine.execute("DROP TABLE inventory"),
    );
    const droppedBytes = await readFile(dropped);
    await expect(
      openDatabase({ path: dropped, readonly: true }),
    ).rejects.toMatchObject({ code: "DB_SCHEMA_DRIFT" });
    expect(await readFile(dropped)).toEqual(droppedBytes);

    const missingColumn = await damagedCopy(
      created,
      format,
      "missing-column",
      (engine) => engine.execute("ALTER TABLE inventory DROP COLUMN label"),
    );
    const missingBytes = await readFile(missingColumn);
    await expect(openDatabase({ path: missingColumn })).rejects.toMatchObject({
      code: "DB_SCHEMA_DRIFT",
    });
    expect(await readFile(missingColumn)).toEqual(missingBytes);

    const extraColumn = await damagedCopy(
      created,
      format,
      "extra-column",
      (engine) =>
        engine.execute("ALTER TABLE inventory ADD COLUMN local_note VARCHAR"),
    );
    const opened = await openDatabase({ path: extraColumn, readonly: true });
    expect(
      (await inspectDatabase({ database: opened })).tables[0],
    ).toMatchObject({
      name: "inventory",
      rowCount: 1n,
    });
    await expect(
      planSchema({ database: opened, schema }),
    ).rejects.toMatchObject({ code: "DB_SCHEMA_DRIFT" });
    await opened.close();
  });

  test.each(scalarCorruptions)(
    `${format}: rejects $suffix without changing the database`,
    async (corruption) => {
      const created = await workspace(format);
      const filePath = await damagedCopy(
        created,
        format,
        corruption.suffix,
        corruption.mutate,
      );
      const before = await readFile(filePath);
      await expect(
        openDatabase({ path: filePath, readonly: true }),
      ).rejects.toMatchObject({ code: "DB_CORRUPT_DATABASE" });
      expect(await readFile(filePath)).toEqual(before);
    },
  );

  test(`${format}: a registry edit invalidates an approved schema plan before DDL`, async () => {
    const { filePath } = await workspace(format);
    const database = await openDatabase({ path: filePath });
    try {
      const plan = await planSchema({
        database,
        schema: {
          version: 1,
          tables: [
            {
              ...schema.tables[0]!,
              columns: [
                ...schema.tables[0]!.columns,
                { name: "planned", type: "text" },
              ],
            },
          ],
        },
      });
      const stored = JSON.stringify({
        ...schema.tables[0]!,
        recordId: { prefix: "ALTERED", padding: 4 },
      });
      await engineOf(database).execute(
        `UPDATE ${TABLE_REGISTRY_TABLE} SET schema_json = ? WHERE table_name = 'inventory'`,
        [stored],
      );

      await expect(applySchema({ database, plan })).rejects.toMatchObject({
        code: "DB_STALE_SCHEMA_PLAN",
      });
      const columns = await engineOf(database).query(
        "SELECT name FROM pragma_table_info('inventory')",
      );
      expect(columns.map((column) => column["name"])).not.toContain("planned");
      expect((await inspectDatabase({ database })).revision).toBe(1n);
    } finally {
      await database.close();
    }
  });
}
