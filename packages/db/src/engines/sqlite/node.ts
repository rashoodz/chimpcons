import BetterSqlite3 from "better-sqlite3";

import { throwIfAborted } from "@consultchimps/core";

import type {
  DatabaseEngine,
  EngineRow,
  EngineTransaction,
  EngineValue,
} from "../../internal/engine.js";
import { quoteIdentifier } from "../../schema.js";

function sqliteValue(
  value: EngineValue,
): null | string | number | bigint | Buffer {
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

function normalizeRow(row: Record<string, unknown>): EngineRow {
  const normalized: Record<string, EngineValue> = Object.create(null);
  for (const [name, value] of Object.entries(row)) {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "bigint"
    ) {
      normalized[name] = value;
    } else if (value instanceof Uint8Array) {
      normalized[name] = new Uint8Array(value);
    } else {
      normalized[name] = String(value);
    }
  }
  return normalized;
}

export class NodeSqliteEngine implements DatabaseEngine {
  readonly format = "sqlite" as const;
  readonly interruptible = false;
  readonly #database: BetterSqlite3.Database;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  private constructor(database: BetterSqlite3.Database, readonly: boolean) {
    this.#database = database;
    if (!readonly) database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    database.defaultSafeIntegers(true);
  }

  static create(path: string): NodeSqliteEngine {
    return new NodeSqliteEngine(new BetterSqlite3(path), false);
  }

  static open(path: string, readonly = false): NodeSqliteEngine {
    return new NodeSqliteEngine(
      new BetterSqlite3(path, { fileMustExist: true, readonly }),
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
      if (this.#closed) throw new Error("SQLite engine is closed");
      return await work();
    } finally {
      release();
    }
  }

  #execute(sql: string, values: readonly EngineValue[] = []): void {
    this.#database.prepare(sql).run(...values.map(sqliteValue));
  }

  #query(
    sql: string,
    values: readonly EngineValue[] = [],
  ): readonly EngineRow[] {
    return this.#database
      .prepare(sql)
      .all(...values.map(sqliteValue))
      .map((row) => normalizeRow(row as Record<string, unknown>));
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

  async bulkInsert(options: {
    readonly table: string;
    readonly columns: readonly string[];
    readonly rows: readonly (readonly EngineValue[])[];
    readonly signal?: AbortSignal | undefined;
  }): Promise<void> {
    await this.#exclusive(async () => this.#bulkInsert(options));
  }

  #bulkInsert(options: {
    readonly table: string;
    readonly columns: readonly string[];
    readonly rows: readonly (readonly EngineValue[])[];
    readonly signal?: AbortSignal | undefined;
  }): void {
    const placeholders = options.columns.map(() => "?").join(", ");
    const statement = this.#database.prepare(
      `INSERT INTO ${quoteIdentifier(options.table)} (${options.columns
        .map(quoteIdentifier)
        .join(", ")}) VALUES (${placeholders})`,
    );
    for (const row of options.rows) {
      throwIfAborted(options.signal, "db.bulk-insert");
      statement.run(...row.map(sqliteValue));
    }
  }

  async transaction<T>(
    work: (transaction: EngineTransaction) => Promise<T>,
  ): Promise<T> {
    return this.#exclusive(async () => {
      this.#database.exec("BEGIN IMMEDIATE");
      const transaction: EngineTransaction = {
        execute: async (sql, values) => this.#execute(sql, values),
        query: async (sql, values) => this.#query(sql, values),
        bulkInsert: async (options) => this.#bulkInsert(options),
      };
      try {
        const result = await work(transaction);
        this.#database.exec("COMMIT");
        return result;
      } catch (error) {
        if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
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
        bulkInsert: async (options) => this.#bulkInsert(options),
      };
      try {
        const result = await work(transaction);
        this.#database.exec("COMMIT");
        return result;
      } catch (error) {
        if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async checkpoint(): Promise<void> {
    await this.#exclusive(async () => {
      this.#database.pragma("wal_checkpoint(TRUNCATE)");
    });
  }

  async backupTo(destination: string): Promise<void> {
    await this.#exclusive(async () => {
      await this.#database.backup(destination);
    });
  }

  interrupt(): void {
    const database = this.#database as BetterSqlite3.Database & {
      interrupt?: () => void;
    };
    database.interrupt?.();
  }

  async close(): Promise<void> {
    await this.#exclusive(async () => {
      this.#database.close();
      this.#closed = true;
    });
  }
}
