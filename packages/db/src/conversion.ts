import {
  isConsultChimpsError,
  throwIfAborted,
  type OperationControlOptions,
  type OperationResult,
} from "@consultchimps/core";

import {
  engineOf,
  inspectDatabase,
  valueAsBigInt,
  valueAsString,
  type Database,
  type DatabaseId,
} from "./database.js";
import { databaseError } from "./errors.js";
import type { EngineTransaction, EngineValue } from "./internal/engine.js";
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
} from "./metadata.js";
import {
  applySchema,
  assertRegisteredColumns,
  planSchema,
  readSchemaFingerprint,
  sortTablesByReferences,
} from "./records.js";
import { quoteIdentifier, type DatabaseFormat } from "./schema.js";

const CONVERSION_BATCH_ROWS = 2_000;

export type ConversionIssue =
  | {
      readonly kind: "unsupported-object";
      readonly name: string;
      readonly objectType: string;
      readonly message: string;
    }
  | {
      readonly kind: "foreign-key-cycle";
      readonly tables: readonly string[];
      readonly message: string;
    };

export interface ConversionChange {
  readonly kind: "storage-representation";
  readonly table: string;
  readonly column: string;
  readonly logicalType: "boolean" | "date" | "decimal";
  readonly message: string;
}

export interface ConversionPlan {
  readonly databaseId: DatabaseId;
  readonly baselineRevision: bigint;
  readonly schemaFingerprint: string;
  readonly sourceFormat: DatabaseFormat;
  readonly targetFormat: DatabaseFormat;
  readonly tableCount: number;
  readonly rowCount: bigint;
  readonly changes: readonly ConversionChange[];
  readonly issues: readonly ConversionIssue[];
  readonly state: "ready" | "unsupported";
}

const INTERNAL_TABLES = new Set([
  APPLICATION_TABLE,
  CAPTURE_ROW_TABLE,
  CAPTURE_TABLE,
  COUNTERS_TABLE,
  DATABASE_METADATA_TABLE,
  DELIVERY_MEMBERSHIP_TABLE,
  DELIVERY_TABLE,
  IMPORT_REQUEST_TABLE,
  SOURCE_CONTENT_TABLE,
  SOURCE_FILE_TABLE,
  SOURCE_NAME_TABLE,
  TABLE_REGISTRY_TABLE,
  PLAN_TABLE,
]);

async function unsupportedObjectsFrom(
  engine: EngineTransaction,
  format: DatabaseFormat,
  expected: ReadonlySet<string>,
): Promise<ConversionIssue[]> {
  const rows =
    format === "sqlite"
      ? await engine.query(
          "SELECT name, type FROM sqlite_master WHERE (type IN ('table', 'view', 'trigger') OR (type = 'index' AND sql IS NOT NULL)) AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
      : await engine.query(
          "SELECT CASE WHEN table_schema = 'main' THEN table_name ELSE table_schema || '.' || table_name END AS name, table_type AS type FROM information_schema.tables WHERE table_schema NOT IN ('information_schema', 'pg_catalog') ORDER BY table_schema, table_name",
        );
  const issues = rows.flatMap((row) => {
    const name = valueAsString(row["name"], "database object name");
    const type = valueAsString(row["type"], "database object type");
    const ordinaryTable =
      type.toLocaleLowerCase() === "table" || type === "BASE TABLE";
    if (ordinaryTable && expected.has(name)) return [];
    return [
      {
        kind: "unsupported-object" as const,
        name,
        objectType: type,
        message: `The ${type.toLocaleLowerCase()} "${name}" has no verified cross-format conversion.`,
      },
    ];
  });
  if (format === "duckdb") {
    const indexes = await engine.query(
      "SELECT index_name AS name FROM duckdb_indexes() ORDER BY index_name",
    );
    issues.push(
      ...indexes.map((row) => ({
        kind: "unsupported-object" as const,
        name: valueAsString(row["name"], "index name"),
        objectType: "index",
        message: `The index "${valueAsString(row["name"], "index name")}" has no verified cross-format conversion.`,
      })),
    );
    const sequences = await engine.query(
      "SELECT sequence_name AS name FROM duckdb_sequences() ORDER BY sequence_name",
    );
    issues.push(
      ...sequences.map((row) => ({
        kind: "unsupported-object" as const,
        name: valueAsString(row["name"], "sequence name"),
        objectType: "sequence",
        message: `The sequence "${valueAsString(row["name"], "sequence name")}" has no verified cross-format conversion.`,
      })),
    );
    const macros = await engine.query(
      "SELECT function_name AS name, function_type AS type FROM duckdb_functions() WHERE database_name = current_database() AND schema_name = 'main' AND function_type IN ('macro', 'table_macro') ORDER BY function_name",
    );
    issues.push(
      ...macros.map((row) => ({
        kind: "unsupported-object" as const,
        name: valueAsString(row["name"], "macro name"),
        objectType: valueAsString(row["type"], "macro type"),
        message: `The macro "${valueAsString(row["name"], "macro name")}" has no verified cross-format conversion.`,
      })),
    );
    const customTypes = await engine.query(
      "SELECT type_name AS name FROM duckdb_types() WHERE database_name = current_database() AND schema_name = 'main' AND NOT internal ORDER BY type_name",
    );
    issues.push(
      ...customTypes.map((row) => ({
        kind: "unsupported-object" as const,
        name: valueAsString(row["name"], "custom type name"),
        objectType: "type",
        message: `The custom type "${valueAsString(row["name"], "custom type name")}" has no verified cross-format conversion.`,
      })),
    );
  }
  return issues;
}

async function unsupportedObjects(
  database: Database,
): Promise<ConversionIssue[]> {
  const inspection = await inspectDatabase({ database });
  return unsupportedObjectsFrom(
    engineOf(database),
    database.format,
    new Set([
      ...INTERNAL_TABLES,
      ...inspection.tables.map((table) => table.name),
    ]),
  );
}

function orderTables(
  tables: readonly Awaited<
    ReturnType<typeof inspectDatabase>
  >["tables"][number][],
): {
  readonly ordered: typeof tables;
  readonly cycle: readonly string[];
} {
  const bySchema = new Map(tables.map((table) => [table.schema, table]));
  try {
    return {
      ordered: sortTablesByReferences(tables.map((table) => table.schema)).map(
        (schema) => {
          const table = bySchema.get(schema);
          if (table === undefined) {
            throw databaseError(
              "DB_CONVERSION_VALIDATION_FAILED",
              `The planned table "${schema.name}" is missing from the source inspection.`,
            );
          }
          return table;
        },
      ),
      cycle: [],
    };
  } catch (error) {
    if (
      isConsultChimpsError(error) &&
      error.code === "DB_SCHEMA_REFERENCE_CYCLE"
    ) {
      return { ordered: [], cycle: tables.map((table) => table.name).sort() };
    }
    throw error;
  }
}

export async function planConversion(options: {
  readonly database: Database;
  readonly format: DatabaseFormat;
}): Promise<ConversionPlan> {
  const inspection = await inspectDatabase({ database: options.database });
  await assertRegisteredColumns(
    engineOf(options.database),
    options.database.format,
    inspection.tables.map((table) => table.schema),
  );
  const changes: ConversionChange[] = [];
  if (inspection.format !== options.format) {
    for (const table of inspection.tables) {
      for (const column of table.schema.columns) {
        if (
          column.type !== "boolean" &&
          column.type !== "date" &&
          column.type !== "decimal"
        ) {
          continue;
        }
        changes.push({
          kind: "storage-representation",
          table: table.name,
          column: column.name,
          logicalType: column.type,
          message: `The logical ${column.type} value remains ${column.type}, while its engine storage representation changes.`,
        });
      }
    }
  }
  const issues: ConversionIssue[] =
    inspection.format === options.format
      ? []
      : await unsupportedObjects(options.database);
  const order = orderTables(inspection.tables);
  if (inspection.format !== options.format && order.cycle.length > 0) {
    issues.push({
      kind: "foreign-key-cycle",
      tables: order.cycle,
      message: `The foreign keys form a cycle across ${order.cycle.join(", ")}. This build does not convert cyclic constraints.`,
    });
  }
  return {
    databaseId: inspection.id,
    baselineRevision: inspection.revision,
    schemaFingerprint: await readSchemaFingerprint(
      engineOf(options.database),
      options.database.format,
    ),
    sourceFormat: inspection.format,
    targetFormat: options.format,
    tableCount: inspection.tables.length,
    rowCount: inspection.tables.reduce(
      (total, table) => total + table.rowCount,
      0n,
    ),
    changes,
    issues,
    state: issues.length === 0 ? "ready" : "unsupported",
  };
}

interface CopyTable {
  readonly name: string;
  readonly columns: readonly string[];
  readonly key: readonly string[];
}

const COPY_TABLES: readonly CopyTable[] = [
  {
    name: COUNTERS_TABLE,
    columns: ["counter_name", "next_value"],
    key: ["counter_name"],
  },
  {
    name: SOURCE_CONTENT_TABLE,
    columns: ["content_hash", "byte_count"],
    key: ["content_hash"],
  },
  {
    name: SOURCE_FILE_TABLE,
    columns: ["source_file_id", "content_hash", "display_name"],
    key: ["source_file_id"],
  },
  {
    name: SOURCE_NAME_TABLE,
    columns: ["source_file_id", "display_name"],
    key: ["source_file_id", "display_name"],
  },
  {
    name: CAPTURE_TABLE,
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
    key: ["capture_id"],
  },
  {
    name: CAPTURE_ROW_TABLE,
    columns: ["capture_id", "source_row", "values_json"],
    key: ["capture_id", "source_row"],
  },
  {
    name: PLAN_TABLE,
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
    key: ["plan_id", "plan_revision"],
  },
  {
    name: APPLICATION_TABLE,
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
    key: ["import_id"],
  },
  {
    name: IMPORT_REQUEST_TABLE,
    columns: [
      "request_id",
      "plan_id",
      "plan_revision",
      "import_ids_json",
      "capture_ids_json",
      "row_count",
    ],
    key: ["request_id"],
  },
  {
    name: DELIVERY_TABLE,
    columns: ["delivery_id", "request_id", "context_json"],
    key: ["delivery_id"],
  },
  {
    name: DELIVERY_MEMBERSHIP_TABLE,
    columns: ["delivery_id", "capture_id"],
    key: ["delivery_id", "capture_id"],
  },
];

function keysetWhere(
  key: readonly string[],
  cursor: readonly EngineValue[] | null,
): { readonly sql: string; readonly values: readonly EngineValue[] } {
  if (cursor === null) return { sql: "", values: [] };
  if (key.length === 1) {
    return {
      sql: ` WHERE ${quoteIdentifier(key[0]!)} > ?`,
      values: [cursor[0]!],
    };
  }
  return {
    sql: ` WHERE (${quoteIdentifier(key[0]!)} > ?) OR (${quoteIdentifier(key[0]!)} = ? AND ${quoteIdentifier(key[1]!)} > ?)`,
    values: [cursor[0]!, cursor[0]!, cursor[1]!],
  };
}

async function copyTable(options: {
  readonly source: EngineTransaction;
  readonly target: EngineTransaction;
  readonly table: CopyTable;
  readonly signal?: AbortSignal | undefined;
}): Promise<bigint> {
  const source = options.source;
  const table = options.table;
  let cursor: readonly EngineValue[] | null = null;
  let copied = 0n;
  while (true) {
    throwIfAborted(options.signal, "db.convert");
    const where = keysetWhere(table.key, cursor);
    const rows = await source.query(
      `SELECT ${table.columns.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(table.name)}${where.sql} ORDER BY ${table.key.map(quoteIdentifier).join(", ")} LIMIT ?`,
      [...where.values, BigInt(CONVERSION_BATCH_ROWS)],
    );
    if (rows.length === 0) break;
    await options.target.bulkInsert({
      table: table.name,
      columns: table.columns,
      rows: rows.map((row) =>
        table.columns.map((column) => row[column] ?? null),
      ),
      signal: options.signal,
    });
    const last = rows.at(-1)!;
    cursor = table.key.map((column) => last[column] ?? null);
    copied += BigInt(rows.length);
  }
  return copied;
}

export async function executeConversion(
  options: {
    readonly source: Database;
    readonly target: Database;
    readonly plan: ConversionPlan;
  } & OperationControlOptions,
): Promise<OperationResult<"tablesConverted" | "rowsConverted">> {
  throwIfAborted(options.signal, "db.convert");
  if (options.plan.state !== "ready") {
    throw databaseError(
      "DB_CONVERSION_UNSUPPORTED",
      "This conversion has unsupported database objects. Review the conversion plan and remove or replace them first.",
      { issues: options.plan.issues },
    );
  }
  const inspection = await inspectDatabase({ database: options.source });
  if (
    inspection.id !== options.plan.databaseId ||
    inspection.revision !== options.plan.baselineRevision ||
    options.source.format !== options.plan.sourceFormat ||
    options.target.format !== options.plan.targetFormat
  ) {
    throw databaseError(
      "DB_STALE_CONVERSION_PLAN",
      "The source database or conversion destination changed after planning. Prepare the conversion again.",
    );
  }
  const targetInspection = await inspectDatabase({ database: options.target });
  if (
    targetInspection.tables.length !== 0 ||
    targetInspection.captures !== 0n ||
    targetInspection.completedImports !== 0n ||
    targetInspection.deliveries !== 0n
  ) {
    throw databaseError(
      "DB_CONVERSION_TARGET_NOT_EMPTY",
      "The conversion destination must be a new empty ConsultChimps database.",
    );
  }
  const tableOrder = orderTables(inspection.tables);
  if (tableOrder.cycle.length > 0) {
    throw databaseError(
      "DB_CONVERSION_FOREIGN_KEY_CYCLE",
      "The conversion cannot create cyclic foreign-key constraints safely.",
      { tables: tableOrder.cycle },
    );
  }
  const schema = {
    version: 1 as const,
    tables: tableOrder.ordered.map((table) => table.schema),
  };
  const schemaPlan = await planSchema({ database: options.target, schema });
  let rowsConverted = 0n;
  const target = engineOf(options.target);
  await engineOf(options.source).readTransaction(async (source) => {
    const revisionRows = await source.query(
      `SELECT revision FROM ${DATABASE_METADATA_TABLE}`,
    );
    if (
      valueAsBigInt(revisionRows[0]?.["revision"], "database revision") !==
        options.plan.baselineRevision ||
      (await readSchemaFingerprint(source, options.source.format)) !==
        options.plan.schemaFingerprint
    ) {
      throw databaseError(
        "DB_STALE_CONVERSION_PLAN",
        "The source database changed after planning. Prepare the conversion again.",
      );
    }
    await assertRegisteredColumns(
      source,
      options.source.format,
      inspection.tables.map((table) => table.schema),
    );
    if (options.source.format !== options.target.format) {
      const issues = await unsupportedObjectsFrom(
        source,
        options.source.format,
        new Set([
          ...INTERNAL_TABLES,
          ...inspection.tables.map((table) => table.name),
        ]),
      );
      if (issues.length > 0) {
        throw databaseError(
          "DB_STALE_CONVERSION_PLAN",
          "The source database gained unsupported objects after planning. Prepare the conversion again.",
          { issues },
        );
      }
    }
    await applySchema({
      database: options.target,
      plan: schemaPlan,
      signal: options.signal,
    });
    await target.transaction(async (transaction) => {
      for (const table of COPY_TABLES) {
        await transaction.execute(`DELETE FROM ${quoteIdentifier(table.name)}`);
        await copyTable({
          source,
          target: transaction,
          table,
          signal: options.signal,
        });
      }
      const registryRows = await source.query(
        `SELECT table_name, schema_version, next_record_id FROM ${TABLE_REGISTRY_TABLE} ORDER BY table_name`,
      );
      for (const row of registryRows) {
        await transaction.execute(
          `UPDATE ${TABLE_REGISTRY_TABLE} SET schema_version = ?, next_record_id = ? WHERE table_name = ?`,
          [
            valueAsBigInt(row["schema_version"], "schema version"),
            valueAsBigInt(row["next_record_id"], "Record ID counter"),
            valueAsString(row["table_name"], "table name"),
          ],
        );
      }
      for (const table of tableOrder.ordered) {
        const columns = [
          "record_id",
          "_imported_row_id",
          "_import_id",
          "_source_file_id",
          "_source_selection",
          "_source_row",
          ...table.schema.columns.map((column) => column.name),
        ];
        rowsConverted += await copyTable({
          source,
          target: transaction,
          table: { name: table.name, columns, key: ["record_id"] },
          signal: options.signal,
        });
      }
      await transaction.execute(
        `UPDATE ${DATABASE_METADATA_TABLE} SET revision = ?`,
        [inspection.revision],
      );
    });
  });
  await options.target.checkpoint();
  const converted = await inspectDatabase({ database: options.target });
  await assertRegisteredColumns(
    engineOf(options.target),
    options.target.format,
    converted.tables.map((table) => table.schema),
  );
  const expectedCounts = new Map(
    inspection.tables.map((table) => [table.name, table.rowCount]),
  );
  const invalidTable = converted.tables.find(
    (table) =>
      expectedCounts.get(table.name) !== table.rowCount ||
      JSON.stringify(table.schema) !==
        JSON.stringify(
          inspection.tables.find((source) => source.name === table.name)
            ?.schema,
        ),
  );
  if (
    converted.tables.length !== inspection.tables.length ||
    invalidTable !== undefined ||
    converted.captures !== inspection.captures ||
    converted.completedImports !== inspection.completedImports ||
    converted.deliveries !== inspection.deliveries ||
    converted.appliedImportPlans !== inspection.appliedImportPlans
  ) {
    throw databaseError(
      "DB_CONVERSION_VALIDATION_FAILED",
      "The converted database did not match the planned schema and history counts. The output was not published.",
      { table: invalidTable?.name },
    );
  }
  return {
    operation: "db.convert",
    artifacts: [],
    warnings: [],
    metrics: {
      tablesConverted: inspection.tables.length,
      rowsConverted: Number(rowsConverted),
    },
  };
}
