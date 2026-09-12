import {
  blobValue,
  DuckDBBlobValue,
  DuckDBInstance,
  type DuckDBConnection,
  type DuckDBValue,
} from "@duckdb/node-api";

import { throwIfAborted } from "@consultchimps/core";

import type {
  DatabaseEngine,
  EngineRow,
  EngineTransaction,
  EngineValue,
} from "../../internal/engine.js";
import { quoteIdentifier } from "../../schema.js";

const APPENDER_FLUSH_ROWS = 2_048;

function quoteStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function copyDatabase(
  connection: DuckDBConnection,
  source: string,
  destination: string,
): Promise<void> {
  const destinationName = `cc_export_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
  const quotedDestinationName = quoteIdentifier(destinationName);
  let attached = false;
  try {
    await connection.run(
      `ATTACH ${quoteStringLiteral(destination)} AS ${quotedDestinationName}`,
    );
    attached = true;
    await connection.run(
      `COPY FROM DATABASE ${quoteIdentifier(source)} TO ${quotedDestinationName}`,
    );
    await connection.run(`DETACH ${quotedDestinationName}`);
    attached = false;
  } catch (error) {
    if (attached) {
      try {
        await connection.run(`DETACH ${quotedDestinationName}`);
      } catch {
        // Preserve the copy failure while releasing the attached destination when possible.
      }
    }
    throw error;
  }
}

function normalizeValue(value: DuckDBValue): EngineValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (value instanceof DuckDBBlobValue) {
    return new Uint8Array(value.bytes);
  }
  return value.toString();
}

function normalizeRows(
  rows: readonly Record<string, DuckDBValue>[],
): EngineRow[] {
  return rows.map((row) => {
    const normalized: Record<string, EngineValue> = Object.create(null);
    for (const [name, value] of Object.entries(row)) {
      normalized[name] = normalizeValue(value);
    }
    return normalized;
  });
}

function duckDbValue(value: EngineValue): DuckDBValue {
  return value instanceof Uint8Array ? blobValue(value) : value;
}

export class NodeDuckDbEngine implements DatabaseEngine {
  readonly format = "duckdb" as const;
  readonly interruptible = true;
  readonly #instance: DuckDBInstance;
  readonly #connection: DuckDBConnection;
  readonly #path: string;
  readonly #readonly: boolean;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  private constructor(
    instance: DuckDBInstance,
    connection: DuckDBConnection,
    path: string,
    readonly: boolean,
  ) {
    this.#instance = instance;
    this.#connection = connection;
    this.#path = path;
    this.#readonly = readonly;
  }

  static async create(
    path: string,
    readonly = false,
  ): Promise<NodeDuckDbEngine> {
    const instance = await DuckDBInstance.create(path, {
      access_mode: readonly ? "READ_ONLY" : "READ_WRITE",
    });
    return new NodeDuckDbEngine(
      instance,
      await instance.connect(),
      path,
      readonly,
    );
  }

  async #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release: () => void = () => undefined;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (this.#closed) throw new Error("DuckDB engine is closed");
      return await work();
    } finally {
      release();
    }
  }

  async #execute(
    sql: string,
    values: readonly EngineValue[] = [],
  ): Promise<void> {
    await this.#connection.run(sql, values.map(duckDbValue));
  }

  async #query(
    sql: string,
    values: readonly EngineValue[] = [],
  ): Promise<readonly EngineRow[]> {
    const reader = await this.#connection.runAndReadAll(
      sql,
      values.map(duckDbValue),
    );
    return normalizeRows(reader.getRowObjects());
  }

  async execute(sql: string, values?: readonly EngineValue[]): Promise<void> {
    await this.#exclusive(() => this.#execute(sql, values));
  }

  async query(
    sql: string,
    values?: readonly EngineValue[],
  ): Promise<readonly EngineRow[]> {
    return this.#exclusive(() => this.#query(sql, values));
  }

  async #insertWithSql(options: {
    readonly table: string;
    readonly columns: readonly string[];
    readonly rows: readonly (readonly EngineValue[])[];
    readonly signal?: AbortSignal | undefined;
  }): Promise<void> {
    if (options.rows.length === 0) return;
    const quotedColumns = options.columns.map(quoteIdentifier).join(", ");
    const rowSql = `(${options.columns.map(() => "?").join(", ")})`;
    const maximumRows = Math.max(1, Math.floor(1000 / options.columns.length));
    for (let offset = 0; offset < options.rows.length; offset += maximumRows) {
      throwIfAborted(options.signal, "db.bulk-insert");
      const batch = options.rows.slice(offset, offset + maximumRows);
      await this.#execute(
        `INSERT INTO ${quoteIdentifier(options.table)} (${quotedColumns}) VALUES ${batch
          .map(() => rowSql)
          .join(", ")}`,
        batch.flat(),
      );
    }
  }

  async #tableColumns(table: string): Promise<readonly string[]> {
    const rows = await this.#query(
      "SELECT name FROM pragma_table_info(?) ORDER BY cid",
      [table],
    );
    return rows.map((row) => {
      const name = row["name"];
      if (typeof name !== "string") {
        throw new Error("DuckDB returned an invalid table column name");
      }
      return name;
    });
  }

  async #bulkInsert(options: {
    readonly table: string;
    readonly columns: readonly string[];
    readonly rows: readonly (readonly EngineValue[])[];
    readonly signal?: AbortSignal | undefined;
  }): Promise<void> {
    if (options.rows.length === 0) return;
    if (options.columns.length === 0) {
      throw new Error("Bulk insertion requires at least one column");
    }
    for (const row of options.rows) {
      if (row.length !== options.columns.length) {
        throw new Error(
          `Bulk insertion received ${row.length} values for ${options.columns.length} columns`,
        );
      }
    }
    throwIfAborted(options.signal, "db.bulk-insert");
    const tableColumns = await this.#tableColumns(options.table);
    const appenderCompatible =
      tableColumns.length === options.columns.length &&
      tableColumns.every((column, index) => column === options.columns[index]);
    if (!appenderCompatible) {
      await this.#insertWithSql(options);
      return;
    }

    const appender = await this.#connection.createAppender(options.table);
    try {
      for (let index = 0; index < options.rows.length; index += 1) {
        if (index % APPENDER_FLUSH_ROWS === 0) {
          throwIfAborted(options.signal, "db.bulk-insert");
        }
        const row = options.rows[index];
        if (row === undefined) continue;
        for (const value of row) appender.appendValue(duckDbValue(value));
        appender.endRow();
        if ((index + 1) % APPENDER_FLUSH_ROWS === 0) {
          appender.flushSync();
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
      throwIfAborted(options.signal, "db.bulk-insert");
      appender.closeSync();
    } catch (error) {
      try {
        appender.closeSync();
      } catch {
        // Keep the insertion or cancellation error that caused cleanup.
      }
      throw error;
    }
  }

  async bulkInsert(options: {
    readonly table: string;
    readonly columns: readonly string[];
    readonly rows: readonly (readonly EngineValue[])[];
    readonly signal?: AbortSignal | undefined;
  }): Promise<void> {
    await this.#exclusive(() => this.#bulkInsert(options));
  }

  async transaction<T>(
    work: (transaction: EngineTransaction) => Promise<T>,
  ): Promise<T> {
    return this.#exclusive(async () => {
      await this.#execute("BEGIN TRANSACTION");
      const transaction: EngineTransaction = {
        execute: (sql, values) => this.#execute(sql, values),
        query: (sql, values) => this.#query(sql, values),
        bulkInsert: (options) => this.#bulkInsert(options),
      };
      try {
        const result = await work(transaction);
        await this.#execute("COMMIT");
        return result;
      } catch (error) {
        await this.#execute("ROLLBACK");
        throw error;
      }
    });
  }

  async readTransaction<T>(
    work: (transaction: EngineTransaction) => Promise<T>,
  ): Promise<T> {
    return this.transaction(work);
  }

  async checkpoint(): Promise<void> {
    await this.#exclusive(() => this.#execute("CHECKPOINT"));
  }

  async copyTo(destination: string): Promise<void> {
    await this.#exclusive(async () => {
      if (!this.#readonly) {
        await this.#execute("CHECKPOINT");
        const rows = await this.#query(
          "SELECT current_database() AS database_name",
        );
        const source = rows[0]?.["database_name"];
        if (typeof source !== "string") {
          throw new Error("DuckDB returned an invalid database name");
        }
        await copyDatabase(this.#connection, source, destination);
        return;
      }

      const instance = await DuckDBInstance.create(":memory:");
      const connection = await instance.connect();
      const sourceName = `cc_source_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
      try {
        await connection.run(
          `ATTACH ${quoteStringLiteral(this.#path)} AS ${quoteIdentifier(sourceName)} (READ_ONLY)`,
        );
        await copyDatabase(connection, sourceName, destination);
        await connection.run(`DETACH ${quoteIdentifier(sourceName)}`);
      } finally {
        connection.closeSync();
        instance.closeSync();
      }
    });
  }

  interrupt(): void {
    this.#connection.interrupt();
  }

  async close(): Promise<void> {
    await this.#exclusive(async () => {
      this.#connection.closeSync();
      this.#instance.closeSync();
      this.#closed = true;
    });
  }
}
