import { ConsultChimpsError } from "@consultchimps/core";

export const DATABASE_FORMATS = ["sqlite", "duckdb"] as const;
export type DatabaseFormat = (typeof DATABASE_FORMATS)[number];

export const COLUMN_TYPES = [
  "text",
  "integer",
  "real",
  "decimal",
  "boolean",
  "date",
  "timestamp",
] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

export interface ColumnDefinition {
  readonly name: string;
  readonly type: ColumnType;
  readonly nullable?: boolean | undefined;
  readonly precision?: number | undefined;
  readonly scale?: number | undefined;
}

export interface ForeignKey {
  readonly column: string;
  readonly referencesTable: string;
}

export interface RecordIdConfig {
  readonly prefix: string;
  readonly padding: number;
  readonly separator?: string | undefined;
}

export interface TableSchema {
  readonly name: string;
  readonly columns: readonly ColumnDefinition[];
  readonly foreignKeys?: readonly ForeignKey[] | undefined;
  readonly recordId: RecordIdConfig;
}

export interface DatabaseSchema {
  readonly version: 1;
  readonly tables: readonly TableSchema[];
}

export const DATABASE_SCHEMA_VERSION = 1;
export const RECORD_ID_COLUMN = "record_id";
export const IMPORT_PROVENANCE_COLUMNS = [
  "_imported_row_id",
  "_import_id",
  "_source_file_id",
  "_source_selection",
  "_source_row",
] as const;
export const RESERVED_TABLE_PREFIX = "_consultchimps";
export const DEFAULT_RECORD_ID_SEPARATOR = "-";
export const MAX_IDENTIFIER_LENGTH = 200;
export const MAX_RECORD_ID_PADDING = 18;

export function identifierKey(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

export function sameIdentifier(left: string, right: string): boolean {
  return identifierKey(left) === identifierKey(right);
}

export function quoteIdentifier(value: string): string {
  assertSafeIdentifier(value, "identifier", true);
  return `"${value.replaceAll('"', '""')}"`;
}

export function assertSafeIdentifier(
  value: string,
  role: "table" | "column" | "identifier" = "identifier",
  allowReserved = false,
): void {
  if (
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value.trim() !== value ||
    Array.from(value).some((character) => character.codePointAt(0)! < 32) ||
    (!allowReserved && identifierKey(value).startsWith(RESERVED_TABLE_PREFIX))
  ) {
    throw new ConsultChimpsError(
      "DB_INVALID_IDENTIFIER",
      `The ${role} name "${value}" is not safe to use in a database.`,
      { details: { role, name: value } },
    );
  }
}

export function assertRecordIdConfig(config: RecordIdConfig): void {
  if (
    config.prefix.trim().length === 0 ||
    config.prefix.length > MAX_IDENTIFIER_LENGTH ||
    Array.from(config.prefix + (config.separator ?? "")).some(
      (character) => character.codePointAt(0)! < 32,
    ) ||
    config.padding < 0 ||
    config.padding > MAX_RECORD_ID_PADDING ||
    !Number.isInteger(config.padding)
  ) {
    throw new ConsultChimpsError(
      "DB_INVALID_RECORD_ID_CONFIG",
      "The Record ID prefix and padding are not valid.",
    );
  }
}

export function formatRecordId(
  config: RecordIdConfig,
  counter: bigint,
): string {
  assertRecordIdConfig(config);
  const separator = config.separator ?? DEFAULT_RECORD_ID_SEPARATOR;
  return `${config.prefix}${separator}${counter.toString().padStart(config.padding, "0")}`;
}

export function validateTableSchema(schema: TableSchema): void {
  assertSafeIdentifier(schema.name, "table");
  assertRecordIdConfig(schema.recordId);
  const names = new Set<string>(
    [RECORD_ID_COLUMN, ...IMPORT_PROVENANCE_COLUMNS].map(identifierKey),
  );
  for (const column of schema.columns) {
    assertSafeIdentifier(column.name, "column");
    const key = identifierKey(column.name);
    if (names.has(key)) {
      throw new ConsultChimpsError(
        "DB_DUPLICATE_COLUMN",
        `The table "${schema.name}" declares the column "${column.name}" more than once or uses a reserved name.`,
        { details: { table: schema.name, column: column.name } },
      );
    }
    names.add(key);
    if (column.type === "decimal") {
      if (
        column.precision === undefined ||
        column.scale === undefined ||
        !Number.isInteger(column.precision) ||
        !Number.isInteger(column.scale) ||
        column.precision < 1 ||
        column.precision > 38 ||
        column.scale < 0 ||
        column.scale > column.precision
      ) {
        throw new ConsultChimpsError(
          "DB_INVALID_DECIMAL",
          `The decimal column "${column.name}" needs a precision from 1 to 38 and a scale no greater than its precision.`,
          { details: { table: schema.name, column: column.name } },
        );
      }
    } else if (column.precision !== undefined || column.scale !== undefined) {
      throw new ConsultChimpsError(
        "DB_INVALID_COLUMN_OPTIONS",
        `The column "${column.name}" can declare precision and scale only when its type is decimal.`,
        { details: { table: schema.name, column: column.name } },
      );
    }
  }
  const referencedColumns = new Set<string>();
  for (const foreignKey of schema.foreignKeys ?? []) {
    assertSafeIdentifier(foreignKey.referencesTable, "table");
    const key = identifierKey(foreignKey.column);
    const column = schema.columns.find(
      (candidate) => identifierKey(candidate.name) === key,
    );
    if (!column || column.type !== "text" || referencedColumns.has(key)) {
      throw new ConsultChimpsError(
        "DB_INVALID_FOREIGN_KEY",
        "Each relationship must use a distinct text column declared in its table and refer to a generated Record ID.",
        {
          details: { table: schema.name, column: foreignKey.column },
        },
      );
    }
    referencedColumns.add(key);
  }
}
