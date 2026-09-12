import { describe, expect, test, vi } from "vitest";

import {
  BrowserPublicationRecoveryError,
  publishBrowserCandidate,
  type BrowserPublicationOperations,
} from "../src/browser-publication.js";

interface StoredRows {
  current: string[];
  backup?: string[];
  candidate?: string[];
}

function operations(
  stored: StoredRows,
): BrowserPublicationOperations<readonly string[]> {
  return {
    async backup() {
      stored.backup = [...stored.current];
    },
    async publishAndOpen() {
      stored.current = [...(stored.candidate ?? [])];
      return stored.current;
    },
    async restore() {
      stored.current = [...(stored.backup ?? [])];
    },
    async cleanupBackups() {
      delete stored.backup;
    },
    async cleanupCandidate() {
      delete stored.candidate;
    },
  };
}

describe("browser database publication", () => {
  test("publishes the candidate and treats cleanup failure as post-commit", async () => {
    const stored: StoredRows = {
      current: ["old row"],
      candidate: ["replacement row"],
    };
    const replacement = operations(stored);
    replacement.cleanupBackups = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error("cleanup failed"));

    const result = await publishBrowserCandidate(replacement);

    expect(result.value).toEqual(["replacement row"]);
    expect(result.cleanupFailures).toHaveLength(1);
    expect(stored.current).toEqual(["replacement row"]);
    expect(stored.candidate).toBeUndefined();
  });

  test("restores persisted rows when publication fails", async () => {
    const stored: StoredRows = {
      current: ["old row"],
      candidate: ["replacement row"],
    };
    const replacement = operations(stored);
    const failure = new Error("storage write failed");
    replacement.publishAndOpen = async () => {
      stored.current = ["partial replacement"];
      throw failure;
    };

    await expect(publishBrowserCandidate(replacement)).rejects.toBe(failure);
    expect(stored.current).toEqual(["old row"]);
    expect(stored.backup).toBeUndefined();
    expect(stored.candidate).toBeUndefined();
  });

  test("retains the recoverable backup when restoration fails", async () => {
    const stored: StoredRows = {
      current: ["old row"],
      candidate: ["replacement row"],
    };
    const replacement = operations(stored);
    replacement.publishAndOpen = async () => {
      stored.current = ["partial replacement"];
      throw new Error("storage write failed");
    };
    replacement.restore = async () => {
      throw new Error("storage restore failed");
    };

    await expect(publishBrowserCandidate(replacement)).rejects.toBeInstanceOf(
      BrowserPublicationRecoveryError,
    );
    expect(stored.backup).toEqual(["old row"]);
    expect(stored.candidate).toBeUndefined();
  });

  test("does not publish when the backup cannot be created", async () => {
    const stored: StoredRows = {
      current: ["old row"],
      candidate: ["replacement row"],
    };
    const replacement = operations(stored);
    replacement.backup = async () => {
      throw new Error("backup failed");
    };

    await expect(publishBrowserCandidate(replacement)).rejects.toThrow(
      "backup failed",
    );
    expect(stored.current).toEqual(["old row"]);
    expect(stored.candidate).toBeUndefined();
  });
});
