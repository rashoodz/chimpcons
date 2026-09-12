import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

import { ConsultChimpsError } from "@consultchimps/core";
import fg from "fast-glob";

export {
  createScratchDirectory,
  openRandomAccessSource,
  type FileSource,
  type ScratchDirectory,
} from "./random-access.js";
export {
  planFilePublication,
  publishStagedFile,
  type FilePublicationPlan,
} from "./publication.js";

/**
 * Stable, published error codes thrown by @consultchimps/files. Values are
 * part of the versioned public API; never change an existing value.
 */
export const FILES_ERRORS = {
  FILES_INPUT_OVERWRITE: "FILES_INPUT_OVERWRITE",
  FILES_NO_INPUTS: "FILES_NO_INPUTS",
  FILES_NOT_FOUND: "FILES_NOT_FOUND",
  FILES_OUTPUT_EXISTS: "FILES_OUTPUT_EXISTS",
} as const;

export type FilesErrorCode = (typeof FILES_ERRORS)[keyof typeof FILES_ERRORS];

export interface DiscoverFilesOptions {
  cwd?: string | undefined;
  extensions?: string[] | undefined;
}

function normalizeExtensions(
  extensions: string[] | undefined,
): Set<string> | undefined {
  if (!extensions || extensions.length === 0) {
    return undefined;
  }

  return new Set(
    extensions.map((extension) => {
      const normalized = extension.toLowerCase();
      return normalized.startsWith(".") ? normalized : `.${normalized}`;
    }),
  );
}

function normalizeGlobPattern(input: string): string {
  return path.sep === "\\" ? input.replaceAll("\\", "/") : input;
}

function filesystemPathKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" || process.platform === "darwin"
    ? resolved.toLowerCase()
    : resolved;
}

/**
 * Whether two paths name the same file on this platform.
 *
 * Comparing resolved path strings is not enough: Windows and the usual macOS
 * volume fold case, so "Combined.xlsx" and "combined.xlsx" are one file there
 * and two files on Linux. An operation deciding whether two of its
 * destinations collide has to ask the platform's question, not the string's,
 * or it writes one output over another and still reports both.
 */
export function isSameFilesystemPath(
  firstPath: string,
  secondPath: string,
): boolean {
  return filesystemPathKey(firstPath) === filesystemPathKey(secondPath);
}

/**
 * Whether `candidatePath` is `ancestorPath` itself or sits beneath it.
 *
 * Two destinations can collide without being equal: naming a file
 * "report.xlsx" and a second output "report.xlsx/mapping.json" asks for one
 * path to be a file and a directory at once, which no filesystem grants. The
 * check is case-folded like {@link isSameFilesystemPath} for the same reason.
 */
export function isPathWithin(
  candidatePath: string,
  ancestorPath: string,
): boolean {
  const candidate = filesystemPathKey(candidatePath);
  const ancestor = filesystemPathKey(ancestorPath);
  if (candidate === ancestor) {
    return true;
  }
  const relative = path.relative(ancestor, candidate);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

export async function discoverFiles(
  inputs: string[],
  options: DiscoverFilesOptions = {},
): Promise<string[]> {
  if (inputs.length === 0) {
    throw new ConsultChimpsError(
      FILES_ERRORS.FILES_NO_INPUTS,
      "At least one input path or pattern is required.",
    );
  }

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const extensions = normalizeExtensions(options.extensions);
  const discovered = new Set<string>();

  for (const input of inputs) {
    const absoluteInput = path.resolve(cwd, input);

    try {
      const inputStat = await stat(absoluteInput);
      if (inputStat.isFile()) {
        discovered.add(absoluteInput);
        continue;
      }

      if (inputStat.isDirectory()) {
        const matches = await fg("**/*", {
          absolute: true,
          cwd: absoluteInput,
          onlyFiles: true,
        });
        matches.forEach((match) => discovered.add(path.resolve(match)));
        continue;
      }
    } catch {
      const matches = await fg(normalizeGlobPattern(input), {
        absolute: true,
        cwd,
        onlyFiles: true,
      });
      matches.forEach((match) => discovered.add(path.resolve(match)));
    }
  }

  const files = [...discovered]
    .filter(
      (filePath) =>
        !extensions || extensions.has(path.extname(filePath).toLowerCase()),
    )
    .sort((left, right) => left.localeCompare(right));

  if (files.length === 0) {
    throw new ConsultChimpsError(
      FILES_ERRORS.FILES_NOT_FOUND,
      "No files matched the supplied inputs.",
      {
        details: { inputs, cwd, extensions: options.extensions },
      },
    );
  }

  return files;
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(path.resolve(targetPath));
    return true;
  } catch {
    return false;
  }
}

export async function ensureDirectory(directoryPath: string): Promise<string> {
  const absolutePath = path.resolve(directoryPath);
  await mkdir(absolutePath, { recursive: true });
  return absolutePath;
}

export async function ensureParentDirectory(filePath: string): Promise<string> {
  const absolutePath = path.resolve(filePath);
  await ensureDirectory(path.dirname(absolutePath));
  return absolutePath;
}

export async function ensureOutputAvailable(
  outputPath: string,
  options: { overwrite?: boolean | undefined } = {},
): Promise<string> {
  const absolutePath = path.resolve(outputPath);
  if (options.overwrite) {
    return absolutePath;
  }

  try {
    await stat(absolutePath);
  } catch {
    return absolutePath;
  }

  throw new ConsultChimpsError(
    FILES_ERRORS.FILES_OUTPUT_EXISTS,
    `Output already exists: ${absolutePath}`,
    {
      details: { outputPath: absolutePath },
    },
  );
}

export function refuseInputOverwrite(
  outputPath: string,
  inputPaths: string[],
): void {
  const resolvedOutput = path.resolve(outputPath);
  const outputKey = filesystemPathKey(resolvedOutput);
  const inputKeys = new Set(inputPaths.map(filesystemPathKey));

  if (inputKeys.has(outputKey)) {
    throw new ConsultChimpsError(
      FILES_ERRORS.FILES_INPUT_OVERWRITE,
      `Refusing to overwrite an input file: ${resolvedOutput}`,
      { details: { outputPath: resolvedOutput } },
    );
  }
}
