import type {
  BindableValue,
  Database as SqliteDatabase,
  SqlValue,
  Sqlite3Static,
} from "@sqlite.org/sqlite-wasm";

import { throwIfAborted } from "@consultchimps/core";

import type {
  DatabaseEngine,
  EngineRow,
  EngineTransaction,
  EngineValue,
} from "../../internal/engine.js";
import { quoteIdentifier } from "../../schema.js";

function sqliteValue(value: EngineValue): BindableValue {
  return value;
}

function engineValue(value: SqlValue): EngineValue {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Int8Array) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return value;
}

export class BrowserSqliteEngine implements DatabaseEngine {
  readonly format = "sqlite" as const;
  readonly interruptible = false;
  readonly #sqlite: Sqlite3Static;
  readonly #database: SqliteDatabase;
  readonly #readonly: boolean;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(
    sqlite: Sqlite3Static,
    database: SqliteDatabase,
    readonly = false,
  ) {
    this.#sqlite = sqlite;
    this.#database = database;
    this.#readonly = readonly;
    database.exec("PRAGMA foreign_keys = ON");
    if (readonly) database.exec("PRAGMA query_only = ON");
  }

  async #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release: () => void = () => undefined;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (this.#closed) throw new Error("SQLite engine is closed");
      return await work();
    } finally {
      release();
    }
  }

  #execute(sql: string, values: readonly EngineValue[] = []): void {
    this.#database.exec({
      sql,
      bind: values.map(sqliteValue),
      returnValue: "this",
    });
  }

  #query(
    sql: string,
    values: readonly EngineValue[] = [],
  ): readonly EngineRow[] {
    const rows = this.#database.exec({
      sql,
      bind: values.map(sqliteValue),
      rowMode: "object",
      returnValue: "resultRows",
    });
    return rows.map((row) => {
      const result: Record<string, EngineValue> = Object.create(null);
      for (const [name, value] of Object.entries(row)) {
        result[name] = engineValue(value);
      }
      return result;
    });
  }

  async execute(sql: string, values?: readonly EngineValue[]): Promise<void> {
    await this.#exclusive(async () => this.#execute(sql, values));
  }

  async query(
    sql: string,
    values?: readonly EngineValue[],
  ): Promise<readonly EngineRow[]> {
    return this.#exclusive(async () => this.#query(sql, values));
  }

  async #bulkInsert(options: {
    readonly table: string;
    readonly columns: readonly string[];
    readonly rows: readonly (readonly EngineValue[])[];
    readonly signal?: AbortSignal | undefined;
  }): Promise<void> {
    const sql = `INSERT INTO ${quoteIdentifier(options.table)} (${options.columns
      .map(quoteIdentifier)
      .join(", ")}) VALUES (${options.columns.map(() => "?").join(", ")})`;
    const statement = this.#database.prepare(sql);
    try {
      for (const [index, row] of options.rows.entries()) {
        throwIfAborted(options.signal, "db.bulk-insert");
        statement.bind(row.map(sqliteValue)).stepReset();
        if ((index + 1) % 256 === 0) {
          await new Promise<void>((resolve) =>
            globalThis.setTimeout(resolve, 0),
          );
        }
      }
    } finally {
      statement.finalize();
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
      this.#database.exec("BEGIN IMMEDIATE");
      const transaction: EngineTransaction = {
        execute: async (sql, values) => this.#execute(sql, values),
        query: async (sql, values) => this.#query(sql, values),
        bulkInsert: (options) => this.#bulkInsert(options),
      };
      try {
        const result = await work(transaction);
        this.#database.exec("COMMIT");
        return result;
      } catch (error) {
        this.#database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async readTransaction<T>(
    work: (transaction: EngineTransaction) => Promise<T>,
  ): Promise<T> {
    return this.#exclusive(async () => {
      this.#database.exec("BEGIN");
      const transaction: EngineTransaction = {
        execute: async (sql, values) => this.#execute(sql, values),
        query: async (sql, values) => this.#query(sql, values),
        bulkInsert: (options) => this.#bulkInsert(options),
      };
      try {
        const result = await work(transaction);
        this.#database.exec("COMMIT");
        return result;
      } catch (error) {
        this.#database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async checkpoint(): Promise<void> {
    await this.#exclusive(async () => {
      if (!this.#readonly) this.#database.exec("PRAGMA optimize");
    });
  }

  interrupt(): void {
    const pointer = this.#database.pointer;
    if (pointer !== undefined) this.#sqlite.capi.sqlite3_interrupt(pointer);
  }

  async close(): Promise<void> {
    await this.#exclusive(async () => {
      this.#database.close();
      this.#closed = true;
    });
  }
}
