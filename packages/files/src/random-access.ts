import { mkdtemp, open, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import {
  ConsultChimpsError,
  throwIfAborted,
  type RandomAccessFile,
  type RandomAccessSource,
} from "@consultchimps/core";

export interface FileSource extends RandomAccessSource {
  verifyUnchanged(): Promise<void>;
  close(): Promise<void>;
}

export interface ScratchDirectory {
  create(): Promise<RandomAccessFile>;
  close(): Promise<void>;
}

function assertRange(offset: number, length: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    !Number.isSafeInteger(offset + length)
  ) {
    throw new ConsultChimpsError(
      "FILES_INVALID_RANGE",
      "The requested file range is invalid. Use nonnegative whole-byte offsets and lengths.",
    );
  }
}

async function readRange(
  handle: FileHandle,
  size: number,
  offset: number,
  length: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  assertRange(offset, length);
  throwIfAborted(signal, "files.read");
  const bytes = new Uint8Array(Math.min(length, Math.max(0, size - offset)));
  let completed = 0;
  while (completed < bytes.length) {
    throwIfAborted(signal, "files.read");
    const result = await handle.read(
      bytes,
      completed,
      bytes.length - completed,
      offset + completed,
    );
    if (result.bytesRead === 0) break;
    completed += result.bytesRead;
  }
  return bytes.subarray(0, completed);
}

export async function openRandomAccessSource(
  filePath: string,
): Promise<FileSource> {
  let handle: FileHandle;
  try {
    handle = await open(filePath, "r");
  } catch (cause) {
    throw new ConsultChimpsError(
      "FILES_INPUT_UNREADABLE",
      "The input file could not be opened. Check that it exists and that you can read it.",
      { cause },
    );
  }
  try {
    const baseline = await handle.stat({ bigint: true });
    if (!baseline.isFile() || baseline.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ConsultChimpsError(
        "FILES_INVALID_SOURCE",
        "Choose a regular file whose size can be addressed safely.",
      );
    }
    return {
      name: path.basename(filePath),
      size: Number(baseline.size),
      readAt: (offset, length, signal) =>
        readRange(handle, Number(baseline.size), offset, length, signal),
      async verifyUnchanged() {
        const current = await handle.stat({ bigint: true });
        let named;
        try {
          named = await stat(filePath, { bigint: true });
        } catch (cause) {
          throw new ConsultChimpsError(
            "FILES_SOURCE_CHANGED",
            "The input file moved or changed while it was being read. Retry with a stable copy.",
            { cause },
          );
        }
        if (
          [current, named].some(
            (value) =>
              value.dev !== baseline.dev ||
              value.ino !== baseline.ino ||
              value.size !== baseline.size ||
              value.mtimeNs !== baseline.mtimeNs ||
              value.ctimeNs !== baseline.ctimeNs,
          )
        ) {
          throw new ConsultChimpsError(
            "FILES_SOURCE_CHANGED",
            "The input file changed while it was being read. Retry with a stable copy.",
          );
        }
      },
      close: () => handle.close(),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function createScratchDirectory(
  parentPath: string,
): Promise<ScratchDirectory> {
  const directory = await mkdtemp(
    path.join(path.resolve(parentPath), "cc-scratch-"),
  );
  const handles = new Set<FileHandle>();
  let sequence = 0;
  let closed = false;
  return {
    async create() {
      if (closed) {
        throw new ConsultChimpsError(
          "FILES_SCRATCH_CLOSED",
          "Temporary storage is closed. Start a new operation before writing more data.",
        );
      }
      const name = `part-${sequence++}`;
      const handle = await open(path.join(directory, name), "wx+", 0o600);
      handles.add(handle);
      let size = 0;
      return {
        name,
        get size() {
          return size;
        },
        readAt: (offset, length, signal) =>
          readRange(handle, size, offset, length, signal),
        async writeAt(offset, bytes) {
          assertRange(offset, bytes.length);
          let completed = 0;
          while (completed < bytes.length) {
            const result = await handle.write(
              bytes,
              completed,
              bytes.length - completed,
              offset + completed,
            );
            if (result.bytesWritten === 0) {
              throw new ConsultChimpsError(
                "FILES_WRITE_FAILED",
                "Temporary storage could not accept more data. Check available disk space.",
              );
            }
            completed += result.bytesWritten;
          }
          size = Math.max(size, offset + bytes.length);
        },
        async truncate(length) {
          assertRange(0, length);
          await handle.truncate(length);
          size = length;
        },
        async close() {
          if (handles.delete(handle)) await handle.close();
        },
      };
    },
    async close() {
      closed = true;
      await Promise.all([...handles].map((handle) => handle.close()));
      handles.clear();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
