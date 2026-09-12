import { link, lstat, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { ConsultChimpsError } from "@consultchimps/core";

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modified: bigint;
  readonly changed: bigint;
}

export interface FilePublicationPlan {
  readonly output: string;
  readonly overwrite: boolean;
  readonly baseline: FileIdentity | null;
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function identity(filePath: string): Promise<FileIdentity | null> {
  try {
    const value = await lstat(filePath, { bigint: true });
    if (!value.isFile()) {
      throw new ConsultChimpsError(
        "FILES_INVALID_DESTINATION",
        "The destination must be a regular file, not a directory or symbolic link. Choose another filename.",
      );
    }
    return {
      device: value.dev,
      inode: value.ino,
      size: value.size,
      modified: value.mtimeNs,
      changed: value.ctimeNs,
    };
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

function sameVersion(
  left: FileIdentity | null,
  right: FileIdentity | null,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modified === right.modified &&
    left.changed === right.changed
  );
}

export async function planFilePublication(options: {
  readonly output: string;
  readonly inputs: readonly string[];
  readonly overwrite?: boolean | undefined;
}): Promise<FilePublicationPlan> {
  const output = path.resolve(options.output);
  const baseline = await identity(output);
  for (const input of options.inputs) {
    let aliases = path.resolve(input) === output;
    if (baseline) {
      const source = await stat(input, { bigint: true });
      aliases ||=
        (source.ino !== 0n &&
          source.ino === baseline.inode &&
          source.dev === baseline.device) ||
        (await realpath(input)) === (await realpath(output));
    }
    if (aliases) {
      throw new ConsultChimpsError(
        "FILES_INPUT_OVERWRITE",
        "The destination refers to an input file. Choose a separate output file; overwrite cannot replace a source.",
        { details: { outputPath: output } },
      );
    }
  }
  if (baseline && !options.overwrite) {
    throw new ConsultChimpsError(
      "FILES_OUTPUT_EXISTS",
      "The output already exists. Choose another filename or explicitly allow replacement.",
      { details: { outputPath: output } },
    );
  }
  return { output, overwrite: options.overwrite === true, baseline };
}

/** Publishes a closed staging file. Replacement requires exclusive destination ownership. */
export async function publishStagedFile(options: {
  readonly temporary: string;
  readonly plan: FilePublicationPlan;
}): Promise<void> {
  const temporary = path.resolve(options.temporary);
  const { plan } = options;
  if (
    temporary === plan.output ||
    path.dirname(temporary) !== path.dirname(plan.output)
  ) {
    throw new ConsultChimpsError(
      "FILES_INVALID_STAGING_PATH",
      "Stage the output under a separate filename in its destination directory.",
    );
  }
  if (!sameVersion(plan.baseline, await identity(plan.output))) {
    throw new ConsultChimpsError(
      "FILES_DESTINATION_CHANGED",
      "The output changed after it was checked. Keep the changed file and retry with a new destination.",
    );
  }
  if (!plan.baseline) {
    try {
      await link(temporary, plan.output);
    } catch (cause) {
      throw new ConsultChimpsError(
        "FILES_PUBLICATION_FAILED",
        "The output could not be published without replacing another file. Check the destination and retry with a new filename.",
        { cause },
      );
    }
    await rm(temporary);
    return;
  }
  if (!plan.overwrite)
    throw new ConsultChimpsError(
      "FILES_OUTPUT_EXISTS",
      "The output exists and replacement was not enabled.",
    );
  await rename(temporary, plan.output);
}
