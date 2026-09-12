import type { OperationResult } from "@consultchimps/core";

import { assertOpen, databaseError } from "./errors.js";
import type { DatabaseEngine, EngineTransaction } from "./internal/engine.js";
import {
  parseStoredTableSchema,
  queryDatabaseMetadata,
  validateDatabaseLayout,
  validateRegisteredTables,
} from "./internal/database-layout.js";
import {
  APPLICATION_TABLE,
  CAPTURE_TABLE,
  COUNTERS_TABLE,
  DATABASE_FILE_FORMAT_VERSION,
  DATABASE_METADATA_TABLE,
  DELIVERY_MEMBERSHIP_TABLE,
  DELIVERY_TABLE,
  IMPORT_REQUEST_TABLE,
  PLAN_TABLE,
  SOURCE_CONTENT_TABLE,
  SOURCE_FILE_TABLE,
  SOURCE_NAME_TABLE,
  CAPTURE_ROW_TABLE,
  TABLE_REGISTRY_TABLE,
} from "./metadata.js";
import {
  quoteIdentifier,
  type DatabaseFormat,
  type DatabaseSchema,
  type TableSchema,
} from "./schema.js";
export { parseStoredTableSchema } from "./internal/database-layout.js";

declare const databaseIdBrand: unique symbol;
export type DatabaseId = string & { readonly [databaseIdBrand]: true };

export interface DatabaseCapabilities {
  readonly persistent: true;
  readonly incrementalWrites: true;
  readonly bulkInsert: true;
  readonly interrupt: boolean;
}

export interface DatabaseTableSummary {
  readonly name: string;
  readonly rowCount: bigint;
  readonly schema: TableSchema;
}

export interface DatabaseInspection {
  readonly id: DatabaseId;
  readonly format: DatabaseFormat;
  readonly formatVersion: number;
  readonly revision: bigint;
  readonly tables: readonly DatabaseTableSummary[];
  readonly captures: bigint;
  readonly completedImports: bigint;
  readonly deliveries: bigint;
  readonly appliedImportPlans: bigint;
}

const engines = new WeakMap<Database, DatabaseEngine>();

export interface Database extends AsyncDisposable {
  readonly id: DatabaseId;
  readonly format: DatabaseFormat;
  readonly capabilities: DatabaseCapabilities;
  readonly isOpen: boolean;
  checkpoint(): Promise<void>;
  close(): Promise<void>;
}

class ManagedDatabase implements Database {
  readonly id: DatabaseId;
  readonly format: DatabaseFormat;
  readonly capabilities: DatabaseCapabilities;
  #open = true;

  constructor(id: DatabaseId, engine: DatabaseEngine) {
    this.id = id;
    this.format = engine.format;
    this.capabilities = {
      persistent: true,
      incrementalWrites: true,
      bulkInsert: true,
      interrupt: engine.interruptible,
    };
    engines.set(this, engine);
  }

  get isOpen(): boolean {
    return this.#open;
  }

  async checkpoint(): Promise<void> {
    assertOpen(this.#open);
    await engineOf(this).checkpoint();
  }

  async close(): Promise<void> {
    if (!this.#open) return;
    const engine = engineOf(this);
    try {
      await engine.close();
    } finally {
      this.#open = false;
      engines.delete(this);
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

export function engineOf(database: Database): DatabaseEngine {
  assertOpen(database.isOpen);
  const engine = engines.get(database);
  if (engine === undefined) {
    throw databaseError("DB_CLOSED", "The database is closed.");
  }
  return engine;
}

export function valueAsString(value: unknown, field: string): string {
  if (typeof value === "string") return value;
  throw databaseError(
    "DB_CORRUPT_DATABASE",
    `The database has an invalid ${field} value.`,
    { field },
  );
}

export function valueAsBigInt(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^-?\d+$/u.test(value)) {
    return BigInt(value);
  }
  throw databaseError(
    "DB_CORRUPT_DATABASE",
    `The database has an invalid ${field} value.`,
    { field },
  );
}

export function valueAsNonNegativeBigInt(
  value: unknown,
  field: string,
): bigint {
  const parsed = valueAsBigInt(value, field);
  if (parsed >= 0n) return parsed;
  throw databaseError(
    "DB_CORRUPT_DATABASE",
    `The database has an invalid ${field} value.`,
    { field },
  );
}

export function valueAsPositiveBigInt(value: unknown, field: string): bigint {
  const parsed = valueAsBigInt(value, field);
  if (parsed > 0n) return parsed;
  throw databaseError(
    "DB_CORRUPT_DATABASE",
    `The database has an invalid ${field} value.`,
    { field },
  );
}

async function initializeMetadata(
  transaction: EngineTransaction,
  id: DatabaseId,
  format: DatabaseFormat,
): Promise<void> {
  await transaction.execute(
    `CREATE TABLE ${DATABASE_METADATA_TABLE} (database_id VARCHAR PRIMARY KEY, format VARCHAR NOT NULL, format_version BIGINT NOT NULL, revision BIGINT NOT NULL)`,
  );
  await transaction.execute(
    `INSERT INTO ${DATABASE_METADATA_TABLE} VALUES (?, ?, ?, ?)`,
    [id, format, BigInt(DATABASE_FILE_FORMAT_VERSION), 0n],
  );
  await transaction.execute(
    `CREATE TABLE ${TABLE_REGISTRY_TABLE} (table_name VARCHAR PRIMARY KEY, schema_json VARCHAR NOT NULL, schema_version BIGINT NOT NULL, next_record_id BIGINT NOT NULL)`,
  );
  await transaction.execute(
    `CREATE TABLE ${COUNTERS_TABLE} (counter_name VARCHAR PRIMARY KEY, next_value BIGINT NOT NULL)`,
  );
  for (const counter of [
    "source_file",
    "capture",
    "plan",
    "import",
    "delivery",
    "imported_row",
  ]) {
    await transaction.execute(`INSERT INTO ${COUNTERS_TABLE} VALUES (?, ?)`, [
      counter,
      1n,
    ]);
  }
  await transaction.execute(
    `CREATE TABLE ${SOURCE_CONTENT_TABLE} (content_hash VARCHAR PRIMARY KEY, byte_count BIGINT NOT NULL)`,
  );
  await transaction.execute(
    `CREATE TABLE ${SOURCE_FILE_TABLE} (source_file_id VARCHAR PRIMARY KEY, content_hash VARCHAR NOT NULL, display_name VARCHAR NOT NULL, UNIQUE(content_hash))`,
  );
  await transaction.execute(
    `CREATE TABLE ${SOURCE_NAME_TABLE} (source_file_id VARCHAR NOT NULL, display_name VARCHAR NOT NULL, PRIMARY KEY(source_file_id, display_name))`,
  );
  await transaction.execute(
    `CREATE TABLE ${CAPTURE_TABLE} (capture_id VARCHAR PRIMARY KEY, source_file_id VARCHAR NOT NULL, source_key VARCHAR NOT NULL, selection_key VARCHAR NOT NULL, selection_label VARCHAR NOT NULL, reader_version VARCHAR NOT NULL, state VARCHAR NOT NULL, row_count BIGINT NOT NULL, columns_json VARCHAR NOT NULL, UNIQUE(source_file_id, selection_key, reader_version))`,
  );
  await transaction.execute(
    `CREATE TABLE ${PLAN_TABLE} (plan_id VARCHAR NOT NULL, plan_revision BIGINT NOT NULL, baseline_revision BIGINT NOT NULL, state VARCHAR NOT NULL, recipe_json VARCHAR NOT NULL, conflicts_json VARCHAR NOT NULL, decisions_json VARCHAR NOT NULL, bindings_json VARCHAR NOT NULL, PRIMARY KEY(plan_id, plan_revision))`,
  );
  await transaction.execute(
    format === "duckdb"
      ? `CREATE TABLE ${CAPTURE_ROW_TABLE} (capture_id VARCHAR NOT NULL, source_row BIGINT NOT NULL, values_json VARCHAR NOT NULL)`
      : `CREATE TABLE ${CAPTURE_ROW_TABLE} (capture_id VARCHAR NOT NULL, source_row BIGINT NOT NULL, values_json VARCHAR NOT NULL, PRIMARY KEY(capture_id, source_row))`,
  );
  await transaction.execute(
    `CREATE TABLE ${APPLICATION_TABLE} (import_id VARCHAR PRIMARY KEY, application_key VARCHAR NOT NULL UNIQUE, request_id VARCHAR NOT NULL, capture_id VARCHAR NOT NULL, table_name VARCHAR NOT NULL, plan_id VARCHAR NOT NULL, plan_revision BIGINT NOT NULL, row_count BIGINT NOT NULL, UNIQUE(request_id, capture_id, table_name))`,
  );
  await transaction.execute(
    `CREATE TABLE ${IMPORT_REQUEST_TABLE} (request_id VARCHAR PRIMARY KEY, plan_id VARCHAR NOT NULL, plan_revision BIGINT NOT NULL, import_ids_json VARCHAR NOT NULL, capture_ids_json VARCHAR NOT NULL, row_count BIGINT NOT NULL)`,
  );
  await transaction.execute(
    `CREATE TABLE ${DELIVERY_TABLE} (delivery_id VARCHAR PRIMARY KEY, request_id VARCHAR NOT NULL UNIQUE, context_json VARCHAR NOT NULL)`,
  );
  await transaction.execute(
    `CREATE TABLE ${DELIVERY_MEMBERSHIP_TABLE} (delivery_id VARCHAR NOT NULL, capture_id VARCHAR NOT NULL, PRIMARY KEY(delivery_id, capture_id))`,
  );
}

export async function createDatabaseHandle(
  engine: DatabaseEngine,
): Promise<Database> {
  const id = `DB-${globalThis.crypto.randomUUID()}` as DatabaseId;
  await engine.transaction(async (transaction) => {
    await initializeMetadata(transaction, id, engine.format);
  });
  return new ManagedDatabase(id, engine);
}

export async function openDatabaseHandle(
  engine: DatabaseEngine,
): Promise<Database> {
  const metadataTables = await queryDatabaseMetadata(
    engine,
    engine.format === "sqlite"
      ? "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1"
      : "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND table_type = 'BASE TABLE' AND table_name = ? LIMIT 1",
    [DATABASE_METADATA_TABLE],
  );
  if (metadataTables.length === 0) {
    throw databaseError(
      "DB_NOT_A_DATABASE",
      "This file is not a supported ConsultChimps database.",
    );
  }
  const versionRows = await queryDatabaseMetadata(
    engine,
    `SELECT format_version FROM ${DATABASE_METADATA_TABLE}`,
  );
  const versionRow = versionRows[0];
  if (versionRow === undefined || versionRows.length !== 1) {
    throw databaseError(
      "DB_CORRUPT_DATABASE",
      "The database metadata is missing or duplicated. Restore a verified database copy before retrying.",
    );
  }
  const version = valueAsBigInt(versionRow["format_version"], "format version");
  if (version !== BigInt(DATABASE_FILE_FORMAT_VERSION)) {
    throw databaseError(
      "DB_UNSUPPORTED_FORMAT_VERSION",
      `This database uses format version ${version}, but this build supports version ${DATABASE_FILE_FORMAT_VERSION}.`,
      {
        fileVersion: version.toString(),
        supportedVersion: DATABASE_FILE_FORMAT_VERSION,
      },
    );
  }
  await validateDatabaseLayout(engine);
  const rows = await queryDatabaseMetadata(
    engine,
    `SELECT database_id, format, revision FROM ${DATABASE_METADATA_TABLE}`,
  );
  const row = rows[0];
  if (row === undefined || rows.length !== 1) {
    throw databaseError(
      "DB_CORRUPT_DATABASE",
      "The database metadata is missing or duplicated. Restore a verified database copy before retrying.",
    );
  }
  const format = valueAsString(row["format"], "format");
  if (format !== engine.format) {
    throw databaseError(
      "DB_FORMAT_MISMATCH",
      `The file contains a ${format} database, but the ${engine.format} engine opened it.`,
      { expected: engine.format, actual: format },
    );
  }
  const databaseId = valueAsString(row["database_id"], "database ID");
  if (databaseId.trim().length === 0) {
    throw databaseError(
      "DB_CORRUPT_DATABASE",
      "The database has an invalid database ID value.",
      { field: "database ID" },
    );
  }
  valueAsNonNegativeBigInt(row["revision"], "revision");
  await validateRegisteredTables(engine, engine.format, {
    allowExtraColumns: true,
  });
  return new ManagedDatabase(databaseId as DatabaseId, engine);
}

export async function inspectDatabase(options: {
  readonly database: Database;
}): Promise<DatabaseInspection> {
  const engine = engineOf(options.database);
  return engine.readTransaction(async (transaction) => {
    await validateRegisteredTables(transaction, options.database.format, {
      allowExtraColumns: true,
    });
    const metadataRows = await transaction.query(
      `SELECT format_version, revision FROM ${DATABASE_METADATA_TABLE}`,
    );
    const registryRows = await transaction.query(
      `SELECT table_name, schema_json FROM ${TABLE_REGISTRY_TABLE} ORDER BY table_name`,
    );
    const captureRows = await transaction.query(
      `SELECT count(*) AS count FROM ${CAPTURE_TABLE}`,
    );
    const applicationRows = await transaction.query(
      `SELECT count(*) AS count FROM ${APPLICATION_TABLE}`,
    );
    const deliveryRows = await transaction.query(
      `SELECT count(*) AS count FROM ${DELIVERY_TABLE}`,
    );
    const planRows = await transaction.query(
      `SELECT count(*) AS count FROM ${PLAN_TABLE}`,
    );
    const metadata = metadataRows[0];
    if (metadata === undefined || metadataRows.length !== 1) {
      throw databaseError(
        "DB_CORRUPT_DATABASE",
        "The database metadata is missing or duplicated.",
      );
    }
    const tables: DatabaseTableSummary[] = [];
    for (const registry of registryRows) {
      const name = valueAsString(registry["table_name"], "table name");
      const schemaText = valueAsString(registry["schema_json"], "table schema");
      const schema = parseStoredTableSchema(schemaText, name);
      const countRows = await transaction.query(
        `SELECT count(*) AS count FROM ${quoteIdentifier(name)}`,
      );
      tables.push({
        name,
        schema,
        rowCount: valueAsBigInt(countRows[0]?.["count"], "row count"),
      });
    }
    const formatVersion = valueAsBigInt(
      metadata["format_version"],
      "format version",
    );
    if (formatVersion > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw databaseError(
        "DB_CORRUPT_DATABASE",
        "The database format version is outside the supported integer range.",
      );
    }
    return {
      id: options.database.id,
      format: options.database.format,
      formatVersion: Number(formatVersion),
      revision: valueAsNonNegativeBigInt(metadata["revision"], "revision"),
      tables,
      captures: valueAsBigInt(captureRows[0]?.["count"], "capture count"),
      completedImports: valueAsBigInt(
        applicationRows[0]?.["count"],
        "import count",
      ),
      deliveries: valueAsBigInt(deliveryRows[0]?.["count"], "delivery count"),
      appliedImportPlans: valueAsBigInt(
        planRows[0]?.["count"],
        "applied import plan count",
      ),
    };
  });
}

export interface CreateDatabaseResult {
  readonly database: Database;
  readonly result: OperationResult<"tablesCreated">;
}

export async function initializeSchema(
  database: Database,
  schema: DatabaseSchema | undefined,
): Promise<number> {
  if (schema === undefined) return 0;
  const { applySchema, planSchema } = await import("./records.js");
  const plan = await planSchema({ database, schema });
  await applySchema({ database, plan });
  return plan.creates.length;
}
