import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { engineOf, inspectDatabase } from "../src/database.js";
import { createDatabase } from "../src/node.js";
import { applySchema, planSchema } from "../src/records.js";
import type { DatabaseSchema, TableSchema } from "../src/schema.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const parent: TableSchema = {
  name: "z_datasets",
  recordId: { prefix: "DS", padding: 4 },
  columns: [{ name: "name", type: "text" }],
};
const child: TableSchema = {
  name: "a_attributes",
  recordId: { prefix: "AT", padding: 4 },
  columns: [
    { name: "dataset_id", type: "text" },
    { name: "domain_id", type: "text" },
  ],
  foreignKeys: [
    { column: "dataset_id", referencesTable: parent.name },
    { column: "domain_id", referencesTable: "domains" },
  ],
};
const domain: TableSchema = {
  name: "domains",
  recordId: { prefix: "DM", padding: 4 },
  columns: [{ name: "name", type: "text" }],
};
const schema: DatabaseSchema = { version: 1, tables: [child, parent, domain] };

for (const format of ["sqlite", "duckdb"] as const) {
  test(`${format}: multiple declared foreign keys are enforced regardless of schema order`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cc-schema-test-"));
    directories.push(directory);
    const { database } = await createDatabase({
      path: path.join(directory, `db.${format}`),
      format,
      schema,
    });
    try {
      const engine = engineOf(database);
      await engine.execute(
        "INSERT INTO z_datasets (record_id, name) VALUES ('DS-0001', 'Synthetic dataset')",
      );
      await engine.execute(
        "INSERT INTO domains (record_id, name) VALUES ('DM-0001', 'Synthetic domain')",
      );
      await engine.execute(
        "INSERT INTO a_attributes (record_id, dataset_id, domain_id) VALUES ('AT-0001', 'DS-0001', 'DM-0001')",
      );
      await expect(
        engine.execute(
          "INSERT INTO a_attributes (record_id, dataset_id, domain_id) VALUES ('AT-0002', 'DS-9999', 'DM-0001')",
        ),
      ).rejects.toThrow();
      await expect(
        engine.execute(
          "INSERT INTO a_attributes (record_id, dataset_id, domain_id) VALUES ('AT-0003', 'DS-0001', 'DM-9999')",
        ),
      ).rejects.toThrow();
      expect(
        (await inspectDatabase({ database })).tables.find(
          (table) => table.name === child.name,
        )?.rowCount,
      ).toBe(1n);
    } finally {
      await database.close();
    }
  });

  test(`${format}: relationship changes are review conflicts and external DDL invalidates a schema plan`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cc-schema-test-"));
    directories.push(directory);
    const { database } = await createDatabase({
      path: path.join(directory, `db.${format}`),
      format,
      schema,
    });
    try {
      const changed = await planSchema({
        database,
        schema: { version: 1, tables: [{ ...child, foreignKeys: [] }] },
      });
      expect(changed.state).toBe("needs-review");
      expect(changed.conflicts).toEqual([
        expect.objectContaining({
          kind: "table-definition",
          property: "relationships",
        }),
      ]);
      await expect(
        applySchema({ database, plan: changed }),
      ).rejects.toMatchObject({ code: "DB_SCHEMA_NEEDS_REVIEW" });
      const plan = await planSchema({
        database,
        schema: {
          version: 1,
          tables: [
            {
              ...parent,
              columns: [...parent.columns, { name: "planned", type: "text" }],
            },
          ],
        },
      });
      await engineOf(database).execute(
        "ALTER TABLE z_datasets ADD COLUMN external_change VARCHAR",
      );
      await expect(applySchema({ database, plan })).rejects.toMatchObject({
        code: "DB_STALE_SCHEMA_PLAN",
      });
      const columns = await engineOf(database).query(
        "SELECT name FROM pragma_table_info('z_datasets')",
      );
      expect(columns.map((row) => row["name"])).not.toContain("planned");
    } finally {
      await database.close();
    }
  });
}

test("invalid relationships and duplicate or reserved definitions fail before publication", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cc-schema-test-"));
  directories.push(directory);
  const invalid: readonly DatabaseSchema[] = [
    {
      version: 1,
      tables: [
        { ...child, columns: [{ name: "dataset_id", type: "integer" }] },
      ],
    },
    { version: 1, tables: [child] },
    { version: 1, tables: [parent, { ...parent, name: "Z_DATASETS" }] },
    {
      version: 1,
      tables: [{ ...parent, columns: [{ name: "_import_id", type: "text" }] }],
    },
    {
      version: 1,
      tables: [
        {
          ...parent,
          columns: [{ name: "parent_id", type: "text" }],
          foreignKeys: [{ column: "parent_id", referencesTable: parent.name }],
        },
      ],
    },
  ];
  for (const [index, value] of invalid.entries()) {
    const output = path.join(directory, `invalid-${index}.duckdb`);
    await expect(
      createDatabase({ path: output, format: "duckdb", schema: value }),
    ).rejects.toThrow();
    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  }
});
