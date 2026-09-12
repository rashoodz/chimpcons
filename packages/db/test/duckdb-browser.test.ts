import type { RandomAccessFile } from "@consultchimps/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const duckdb = vi.hoisted(() => ({
  accessMode: "",
  checkpointFailure: undefined as Error | undefined,
  queries: [] as string[],
  connectionCloses: 0,
  flushes: 0,
  terminations: 0,
}));

vi.mock("@duckdb/duckdb-wasm/dist/duckdb-browser", () => ({
  DuckDBAccessMode: {
    READ_ONLY: "read-only",
    READ_WRITE: "read-write",
  },
  DuckDBDataProtocol: { BROWSER_FSACCESS: "browser-file" },
  VoidLogger: class {},
  AsyncDuckDB: class {
    async instantiate(): Promise<void> {}

    async registerFileHandle(): Promise<void> {}

    async open(options: { readonly accessMode: string }): Promise<void> {
      duckdb.accessMode = options.accessMode;
    }

    async connect() {
      return {
        async query(sql: string) {
          duckdb.queries.push(sql);
          if (sql === "CHECKPOINT" && duckdb.checkpointFailure !== undefined) {
            throw duckdb.checkpointFailure;
          }
          return { toArray: () => [] };
        },
        async prepare(): Promise<never> {
          throw new Error("Unexpected prepared statement");
        },
        async cancelSent(): Promise<void> {},
        async close(): Promise<void> {
          duckdb.connectionCloses += 1;
        },
      };
    }

    async flushFiles(): Promise<void> {
      duckdb.flushes += 1;
    }

    async terminate(): Promise<void> {
      duckdb.terminations += 1;
    }
  },
}));

import { BrowserDuckDbEngine } from "../src/engines/duckdb/browser.js";

function memoryFile(): RandomAccessFile & { bytes(): Uint8Array } {
  let stored = new Uint8Array();
  return {
    name: "copy.duckdb",
    get size() {
      return stored.byteLength;
    },
    async readAt(offset, length) {
      return stored.slice(offset, offset + length);
    },
    async writeAt(offset, bytes) {
      const required = offset + bytes.byteLength;
      if (required > stored.byteLength) {
        const expanded = new Uint8Array(required);
        expanded.set(stored);
        stored = expanded;
      }
      stored.set(bytes, offset);
    },
    async truncate(size) {
      stored = stored.slice(0, size);
    },
    async close() {},
    bytes() {
      return stored.slice();
    },
  };
}

beforeEach(() => {
  duckdb.accessMode = "";
  duckdb.checkpointFailure = undefined;
  duckdb.queries.length = 0;
  duckdb.connectionCloses = 0;
  duckdb.flushes = 0;
  duckdb.terminations = 0;
  vi.stubGlobal("Worker", class {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test("copies and closes a read-only browser database without a write checkpoint", async () => {
  const sourceBytes = new Uint8Array(1024 * 1024 + 17);
  sourceBytes[0] = 7;
  sourceBytes[sourceBytes.length - 1] = 9;
  const engine = await BrowserDuckDbEngine.open({
    wasmUrl: "duckdb.wasm",
    workerUrl: "duckdb.worker.js",
    storageName: "readonly.duckdb",
    fileHandle: {
      async getFile() {
        return new Blob([sourceBytes]);
      },
    },
    walHandle: {
      async getFile() {
        return new Blob();
      },
    },
    readonly: true,
  });
  const destination = memoryFile();

  await engine.checkpoint();
  await expect(engine.copyTo(destination)).resolves.toBe(
    sourceBytes.byteLength,
  );
  await engine.close();

  expect(duckdb.accessMode).toBe("read-only");
  expect(duckdb.queries).not.toContain("CHECKPOINT");
  expect(destination.bytes()).toEqual(sourceBytes);
  expect(duckdb.connectionCloses).toBe(1);
  expect(duckdb.flushes).toBe(2);
  expect(duckdb.terminations).toBe(1);
});

test("releases browser DuckDB resources when a writable close checkpoint fails", async () => {
  const checkpointFailure = new Error("Injected checkpoint failure");
  duckdb.checkpointFailure = checkpointFailure;
  const engine = await BrowserDuckDbEngine.open({
    wasmUrl: "duckdb.wasm",
    workerUrl: "duckdb.worker.js",
    storageName: "writable.duckdb",
    fileHandle: {
      async getFile() {
        return new Blob();
      },
    },
    walHandle: {
      async getFile() {
        return new Blob();
      },
    },
  });

  await expect(engine.close()).rejects.toBe(checkpointFailure);
  expect(duckdb.queries).toContain("CHECKPOINT");
  expect(duckdb.connectionCloses).toBe(1);
  expect(duckdb.flushes).toBe(1);
  expect(duckdb.terminations).toBe(1);
});
