import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import {
  createScratchDirectory,
  openRandomAccessSource,
} from "../src/index.js";

const directories: string[] = [];

async function fixture(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cc-file-test-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("reads file ranges without changing the source", async () => {
  const directory = await fixture();
  const input = path.join(directory, "source.xlsx");
  await writeFile(input, "abcdef");
  const source = await openRandomAccessSource(input);
  try {
    expect(source.name).toBe("source.xlsx");
    expect(source.size).toBe(6);
    expect(new TextDecoder().decode(await source.readAt(2, 3))).toBe("cde");
    expect(new TextDecoder().decode(await source.readAt(5, 3))).toBe("f");
    expect(await source.readAt(20, 2)).toHaveLength(0);
    await expect(source.readAt(-1, 2)).rejects.toMatchObject({
      code: "FILES_INVALID_RANGE",
    });
    await expect(
      source.readAt(0, 2, AbortSignal.abort()),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
    await source.verifyUnchanged();
  } finally {
    await source.close();
  }
  expect(await readFile(input, "utf8")).toBe("abcdef");
});

test("detects edits and replacement of a captured source", async () => {
  const directory = await fixture();
  const input = path.join(directory, "source.xlsx");
  await writeFile(input, "before");
  const source = await openRandomAccessSource(input);
  try {
    await writeFile(input, "after");
    await expect(source.verifyUnchanged()).rejects.toMatchObject({
      code: "FILES_SOURCE_CHANGED",
    });
  } finally {
    await source.close();
  }
  const replacementSource = await openRandomAccessSource(input);
  try {
    await rename(input, path.join(directory, "moved.xlsx"));
    await writeFile(input, "after");
    await expect(replacementSource.verifyUnchanged()).rejects.toMatchObject({
      code: "FILES_SOURCE_CHANGED",
    });
  } finally {
    await replacementSource.close();
  }
});

test("temporary random-access storage cleans only its owned files", async () => {
  const directory = await fixture();
  const retained = path.join(directory, "keep.txt");
  await writeFile(retained, "keep");
  const scratch = await createScratchDirectory(directory);
  try {
    const file = await scratch.create();
    await file.writeAt(0, new TextEncoder().encode("abcdef"));
    await file.writeAt(2, new TextEncoder().encode("XY"));
    expect(file.size).toBe(6);
    expect(new TextDecoder().decode(await file.readAt(0, 6))).toBe("abXYef");
    await file.truncate(3);
    expect(file.size).toBe(3);
    expect(new TextDecoder().decode(await file.readAt(0, 6))).toBe("abX");
    await file.close();
    await file.close();
    await scratch.create();
  } finally {
    await scratch.close();
  }
  expect(await readdir(directory)).toEqual(["keep.txt"]);
  expect(await readFile(retained, "utf8")).toBe("keep");
  await expect(scratch.create()).rejects.toMatchObject({
    code: "FILES_SCRATCH_CLOSED",
  });
});
