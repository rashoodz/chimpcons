import {
  AsyncDuckDB,
  DuckDBAccessMode,
  DuckDBDataProtocol,
  VoidLogger,
  type AsyncDuckDBConnection,
} from "@duckdb/duckdb-wasm/dist/duckdb-browser";

import { throwIfAborted } from "@consultchimps/core";
import type { RandomAccessFile } from "@consultchimps/core";

import type {
  DatabaseEngine,
  EngineRow,
  EngineTransaction,
  EngineValue,
} from "../../internal/engine.js";
import { quoteIdentifier } from "../../schema.js";

function normalizeValue(value: unknown): EngineValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean" ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function normalizeRow(value: unknown): EngineRow {
  const source =
    typeof value === "object" && value !== null && "toJSON" in value
      ? (value as { toJSON(): unknown }).toJSON()
      : value;
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    throw new Error("DuckDB returned a row in an unsupported shape");
  }
  const row: Record<string, EngineValue> = Object.create(null);
  for (const [name, cell] of Object.entries(source)) {
    row[name] = normalizeValue(cell);
  }
  return row;
}

export interface BrowserDuckDbEngineOptions {
  readonly wasmUrl: string;
  readonly workerUrl: string;
  readonly storageName: string;
  readonly fileHandle: BrowserFileHandle;
  readonly walHandle: BrowserFileHandle;
  readonly readonly?: boolean | undefined;
}

interface BrowserFile {
  readonly size: number;
  slice(start?: number, end?: number): Blob;
}

export interface BrowserFileHandle {
  getFile(): Promise<BrowserFile>;
}

export class BrowserDuckDbEngine implements DatabaseEngine {
  readonly format = "duckdb" as const;
  readonly interruptible = true;
  readonly #database: AsyncDuckDB;
  readonly #connection: AsyncDuckDBConnection;
  readonly #fileHandle: BrowserFileHandle;
  readonly #readonly: boolean;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  private constructor(
    database: AsyncDuckDB,
    connection: AsyncDuckDBConnection,
    fileHandle: BrowserFileHandle,
    readonly: boolean,
  ) {
    this.#database = database;
    this.#connection = connection;
    this.#fileHandle = fileHandle;
    this.#readonly = readonly;
  }

  static async open(
    options: BrowserDuckDbEngineOptions,
  ): Promise<BrowserDuckDbEngine> {
    type DuckWorker = NonNullable<ConstructorParameters<typeof AsyncDuckDB>[1]>;
    const WorkerConstructor = (
      globalThis as unknown as {
        readonly Worker: new (
          url: string,
          options: { readonly type: "classic" },
        ) => DuckWorker;
      }
    ).Worker;
    const worker = new WorkerConstructor(options.workerUrl, {
      type: "classic",
    });
    const database = new AsyncDuckDB(new VoidLogger(), worker);
    try {
      await database.instantiate(options.wasmUrl);
      await database.registerFileHandle(
        options.storageName,
        options.fileHandle,
        DuckDBDataProtocol.BROWSER_FSACCESS,
        true,
      );
      await database.registerFileHandle(
        `${options.storageName}.wal`,
        options.walHandle,
        DuckDBDataProtocol.BROWSER_FSACCESS,
        true,
      );
      await database.open({
        path: options.storageName,
        accessMode:
          options.readonly === true
            ? DuckDBAccessMode.READ_ONLY
            : DuckDBAccessMode.READ_WRITE,
        useDirectIO: true,
        arrowLosslessConversion: true,
      });
      return new BrowserDuckDbEngine(
        database,
        await database.connect(),
        options.fileHandle,
        options.readonly === true,
      );
    } catch (error) {
      await database.terminate().catch(() => undefined);
      throw error;
    }
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

  async #run(
    sql: string,
    values: readonly EngineValue[] = [],
  ): Promise<unknown> {
    if (values.length === 0) return this.#connection.query(sql);
    const statement = await this.#connection.prepare(sql);
    try {
      return await statement.query(
        ...values.map((value) =>
          typeof value === "bigint" ? value.toString() : value,
        ),
      );
    } finally {
      await statement.close();
    }
  }

  async #execute(
    sql: string,
    values: readonly EngineValue[] = [],
  ): Promise<void> {
    await this.#run(sql, values);
  }

  async #query(
    sql: string,
    values: readonly EngineValue[] = [],
  ): Promise<readonly EngineRow[]> {
    const table = await this.#run(sql, values);
    if (
      typeof table !== "object" ||
      table === null ||
      !("toArray" in table) ||
      typeof table.toArray !== "function"
    ) {
      throw new Error("DuckDB did not return a table");
    }
    return (table.toArray() as readonly unknown[]).map(normalizeRow);
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

  async #bulkInsert(options: {
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
    await this.#exclusive(async () => {
      if (!this.#readonly) await this.#execute("CHECKPOINT");
    });
  }

  interrupt(): void {
    void this.#connection.cancelSent();
  }

  async copyTo(
    destination: RandomAccessFile,
    signal?: AbortSignal,
  ): Promise<number> {
    return this.#exclusive(async () => {
      if (!this.#readonly) await this.#execute("CHECKPOINT");
      await this.#database.flushFiles();
      const file = await this.#fileHandle.getFile();
      const chunkSize = 1024 * 1024;
      await destination.truncate(0);
      for (let offset = 0; offset < file.size; offset += chunkSize) {
        throwIfAborted(signal, "db.export");
        const bytes = new Uint8Array(
          await file.slice(offset, offset + chunkSize).arrayBuffer(),
        );
        await destination.writeAt(offset, bytes);
      }
      await destination.truncate(file.size);
      return file.size;
    });
  }

  async close(): Promise<void> {
    await this.#exclusive(async () => {
      const failures: unknown[] = [];
      const attempt = async (work: () => Promise<unknown>): Promise<void> => {
        try {
          await work();
        } catch (error) {
          failures.push(error);
        }
      };
      if (!this.#readonly) {
        await attempt(() => this.#execute("CHECKPOINT"));
      }
      await attempt(() => this.#connection.close());
      await attempt(() => this.#database.flushFiles());
      await attempt(() => this.#database.terminate());
      this.#closed = true;
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          "DuckDB failed while closing the browser database.",
        );
      }
    });
  }
}
