import type { RandomAccessFile, RandomAccessSource } from "@consultchimps/core";

interface OpfsFileHandle {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<File>;
  createSyncAccessHandle(): Promise<OpfsSyncAccessHandle>;
}

interface OpfsSyncAccessHandle {
  read(buffer: Uint8Array, options: { readonly at: number }): number;
  write(buffer: Uint8Array, options: { readonly at: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

interface OpfsDirectoryHandle {
  readonly kind: "directory";
  readonly name: string;
  values(): AsyncIterableIterator<OpfsDirectoryHandle | OpfsFileHandle>;
  getFileHandle(
    name: string,
    options?: { readonly create?: boolean },
  ): Promise<OpfsFileHandle>;
  removeEntry(name: string): Promise<void>;
}

interface BrowserLock {
  readonly name: string;
}

interface BrowserLockManager {
  request<T>(
    name: string,
    options: {
      readonly mode: "exclusive" | "shared";
      readonly ifAvailable?: boolean;
    },
    callback: (lock: BrowserLock | null) => Promise<T> | T,
  ): Promise<T>;
}

interface OpfsStorageManager {
  getDirectory(): Promise<OpfsDirectoryHandle>;
}

function storageManager(): OpfsStorageManager {
  const storage: unknown = navigator.storage;
  if (
    typeof storage !== "object" ||
    storage === null ||
    !("getDirectory" in storage) ||
    typeof storage.getDirectory !== "function"
  ) {
    throw new Error(
      "This browser does not provide origin-private file storage. Use a current Chromium browser and try again.",
    );
  }
  return storage as OpfsStorageManager;
}

const EXPORT_PREFIX = ".consultchimps-export-";
const EXPORT_RETENTION_MILLISECONDS = 24 * 60 * 60 * 1_000;
const EXPORT_CLEANUP_INTERVAL_MILLISECONDS = 60 * 60 * 1_000;
const EXPORT_NAME =
  /^\.consultchimps-export-(\d{13})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(sqlite|duckdb)$/u;
const LEGACY_EXPORT_NAME =
  /^\.consultchimps-export-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(sqlite|duckdb)$/u;

function lockManager(): BrowserLockManager | null {
  const candidate: unknown = (
    navigator as Navigator & { readonly locks?: unknown }
  ).locks;
  return typeof candidate === "object" && candidate !== null
    ? (candidate as BrowserLockManager)
    : null;
}

function exportLockName(name: string): string {
  return `consultchimps:browser-export:${name}`;
}

function exportExpiry(name: string): number | null {
  const match = EXPORT_NAME.exec(name);
  if (match === null) return null;
  const expiry = Number(match[1]);
  return Number.isSafeInteger(expiry) ? expiry : null;
}

export const browserExportCleanupIntervalMilliseconds =
  EXPORT_CLEANUP_INTERVAL_MILLISECONDS;

export function createBrowserExportName(
  extension: "duckdb" | "sqlite",
): string {
  const expiry = Date.now() + EXPORT_RETENTION_MILLISECONDS;
  return `${EXPORT_PREFIX}${String(expiry)}-${globalThis.crypto.randomUUID()}.${extension}`;
}

export async function withBrowserExportLease<T>(
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  const locks = lockManager();
  if (locks === null) return operation();
  return locks.request(exportLockName(name), { mode: "exclusive" }, operation);
}

export async function retainBrowserExportLease(
  name: string,
): Promise<() => void> {
  const locks = lockManager();
  if (
    locks === null ||
    (exportExpiry(name) === null && !LEGACY_EXPORT_NAME.test(name))
  ) {
    return () => undefined;
  }
  let release = (): void => undefined;
  let acquired = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  void locks
    .request(exportLockName(name), { mode: "shared" }, async () => {
      acquired();
      await held;
    })
    .catch(() => acquired());
  await ready;
  return release;
}

export async function cleanupExpiredBrowserExports(
  now = Date.now(),
): Promise<number> {
  const locks = lockManager();
  if (locks === null) return 0;
  const root = await storageManager().getDirectory();
  let removed = 0;
  for await (const entry of root.values()) {
    if (entry.kind !== "file") continue;
    const encodedExpiry = exportExpiry(entry.name);
    const legacy =
      encodedExpiry === null && LEGACY_EXPORT_NAME.test(entry.name);
    if (!legacy && (encodedExpiry === null || encodedExpiry > now)) continue;
    await locks.request(
      exportLockName(entry.name),
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (lock === null) return;
        if (
          legacy &&
          (await entry.getFile()).lastModified + EXPORT_RETENTION_MILLISECONDS >
            now
        ) {
          return;
        }
        try {
          await root.removeEntry(entry.name);
          removed += 1;
        } catch (error) {
          if (!(
            error instanceof DOMException && error.name === "NotFoundError"
          )) {
            throw error;
          }
        }
      },
    );
  }
  return removed;
}

export class BrowserBlobSource implements RandomAccessSource {
  readonly name: string;
  readonly size: number;
  readonly #blob: Blob;

  constructor(name: string, blob: Blob) {
    this.name = name;
    this.size = blob.size;
    this.#blob = blob;
  }

  async readAt(
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    signal?.throwIfAborted();
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > this.size
    ) {
      throw new RangeError("The requested file range is outside the source");
    }
    const bytes = new Uint8Array(
      await this.#blob.slice(offset, offset + length).arrayBuffer(),
    );
    signal?.throwIfAborted();
    return bytes;
  }
}

export class BrowserOpfsFile implements RandomAccessFile {
  readonly name: string;
  readonly #handle: OpfsFileHandle;
  readonly #access: OpfsSyncAccessHandle;
  readonly #removeOnClose: boolean;
  #size: number;
  #closed = false;

  private constructor(
    name: string,
    handle: OpfsFileHandle,
    access: OpfsSyncAccessHandle,
    size: number,
    removeOnClose: boolean,
  ) {
    this.name = name;
    this.#handle = handle;
    this.#access = access;
    this.#size = size;
    this.#removeOnClose = removeOnClose;
  }

  static async open(
    name: string,
    create = false,
    removeOnClose = false,
  ): Promise<BrowserOpfsFile> {
    const root = await storageManager().getDirectory();
    const handle = await root.getFileHandle(name, { create });
    const access = await handle.createSyncAccessHandle();
    return new BrowserOpfsFile(
      name,
      handle,
      access,
      (await handle.getFile()).size,
      removeOnClose,
    );
  }

  get size(): number {
    return this.#size;
  }

  async readAt(
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    signal?.throwIfAborted();
    if (offset < 0 || length < 0 || offset + length > this.#size) {
      throw new RangeError(
        "The requested file range is outside the working file",
      );
    }
    const bytes = new Uint8Array(length);
    const read = this.#access.read(bytes, { at: offset });
    signal?.throwIfAborted();
    return read === length ? bytes : bytes.subarray(0, read);
  }

  async writeAt(offset: number, bytes: Uint8Array): Promise<void> {
    const written = this.#access.write(bytes, { at: offset });
    if (written !== bytes.byteLength) {
      throw new Error("The browser scratch file accepted only part of a write");
    }
    this.#size = Math.max(this.#size, offset + bytes.byteLength);
  }

  async truncate(size: number): Promise<void> {
    this.#access.truncate(size);
    this.#size = size;
  }

  async file(): Promise<File> {
    this.#access.flush();
    return this.#handle.getFile();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#access.flush();
    this.#access.close();
    if (!this.#removeOnClose) return;
    try {
      await removeOpfsFile(this.name);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "NotFoundError")) {
        throw error;
      }
    }
  }
}

export async function removeOpfsFile(name: string): Promise<void> {
  const root = await storageManager().getDirectory();
  await root.removeEntry(name);
}

export const browserScratchFactory = {
  async create(): Promise<RandomAccessFile> {
    return BrowserOpfsFile.open(
      `.consultchimps-scratch-${globalThis.crypto.randomUUID()}`,
      true,
      true,
    );
  },
};
