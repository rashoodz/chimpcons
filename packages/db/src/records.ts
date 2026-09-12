import {
  throwIfAborted,
  type OperationControlOptions,
  type OperationResult,
} from "@consultchimps/core";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import {
  engineOf,
  inspectDatabase,
  valueAsNonNegativeBigInt,
  type Database,
  type DatabaseId,
} from "./database.js";
import { databaseError } from "./errors.js";
import type { EngineTransaction } from "./internal/engine.js";
import {
  assertRegisteredStorage,
  parseStoredTableSchema,
  readRegisteredTables,
  storageType,
  validateRegisteredTables,
} from "./internal/database-layout.js";
import { DATABASE_METADATA_TABLE, TABLE_REGISTRY_TABLE } from "./metadata.js";
import {
  identifierKey,
  quoteIdentifier,
  validateTableSchema,
  type ColumnDefinition,
  type DatabaseSchema,
  type TableSchema,
} from "./schema.js";

export type SchemaConflict =
  | {
      readonly kind: "table-definition";
      readonly table: string;
      readonly property: "relationships" | "record-id" | "nullability";
      readonly message: string;
    }
  | {
      readonly kind: "column-type";
      readonly table: string;
      readonly column: string;
      readonly existing: ColumnDefinition;
      readonly proposed: ColumnDefinition;
    }
  | {
      readonly kind: "required-column";
      readonly table: string;
      readonly column: string;
    };

export interface AddColumnsPlan {
  readonly table: string;
  readonly columns: readonly ColumnDefinition[];
}

export interface SchemaPlan {
  readonly databaseId: DatabaseId;
  readonly baselineRevision: bigint;
  readonly schemaFingerprint: string;
  readonly creates: readonly TableSchema[];
  readonly adds: readonly AddColumnsPlan[];
  readonly conflicts: readonly SchemaConflict[];
  readonly state: "ready" | "needs-review";
}

function sameColumnType(
  existing: ColumnDefinition,
  proposed: ColumnDefinition,
): boolean {
  return (
    existing.type === proposed.type &&
    existing.precision === proposed.precision &&
    existing.scale === proposed.scale
  );
}

function recordIdKey(schema: TableSchema): string {
  return JSON.stringify([
    schema.recordId.prefix,
    schema.recordId.padding,
    schema.recordId.separator ?? "-",
  ]);
}

function relationshipKey(schema: TableSchema): string {
  return JSON.stringify(
    (schema.foreignKeys ?? [])
      .map((relationship) =>
        JSON.stringify([
          identifierKey(relationship.column),
          identifierKey(relationship.referencesTable),
        ]),
      )
      .sort(),
  );
}

export function sortTablesByReferences(
  tables: readonly TableSchema[],
): readonly TableSchema[] {
  const byName = new Map<string, TableSchema>();
  for (const table of tables) {
    validateTableSchema(table);
    const key = identifierKey(table.name);
    if (byName.has(key))
      throw databaseError(
        "DB_DUPLICATE_TABLE",
        "The schema declares the same table name more than once. Keep one definition for each table.",
        { table: table.name },
      );
    byName.set(key, table);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: TableSchema[] = [];
  const visit = (table: TableSchema): void => {
    const key = identifierKey(table.name);
    if (visited.has(key)) return;
    if (visiting.has(key))
      throw databaseError(
        "DB_SCHEMA_REFERENCE_CYCLE",
        "These table relationships form a cycle. Use an acyclic relationship schema for this import phase.",
        { table: table.name },
      );
    visiting.add(key);
    for (const reference of table.foreignKeys ?? []) {
      const target = byName.get(identifierKey(reference.referencesTable));
      if (target) visit(target);
    }
    visiting.delete(key);
    visited.add(key);
    ordered.push(table);
  };
  for (const table of tables) visit(table);
  return ordered;
}

export async function readSchemaFingerprint(
  transaction: EngineTransaction,
  format: Database["format"],
): Promise<string> {
  const rows = await transaction.query(
    format === "sqlite"
      ? "SELECT type, name, COALESCE(sql, '') AS definition FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
      : "SELECT 'table' AS type, schema_name || '.' || table_name AS name, sql AS definition FROM duckdb_tables() WHERE NOT internal AND NOT temporary AND database_name = current_database() UNION ALL SELECT 'index' AS type, schema_name || '.' || index_name AS name, sql AS definition FROM duckdb_indexes() WHERE NOT is_primary AND database_name = current_database() ORDER BY type, name",
  );
  const registered = await readRegisteredTables(transaction);
  const serialized = JSON.stringify({
    physical: rows.map((row) => [row["type"], row["name"], row["definition"]]),
    registered: registered.map(({ schema, schemaVersion }) => [
      schema.name,
      schemaVersion.toString(),
      schema,
    ]),
  });
  return bytesToHex(sha256(new TextEncoder().encode(serialized)));
}

export async function planSchema(options: {
  readonly database: Database;
  readonly schema: DatabaseSchema;
}): Promise<SchemaPlan> {
  const inspection = await inspectDatabase({ database: options.database });
  await assertRegisteredColumns(
    engineOf(options.database),
    options.database.format,
    inspection.tables.map((table) => table.schema),
  );
  const existingByName = new Map(
    inspection.tables.map((table) => [identifierKey(table.name), table.schema]),
  );
  const creates: TableSchema[] = [];
  const adds: AddColumnsPlan[] = [];
  const conflicts: SchemaConflict[] = [];
  const proposedTables = sortTablesByReferences(options.schema.tables);
  const knownNames = new Set([
    ...existingByName.keys(),
    ...proposedTables.map((table) => identifierKey(table.name)),
  ]);
  for (const table of proposedTables)
    for (const reference of table.foreignKeys ?? []) {
      if (!knownNames.has(identifierKey(reference.referencesTable)))
        throw databaseError(
          "DB_FOREIGN_TABLE_NOT_FOUND",
          "A relationship refers to a table that does not exist or appear in this schema. Add the referenced table first.",
          { table: table.name, referencesTable: reference.referencesTable },
        );
    }
  for (const proposed of proposedTables) {
    validateTableSchema(proposed);
    const existing = existingByName.get(identifierKey(proposed.name));
    if (existing === undefined) {
      creates.push(proposed);
      continue;
    }
    if (recordIdKey(existing) !== recordIdKey(proposed))
      conflicts.push({
        kind: "table-definition",
        table: existing.name,
        property: "record-id",
        message:
          "Changing the Record ID configuration of an existing table is not an additive schema operation.",
      });
    if (relationshipKey(existing) !== relationshipKey(proposed))
      conflicts.push({
        kind: "table-definition",
        table: existing.name,
        property: "relationships",
        message:
          "Changing existing relationships requires a separate migration; this operation only creates tables and adds nullable columns.",
      });
    const existingColumns = new Map(
      existing.columns.map((column) => [identifierKey(column.name), column]),
    );
    const added: ColumnDefinition[] = [];
    for (const column of proposed.columns) {
      const current = existingColumns.get(identifierKey(column.name));
      if (current === undefined) {
        if (column.nullable === false) {
          conflicts.push({
            kind: "required-column",
            table: existing.name,
            column: column.name,
          });
        } else {
          added.push(column);
        }
      } else if (!sameColumnType(current, column)) {
        conflicts.push({
          kind: "column-type",
          table: existing.name,
          column: current.name,
          existing: current,
          proposed: column,
        });
      } else if ((current.nullable !== false) !== (column.nullable !== false)) {
        conflicts.push({
          kind: "table-definition",
          table: existing.name,
          property: "nullability",
          message: `Changing whether "${current.name}" permits blank values requires a separate migration.`,
        });
      }
    }
    if (added.length > 0) adds.push({ table: existing.name, columns: added });
  }
  return {
    databaseId: options.database.id,
    baselineRevision: inspection.revision,
    schemaFingerprint: await readSchemaFingerprint(
      engineOf(options.database),
      options.database.format,
    ),
    creates,
    adds,
    conflicts,
    state: conflicts.length === 0 ? "ready" : "needs-review",
  };
}

export async function assertRegisteredColumns(
  transaction: EngineTransaction,
  format: Database["format"],
  tables: readonly TableSchema[],
): Promise<void> {
  await assertRegisteredStorage(transaction, format, tables);
  for (const table of tables) {
    await assertRegisteredConstraints(transaction, format, table.name);
    const relationships = await transaction.query(
      format === "sqlite"
        ? 'SELECT "from" AS column_name, "table" AS target_table, "to" AS target_column, on_update, on_delete, match FROM pragma_foreign_key_list(?)'
        : "SELECT constraint_column_names[1] AS column_name, referenced_table AS target_table, referenced_column_names[1] AS target_column, len(constraint_column_names) AS column_count FROM duckdb_constraints() WHERE constraint_type = 'FOREIGN KEY' AND database_name = current_database() AND schema_name = 'main' AND table_name = ?",
      [table.name],
    );
    const physicalKeys = relationships
      .map((relationship) => {
        const column = relationship["column_name"];
        const target = relationship["target_table"];
        const targetColumn = relationship["target_column"];
        if (
          typeof column !== "string" ||
          typeof target !== "string" ||
          targetColumn !== "record_id" ||
          (format === "sqlite" &&
            (relationship["on_update"] !== "NO ACTION" ||
              relationship["on_delete"] !== "NO ACTION" ||
              relationship["match"] !== "NONE")) ||
          (relationship["column_count"] !== undefined &&
            String(relationship["column_count"]) !== "1")
        )
          return "unsupported";
        return JSON.stringify([identifierKey(column), identifierKey(target)]);
      })
      .sort();
    if (JSON.stringify(physicalKeys) !== relationshipKey(table))
      throw databaseError(
        "DB_SCHEMA_DRIFT",
        "A managed table's relationships differ from its declared schema. Restore its relationships before importing.",
        { table: table.name },
      );
  }
}

async function assertRegisteredConstraints(
  transaction: EngineTransaction,
  format: Database["format"],
  table: string,
): Promise<void> {
  let supported: boolean;
  if (format === "duckdb") {
    const constraints = await transaction.query(
      "SELECT constraint_type, constraint_column_names[1] AS column_name, len(constraint_column_names) AS column_count FROM duckdb_constraints() WHERE database_name = current_database() AND schema_name = 'main' AND table_name = ? AND constraint_type NOT IN ('NOT NULL', 'FOREIGN KEY')",
      [table],
    );
    supported =
      constraints.length === 1 &&
      constraints[0]?.["constraint_type"] === "PRIMARY KEY" &&
      constraints[0]["column_name"] === "record_id" &&
      String(constraints[0]["column_count"]) === "1";
  } else {
    const definitions = await transaction.query(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?",
      [table],
    );
    const sql = definitions[0]?.["sql"];
    const keywords =
      typeof sql === "string"
        ? sql.replace(
            /'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\//gu,
            " ",
          )
        : "";
    const keys = await transaction.query(
      'SELECT i.origin, x.name, x.cid, i.partial FROM pragma_index_list(?) i JOIN pragma_index_info(i.name) x WHERE i."unique" = 1 ORDER BY i.origin, x.seqno',
      [table],
    );
    supported =
      typeof sql === "string" &&
      !/\b(?:CHECK|COLLATE|GENERATED|DEFERRABLE|STRICT)\b|\bWITHOUT\s+ROWID\b|\bON\s+CONFLICT\b/iu.test(
        keywords,
      ) &&
      keys.length === 2 &&
      keys.some(
        (key) => key["origin"] === "pk" && key["name"] === "record_id",
      ) &&
      keys.some(
        (key) => key["origin"] === "u" && key["name"] === "_imported_row_id",
      );
  }
  if (!supported)
    throw databaseError(
      "DB_SCHEMA_DRIFT",
      "A managed table has constraints outside its declared schema. Restore its declared constraints before importing or converting.",
      { table },
    );
}

export async function createManagedTable(
  transaction: EngineTransaction,
  format: Database["format"],
  schema: TableSchema,
): Promise<void> {
  validateTableSchema(schema);
  const references: string[] = [];
  for (const relationship of schema.foreignKeys ?? []) {
    const rows = await transaction.query(
      `SELECT table_name FROM ${TABLE_REGISTRY_TABLE}`,
    );
    const target = rows.find(
      (row) =>
        typeof row["table_name"] === "string" &&
        identifierKey(row["table_name"]) ===
          identifierKey(relationship.referencesTable),
    )?.["table_name"];
    if (typeof target !== "string")
      throw databaseError(
        "DB_FOREIGN_TABLE_NOT_FOUND",
        "Create the referenced table before creating this relationship.",
        { table: schema.name, referencesTable: relationship.referencesTable },
      );
    references.push(
      `FOREIGN KEY (${quoteIdentifier(schema.columns.find((column) => identifierKey(column.name) === identifierKey(relationship.column))!.name)}) REFERENCES ${quoteIdentifier(target)} (${quoteIdentifier("record_id")})`,
    );
  }
  const columns = [
    `${quoteIdentifier("record_id")} VARCHAR NOT NULL PRIMARY KEY`,
    `${quoteIdentifier("_imported_row_id")} BIGINT${format === "sqlite" ? " UNIQUE" : ""}`,
    `${quoteIdentifier("_import_id")} VARCHAR`,
    `${quoteIdentifier("_source_file_id")} VARCHAR`,
    `${quoteIdentifier("_source_selection")} VARCHAR`,
    `${quoteIdentifier("_source_row")} BIGINT`,
    ...schema.columns.map(
      (column) =>
        `${quoteIdentifier(column.name)} ${storageType(format, column)}${column.nullable === false ? " NOT NULL" : ""}`,
    ),
    ...references,
  ];
  await transaction.execute(
    `CREATE TABLE ${quoteIdentifier(schema.name)} (${columns.join(", ")})`,
  );
  await transaction.execute(
    `INSERT INTO ${TABLE_REGISTRY_TABLE} (table_name, schema_json, schema_version, next_record_id) VALUES (?, ?, ?, ?)`,
    [schema.name, JSON.stringify(schema), 1n, 1n],
  );
}

export async function applySchema(
  options: {
    readonly database: Database;
    readonly plan: SchemaPlan;
  } & OperationControlOptions,
): Promise<OperationResult<"tablesCreated" | "columnsAdded">> {
  throwIfAborted(options.signal, "db.schema.apply");
  if (options.plan.state !== "ready") {
    throw databaseError(
      "DB_SCHEMA_NEEDS_REVIEW",
      "The schema plan still has conflicts. Resolve them before applying it.",
    );
  }
  if (options.plan.databaseId !== options.database.id) {
    throw databaseError(
      "DB_SCHEMA_WRONG_DATABASE",
      "The schema plan belongs to a different database.",
    );
  }
  const engine = engineOf(options.database);
  await engine.transaction(async (transaction) => {
    const revisionRows = await transaction.query(
      `SELECT revision FROM ${DATABASE_METADATA_TABLE}`,
    );
    const current = valueAsNonNegativeBigInt(
      revisionRows[0]?.["revision"],
      "revision",
    );
    if (
      current !== options.plan.baselineRevision ||
      (await readSchemaFingerprint(transaction, options.database.format)) !==
        options.plan.schemaFingerprint
    ) {
      throw databaseError(
        "DB_STALE_SCHEMA_PLAN",
        "The database schema changed after this plan was prepared. Prepare it again before applying.",
      );
    }
    await validateRegisteredTables(transaction, options.database.format);
    for (const schema of options.plan.creates) {
      throwIfAborted(options.signal, "db.schema.apply");
      await createManagedTable(transaction, options.database.format, schema);
    }
    for (const addition of options.plan.adds) {
      const rows = await transaction.query(
        `SELECT schema_json FROM ${TABLE_REGISTRY_TABLE} WHERE table_name = ?`,
        [addition.table],
      );
      const stored = rows[0]?.["schema_json"];
      if (typeof stored !== "string") {
        throw databaseError(
          "DB_STALE_SCHEMA_PLAN",
          `The table "${addition.table}" no longer exists.`,
        );
      }
      const schema = parseStoredTableSchema(stored, addition.table);
      for (const column of addition.columns) {
        throwIfAborted(options.signal, "db.schema.apply");
        await transaction.execute(
          `ALTER TABLE ${quoteIdentifier(addition.table)} ADD COLUMN ${quoteIdentifier(column.name)} ${storageType(options.database.format, column)}`,
        );
      }
      const updated: TableSchema = {
        ...schema,
        columns: [...schema.columns, ...addition.columns],
      };
      await transaction.execute(
        `UPDATE ${TABLE_REGISTRY_TABLE} SET schema_json = ?, schema_version = schema_version + 1 WHERE table_name = ?`,
        [JSON.stringify(updated), addition.table],
      );
    }
    if (options.plan.creates.length > 0 || options.plan.adds.length > 0) {
      await transaction.execute(
        `UPDATE ${DATABASE_METADATA_TABLE} SET revision = revision + 1`,
      );
    }
  });
  return {
    operation: "db.schema.apply",
    artifacts: [],
    warnings: [],
    metrics: {
      tablesCreated: options.plan.creates.length,
      columnsAdded: options.plan.adds.reduce(
        (total, addition) => total + addition.columns.length,
        0,
      ),
    },
  };
}
