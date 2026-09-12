import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import {
  ConsultChimpsError,
  type OperationControlOptions,
} from "@consultchimps/core";
import {
  createWorkbookImportSource,
  type WorkbookImportSource,
  type ImportRecipe,
} from "@consultchimps/db";
import {
  createScratchDirectory,
  openRandomAccessSource,
  type FileSource,
} from "@consultchimps/files";
import type { WorkbookSelection } from "@consultchimps/xlsx/stream";

export interface DbInputOptions {
  readonly input: readonly string[];
  readonly sheet?: string | undefined;
  readonly table?: string | undefined;
  readonly range?: string | undefined;
  readonly headerRow?: number | undefined;
  readonly hidden?: boolean | undefined;
}

export interface OpenDbInputs {
  readonly paths: readonly string[];
  readonly workbooks: readonly WorkbookImportSource[];
  close(): Promise<void>;
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isFileSystemError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    "syscall" in error &&
    typeof error.syscall === "string"
  );
}

function documentUnreadable(cause: unknown): ConsultChimpsError {
  return new ConsultChimpsError(
    "DB_DOCUMENT_UNREADABLE",
    "The JSON configuration file could not be opened. Check that it exists and that you can read it.",
    { cause },
  );
}

async function parseInput(input: string): Promise<{
  readonly filePath: string;
  readonly key: string;
}> {
  const separator = input.indexOf("=");
  const possibleAlias = separator > 0 ? input.slice(0, separator) : undefined;
  if (
    possibleAlias !== undefined &&
    !possibleAlias.includes("/") &&
    !possibleAlias.includes("\\")
  ) {
    try {
      await stat(input);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      return {
        filePath: input.slice(separator + 1),
        key: possibleAlias,
      };
    }
  }
  return { filePath: input, key: path.parse(input).name };
}

export async function readDbDocument(filePath: string): Promise<unknown> {
  let info;
  try {
    info = await stat(filePath);
  } catch (error) {
    if (!isFileSystemError(error)) throw error;
    throw documentUnreadable(error);
  }
  if (!info.isFile() || info.size > 8 * 1024 * 1024) {
    throw new ConsultChimpsError(
      "DB_INVALID_DOCUMENT",
      "Choose a JSON configuration file no larger than 8 MiB.",
    );
  }
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (!isFileSystemError(error)) throw error;
    throw documentUnreadable(error);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ConsultChimpsError(
      "DB_INVALID_JSON",
      "The configuration is not valid JSON. Correct it before retrying.",
    );
  }
}

export async function openDbInputs(
  options: DbInputOptions,
  controls: OperationControlOptions,
  recipe?: ImportRecipe,
): Promise<OpenDbInputs> {
  const chosen = [options.sheet, options.table, options.range].filter(
    (value) => value !== undefined,
  );
  if (
    chosen.length > 1 ||
    (chosen.length > 0 && (options.input.length !== 1 || recipe !== undefined))
  ) {
    throw new ConsultChimpsError(
      "DB_AMBIGUOUS_SELECTION",
      "Use one region flag with one workbook, or save multiple source selections in an import recipe.",
    );
  }
  const scratch = await createScratchDirectory(tmpdir());
  const files: FileSource[] = [];
  const workbooks: WorkbookImportSource[] = [];
  const paths: string[] = [];
  const keys = new Set<string>();
  async function close(): Promise<void> {
    try {
      await Promise.all(workbooks.map((workbook) => workbook.close()));
    } finally {
      try {
        await Promise.all(files.map((file) => file.close()));
      } finally {
        await scratch.close();
      }
    }
  }
  try {
    for (const input of options.input) {
      const { filePath, key } = await parseInput(input);
      if (keys.has(key))
        throw new ConsultChimpsError(
          "DB_DUPLICATE_SOURCE_KEY",
          "Two inputs use the same key. Give each input a unique alias, for example --input inventory=inventory.xlsx.",
        );
      keys.add(key);
      paths.push(path.resolve(filePath));
      const bytes = await openRandomAccessSource(filePath);
      files.push(bytes);
      const selection: WorkbookSelection | undefined = options.sheet
        ? { sheet: options.sheet, headerRow: options.headerRow ?? 1 }
        : options.table
          ? { table: options.table }
          : options.range
            ? { range: options.range }
            : undefined;
      workbooks.push(
        await createWorkbookImportSource({
          key,
          bytes,
          scratch,
          selection,
          selectionKeys: recipe?.routes
            .filter((route) => route.source === key)
            .map((route) => route.selection),
          hidden: options.hidden,
          headerRow: options.headerRow,
          verifyUnchanged: () => bytes.verifyUnchanged(),
          ...controls,
        }),
      );
    }
    return { paths, workbooks, close };
  } catch (error) {
    await close();
    throw error;
  }
}
