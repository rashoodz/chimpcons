import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserOpfsFile } from "./workspace-files";

describe("BrowserOpfsFile", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps one sync access handle for its bounded lifecycle", async () => {
    let bytes = new Uint8Array(0);
    let accessCreates = 0;
    let closes = 0;
    const removed: string[] = [];
    const access = {
      read(target: Uint8Array, { at }: { readonly at: number }) {
        const source = bytes.subarray(at, at + target.byteLength);
        target.set(source);
        return source.byteLength;
      },
      write(source: Uint8Array, { at }: { readonly at: number }) {
        const next = new Uint8Array(
          Math.max(bytes.byteLength, at + source.length),
        );
        next.set(bytes);
        next.set(source, at);
        bytes = next;
        return source.byteLength;
      },
      truncate(size: number) {
        const next = new Uint8Array(size);
        next.set(bytes.subarray(0, size));
        bytes = next;
      },
      flush: vi.fn(),
      close() {
        closes += 1;
      },
    };
    const handle = {
      name: "scratch",
      async getFile() {
        return new File([bytes], "scratch");
      },
      async createSyncAccessHandle() {
        accessCreates += 1;
        return access;
      },
    };
    vi.stubGlobal("navigator", {
      storage: {
        async getDirectory() {
          return {
            async getFileHandle() {
              return handle;
            },
            async removeEntry(name: string) {
              removed.push(name);
            },
          };
        },
      },
    });

    const file = await BrowserOpfsFile.open("scratch", true, true);
    await file.writeAt(0, new Uint8Array([1, 2]));
    await file.writeAt(2, new Uint8Array([3, 4]));
    expect(await file.readAt(1, 3)).toEqual(new Uint8Array([2, 3, 4]));
    await file.truncate(3);
    expect(file.size).toBe(3);
    await file.close();
    await file.close();

    expect(accessCreates).toBe(1);
    expect(closes).toBe(1);
    expect(removed).toEqual(["scratch"]);
  });
});
