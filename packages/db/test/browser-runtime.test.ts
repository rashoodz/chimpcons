import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import type {
  Database as SqliteDatabase,
  Sqlite3Static,
} from "@sqlite.org/sqlite-wasm";
import type * as SqliteWasmModule from "@sqlite.org/sqlite-wasm";

import type { RandomAccessFile, RandomAccessSource } from "@consultchimps/core";

import { inspectDatabase } from "../src/database.js";
import { applySchema, planSchema } from "../src/records.js";
import type {
  BrowserDatabaseRuntime,
  BrowserDatabaseRuntimeOptions,
} from "../src/browser.js";

const SQLITE_HEADER = new TextEncoder().encode("SQLite format 3\0");
const SAH_HEADER_BYTES = 4096;
const SAH_PATH_BYTES = 512;

type SqliteDatabaseConstructor = new (
  options?:
    | string
    | {
        readonly filename?: string;
        readonly flags?: string;
        readonly vfs?: string;
      },
  flags?: string,
) => SqliteDatabase;

class MemoryFile implements RandomAccessFile {
  readonly name: string;
  #bytes = new Uint8Array();

  constructor(name: string, bytes?: Uint8Array) {
    this.name = name;
    if (bytes !== undefined) this.#bytes = bytes.slice();
  }

  get size(): number {
    return this.#bytes.byteLength;
  }

  async readAt(offset: number, length: number): Promise<Uint8Array> {
    return this.#bytes.slice(offset, offset + length);
  }

  async writeAt(offset: number, bytes: Uint8Array): Promise<void> {
    const end = offset + bytes.byteLength;
    if (end > this.#bytes.byteLength) {
      const expanded = new Uint8Array(end);
      expanded.set(this.#bytes);
      this.#bytes = expanded;
    }
    this.#bytes.set(bytes, offset);
  }

  async truncate(size: number): Promise<void> {
    const resized = new Uint8Array(size);
    resized.set(this.#bytes.subarray(0, size));
    this.#bytes = resized;
  }

  async close(): Promise<void> {}

  bytes(): Uint8Array {
    return this.#bytes.slice();
  }
}

class MemoryFileHandle {
  readonly kind = "file" as const;
  readonly name: string;
  #bytes = new Uint8Array();

  constructor(name: string) {
    this.name = name;
  }

  replace(bytes: Uint8Array): void {
    this.#bytes = bytes.slice();
  }

  async getFile(): Promise<Blob> {
    return new Blob([this.#bytes]);
  }

  async createWritable() {
    let next = this.#bytes.slice();
    return {
      async write(write: {
        readonly position: number;
        readonly data: Uint8Array;
      }) {
        const end = write.position + write.data.byteLength;
        if (end > next.byteLength) {
          const expanded = new Uint8Array(end);
          expanded.set(next);
          next = expanded;
        }
        next.set(write.data, write.position);
      },
      async truncate(size: number) {
        const resized = new Uint8Array(size);
        resized.set(next.subarray(0, size));
        next = resized;
      },
      close: async () => {
        this.#bytes = next;
      },
      async abort() {},
    };
  }
}

class MemoryDirectoryHandle {
  readonly kind = "directory" as const;
  readonly name: string;
  readonly directories = new Map<string, MemoryDirectoryHandle>();
  readonly files = new Map<string, MemoryFileHandle>();

  constructor(name: string) {
    this.name = name;
  }

  async *values(): AsyncIterableIterator<
    MemoryDirectoryHandle | MemoryFileHandle
  > {
    yield* this.directories.values();
    yield* this.files.values();
  }

  async getDirectoryHandle(
    name: string,
    options?: { readonly create?: boolean },
  ): Promise<MemoryDirectoryHandle> {
    const existing = this.directories.get(name);
    if (existing !== undefined) return existing;
    if (options?.create !== true) throw notFound();
    const created = new MemoryDirectoryHandle(name);
    this.directories.set(name, created);
    return created;
  }

  async getFileHandle(
    name: string,
    options?: { readonly create?: boolean },
  ): Promise<MemoryFileHandle> {
    const existing = this.files.get(name);
    if (existing !== undefined) return existing;
    if (options?.create !== true) throw notFound();
    const created = new MemoryFileHandle(name);
    this.files.set(name, created);
    return created;
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.files.delete(name) && !this.directories.delete(name)) {
      throw notFound();
    }
  }
}

function notFound(): DOMException {
  return new DOMException("Missing test entry", "NotFoundError");
}

class SqlitePoolHarness {
  readonly root = new MemoryDirectoryHandle("root");
  readonly databases = new Map<string, Uint8Array>();
  readonly openFlags = new Map<string, string[]>();
  #sqlite: Sqlite3Static | undefined;
  #nativeDatabase: SqliteDatabaseConstructor | undefined;
  #opaque: MemoryDirectoryHandle | undefined;
  #nextSlot = 1;
  readonly #slots = new Map<string, string>();
  failNextImportName: string | undefined;
  failNextUnlinkName: string | undefined;
  failNextSqlContaining: string | undefined;

  async install(
    sqlite: Sqlite3Static,
    directoryPath: string,
    nativeDatabase: SqliteDatabaseConstructor,
  ) {
    this.#sqlite = sqlite;
    this.#nativeDatabase = nativeDatabase;
    let directory = this.root;
    for (const segment of directoryPath.split("/").filter(Boolean)) {
      directory = await directory.getDirectoryHandle(segment, { create: true });
    }
    this.#opaque = await directory.getDirectoryHandle(".opaque", {
      create: true,
    });
    const openDatabase = this.openDatabase.bind(this);
    function OpfsSAHPoolDb(filename: string, flags?: string) {
      return openDatabase(filename, flags);
    }
    return {
      OpfsSAHPoolDb,
      vfsName: "test-sahpool",
      getFileNames: () => [...this.databases.keys()],
      getFileCount: () => this.databases.size,
      reserveMinimumCapacity: async (minimum: number) => minimum,
      importDb: async (
        name: string,
        read: () => Promise<Uint8Array | undefined>,
      ) => {
        const chunks: Uint8Array[] = [];
        for (;;) {
          const chunk = await read();
          if (chunk === undefined) break;
          chunks.push(chunk);
        }
        const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        if (!SQLITE_HEADER.every((byte, index) => bytes[index] === byte)) {
          throw new Error("Imported bytes are not SQLite");
        }
        if (this.failNextImportName === name) {
          this.failNextImportName = undefined;
          this.persist(name, bytes.subarray(0, Math.min(64, bytes.length)));
          throw new Error("Injected browser storage write failure");
        }
        this.persist(name, bytes);
        return size;
      },
      unlink: (name: string) => this.unlink(name),
    };
  }

  openDatabase(name: string, flags = "c") {
    const sqlite = this.#sqlite;
    const NativeDatabase = this.#nativeDatabase;
    if (sqlite === undefined || NativeDatabase === undefined) {
      throw new Error("SQLite test pool is not ready");
    }
    this.openFlags.set(name, [...(this.openFlags.get(name) ?? []), flags]);
    const readonly = !flags.includes("c") && !flags.includes("w");
    if (readonly && !this.databases.has(name)) {
      throw new Error("SQLite read-only database does not exist");
    }
    const database = new NativeDatabase(":memory:");
    const existing = this.databases.get(name);
    if (existing !== undefined) {
      const databasePointer = database.pointer;
      if (databasePointer === undefined) {
        throw new Error("SQLite test database did not open");
      }
      const capacity = existing.byteLength + 1024 * 1024;
      const pointer = sqlite.wasm.alloc(capacity);
      sqlite.wasm.heap8u().set(existing, pointer);
      database.checkRc(
        sqlite.capi.sqlite3_deserialize(
          databasePointer,
          "main",
          pointer,
          existing.byteLength,
          capacity,
          sqlite.capi.SQLITE_DESERIALIZE_FREEONCLOSE |
            sqlite.capi.SQLITE_DESERIALIZE_RESIZEABLE,
        ),
      );
    }
    const executable = database as unknown as {
      exec: (...arguments_: readonly unknown[]) => unknown;
    };
    const execute = executable.exec.bind(database);
    executable.exec = (...arguments_) => {
      const input = arguments_[0];
      const sql =
        typeof input === "string"
          ? input
          : typeof input === "object" &&
              input !== null &&
              "sql" in input &&
              typeof input.sql === "string"
            ? input.sql
            : "";
      if (
        this.failNextSqlContaining !== undefined &&
        sql.includes(this.failNextSqlContaining)
      ) {
        this.failNextSqlContaining = undefined;
        throw new Error("Injected SQLite metadata failure");
      }
      return Reflect.apply(execute, database, arguments_);
    };
    const close = database.close.bind(database);
    database.close = () => {
      if (!readonly && database.pointer !== undefined) {
        this.persist(name, sqlite.capi.sqlite3_js_db_export(database.pointer));
      }
      close();
    };
    return database;
  }

  persist(name: string, bytes: Uint8Array): void {
    this.databases.set(name, bytes.slice());
    const slot = this.#slots.get(name) ?? `slot-${this.#nextSlot++}`;
    this.#slots.set(name, slot);
    const header = new Uint8Array(SAH_HEADER_BYTES);
    header.set(new TextEncoder().encode(name).subarray(0, SAH_PATH_BYTES));
    const stored = new Uint8Array(header.length + bytes.length);
    stored.set(header);
    stored.set(bytes, header.length);
    const handle = this.#opaque?.files.get(slot) ?? new MemoryFileHandle(slot);
    handle.replace(stored);
    this.#opaque?.files.set(slot, handle);
  }

  unlink(name: string): void {
    if (this.failNextUnlinkName === name) {
      this.failNextUnlinkName = undefined;
      throw new Error("Injected browser storage cleanup failure");
    }
    this.databases.delete(name);
    const slot = this.#slots.get(name);
    if (slot !== undefined) this.#opaque?.files.delete(slot);
    this.#slots.delete(name);
  }

  async directory(...segments: string[]): Promise<MemoryDirectoryHandle> {
    let directory = this.root;
    for (const segment of segments) {
      directory = await directory.getDirectoryHandle(segment);
    }
    return directory;
  }
}

let harness: SqlitePoolHarness;
let configureBrowserDatabaseRuntime: (
  options: BrowserDatabaseRuntimeOptions,
) => Promise<BrowserDatabaseRuntime>;

const runtimeOptions: BrowserDatabaseRuntimeOptions = {
  sqlite: {
    wasmUrl: "sqlite-test.wasm",
    directory: "consultchimps/sqlite",
    initialCapacity: 8,
  },
  duckdb: { wasmUrl: "duckdb-test.wasm", workerUrl: "duckdb-test.worker.js" },
  opfsDirectory: "consultchimps/databases",
};

beforeAll(async () => {
  vi.doMock("../src/engines/duckdb/browser.js", () => ({
    BrowserDuckDbEngine: class {
      static async open(): Promise<never> {
        throw new Error("DuckDB is outside this SQLite runtime fixture");
      }
    },
  }));
  vi.doMock("@sqlite.org/sqlite-wasm", async () => {
    const actual = await vi.importActual<typeof SqliteWasmModule>(
      "@sqlite.org/sqlite-wasm",
    );
    let NativeDatabase: SqliteDatabaseConstructor | undefined;
    let sqliteInstance: Sqlite3Static | undefined;
    return {
      ...actual,
      default: async () => {
        const sqlite = (sqliteInstance ??= await actual.default());
        NativeDatabase ??= sqlite.oo1
          .DB as unknown as SqliteDatabaseConstructor;
        sqlite.installOpfsSAHPoolVfs = async (options) => {
          const installed = await harness.install(
            sqlite,
            options.directory ?? "consultchimps/sqlite",
            NativeDatabase!,
          );
          const TestDatabase = function (
            open?:
              | string
              | {
                  readonly filename?: string;
                  readonly flags?: string;
                  readonly vfs?: string;
                },
            flags?: string,
          ): SqliteDatabase {
            if (typeof open === "object" && open.vfs === installed.vfsName) {
              return harness.openDatabase(
                open.filename ?? ":memory:",
                open.flags,
              );
            }
            return Reflect.construct(
              NativeDatabase!,
              flags === undefined ? [open] : [open, flags],
            ) as SqliteDatabase;
          } as unknown as SqliteDatabaseConstructor;
          TestDatabase.prototype = NativeDatabase!.prototype;
          (sqlite.oo1 as unknown as { DB: SqliteDatabaseConstructor }).DB =
            TestDatabase;
          return installed as unknown as Awaited<
            ReturnType<Sqlite3Static["installOpfsSAHPoolVfs"]>
          >;
        };
        return sqlite;
      },
    };
  });
  ({ configureBrowserDatabaseRuntime } = await import("../src/browser.js"));
});

beforeEach(() => {
  harness = new SqlitePoolHarness();
  const storage = {
    async getDirectory() {
      if (this !== storage) throw new Error("Storage receiver was not bound");
      return harness.root;
    },
  };
  vi.stubGlobal("navigator", {
    storage,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  vi.doUnmock("@sqlite.org/sqlite-wasm");
  vi.doUnmock("../src/engines/duckdb/browser.js");
});

async function createRuntime(): Promise<BrowserDatabaseRuntime> {
  return configureBrowserDatabaseRuntime(runtimeOptions);
}

describe("browser database runtime", () => {
  test("publishes SQLite contents, reopens them, and isolates normalized names", async () => {
    const runtime = await createRuntime();
    const created = await runtime.createDatabase({
      name: "Ｗorkspace.sqlite",
      format: "sqlite",
      schema: {
        version: 1,
        tables: [
          {
            name: "Sales",
            columns: [{ name: "amount", type: "integer" }],
            recordId: { prefix: "SALE", padding: 4 },
          },
        ],
      },
    });
    const id = created.database.id;
    expect(created.result.metrics.tablesCreated).toBe(1);
    expect(
      (await inspectDatabase({ database: created.database })).tables,
    ).toMatchObject([{ name: "Sales", rowCount: 0n }]);

    await expect(
      runtime.createDatabase({
        name: "Workspace.sqlite",
        format: "sqlite",
        overwrite: true,
      }),
    ).rejects.toMatchObject({ code: "DB_BROWSER_DATABASE_BUSY" });
    await created.database.close();

    const reopenedRuntime = await createRuntime();
    const reopened = await reopenedRuntime.openDatabase({
      name: "Workspace.sqlite",
    });
    expect(reopened.id).toBe(id);
    expect(
      (await inspectDatabase({ database: reopened })).tables,
    ).toMatchObject([{ name: "Sales", rowCount: 0n }]);
    expect([...harness.databases.keys()]).toEqual(["/Workspace.sqlite"]);
    await reopened.close();
  });

  test("exports and imports persisted SQLite bytes without leaving candidates", async () => {
    const runtime = await createRuntime();
    const created = await runtime.createDatabase({
      name: "source.sqlite",
      format: "sqlite",
      schema: {
        version: 1,
        tables: [
          {
            name: "Inventory",
            columns: [{ name: "label", type: "text" }],
            recordId: { prefix: "ITEM", padding: 3 },
          },
        ],
      },
    });
    const destination = new MemoryFile("export.sqlite");
    const exported = await runtime.exportDatabase({
      database: created.database,
      name: destination.name,
      destination,
      format: "sqlite",
    });
    expect(exported.metrics.bytesWritten).toBe(destination.size);
    expect(destination.bytes().subarray(0, SQLITE_HEADER.length)).toEqual(
      SQLITE_HEADER,
    );
    await created.database.close();

    const imported = await runtime.importDatabase({
      name: "copy.sqlite",
      source: destination,
    });
    expect(imported.id).toBe(created.database.id);
    expect(
      (await inspectDatabase({ database: imported })).tables,
    ).toMatchObject([{ name: "Inventory", rowCount: 0n }]);
    expect(
      [...harness.databases.keys()].filter((name) =>
        name.includes(".consultchimps-"),
      ),
    ).toEqual([]);
    await imported.close();
  });

  test("rejects invalid database bytes without replacing the prior working copy", async () => {
    const runtime = await createRuntime();
    const original = await runtime.createDatabase({
      name: "protected.sqlite",
      format: "sqlite",
      schema: {
        version: 1,
        tables: [
          {
            name: "Preserved",
            columns: [{ name: "value", type: "text" }],
            recordId: { prefix: "KEEP", padding: 3 },
          },
        ],
      },
    });
    const originalId = original.database.id;
    await original.database.close();
    const originalBytes = harness.databases.get("/protected.sqlite")?.slice();
    if (originalBytes === undefined) throw new Error("Missing original bytes");

    const corruptSqlite = new Uint8Array(4096);
    corruptSqlite.set(SQLITE_HEADER);
    const invalidInputs: ReadonlyArray<{
      readonly name: string;
      readonly format: "sqlite" | "duckdb";
      readonly bytes: Uint8Array;
    }> = [
      {
        name: "corrupt.sqlite",
        format: "sqlite",
        bytes: corruptSqlite,
      },
      {
        name: "random.bin",
        format: "duckdb",
        bytes: new Uint8Array([1, 2, 3, 4]),
      },
      {
        name: "invalid.duckdb",
        format: "duckdb",
        bytes: new TextEncoder().encode("invalid DuckDB test bytes"),
      },
    ];

    for (const invalid of invalidInputs) {
      await expect(
        runtime.importDatabase({
          name: "protected.sqlite",
          source: new MemoryFile(invalid.name, invalid.bytes),
          overwrite: true,
        }),
        invalid.name,
      ).rejects.toMatchObject({
        code: "DB_UNSUPPORTED_FILE_FORMAT",
        details: { detectedFormat: invalid.format },
      });
      expect(harness.databases.get("/protected.sqlite")).toEqual(originalBytes);
      expect(
        [...harness.databases.keys()].some((name) =>
          name.includes(".consultchimps-import-"),
        ),
      ).toBe(false);
      const duckDirectory = await harness.directory(
        "consultchimps",
        "databases",
      );
      expect(
        [...duckDirectory.files.keys()].some((name) =>
          name.includes(".consultchimps-import-"),
        ),
      ).toBe(false);

      const reopened = await runtime.openDatabase({
        name: "protected.sqlite",
      });
      expect(reopened.id).toBe(originalId);
      expect(
        (await inspectDatabase({ database: reopened })).tables.map(
          (table) => table.name,
        ),
      ).toEqual(["Preserved"]);
      await reopened.close();
    }
  });

  test("does not relabel a source callback failure as a database format error", async () => {
    const runtime = await createRuntime();
    const failures: readonly unknown[] = [
      new Error("Injected source read failure"),
      null,
    ];
    for (const [index, sourceFailure] of failures.entries()) {
      const name = `unreadable-${index}.sqlite`;
      const source: RandomAccessSource = {
        name,
        size: SQLITE_HEADER.length + 1,
        async readAt(offset, length) {
          if (offset === 0 && length === SQLITE_HEADER.length) {
            return SQLITE_HEADER;
          }
          throw sourceFailure;
        },
      };
      let rejection: unknown = Symbol("no rejection");
      try {
        await runtime.importDatabase({ name, source });
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBe(sourceFailure);
      await expect(runtime.openDatabase({ name })).rejects.toMatchObject({
        code: "DB_BROWSER_STORAGE_MISSING",
      });
    }
  });

  test("refuses to replace a nonempty export destination without overwrite", async () => {
    const runtime = await createRuntime();
    const created = await runtime.createDatabase({
      name: "source.sqlite",
      format: "sqlite",
    });
    const originalBytes = new Uint8Array([10, 20, 30, 40]);
    const destination = new MemoryFile("existing.sqlite", originalBytes);

    await expect(
      runtime.exportDatabase({
        database: created.database,
        name: destination.name,
        destination,
        format: "sqlite",
      }),
    ).rejects.toMatchObject({
      code: "DB_OUTPUT_EXISTS",
      details: { name: "existing.sqlite", size: originalBytes.length },
    });
    expect(destination.bytes()).toEqual(originalBytes);

    await expect(
      runtime.exportDatabase({
        database: created.database,
        name: destination.name,
        destination,
        format: "sqlite",
        overwrite: true,
      }),
    ).resolves.toMatchObject({ operation: "db.export" });
    expect(destination.bytes().subarray(0, SQLITE_HEADER.length)).toEqual(
      SQLITE_HEADER,
    );
    await created.database.close();
  });

  test("keeps a SQLite database unchanged through a read-only handle", async () => {
    const runtime = await createRuntime();
    const created = await runtime.createDatabase({
      name: "readonly.sqlite",
      format: "sqlite",
      schema: {
        version: 1,
        tables: [
          {
            name: "Original",
            columns: [{ name: "value", type: "text" }],
            recordId: { prefix: "ORIGINAL", padding: 3 },
          },
        ],
      },
    });
    await created.database.close();

    const readonly = await runtime.openDatabase({
      name: "readonly.sqlite",
      readonly: true,
    });
    expect(harness.openFlags.get("/readonly.sqlite")?.at(-1)).toBe("r");
    const plan = await planSchema({
      database: readonly,
      schema: {
        version: 1,
        tables: [
          {
            name: "Original",
            columns: [{ name: "value", type: "text" }],
            recordId: { prefix: "ORIGINAL", padding: 3 },
          },
          {
            name: "Unexpected",
            columns: [{ name: "value", type: "text" }],
            recordId: { prefix: "UNEXPECTED", padding: 3 },
          },
        ],
      },
    });
    await expect(applySchema({ database: readonly, plan })).rejects.toThrow();
    await readonly.checkpoint();
    await readonly.close();

    const reopened = await runtime.openDatabase({ name: "readonly.sqlite" });
    expect(
      (await inspectDatabase({ database: reopened })).tables.map(
        (table) => table.name,
      ),
    ).toEqual(["Original"]);
    await reopened.close();
  });

  test("keeps the prior database on collision and cleans an aborted import", async () => {
    const runtime = await createRuntime();
    const original = await runtime.createDatabase({
      name: "shared.sqlite",
      format: "sqlite",
    });
    const originalId = original.database.id;
    const exported = new MemoryFile("source.sqlite");
    await runtime.exportDatabase({
      database: original.database,
      name: exported.name,
      destination: exported,
      format: "sqlite",
    });
    await original.database.close();

    await expect(
      runtime.importDatabase({ name: "shared.sqlite", source: exported }),
    ).rejects.toMatchObject({ code: "DB_OUTPUT_EXISTS" });

    const controller = new AbortController();
    const abortingSource: RandomAccessSource = {
      name: "aborting.sqlite",
      size: exported.size,
      async readAt(offset, length) {
        const bytes = await exported.readAt(offset, length);
        controller.abort();
        return bytes;
      },
    };
    await expect(
      runtime.importDatabase({
        name: "cancelled.sqlite",
        source: abortingSource,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
    await expect(
      runtime.openDatabase({ name: "cancelled.sqlite" }),
    ).rejects.toMatchObject({ code: "DB_BROWSER_STORAGE_MISSING" });
    expect(
      [...harness.databases.keys()].some((name) =>
        name.includes(".consultchimps-import-"),
      ),
    ).toBe(false);

    const reopened = await runtime.openDatabase({ name: "shared.sqlite" });
    expect(reopened.id).toBe(originalId);
    await reopened.close();
  });

  test("rejects malformed source reads without replacing an existing SQLite database", async () => {
    const runtime = await createRuntime();
    const original = await runtime.createDatabase({
      name: "short-read.sqlite",
      format: "sqlite",
      schema: {
        version: 1,
        tables: [
          {
            name: "Preserved",
            columns: [{ name: "value", type: "text" }],
            recordId: { prefix: "KEEP", padding: 3 },
          },
        ],
      },
    });
    const originalId = original.database.id;
    const exported = new MemoryFile("source.sqlite");
    await runtime.exportDatabase({
      database: original.database,
      name: exported.name,
      destination: exported,
      format: "sqlite",
    });
    await original.database.close();
    const originalBytes = harness.databases.get("/short-read.sqlite")?.slice();
    if (originalBytes === undefined) throw new Error("Missing original bytes");

    const copyChunkBytes = 1024 * 1024;
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly source: RandomAccessSource;
      readonly expected: { offset: number; expected: number; actual: number };
    }> = [
      {
        name: "zero",
        source: {
          name: "zero.sqlite",
          size: exported.size,
          async readAt() {
            return new Uint8Array();
          },
        },
        expected: { offset: 0, expected: SQLITE_HEADER.length, actual: 0 },
      },
      {
        name: "partial",
        source: {
          name: "partial.sqlite",
          size: exported.size,
          async readAt(offset, length) {
            return (await exported.readAt(offset, length)).slice(0, length - 1);
          },
        },
        expected: {
          offset: 0,
          expected: SQLITE_HEADER.length,
          actual: SQLITE_HEADER.length - 1,
        },
      },
      {
        name: "oversized",
        source: {
          name: "oversized.sqlite",
          size: exported.size,
          async readAt(offset, length) {
            const bytes = new Uint8Array(length + 1);
            bytes.set(await exported.readAt(offset, length));
            return bytes;
          },
        },
        expected: {
          offset: 0,
          expected: SQLITE_HEADER.length,
          actual: SQLITE_HEADER.length + 1,
        },
      },
      {
        name: "later-partial",
        source: {
          name: "later-partial.sqlite",
          size: copyChunkBytes + 32,
          async readAt(offset, length) {
            if (length === SQLITE_HEADER.length) {
              return exported.readAt(0, length);
            }
            if (offset === 0) {
              const bytes = new Uint8Array(length);
              bytes.set(
                (await exported.readAt(0, exported.size)).subarray(0, length),
              );
              return bytes;
            }
            return new Uint8Array(length - 1);
          },
        },
        expected: { offset: copyChunkBytes, expected: 32, actual: 31 },
      },
    ];

    for (const malformed of cases) {
      await expect(
        runtime.importDatabase({
          name: "short-read.sqlite",
          source: malformed.source,
          overwrite: true,
        }),
        malformed.name,
      ).rejects.toMatchObject({
        code: "DB_SOURCE_SHORT_READ",
        details: malformed.expected,
      });
      expect(harness.databases.get("/short-read.sqlite")).toEqual(
        originalBytes,
      );
      expect(
        [...harness.databases.keys()].some((name) =>
          name.includes(".consultchimps-import-"),
        ),
      ).toBe(false);
      const reopened = await runtime.openDatabase({
        name: "short-read.sqlite",
      });
      expect(reopened.id).toBe(originalId);
      expect(
        (await inspectDatabase({ database: reopened })).tables.map(
          (table) => table.name,
        ),
      ).toEqual(["Preserved"]);
      await reopened.close();
    }
  });

  test("restores persisted SQLite bytes when replacement publication fails", async () => {
    const runtime = await createRuntime();
    const original = await runtime.createDatabase({
      name: "protected.sqlite",
      format: "sqlite",
      schema: {
        version: 1,
        tables: [
          {
            name: "ProtectedRows",
            columns: [{ name: "value", type: "text" }],
            recordId: { prefix: "PROTECTED", padding: 2 },
          },
        ],
      },
    });
    const originalId = original.database.id;
    await original.database.close();
    harness.failNextImportName = "/protected.sqlite";

    await expect(
      runtime.createDatabase({
        name: "protected.sqlite",
        format: "sqlite",
        overwrite: true,
      }),
    ).rejects.toThrow("Injected browser storage write failure");

    const reopened = await runtime.openDatabase({ name: "protected.sqlite" });
    expect(reopened.id).toBe(originalId);
    expect(
      (await inspectDatabase({ database: reopened })).tables,
    ).toMatchObject([{ name: "ProtectedRows", rowCount: 0n }]);
    expect(
      [...harness.databases.keys()].filter((name) =>
        name.includes(".consultchimps-"),
      ),
    ).toEqual([]);
    await reopened.close();
  });

  test("reports cleanup of a partially published new database without inventing a backup", async () => {
    const runtime = await createRuntime();
    const unrelated = await runtime.createDatabase({
      name: "unrelated.sqlite",
      format: "sqlite",
    });
    const unrelatedId = unrelated.database.id;
    await unrelated.database.close();
    harness.failNextImportName = "/new.sqlite";
    harness.failNextUnlinkName = "/new.sqlite";

    let failure: unknown;
    try {
      await runtime.createDatabase({ name: "new.sqlite", format: "sqlite" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "DB_BROWSER_PUBLICATION_CLEANUP_REQUIRED",
      details: { name: "new.sqlite", incompleteName: "new.sqlite" },
    });
    if (!(failure instanceof Error)) throw new Error("Expected create to fail");
    expect(failure.message).not.toContain("backup");
    expect(failure.message).not.toContain("openDatabase");
    expect(harness.databases.get("/new.sqlite")?.byteLength).toBe(64);

    const reopened = await runtime.openDatabase({ name: "unrelated.sqlite" });
    expect(reopened.id).toBe(unrelatedId);
    await reopened.close();
  });

  test("lists recoverable prepared imports and ignores unrelated matching files", async () => {
    const runtime = await createRuntime();
    const created = await runtime.createDatabase({
      name: "workspace.sqlite",
      format: "sqlite",
    });
    const inspection = await inspectDatabase({ database: created.database });
    const prepared = await runtime.createPreparedImport({
      name: ".consultchimps-import-review.sqlite",
      database: created.database,
      recipe: { version: 1, routes: [] },
      baselineRevision: inspection.revision,
    });
    const preparedId = prepared.id;
    await expect(
      runtime.createPreparedImport({
        name: ".consultchimps-import-review.sqlite",
        database: created.database,
        recipe: { version: 1, routes: [] },
        baselineRevision: inspection.revision,
        overwrite: true,
      }),
    ).rejects.toMatchObject({ code: "DB_BROWSER_DATABASE_BUSY" });
    await prepared.close();
    const unrelated = await runtime.createDatabase({
      name: ".consultchimps-import-unrelated.sqlite",
      format: "sqlite",
    });
    await unrelated.database.close();
    await expect(
      runtime.createPreparedImport({
        name: ".consultchimps-import-unrelated.sqlite",
        database: created.database,
        recipe: { version: 1, routes: [] },
        baselineRevision: inspection.revision,
        overwrite: true,
      }),
    ).rejects.toMatchObject({ code: "DB_BROWSER_STORAGE_KIND_MISMATCH" });

    await expect(
      runtime.createPreparedImport({
        name: ".consultchimps-import-review.sqlite",
        database: created.database,
        recipe: { version: 1, routes: [] },
        baselineRevision: inspection.revision,
      }),
    ).rejects.toMatchObject({ code: "DB_OUTPUT_EXISTS" });
    await expect(
      runtime.listPreparedImports({ database: created.database }),
    ).resolves.toEqual({
      imports: [
        {
          name: ".consultchimps-import-review.sqlite",
          id: preparedId,
          databaseId: created.database.id,
          application: "pending",
        },
      ],
      ignored: [".consultchimps-import-unrelated.sqlite"],
    });

    const reopened = await runtime.openPreparedImport({
      name: ".consultchimps-import-review.sqlite",
    });
    expect(reopened.id).toBe(preparedId);
    await reopened.close();
    await created.database.close();
  });

  test("preserves a prepared import when replacement initialization fails", async () => {
    const runtime = await createRuntime();
    const created = await runtime.createDatabase({
      name: "workspace.sqlite",
      format: "sqlite",
    });
    const inspection = await inspectDatabase({ database: created.database });
    const planName = ".consultchimps-import-protected.sqlite";
    const original = await runtime.createPreparedImport({
      name: planName,
      database: created.database,
      recipe: { version: 1, routes: [] },
      baselineRevision: inspection.revision,
    });
    const originalId = original.id;
    await original.close();
    harness.failNextSqlContaining = "CREATE TABLE _consultchimps_prepared";

    await expect(
      runtime.createPreparedImport({
        name: planName,
        database: created.database,
        recipe: { version: 1, routes: [] },
        baselineRevision: inspection.revision,
        overwrite: true,
      }),
    ).rejects.toThrow("Injected SQLite metadata failure");

    const reopened = await runtime.openPreparedImport({ name: planName });
    expect(reopened.id).toBe(originalId);
    expect(
      [...harness.databases.keys()].filter((name) =>
        name.includes(".consultchimps-plan-candidate-"),
      ),
    ).toEqual([]);
    await reopened.close();
    await created.database.close();
  });

  test("discards only a closed prepared import with the exact name", async () => {
    const runtime = await createRuntime();
    const created = await runtime.createDatabase({
      name: "workspace.sqlite",
      format: "sqlite",
    });
    const inspection = await inspectDatabase({ database: created.database });
    const planName = ".consultchimps-import-private.sqlite";
    const prepared = await runtime.createPreparedImport({
      name: planName,
      database: created.database,
      recipe: { version: 1, routes: [] },
      baselineRevision: inspection.revision,
    });

    await expect(
      runtime.discardPreparedImport({ name: planName }),
    ).rejects.toMatchObject({ code: "DB_BROWSER_DATABASE_BUSY" });
    await prepared.close();
    await expect(
      runtime.discardPreparedImport({ name: planName }),
    ).resolves.toBeUndefined();
    await expect(
      runtime.openPreparedImport({ name: planName }),
    ).rejects.toMatchObject({ code: "DB_BROWSER_STORAGE_MISSING" });
    await expect(
      runtime.discardPreparedImport({ name: "workspace.sqlite" }),
    ).rejects.toMatchObject({ code: "DB_BROWSER_STORAGE_KIND_MISMATCH" });

    expect([...harness.databases.keys()]).toEqual(["/workspace.sqlite"]);
    await created.database.close();
  });
});
