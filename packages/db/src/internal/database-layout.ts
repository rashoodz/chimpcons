import { isConsultChimpsError } from "@consultchimps/core";

import { databaseError } from "../errors.js";
import {
  identifierKey,
  quoteIdentifier,
  type ColumnDefinition,
  type DatabaseFormat,
  type TableSchema,
} from "../schema.js";
import { parseDatabaseSchema } from "../validators.js";
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
} from "../metadata.js";
import type {
  DatabaseEngine,
  EngineRow,
  EngineTransaction,
  EngineValue,
} from "./engine.js";

const REQUIRED_DATABASE_SCHEMA = [
  {
    table: DATABASE_METADATA_TABLE,
    columns: ["database_id", "format", "format_version", "revision"],
  },
  {
    table: TABLE_REGISTRY_TABLE,
    columns: ["table_name", "schema_json", "schema_version", "next_record_id"],
  },
  {
    table: COUNTERS_TABLE,
    columns: ["counter_name", "next_value"],
  },
  {
    table: SOURCE_CONTENT_TABLE,
    columns: ["content_hash", "byte_count"],
  },
  {
    table: SOURCE_FILE_TABLE,
    columns: ["source_file_id", "content_hash", "display_name"],
  },
  {
    table: SOURCE_NAME_TABLE,
    columns: ["source_file_id", "display_name"],
  },
  {
    table: CAPTURE_TABLE,
    columns: [
      "capture_id",
      "source_file_id",
      "source_key",
      "selection_key",
      "selection_label",
      "reader_version",
      "state",
      "row_count",
      "columns_json",
    ],
  },
  {
    table: PLAN_TABLE,
    columns: [
      "plan_id",
      "plan_revision",
      "baseline_revision",
      "state",
      "recipe_json",
      "conflicts_json",
      "decisions_json",
      "bindings_json",
    ],
  },
  {
    table: CAPTURE_ROW_TABLE,
    columns: ["capture_id", "source_row", "values_json"],
  },
  {
    table: APPLICATION_TABLE,
    columns: [
      "import_id",
      "application_key",
      "request_id",
      "capture_id",
      "table_name",
      "plan_id",
      "plan_revision",
      "row_count",
    ],
  },
  {
    table: IMPORT_REQUEST_TABLE,
    columns: [
      "request_id",
      "plan_id",
      "plan_revision",
      "import_ids_json",
      "capture_ids_json",
      "row_count",
    ],
  },
  {
    table: DELIVERY_TABLE,
    columns: ["delivery_id", "request_id", "context_json"],
  },
  {
    table: DELIVERY_MEMBERSHIP_TABLE,
    columns: ["delivery_id", "capture_id"],
  },
] as const;

function corruptDatabase(details?: Record<string, unknown>, cause?: unknown) {
  return databaseError(
    "DB_CORRUPT_DATABASE",
    "The database is incomplete or damaged. Restore a verified database copy before retrying.",
    details,
    cause,
  );
}

function storedBigInt(value: unknown, field: string, minimum: bigint): bigint {
  const parsed =
    typeof value === "bigint"
      ? value
      : typeof value === "number" && Number.isSafeInteger(value)
        ? BigInt(value)
        : typeof value === "string" && /^-?\d+$/u.test(value)
          ? BigInt(value)
          : undefined;
  if (parsed !== undefined && parsed >= minimum) return parsed;
  throw corruptDatabase({ field });
}

export function parseStoredTableSchema(
  schemaText: string,
  expectedName: string,
): TableSchema {
  try {
    const value: unknown = JSON.parse(schemaText);
    const parsed = parseDatabaseSchema({ version: 1, tables: [value] });
    const stored = parsed.tables[0];
    if (stored === undefined || stored.name !== expectedName)
      throw new Error("stored schema table name mismatch");
    return stored;
  } catch (cause) {
    throw databaseError(
      "DB_CORRUPT_DATABASE",
      `The stored schema for "${expectedName}" is invalid.`,
      { table: expectedName },
      cause,
    );
  }
}

export function storageType(
  format: DatabaseFormat,
  column: ColumnDefinition,
): string {
  switch (column.type) {
    case "text":
      return "VARCHAR";
    case "timestamp":
      return format === "duckdb" ? "TIMESTAMP" : "VARCHAR";
    case "integer":
      return "BIGINT";
    case "real":
      return "DOUBLE";
    case "boolean":
      return format === "duckdb" ? "BOOLEAN" : "BIGINT";
    case "date":
      return format === "duckdb" ? "DATE" : "VARCHAR";
    case "decimal":
      return format === "duckdb"
        ? `DECIMAL(${column.precision}, ${column.scale})`
        : "VARCHAR";
  }
}

export interface RegisteredTable {
  readonly schema: TableSchema;
  readonly schemaVersion: bigint;
}

const REQUIRED_COUNTERS = [
  "source_file",
  "capture",
  "plan",
  "import",
  "delivery",
  "imported_row",
] as const;

export async function readRegisteredTables(
  transaction: EngineTransaction,
): Promise<readonly RegisteredTable[]> {
  const counterRows = await transaction.query(
    `SELECT counter_name, next_value FROM ${COUNTERS_TABLE}`,
  );
  const counters = new Map(
    counterRows.flatMap((row) =>
      typeof row["counter_name"] === "string"
        ? [[row["counter_name"], row["next_value"]] as const]
        : [],
    ),
  );
  for (const counter of REQUIRED_COUNTERS)
    storedBigInt(counters.get(counter), `${counter} counter`, 1n);
  const rows = await transaction.query(
    `SELECT table_name, schema_json, schema_version, next_record_id FROM ${TABLE_REGISTRY_TABLE} ORDER BY table_name`,
  );
  return rows.map((row) => {
    const name = row["table_name"];
    const schemaText = row["schema_json"];
    if (
      typeof name !== "string" ||
      name.trim().length === 0 ||
      typeof schemaText !== "string"
    )
      throw corruptDatabase({ field: "table registry" });
    storedBigInt(row["next_record_id"], "Record ID counter", 1n);
    return {
      schema: parseStoredTableSchema(schemaText, name),
      schemaVersion: storedBigInt(row["schema_version"], "schema version", 1n),
    };
  });
}

export async function assertRegisteredStorage(
  transaction: EngineTransaction,
  format: DatabaseFormat,
  tables: readonly TableSchema[],
  options: { readonly allowExtraColumns?: boolean } = {},
): Promise<void> {
  if (tables.length > 0) {
    const names = tables.map(({ name }) => name);
    const placeholders = names.map(() => "?").join(", ");
    const rows = await transaction.query(
      format === "sqlite"
        ? `SELECT name AS table_name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`
        : `SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND table_type = 'BASE TABLE' AND table_name IN (${placeholders})`,
      names,
    );
    const baseTables = new Set(
      rows.flatMap((row) =>
        typeof row["table_name"] === "string" ? [row["table_name"]] : [],
      ),
    );
    const missing = names.find((name) => !baseTables.has(name));
    if (missing !== undefined)
      throw databaseError(
        "DB_SCHEMA_DRIFT",
        "A managed table was changed outside the database schema operations. Restore its declared layout or copy the changed data into a new managed table before importing.",
        { table: missing },
      );
  }
  for (const table of tables) {
    const actual = await transaction.query(
      `PRAGMA ${format === "sqlite" ? "table_xinfo" : "table_info"}(${quoteIdentifier(table.name)})`,
    );
    const actualByName = new Map(
      actual.flatMap((column) =>
        typeof column["name"] === "string"
          ? [[identifierKey(column["name"]), column] as const]
          : [],
      ),
    );
    const expected = new Map([
      ["record_id", "VARCHAR"],
      ["_imported_row_id", "BIGINT"],
      ["_import_id", "VARCHAR"],
      ["_source_file_id", "VARCHAR"],
      ["_source_selection", "VARCHAR"],
      ["_source_row", "BIGINT"],
      ...table.columns.map(
        (column) =>
          [identifierKey(column.name), storageType(format, column)] as const,
      ),
    ]);
    const matches =
      (options.allowExtraColumns === true || actual.length === expected.size) &&
      [...expected].every(([expectedName, expectedType]) => {
        const column = actualByName.get(expectedName);
        if (column === undefined) return false;
        const name = column["name"];
        const type = column["type"];
        if (
          typeof name !== "string" ||
          typeof type !== "string" ||
          expectedType.replaceAll(" ", "") !==
            type.toUpperCase().replaceAll(" ", "")
        )
          return false;
        const definition = table.columns.find(
          (candidate) => identifierKey(candidate.name) === identifierKey(name),
        );
        return (
          (column["dflt_value"] === null ||
            column["dflt_value"] === undefined) &&
          (column["hidden"] === undefined ||
            String(column["hidden"]) === "0") &&
          (identifierKey(name) === "record_id" ||
            definition?.nullable === false) ===
            (column["notnull"] === true ||
              column["notnull"] === 1n ||
              column["notnull"] === 1)
        );
      });
    if (!matches)
      throw databaseError(
        "DB_SCHEMA_DRIFT",
        "A managed table was changed outside the database schema operations. Restore its declared layout or copy the changed data into a new managed table before importing.",
        { table: table.name },
      );
  }
}

export async function validateRegisteredTables(
  transaction: EngineTransaction,
  format: DatabaseFormat,
  options: { readonly allowExtraColumns?: boolean } = {},
): Promise<readonly TableSchema[]> {
  const schemas = (await readRegisteredTables(transaction)).map(
    ({ schema }) => schema,
  );
  await assertRegisteredStorage(transaction, format, schemas, options);
  return schemas;
}

export async function queryDatabaseMetadata(
  engine: DatabaseEngine,
  sql: string,
  values?: readonly EngineValue[],
): Promise<readonly EngineRow[]> {
  try {
    return await engine.query(sql, values);
  } catch (cause) {
    if (isConsultChimpsError(cause)) throw cause;
    if (cause instanceof Error && cause.name === "AbortError") throw cause;
    throw corruptDatabase(undefined, cause);
  }
}

export async function validateDatabaseLayout(
  engine: DatabaseEngine,
): Promise<void> {
  const requiredTables = REQUIRED_DATABASE_SCHEMA.map(({ table }) => table);
  const placeholders = requiredTables.map(() => "?").join(", ");
  const tableRows = await queryDatabaseMetadata(
    engine,
    engine.format === "sqlite"
      ? `SELECT name AS table_name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`
      : `SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND table_type = 'BASE TABLE' AND table_name IN (${placeholders})`,
    requiredTables,
  );
  const baseTables = new Set(
    tableRows.flatMap((row) =>
      typeof row["table_name"] === "string" ? [row["table_name"]] : [],
    ),
  );
  const missingTables = requiredTables.filter(
    (table) => !baseTables.has(table),
  );
  if (missingTables.length > 0) {
    throw corruptDatabase({ missingTables });
  }
  for (const required of REQUIRED_DATABASE_SCHEMA) {
    const rows = await queryDatabaseMetadata(
      engine,
      engine.format === "sqlite"
        ? "SELECT name AS column_name FROM pragma_table_info(?)"
        : "SELECT column_name FROM information_schema.columns WHERE table_schema = 'main' AND table_name = ? ORDER BY ordinal_position",
      [required.table],
    );
    const columns = new Set(
      rows.flatMap((row) =>
        typeof row["column_name"] === "string" ? [row["column_name"]] : [],
      ),
    );
    const missingColumns = required.columns.filter(
      (column) => !columns.has(column),
    );
    if (missingColumns.length > 0) {
      throw corruptDatabase({ table: required.table, missingColumns });
    }
  }
}
