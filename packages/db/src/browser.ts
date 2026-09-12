import sqlite3InitModule, { type Sqlite3Static } from "@sqlite.org/sqlite-wasm";

import {
  isConsultChimpsError,
  throwIfAborted,
  type OperationControlOptions,
  type OperationResult,
  type RandomAccessFile,
  type RandomAccessSource,
} from "@consultchimps/core";

import {
  createDatabaseHandle,
  engineOf,
  initializeSchema,
  openDatabaseHandle,
  type CreateDatabaseResult,
  type Database,
} from "./database.js";
import { executeConversion, planConversion } from "./conversion.js";
import { BrowserDuckDbEngine } from "./engines/duckdb/browser.js";
import { BrowserSqliteEngine } from "./engines/sqlite/browser.js";
import { databaseError } from "./errors.js";
import { inspectAppliedImportPlan } from "./import/history.js";
import {
  createPreparedImportHandle,
  openPreparedImportHandle,
  PREPARED_METADATA_TABLE,
  preparedEngineOf,
  preparedRef,
  type PreparedImport,
} from "./prepared.js";
import {
  BrowserPublicationRecoveryError,
  publishBrowserCandidate,
} from "./browser-publication.js";
import type { DatabaseFormat, DatabaseSchema } from "./schema.js";
import type { ImportRecipe } from "./import/types.js";
import { DATABASE_METADATA_TABLE } from "./metadata.js";
import { readSchemaFingerprint } from "./records.js";

const SQLITE_HEADER = new TextEncoder().encode("SQLite format 3\0");
const COPY_CHUNK_BYTES = 1024 * 1024;
const SAH_HEADER_BYTES = 4096;
const SAH_PATH_BYTES = 512;

interface StoredDatabase {
  readonly name: string;
  readonly format: DatabaseFormat;
  readonly duckdb?: BrowserDuckDbEngine | undefined;
}

type SqliteStorageKind = "database" | "prepared" | "unknown";

interface BrowserStorageState {
  readonly sqlite: boolean;
  readonly sqliteKind?: SqliteStorageKind | undefined;
  readonly duckdb: boolean;
}

interface TrackedBrowserHandle {
  readonly isOpen: boolean;
}

interface OpenedBrowserHandle {
  readonly reference: WeakRef<TrackedBrowserHandle>;
  readonly sqliteKind?: Exclude<SqliteStorageKind, "unknown"> | undefined;
}

interface BrowserWritable {
  write(data: {
    readonly type: "write";
    readonly position: number;
    readonly data: Uint8Array;
  }): Promise<void>;
  truncate(size: number): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}

interface BrowserFileHandle {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<Blob>;
  createWritable(): Promise<BrowserWritable>;
}

interface BrowserDirectoryHandle {
  readonly kind: "directory";
  readonly name: string;
  values(): AsyncIterableIterator<BrowserDirectoryHandle | BrowserFileHandle>;
  getDirectoryHandle(
    name: string,
    options?: { readonly create?: boolean },
  ): Promise<BrowserDirectoryHandle>;
  getFileHandle(
    name: string,
    options?: { readonly create?: boolean },
  ): Promise<BrowserFileHandle>;
  removeEntry(name: string): Promise<void>;
}

function browserStorage(): {
  getDirectory(): Promise<BrowserDirectoryHandle>;
} {
  const navigatorValue = globalThis.navigator as unknown as {
    readonly storage?: {
      getDirectory?: () => Promise<BrowserDirectoryHandle>;
    };
  };
  if (navigatorValue.storage?.getDirectory === undefined) {
    throw databaseError(
      "DB_BROWSER_STORAGE_UNAVAILABLE",
      "This browser does not provide origin-private file storage.",
    );
  }
  return {
    getDirectory: navigatorValue.storage.getDirectory.bind(
      navigatorValue.storage,
    ),
  };
}

export interface BrowserDatabaseRuntimeOptions {
  readonly sqlite: {
    readonly wasmUrl: string;
    readonly directory: string;
    readonly initialCapacity?: number | undefined;
  };
  readonly duckdb: {
    readonly wasmUrl: string;
    readonly workerUrl: string;
  };
  readonly opfsDirectory?: string | undefined;
}

export interface CreateBrowserDatabaseOptions extends OperationControlOptions {
  readonly name: string;
  readonly format: DatabaseFormat;
  readonly schema?: DatabaseSchema | undefined;
  readonly overwrite?: boolean | undefined;
}

export interface ImportBrowserDatabaseOptions extends OperationControlOptions {
  readonly name: string;
  readonly source: RandomAccessSource;
  readonly overwrite?: boolean | undefined;
}

export interface CreateBrowserPreparedImportOptions extends OperationControlOptions {
  readonly name: string;
  readonly database: Database;
  readonly recipe: ImportRecipe;
  readonly baselineRevision: bigint;
  readonly overwrite?: boolean | undefined;
}

export interface ExportBrowserDatabaseOptions extends OperationControlOptions {
  readonly database: Database;
  readonly name: string;
  readonly destination: RandomAccessFile;
  readonly format: DatabaseFormat;
  readonly overwrite?: boolean | undefined;
}

export interface BrowserPreparedImportSummary {
  readonly name: string;
  readonly id: string;
  readonly databaseId: string;
  readonly application: "applied" | "pending";
}

export interface BrowserPreparedImportListing {
  readonly imports: readonly BrowserPreparedImportSummary[];
  readonly ignored: readonly string[];
}

export interface BrowserDatabaseRuntime {
  createDatabase(
    options: CreateBrowserDatabaseOptions,
  ): Promise<CreateDatabaseResult>;
  openDatabase(options: {
    readonly name: string;
    readonly readonly?: boolean | undefined;
  }): Promise<Database>;
  importDatabase(options: ImportBrowserDatabaseOptions): Promise<Database>;
  createPreparedImport(
    options: CreateBrowserPreparedImportOptions,
  ): Promise<PreparedImport>;
  openPreparedImport(options: {
    readonly name: string;
  }): Promise<PreparedImport>;
  discardPreparedImport(options: { readonly name: string }): Promise<void>;
  listPreparedImports(options: {
    readonly database: Database;
  }): Promise<BrowserPreparedImportListing>;
  exportDatabase(
    options: ExportBrowserDatabaseOptions,
  ): Promise<OperationResult<"bytesWritten">>;
}

function storageName(name: string): string {
  const normalized = name.normalize("NFKC");
  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized === ".." ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    !/^[\p{L}\p{N}._-]+$/u.test(normalized)
  ) {
    throw databaseError(
      "DB_INVALID_STORAGE_NAME",
      "Choose a database name that uses letters, numbers, dots, underscores, or hyphens.",
      { name },
    );
  }
  return normalized;
}

function sqliteName(name: string): string {
  return `/${storageName(name)}`;
}

async function opfsDirectory(name: string): Promise<BrowserDirectoryHandle> {
  let directory = await browserStorage().getDirectory();
  for (const segment of name.split("/").filter((part) => part.length > 0)) {
    directory = await directory.getDirectoryHandle(storageName(segment), {
      create: true,
    });
  }
  return directory;
}

async function fileExists(
  directory: BrowserDirectoryHandle,
  name: string,
): Promise<boolean> {
  try {
    await directory.getFileHandle(name);
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") {
      return false;
    }
    throw error;
  }
}

async function replaceDuckDbFiles(
  directory: BrowserDirectoryHandle,
  name: string,
  overwrite: boolean,
): Promise<{ file: BrowserFileHandle; wal: BrowserFileHandle }> {
  const exists = await fileExists(directory, name);
  if (exists && !overwrite) {
    throw databaseError(
      "DB_OUTPUT_EXISTS",
      "A browser database with this name already exists. Choose another name or allow replacement.",
      { name },
    );
  }
  if (exists) await directory.removeEntry(name);
  if (await fileExists(directory, `${name}.wal`)) {
    await directory.removeEntry(`${name}.wal`);
  }
  return {
    file: await directory.getFileHandle(name, { create: true }),
    wal: await directory.getFileHandle(`${name}.wal`, { create: true }),
  };
}

async function removeDuckDbFiles(
  directory: BrowserDirectoryHandle,
  name: string,
): Promise<void> {
  if (await fileExists(directory, `${name}.wal`)) {
    await directory.removeEntry(`${name}.wal`);
  }
  if (await fileExists(directory, name)) await directory.removeEntry(name);
}

async function copyBlobToFile(
  source: Blob,
  handle: BrowserFileHandle,
): Promise<void> {
  const writable = await handle.createWritable();
  let closed = false;
  try {
    for (let offset = 0; offset < source.size; offset += COPY_CHUNK_BYTES) {
      const length = Math.min(COPY_CHUNK_BYTES, source.size - offset);
      const bytes = new Uint8Array(
        await source.slice(offset, offset + length).arrayBuffer(),
      );
      await writable.write({ type: "write", position: offset, data: bytes });
    }
    await writable.truncate(source.size);
    await writable.close();
    closed = true;
  } catch (error) {
    if (!closed && writable.abort !== undefined) {
      await writable.abort(error).catch(() => undefined);
    }
    throw error;
  }
}

async function copyDuckDbFiles(
  directory: BrowserDirectoryHandle,
  source: string,
  destination: string,
): Promise<void> {
  const sourceFile = await (await directory.getFileHandle(source)).getFile();
  const sourceWal = await (
    await directory.getFileHandle(`${source}.wal`)
  ).getFile();
  await copyBlobToFile(
    sourceFile,
    await directory.getFileHandle(destination, { create: true }),
  );
  await copyBlobToFile(
    sourceWal,
    await directory.getFileHandle(`${destination}.wal`, { create: true }),
  );
}

async function writeSource(
  source: RandomAccessSource,
  handle: BrowserFileHandle,
  signal?: AbortSignal,
  onProgress?: OperationControlOptions["onProgress"],
): Promise<void> {
  const writable = await handle.createWritable();
  let closed = false;
  try {
    for (let offset = 0; offset < source.size; offset += COPY_CHUNK_BYTES) {
      throwIfAborted(signal, "db.browser.import");
      const length = Math.min(COPY_CHUNK_BYTES, source.size - offset);
      const bytes = await readSourceChunk(source, offset, length, signal);
      await writable.write({ type: "write", position: offset, data: bytes });
      onProgress?.({
        operation: "db.browser.import",
        stage: "copying",
        completed: offset + bytes.length,
        total: source.size,
        detail: source.name,
      });
    }
    await writable.truncate(source.size);
    await writable.close();
    closed = true;
  } catch (error) {
    if (!closed && writable.abort !== undefined) {
      await writable.abort(error).catch(() => undefined);
    }
    throw error;
  }
}

async function readSourceChunk(
  source: RandomAccessSource,
  offset: number,
  length: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const bytes = await source.readAt(offset, length, signal);
  if (bytes.length !== length) {
    throw databaseError(
      "DB_SOURCE_SHORT_READ",
      "The database source returned a different number of bytes than requested.",
      { offset, expected: length, actual: bytes.length },
    );
  }
  return bytes;
}

async function sqlitePoolDirectory(
  path: string,
): Promise<BrowserDirectoryHandle> {
  let directory = await browserStorage().getDirectory();
  for (const segment of path.split("/").filter((part) => part.length > 0)) {
    directory = await directory.getDirectoryHandle(storageName(segment));
  }
  return directory.getDirectoryHandle(".opaque");
}

async function findSqlitePoolFile(
  directory: BrowserDirectoryHandle,
  path: string,
): Promise<Blob> {
  for await (const entry of directory.values()) {
    if (entry.kind !== "file") continue;
    const file = await entry.getFile();
    if (file.size <= SAH_HEADER_BYTES) continue;
    const pathBytes = new Uint8Array(
      await file.slice(0, SAH_PATH_BYTES).arrayBuffer(),
    );
    const end = pathBytes.indexOf(0);
    const associatedPath = new TextDecoder().decode(
      pathBytes.subarray(0, end < 0 ? pathBytes.length : end),
    );
    if (associatedPath === path) return file;
  }
  throw databaseError(
    "DB_BROWSER_STORAGE_MISSING",
    "The SQLite working database could not be found in browser storage.",
    { name: path },
  );
}

async function sqlitePoolPayload(
  directory: BrowserDirectoryHandle,
  path: string,
): Promise<Blob> {
  const file = await findSqlitePoolFile(directory, path);
  return file.slice(SAH_HEADER_BYTES);
}

async function copySqlitePoolFile(options: {
  readonly poolDirectory: BrowserDirectoryHandle;
  readonly name: string;
  readonly destination: RandomAccessFile;
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: OperationControlOptions["onProgress"];
}): Promise<number> {
  const file = await findSqlitePoolFile(
    options.poolDirectory,
    sqliteName(options.name),
  );
  const size = file.size - SAH_HEADER_BYTES;
  if (size < 512 || size % 512 !== 0) {
    throw databaseError(
      "DB_CORRUPT_DATABASE",
      "The SQLite working database has an invalid file size.",
    );
  }
  await options.destination.truncate(0);
  for (let offset = 0; offset < size; offset += COPY_CHUNK_BYTES) {
    throwIfAborted(options.signal, "db.browser.export");
    const length = Math.min(COPY_CHUNK_BYTES, size - offset);
    const bytes = new Uint8Array(
      await file
        .slice(SAH_HEADER_BYTES + offset, SAH_HEADER_BYTES + offset + length)
        .arrayBuffer(),
    );
    if (
      offset === 0 &&
      !SQLITE_HEADER.every((byte, index) => bytes[index] === byte)
    ) {
      throw databaseError(
        "DB_CORRUPT_DATABASE",
        "The SQLite working database has an invalid file header.",
      );
    }
    await options.destination.writeAt(offset, bytes);
    options.onProgress?.({
      operation: "db.browser.export",
      stage: "copying",
      completed: offset + bytes.length,
      total: size,
      detail: options.name,
    });
  }
  await options.destination.truncate(size);
  return size;
}

async function detectSourceFormat(
  source: RandomAccessSource,
  signal?: AbortSignal,
): Promise<DatabaseFormat> {
  const header = await readSourceChunk(
    source,
    0,
    Math.min(SQLITE_HEADER.length, source.size),
    signal,
  );
  return header.length === SQLITE_HEADER.length &&
    header.every((byte, index) => byte === SQLITE_HEADER[index])
    ? "sqlite"
    : "duckdb";
}

function importValidationError(
  cause: unknown,
  format: DatabaseFormat,
): unknown {
  if (
    isConsultChimpsError(cause) &&
    cause.code !== "DB_BROWSER_STORAGE_KIND_MISMATCH" &&
    cause.code !== "DB_BROWSER_STORAGE_MISSING"
  ) {
    return cause;
  }
  if (cause instanceof Error && cause.name === "AbortError") return cause;
  return databaseError(
    "DB_UNSUPPORTED_FILE_FORMAT",
    "The selected file is not a supported SQLite or DuckDB database. Choose a valid database file and try again.",
    { detectedFormat: format },
    cause,
  );
}

export async function configureBrowserDatabaseRuntime(
  options: BrowserDatabaseRuntimeOptions,
): Promise<BrowserDatabaseRuntime> {
  const initialize = sqlite3InitModule as unknown as (options: {
    readonly locateFile: () => string;
  }) => Promise<Sqlite3Static>;
  const sqlite = await initialize({ locateFile: () => options.sqlite.wasmUrl });
  const pool = await sqlite.installOpfsSAHPoolVfs({
    directory: options.sqlite.directory,
    ...(options.sqlite.initialCapacity === undefined
      ? {}
      : { initialCapacity: options.sqlite.initialCapacity }),
  });
  if (options.sqlite.initialCapacity !== undefined) {
    await pool.reserveMinimumCapacity(options.sqlite.initialCapacity);
  }
  const duckDirectory = await opfsDirectory(
    options.opfsDirectory ?? "consultchimps-databases",
  );
  const sqliteDirectory = await sqlitePoolDirectory(options.sqlite.directory);
  const stored = new WeakMap<Database, StoredDatabase>();
  const openedByName = new Map<string, Set<OpenedBrowserHandle>>();
  const nameLocks = new Map<string, Promise<void>>();

  const withNameLock = async <T>(
    name: string,
    work: () => Promise<T>,
  ): Promise<T> => {
    const previous = nameLocks.get(name) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    nameLocks.set(name, current);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (nameLocks.get(name) === current) nameLocks.delete(name);
    }
  };

  const openedHandles = (name: string): Set<OpenedBrowserHandle> => {
    const opened = openedByName.get(name);
    if (opened === undefined) return new Set();
    for (const entry of opened) {
      const handle = entry.reference.deref();
      if (handle === undefined || !handle.isOpen) opened.delete(entry);
    }
    if (opened.size === 0) {
      openedByName.delete(name);
      return new Set();
    }
    return opened;
  };

  const registerOpenHandle = (
    name: string,
    handle: TrackedBrowserHandle,
    sqliteKind?: Exclude<SqliteStorageKind, "unknown">,
  ): void => {
    const opened = openedHandles(name);
    opened.add({
      reference: new WeakRef(handle),
      ...(sqliteKind === undefined ? {} : { sqliteKind }),
    });
    openedByName.set(name, opened);
  };

  const register = (database: Database, value: StoredDatabase): Database => {
    stored.set(database, value);
    registerOpenHandle(
      value.name,
      database,
      value.format === "sqlite" ? "database" : undefined,
    );
    return database;
  };

  const assertNotBusy = (name: string): void => {
    if (openedHandles(name).size === 0) return;
    throw databaseError(
      "DB_BROWSER_DATABASE_BUSY",
      "Close the open browser working copy before replacing it.",
      { name },
    );
  };

  const sqliteStorageKind = async (
    name: string,
  ): Promise<SqliteStorageKind> => {
    const tracked = new Set(
      [...openedHandles(name)]
        .map((entry) => entry.sqliteKind)
        .filter(
          (kind): kind is Exclude<SqliteStorageKind, "unknown"> =>
            kind !== undefined,
        ),
    );
    if (tracked.size === 1) return [...tracked][0]!;
    if (tracked.size > 1) return "unknown";

    let engine: BrowserSqliteEngine | undefined;
    try {
      engine = sqliteEngine(name, true);
      const rows = await engine.query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)",
        [DATABASE_METADATA_TABLE, PREPARED_METADATA_TABLE],
      );
      const names = new Set(rows.map((row) => row["name"]));
      if (
        names.has(DATABASE_METADATA_TABLE) &&
        !names.has(PREPARED_METADATA_TABLE)
      ) {
        return "database";
      }
      if (
        names.has(PREPARED_METADATA_TABLE) &&
        !names.has(DATABASE_METADATA_TABLE)
      ) {
        return "prepared";
      }
      return "unknown";
    } catch {
      return "unknown";
    } finally {
      await engine?.close().catch(() => undefined);
    }
  };

  const storageState = async (name: string): Promise<BrowserStorageState> => {
    const sqliteStored = pool.getFileNames().includes(sqliteName(name));
    return {
      sqlite: sqliteStored,
      ...(sqliteStored ? { sqliteKind: await sqliteStorageKind(name) } : {}),
      duckdb: await fileExists(duckDirectory, name),
    };
  };

  const assertDatabaseStorageKind = (
    name: string,
    state: BrowserStorageState,
  ): void => {
    if (state.sqlite && state.sqliteKind !== "database") {
      const message =
        state.sqliteKind === "prepared"
          ? "This browser working copy is an import plan, not a database. Choose another name."
          : "This browser working copy is not a recognized ConsultChimps database. Choose another name.";
      throw databaseError("DB_BROWSER_STORAGE_KIND_MISMATCH", message, {
        name,
        expected: "database",
        actual: state.sqliteKind,
      });
    }
  };

  const assertPreparedStorageKind = (
    name: string,
    state: BrowserStorageState,
  ): void => {
    if (state.duckdb || (state.sqlite && state.sqliteKind !== "prepared")) {
      const actual = state.duckdb ? "database" : state.sqliteKind;
      const message =
        actual === "unknown"
          ? "This browser working copy is not a recognized ConsultChimps import plan. Choose another name."
          : "This browser working copy is a database, not an import plan. Choose another name.";
      throw databaseError("DB_BROWSER_STORAGE_KIND_MISMATCH", message, {
        name,
        expected: "prepared",
        actual,
      });
    }
  };

  const importSqliteBlob = async (name: string, blob: Blob): Promise<void> => {
    let offset = 0;
    await pool.importDb(sqliteName(name), async () => {
      if (offset >= blob.size) return undefined;
      const length = Math.min(COPY_CHUNK_BYTES, blob.size - offset);
      const bytes = new Uint8Array(
        await blob.slice(offset, offset + length).arrayBuffer(),
      );
      offset += bytes.byteLength;
      return bytes;
    });
  };

  const copySqlite = async (source: string, destination: string) => {
    const payload = await sqlitePoolPayload(
      sqliteDirectory,
      sqliteName(source),
    );
    await importSqliteBlob(destination, payload);
  };

  const sqliteEngine = (name: string, readonly = false): BrowserSqliteEngine =>
    new BrowserSqliteEngine(
      sqlite,
      readonly
        ? new sqlite.oo1.DB({
            filename: sqliteName(name),
            flags: "r",
            vfs: pool.vfsName,
          })
        : new pool.OpfsSAHPoolDb(sqliteName(name)),
      readonly,
    );

  const discardCandidate = async (
    format: DatabaseFormat,
    candidate: string,
  ): Promise<void> => {
    if (format === "sqlite") {
      try {
        pool.unlink(sqliteName(candidate));
      } catch {
        // Candidate cleanup cannot replace the operational or recovery error.
      }
      return;
    }
    await removeDuckDbFiles(duckDirectory, candidate).catch(() => undefined);
  };

  const duckEngine = async (
    name: string,
    readonly = false,
  ): Promise<BrowserDuckDbEngine> => {
    const file = await duckDirectory.getFileHandle(name);
    const wal = await duckDirectory.getFileHandle(`${name}.wal`, {
      create: true,
    });
    return BrowserDuckDbEngine.open({
      ...options.duckdb,
      storageName: name,
      fileHandle: file,
      walHandle: wal,
      readonly,
    });
  };

  const publishCandidate = async <T>(
    name: string,
    format: DatabaseFormat,
    candidate: string,
    state: BrowserStorageState,
    openPublished: () => Promise<T>,
  ): Promise<{
    readonly value: T;
    readonly cleanupFailures: readonly unknown[];
  }> => {
    const token = globalThis.crypto.randomUUID();
    const sqliteBackup = `.consultchimps-backup-${token}.sqlite`;
    const duckdbBackup = `.consultchimps-backup-${token}.duckdb`;
    if (state.sqlite || format === "sqlite") {
      await pool.reserveMinimumCapacity(pool.getFileCount() + 2);
    }
    try {
      const published = await publishBrowserCandidate({
        async backup() {
          if (state.sqlite) await copySqlite(name, sqliteBackup);
          if (state.duckdb) {
            await copyDuckDbFiles(duckDirectory, name, duckdbBackup);
          }
        },
        async publishAndOpen() {
          if (format === "sqlite") {
            await copySqlite(candidate, name);
            if (state.duckdb) await removeDuckDbFiles(duckDirectory, name);
          } else {
            await copyDuckDbFiles(duckDirectory, candidate, name);
            if (state.sqlite) pool.unlink(sqliteName(name));
          }
          return openPublished();
        },
        async restore() {
          if (state.sqlite) await copySqlite(sqliteBackup, name);
          else if (pool.getFileNames().includes(sqliteName(name))) {
            pool.unlink(sqliteName(name));
          }
          await removeDuckDbFiles(duckDirectory, name);
          if (state.duckdb) {
            await copyDuckDbFiles(duckDirectory, duckdbBackup, name);
          }
        },
        async cleanupBackups() {
          if (state.sqlite) pool.unlink(sqliteName(sqliteBackup));
          if (state.duckdb) {
            await removeDuckDbFiles(duckDirectory, duckdbBackup);
          }
        },
        async cleanupCandidate() {
          if (format === "sqlite") pool.unlink(sqliteName(candidate));
          else await removeDuckDbFiles(duckDirectory, candidate);
        },
      });
      return {
        value: published.value,
        cleanupFailures: published.cleanupFailures,
      };
    } catch (error) {
      if (!(error instanceof BrowserPublicationRecoveryError)) throw error;
      const backups = [
        state.sqlite ? sqliteBackup : undefined,
        state.duckdb ? duckdbBackup : undefined,
      ].filter((value): value is string => value !== undefined);
      if (backups.length === 0) {
        throw databaseError(
          "DB_BROWSER_PUBLICATION_CLEANUP_REQUIRED",
          "Browser storage failed while publishing a new working copy and could not remove the incomplete copy. Choose another name and retry. The incomplete copy remains under this name for inspection.",
          { name, incompleteName: name },
          error,
        );
      }
      const recoveryInstruction =
        state.sqliteKind === "prepared"
          ? `Use BrowserDatabaseRuntime.openPreparedImport with ${sqliteBackup} to inspect or resume that backup before retrying.`
          : `Use BrowserDatabaseRuntime.openDatabase with ${backups.join(" or ")} and export that backup before retrying.`;
      throw databaseError(
        "DB_BROWSER_REPLACEMENT_RECOVERY_REQUIRED",
        `Browser storage failed while replacing a working copy and while restoring its previous contents. ${recoveryInstruction}`,
        {
          name,
          kind: state.sqliteKind === "prepared" ? "prepared" : "database",
          sqliteBackup: state.sqlite ? sqliteBackup : undefined,
          duckdbBackup: state.duckdb ? duckdbBackup : undefined,
        },
        error,
      );
    }
  };

  const openDatabaseUnlocked = async (
    open: {
      readonly name: string;
      readonly readonly?: boolean | undefined;
    },
    registerDatabase = true,
  ): Promise<Database> => {
    const name = storageName(open.name);
    const state = await storageState(name);
    if (state.sqlite && state.duckdb) {
      throw databaseError(
        "DB_AMBIGUOUS_BROWSER_STORAGE",
        "Both SQLite and DuckDB working copies use this browser database name. Replace one copy with an explicit format before reopening it.",
        { name },
      );
    }
    if (!state.sqlite && !state.duckdb) {
      throw databaseError(
        "DB_BROWSER_STORAGE_MISSING",
        "The browser working database could not be found.",
        { name },
      );
    }
    assertDatabaseStorageKind(name, state);
    const format: DatabaseFormat = state.sqlite ? "sqlite" : "duckdb";
    const engine =
      format === "sqlite"
        ? sqliteEngine(name, open.readonly === true)
        : await duckEngine(name, open.readonly);
    try {
      const database = await openDatabaseHandle(engine);
      if (registerDatabase) {
        register(database, {
          name,
          format,
          ...(format === "duckdb"
            ? { duckdb: engine as BrowserDuckDbEngine }
            : {}),
        });
      }
      return database;
    } catch (error) {
      await engine.close().catch(() => undefined);
      throw error;
    }
  };

  const openDatabase = (open: {
    readonly name: string;
    readonly readonly?: boolean | undefined;
  }): Promise<Database> => {
    const name = storageName(open.name);
    return withNameLock(name, () => openDatabaseUnlocked(open));
  };

  const createDatabaseUnlocked = async (
    create: CreateBrowserDatabaseOptions,
  ): Promise<CreateDatabaseResult> => {
    throwIfAborted(create.signal, "db.browser.create");
    const name = storageName(create.name);
    const state = await storageState(name);
    assertDatabaseStorageKind(name, state);
    if ((state.sqlite || state.duckdb) && create.overwrite !== true) {
      throw databaseError(
        "DB_OUTPUT_EXISTS",
        "A browser database with this name already exists. Choose another name or allow replacement.",
        { name },
      );
    }
    if (state.sqlite || state.duckdb) assertNotBusy(name);
    const candidate = `.consultchimps-create-${globalThis.crypto.randomUUID()}.${create.format}`;
    let engine: BrowserSqliteEngine | BrowserDuckDbEngine | undefined;
    try {
      if (create.format === "sqlite") {
        engine = sqliteEngine(candidate);
      } else {
        const handles = await replaceDuckDbFiles(
          duckDirectory,
          candidate,
          false,
        );
        engine = await BrowserDuckDbEngine.open({
          ...options.duckdb,
          storageName: candidate,
          fileHandle: handles.file,
          walHandle: handles.wal,
        });
      }
      const database = await createDatabaseHandle(engine);
      const tablesCreated = await initializeSchema(database, create.schema);
      await database.checkpoint();
      await database.close();
      throwIfAborted(create.signal, "db.browser.create");
      const published = await publishCandidate(
        name,
        create.format,
        candidate,
        state,
        () => openDatabaseUnlocked({ name }),
      );
      return {
        database: published.value,
        result: {
          operation: "db.create",
          artifacts: [],
          warnings:
            published.cleanupFailures.length === 0
              ? []
              : [
                  "The replacement completed, but temporary browser backup cleanup could not finish.",
                ],
          metrics: { tablesCreated },
        },
      };
    } catch (error) {
      await engine?.close().catch(() => undefined);
      await discardCandidate(create.format, candidate);
      throw error;
    }
  };

  const createDatabase = (
    create: CreateBrowserDatabaseOptions,
  ): Promise<CreateDatabaseResult> => {
    const name = storageName(create.name);
    return withNameLock(name, () => createDatabaseUnlocked(create));
  };

  const openPreparedImportUnlocked = async (open: {
    readonly name: string;
  }): Promise<PreparedImport> => {
    const name = storageName(open.name);
    const state = await storageState(name);
    if (!state.sqlite && !state.duckdb) {
      throw databaseError(
        "DB_BROWSER_STORAGE_MISSING",
        "The browser import plan could not be found.",
        { name },
      );
    }
    assertPreparedStorageKind(name, state);
    const engine = sqliteEngine(name);
    try {
      const prepared = await openPreparedImportHandle(engine);
      registerOpenHandle(name, prepared, "prepared");
      return prepared;
    } catch (error) {
      await engine.close().catch(() => undefined);
      throw error;
    }
  };

  const openPreparedImport = (open: {
    readonly name: string;
  }): Promise<PreparedImport> => {
    const name = storageName(open.name);
    return withNameLock(name, () => openPreparedImportUnlocked(open));
  };

  const createPreparedImport = (
    create: CreateBrowserPreparedImportOptions,
  ): Promise<PreparedImport> => {
    const name = storageName(create.name);
    return withNameLock(name, async () => {
      throwIfAborted(create.signal, "db.browser.plan");
      const state = await storageState(name);
      assertPreparedStorageKind(name, state);
      if (state.sqlite && create.overwrite !== true) {
        throw databaseError(
          "DB_OUTPUT_EXISTS",
          "A browser import plan with this name already exists. Choose another name or allow replacement.",
          { name },
        );
      }
      if (state.sqlite) assertNotBusy(name);
      const baselineSchemaFingerprint = await readSchemaFingerprint(
        engineOf(create.database),
        create.database.format,
      );
      const candidate = `.consultchimps-plan-candidate-${globalThis.crypto.randomUUID()}.sqlite`;
      let engine: BrowserSqliteEngine | undefined;
      let prepared: PreparedImport | undefined;
      try {
        engine = sqliteEngine(candidate);
        prepared = await createPreparedImportHandle({
          engine,
          databaseId: create.database.id,
          baselineRevision: create.baselineRevision,
          baselineSchemaFingerprint,
          recipe: create.recipe,
        });
        await preparedEngineOf(prepared).checkpoint();
        await prepared.close();
        throwIfAborted(create.signal, "db.browser.plan");
        return (
          await publishCandidate(name, "sqlite", candidate, state, () =>
            openPreparedImportUnlocked({ name }),
          )
        ).value;
      } catch (error) {
        await prepared?.close().catch(() => undefined);
        await engine?.close().catch(() => undefined);
        await discardCandidate("sqlite", candidate);
        throw error;
      }
    });
  };

  const discardPreparedImport = (discard: {
    readonly name: string;
  }): Promise<void> => {
    const name = storageName(discard.name);
    return withNameLock(name, async () => {
      const state = await storageState(name);
      if (!state.sqlite && !state.duckdb) {
        throw databaseError(
          "DB_BROWSER_STORAGE_MISSING",
          "The browser import plan could not be found.",
          { name },
        );
      }
      assertPreparedStorageKind(name, state);
      assertNotBusy(name);
      pool.unlink(sqliteName(name));
    });
  };

  const exportStored = async (
    database: Database,
    source: StoredDatabase,
    destination: RandomAccessFile,
    controls: OperationControlOptions,
  ): Promise<number> => {
    if (source.format === "sqlite") {
      await database.checkpoint();
      return copySqlitePoolFile({
        poolDirectory: sqliteDirectory,
        name: source.name,
        destination,
        signal: controls.signal,
        onProgress: controls.onProgress,
      });
    }
    return source.duckdb!.copyTo(destination, controls.signal);
  };

  const removeStored = async (source: StoredDatabase): Promise<void> => {
    if (source.format === "sqlite") {
      pool.unlink(sqliteName(source.name));
      return;
    }
    if (await fileExists(duckDirectory, source.name)) {
      await duckDirectory.removeEntry(source.name);
    }
    if (await fileExists(duckDirectory, `${source.name}.wal`)) {
      await duckDirectory.removeEntry(`${source.name}.wal`);
    }
  };

  return {
    createDatabase,
    openDatabase,
    async importDatabase(importOptions) {
      const name = storageName(importOptions.name);
      return withNameLock(name, async () => {
        const format = await detectSourceFormat(
          importOptions.source,
          importOptions.signal,
        );
        const state = await storageState(name);
        assertDatabaseStorageKind(name, state);
        if (
          (state.sqlite || state.duckdb) &&
          importOptions.overwrite !== true
        ) {
          throw databaseError(
            "DB_OUTPUT_EXISTS",
            "A browser database with this name already exists. Choose another name or allow replacement.",
            { name },
          );
        }
        if (state.sqlite || state.duckdb) assertNotBusy(name);
        const candidate = `.consultchimps-import-${globalThis.crypto.randomUUID()}.${format}`;
        let candidateDatabase: Database | undefined;
        try {
          if (format === "sqlite") {
            let offset = 0;
            let sourceFailure: { readonly error: unknown } | undefined;
            try {
              await pool.importDb(sqliteName(candidate), async () => {
                try {
                  if (offset >= importOptions.source.size) return undefined;
                  throwIfAborted(importOptions.signal, "db.browser.import");
                  const length = Math.min(
                    COPY_CHUNK_BYTES,
                    importOptions.source.size - offset,
                  );
                  const bytes = await readSourceChunk(
                    importOptions.source,
                    offset,
                    length,
                    importOptions.signal,
                  );
                  offset += length;
                  importOptions.onProgress?.({
                    operation: "db.browser.import",
                    stage: "copying",
                    completed: offset,
                    total: importOptions.source.size,
                    detail: importOptions.source.name,
                  });
                  return bytes;
                } catch (error) {
                  sourceFailure = { error };
                  throw error;
                }
              });
            } catch (error) {
              if (sourceFailure !== undefined) throw sourceFailure.error;
              throw importValidationError(error, format);
            }
          } else {
            const handles = await replaceDuckDbFiles(
              duckDirectory,
              candidate,
              false,
            );
            await writeSource(
              importOptions.source,
              handles.file,
              importOptions.signal,
              importOptions.onProgress,
            );
          }
          try {
            candidateDatabase = await openDatabaseUnlocked(
              { name: candidate },
              false,
            );
          } catch (error) {
            throw importValidationError(error, format);
          }
          await candidateDatabase.checkpoint();
          await candidateDatabase.close();
          throwIfAborted(importOptions.signal, "db.browser.import");
          return (
            await publishCandidate(name, format, candidate, state, () =>
              openDatabaseUnlocked({ name }),
            )
          ).value;
        } catch (error) {
          await candidateDatabase?.close().catch(() => undefined);
          await discardCandidate(format, candidate);
          throw error;
        }
      });
    },
    createPreparedImport,
    openPreparedImport,
    discardPreparedImport,
    async listPreparedImports(listOptions) {
      const names = pool
        .getFileNames()
        .filter(
          (name) =>
            name.startsWith("/.consultchimps-import-") &&
            name.endsWith(".sqlite"),
        )
        .map((name) => name.slice(1))
        .sort();
      const imports: BrowserPreparedImportSummary[] = [];
      const ignored: string[] = [];
      for (const name of names) {
        let engine: BrowserSqliteEngine | undefined;
        let prepared: PreparedImport | undefined;
        try {
          engine = new BrowserSqliteEngine(
            sqlite,
            new pool.OpfsSAHPoolDb(sqliteName(name)),
          );
          prepared = await openPreparedImportHandle(engine);
          const ref = await preparedRef(prepared);
          const applied =
            ref.databaseId === listOptions.database.id &&
            (await inspectAppliedImportPlan({
              database: listOptions.database,
              planId: ref.id,
              planRevision: ref.planRevision,
            })) !== null;
          imports.push({
            name,
            id: prepared.id,
            databaseId: prepared.databaseId,
            application: applied ? "applied" : "pending",
          });
        } catch {
          ignored.push(name);
        } finally {
          if (prepared !== undefined) await prepared.close();
          else await engine?.close().catch(() => undefined);
        }
      }
      return { imports, ignored };
    },
    async exportDatabase(exportOptions) {
      if (
        exportOptions.destination.size > 0 &&
        exportOptions.overwrite !== true
      ) {
        throw databaseError(
          "DB_OUTPUT_EXISTS",
          "The export destination already contains data. Choose another destination or allow replacement.",
          {
            name: exportOptions.name,
            size: exportOptions.destination.size,
          },
        );
      }
      throwIfAborted(exportOptions.signal, "db.browser.export");
      const source = stored.get(exportOptions.database);
      if (source === undefined) {
        throw databaseError(
          "DB_UNKNOWN_BROWSER_DATABASE",
          "This database was not opened by the current browser runtime.",
        );
      }
      let bytesWritten: number;
      if (source.format === exportOptions.format) {
        bytesWritten = await exportStored(
          exportOptions.database,
          source,
          exportOptions.destination,
          exportOptions,
        );
      } else {
        const plan = await planConversion({
          database: exportOptions.database,
          format: exportOptions.format,
        });
        const temporaryName = `.consultchimps-conversion-${globalThis.crypto.randomUUID()}.${exportOptions.format}`;
        const created = await createDatabase({
          name: temporaryName,
          format: exportOptions.format,
          signal: exportOptions.signal,
        });
        const converted = stored.get(created.database);
        if (converted === undefined) {
          await created.database.close();
          throw databaseError(
            "DB_UNKNOWN_BROWSER_DATABASE",
            "The conversion database was not registered by the browser runtime.",
          );
        }
        try {
          await executeConversion({
            source: exportOptions.database,
            target: created.database,
            plan,
            signal: exportOptions.signal,
            onProgress: exportOptions.onProgress,
          });
          bytesWritten = await exportStored(
            created.database,
            converted,
            exportOptions.destination,
            exportOptions,
          );
        } finally {
          await created.database.close().catch(() => undefined);
          await removeStored(converted).catch(() => undefined);
        }
      }
      return {
        operation: "db.export",
        artifacts: [],
        warnings: [],
        metrics: { bytesWritten },
      };
    },
  };
}
