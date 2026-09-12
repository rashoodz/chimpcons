import {
  ConsultChimpsError,
  throwIfAborted,
  type RandomAccessSource,
} from "@consultchimps/core";
import { Reader, TextWriter, ZipReader, type FileEntry } from "@zip.js/zip.js";

import { XLSX_ERRORS } from "../errors.js";
import type { WorkbookStreamOptions } from "./types.js";

const MEBIBYTE = 1024 * 1024;
const GIBIBYTE = 1024 * MEBIBYTE;

export interface StreamLimits {
  readonly chunkBytes: number;
  readonly maximumEntries: number;
  readonly maximumCentralDirectoryBytes: number;
  readonly maximumExpandedBytes: number;
  readonly maximumWorksheetBytes: number;
  readonly maximumMetadataBytes: number;
  readonly maximumSharedStrings: number;
  readonly maximumCellBytes: number;
}

export interface ZipPackage {
  readonly reader: ZipReader<RandomAccessSource>;
  readonly entries: ReadonlyMap<string, FileEntry>;
  readonly limits: StreamLimits;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new ConsultChimpsError(
      XLSX_ERRORS.XLSX_READ_FAILED,
      `${label} must be a positive whole number.`,
      { details: { option: label, value } },
    );
  }
  return selected;
}

export function streamLimits(options: WorkbookStreamOptions): StreamLimits {
  return {
    chunkBytes: positiveInteger(options.chunkBytes, MEBIBYTE, "chunkBytes"),
    maximumEntries: positiveInteger(
      options.maximumEntries,
      10_000,
      "maximumEntries",
    ),
    maximumCentralDirectoryBytes: positiveInteger(
      options.maximumCentralDirectoryBytes,
      64 * MEBIBYTE,
      "maximumCentralDirectoryBytes",
    ),
    maximumExpandedBytes: positiveInteger(
      options.maximumExpandedBytes,
      8 * GIBIBYTE,
      "maximumExpandedBytes",
    ),
    maximumWorksheetBytes: positiveInteger(
      options.maximumEntryBytes,
      4 * GIBIBYTE,
      "maximumEntryBytes",
    ),
    maximumMetadataBytes: positiveInteger(
      options.maximumMetadataBytes,
      16 * MEBIBYTE,
      "maximumMetadataBytes",
    ),
    maximumSharedStrings: positiveInteger(
      options.maximumSharedStrings,
      50_000_000,
      "maximumSharedStrings",
    ),
    maximumCellBytes: positiveInteger(
      options.maximumCellBytes,
      16 * MEBIBYTE,
      "maximumCellBytes",
    ),
  };
}

class SourceReader extends Reader<unknown> {
  readonly #source: RandomAccessSource;
  readonly #chunkBytes: number;
  readonly #signal: AbortSignal | undefined;
  readonly #maximumAllocationBytes: number;

  constructor(
    source: RandomAccessSource,
    chunkBytes: number,
    signal: AbortSignal | undefined,
    maximumAllocationBytes: number,
  ) {
    super(undefined);
    this.#source = source;
    this.#chunkBytes = chunkBytes;
    this.#signal = signal;
    this.#maximumAllocationBytes = maximumAllocationBytes;
    this.size = source.size;
  }

  override async init(): Promise<void> {
    await super.init?.();
    this.size = this.#source.size;
  }

  override async readUint8Array(
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > this.size
    ) {
      throw new Error("The ZIP reader requested an invalid source range.");
    }
    if (length > this.#maximumAllocationBytes) {
      throw new Error(
        `The ZIP reader requested a ${length}-byte range, above the configured ${this.#maximumAllocationBytes}-byte allocation limit.`,
      );
    }
    const result = new Uint8Array(length);
    for (let written = 0; written < length;) {
      const count = Math.min(this.#chunkBytes, length - written);
      const chunk = await this.#source.readAt(
        offset + written,
        count,
        this.#signal,
      );
      if (chunk.byteLength !== count) {
        throw new Error("The workbook source returned a short range read.");
      }
      result.set(chunk, written);
      written += count;
    }
    return result;
  }
}

async function readSourceRange(
  source: RandomAccessSource,
  offset: number,
  length: number,
  chunkBytes: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const result = new Uint8Array(length);
  for (let written = 0; written < length;) {
    throwIfAborted(signal, "xlsx.stream", "memory");
    const count = Math.min(chunkBytes, length - written);
    const chunk = await source.readAt(offset + written, count, signal);
    if (chunk.byteLength !== count) {
      throw new Error("The workbook source returned a short range read.");
    }
    result.set(chunk, written);
    written += count;
  }
  return result;
}

function safeUint64(view: DataView, offset: number): number {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("The ZIP central directory size is too large.");
  }
  return Number(value);
}

async function assertCentralDirectoryBound(
  source: RandomAccessSource,
  limits: StreamLimits,
  signal: AbortSignal | undefined,
): Promise<void> {
  const endLength = Math.min(source.size, 22 + 65_535);
  if (endLength < 22) return;
  const endOffset = source.size - endLength;
  const end = await readSourceRange(
    source,
    endOffset,
    endLength,
    limits.chunkBytes,
    signal,
  );
  const view = new DataView(end.buffer, end.byteOffset, end.byteLength);
  let recordOffset = -1;
  for (let index = end.length - 22; index >= 0; index -= 1) {
    if (
      view.getUint32(index, true) === 0x06054b50 &&
      index + 22 + view.getUint16(index + 20, true) === end.length
    ) {
      recordOffset = index;
      break;
    }
  }
  if (recordOffset < 0) return;
  let directoryBytes = view.getUint32(recordOffset + 12, true);
  if (directoryBytes === 0xffffffff) {
    const locatorOffset = endOffset + recordOffset - 20;
    if (locatorOffset < 0) return;
    const locator = await readSourceRange(
      source,
      locatorOffset,
      20,
      limits.chunkBytes,
      signal,
    );
    const locatorView = new DataView(
      locator.buffer,
      locator.byteOffset,
      locator.byteLength,
    );
    if (locatorView.getUint32(0, true) !== 0x07064b50) return;
    const zip64Offset = safeUint64(locatorView, 8);
    if (zip64Offset + 56 > source.size) return;
    const zip64 = await readSourceRange(
      source,
      zip64Offset,
      56,
      limits.chunkBytes,
      signal,
    );
    const zip64View = new DataView(
      zip64.buffer,
      zip64.byteOffset,
      zip64.byteLength,
    );
    if (zip64View.getUint32(0, true) !== 0x06064b50) return;
    directoryBytes = safeUint64(zip64View, 40);
  }
  if (directoryBytes > limits.maximumCentralDirectoryBytes) {
    throw new Error(
      `The ZIP central directory is ${directoryBytes} bytes, above the configured ${limits.maximumCentralDirectoryBytes}-byte limit.`,
    );
  }
}

export function workbookFailure(
  source: RandomAccessSource,
  cause: unknown,
  signal?: AbortSignal | undefined,
): ConsultChimpsError {
  throwIfAborted(signal, "xlsx.stream", "memory");
  if (cause instanceof ConsultChimpsError) return cause;
  return new ConsultChimpsError(
    XLSX_ERRORS.XLSX_READ_FAILED,
    `Could not read workbook "${source.name}". Check that it is a valid, unencrypted Excel workbook and try again.`,
    { cause, details: { source: source.name } },
  );
}

function entryKind(filename: string): "large" | "metadata" {
  return filename === "xl/workbook.xml" ||
    filename === "xl/styles.xml" ||
    /(?:^|\/)_rels\/[^/]+\.rels$/iu.test(filename) ||
    /^xl\/tables\/[^/]+\.xml$/iu.test(filename)
    ? "metadata"
    : "large";
}

export async function openZipPackage(
  source: RandomAccessSource,
  options: WorkbookStreamOptions,
): Promise<ZipPackage> {
  const limits = streamLimits(options);
  throwIfAborted(options.signal, "xlsx.stream", "memory");
  try {
    await assertCentralDirectoryBound(source, limits, options.signal);
  } catch (cause) {
    throw workbookFailure(source, cause, options.signal);
  }
  const sourceReader = new SourceReader(
    source,
    limits.chunkBytes,
    options.signal,
    Math.max(22 + 65_535, limits.maximumCentralDirectoryBytes),
  );
  const reader = new ZipReader(sourceReader, {
    checkCrc32: true,
    checkLocalDirectory: true,
    maxAppendedDataSize: 0,
    strictness: "strict",
  });
  try {
    const listed = await reader.getEntries();
    throwIfAborted(options.signal, "xlsx.stream", "memory");
    if (listed.length > limits.maximumEntries) {
      throw new Error(
        `The workbook has ${listed.length} ZIP entries, above the configured limit of ${limits.maximumEntries}.`,
      );
    }
    const entries = new Map<string, FileEntry>();
    let expandedBytes = 0;
    for (const entry of listed) {
      if (entry.directory) continue;
      if (entries.has(entry.filename)) {
        throw new Error(
          `The ZIP package contains duplicate entry "${entry.filename}".`,
        );
      }
      const maximum =
        entryKind(entry.filename) === "metadata"
          ? limits.maximumMetadataBytes
          : limits.maximumWorksheetBytes;
      if (
        !Number.isSafeInteger(entry.uncompressedSize) ||
        entry.uncompressedSize < 0
      ) {
        throw new Error(`ZIP entry "${entry.filename}" has an invalid size.`);
      }
      if (entry.uncompressedSize > maximum) {
        throw new Error(
          `ZIP entry "${entry.filename}" expands to ${entry.uncompressedSize} bytes, above its configured ${maximum}-byte limit.`,
        );
      }
      expandedBytes += entry.uncompressedSize;
      if (
        !Number.isSafeInteger(expandedBytes) ||
        expandedBytes > limits.maximumExpandedBytes
      ) {
        throw new Error(
          `The workbook expands beyond the configured ${limits.maximumExpandedBytes}-byte package limit.`,
        );
      }
      entries.set(entry.filename, entry);
    }
    return { reader, entries, limits };
  } catch (cause) {
    await reader.close().catch(() => undefined);
    throw workbookFailure(source, cause, options.signal);
  }
}

export async function readMetadataText(
  entry: FileEntry,
  limits: StreamLimits,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (entry.uncompressedSize > limits.maximumMetadataBytes) {
    throw new Error(
      `Metadata entry "${entry.filename}" is above the configured size limit.`,
    );
  }
  const result = await entry.getData(new TextWriter(), {
    checkCrc32: true,
    ...(signal === undefined ? {} : { signal }),
  });
  if (
    new TextEncoder().encode(result).byteLength > limits.maximumMetadataBytes
  ) {
    throw new Error(
      `Metadata entry "${entry.filename}" exceeded the configured size limit while reading.`,
    );
  }
  return result;
}

export async function forEachEntryChunk(
  entry: FileEntry,
  options: {
    readonly signal?: AbortSignal | undefined;
    readonly onProgress?: WorkbookStreamOptions["onProgress"];
    readonly stage: string;
    readonly consume: (chunk: Uint8Array) => Promise<void> | void;
  },
): Promise<void> {
  throwIfAborted(options.signal, "xlsx.stream", "memory");
  let completed = 0;
  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      throwIfAborted(options.signal, "xlsx.stream", "memory");
      completed += chunk.byteLength;
      if (completed > entry.uncompressedSize) {
        throw new Error(
          `ZIP entry "${entry.filename}" expanded beyond its declared size.`,
        );
      }
      await options.consume(chunk);
      options.onProgress?.({
        operation: "xlsx.stream",
        stage: options.stage,
        completed,
        total: entry.uncompressedSize,
        detail: entry.filename,
      });
    },
  });
  await entry.getData(writable, {
    checkCrc32: true,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

async function drainEntry(
  streamReader: ReadableStreamDefaultReader<Uint8Array>,
  writing: Promise<unknown>,
  account: (chunk: Uint8Array) => void,
): Promise<void> {
  let failure: unknown;
  try {
    for (;;) {
      const chunk = await streamReader.read();
      if (chunk.done) break;
      account(chunk.value);
    }
  } catch (cause) {
    failure = cause;
  }
  try {
    await writing;
  } catch (cause) {
    failure ??= cause;
  }
  if (failure !== undefined) throw failure;
}

export async function* entryChunks(
  entry: FileEntry,
  options: {
    readonly signal?: AbortSignal | undefined;
    readonly onProgress?: WorkbookStreamOptions["onProgress"];
    readonly stage: string;
  },
): AsyncIterable<Uint8Array> {
  throwIfAborted(options.signal, "xlsx.stream", "memory");
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const streamReader = stream.readable.getReader();
  const writing = entry.getData(stream.writable, {
    checkCrc32: true,
    signal: controller.signal,
  });
  void writing.catch(() => undefined);
  let completed = 0;
  let consumed = false;
  const account = (chunk: Uint8Array) => {
    completed += chunk.byteLength;
    if (completed > entry.uncompressedSize) {
      throw new Error(
        `ZIP entry "${entry.filename}" expanded beyond its declared size.`,
      );
    }
    options.onProgress?.({
      operation: "xlsx.stream",
      stage: options.stage,
      completed,
      total: entry.uncompressedSize,
      detail: entry.filename,
    });
  };
  try {
    for (;;) {
      const chunk = await streamReader.read();
      if (chunk.done) break;
      throwIfAborted(options.signal, "xlsx.stream", "memory");
      account(chunk.value);
      yield chunk.value;
    }
    await writing;
    consumed = true;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    if (!consumed) {
      if (options.signal?.aborted) {
        controller.abort(options.signal.reason);
        await streamReader.cancel().catch(() => undefined);
        await writing.catch(() => undefined);
      } else {
        await drainEntry(streamReader, writing, account);
      }
    }
    streamReader.releaseLock();
  }
}
