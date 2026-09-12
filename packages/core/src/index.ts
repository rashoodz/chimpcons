export { safeNameFragment, truncateToUtf8Bytes } from "./names.js";
export type { RandomAccessFile, RandomAccessSource } from "./bytes.js";

export type ArtifactKind = "file" | "directory";

export interface Artifact {
  kind: ArtifactKind;
  path: string;
  mediaType?: string;
}

/**
 * The structured outcome of a completed operation. TMetric narrows the metric
 * names an operation reports, making metric renames a compile-time error; the
 * default keeps consumers that handle arbitrary operations working.
 */
export interface OperationResult<TMetric extends string = string> {
  operation: string;
  artifacts: Artifact[];
  warnings: string[];
  metrics: Record<TMetric, number>;
}

export interface OperationProgress {
  operation: string;
  stage: string;
  completed: number;
  total: number;
  detail?: string;
}

export type ProgressReporter = (progress: OperationProgress) => void;

/**
 * Cross-cutting controls accepted by every long-running operation. Progress
 * events are deterministic for identical inputs and options; aborting stops
 * the operation before its next unit of work with an OPERATION_ABORTED error.
 */
export interface OperationControlOptions {
  signal?: AbortSignal | undefined;
  onProgress?: ProgressReporter | undefined;
}

export interface PlannedOutput {
  kind: ArtifactKind;
  path: string;
  /**
   * True when something already exists at this path. Executing the operation
   * without overwrite enabled will refuse to replace it.
   */
  exists: boolean;
  mediaType?: string;
}

/**
 * The validated write plan for an operation: every input it will read and
 * every output it intends to create, computed without writing anything.
 */
export interface OperationPlan<TMetric extends string = string> {
  operation: string;
  inputs: string[];
  outputs: PlannedOutput[];
  warnings: string[];
  metrics: Record<TMetric, number>;
}

/**
 * An output produced entirely in memory by a byte-level operation variant.
 * The name is a plain portable filename, never a filesystem path.
 */
export interface ByteArtifact {
  name: string;
  bytes: Uint8Array;
  mediaType?: string;
}

/**
 * The outcome of a byte-level operation variant: the same structured result
 * the path-based operation reports (artifact paths carry output names), plus
 * the produced bytes themselves.
 */
export interface ByteOperationOutcome<TMetric extends string = string> {
  result: OperationResult<TMetric>;
  outputs: ByteArtifact[];
}

export const OPERATION_ABORTED = "OPERATION_ABORTED";

/**
 * Where a cancelled operation's already-produced outputs live: "files" for
 * path-based operations, whose completed output files remain on disk, or
 * "memory" for byte-based operations, which return nothing when cancelled.
 */
export type AbortOutputContext = "files" | "memory";

export function throwIfAborted(
  signal: AbortSignal | undefined,
  operation: string,
  outputContext: AbortOutputContext = "files",
): void {
  if (signal?.aborted) {
    const consequence =
      outputContext === "memory"
        ? "No source data was changed and no partial output was produced."
        : "No source file was changed; output files completed before the cancellation may remain.";
    throw new ConsultChimpsError(
      OPERATION_ABORTED,
      `The "${operation}" operation was cancelled before it finished. ${consequence}`,
      {
        cause: signal.reason,
        details: { operation },
      },
    );
  }
}

export interface ConsultChimpsErrorOptions {
  cause?: unknown;
  details?: Record<string, unknown>;
}

export class ConsultChimpsError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: string,
    message: string,
    options: ConsultChimpsErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ConsultChimpsError";
    this.code = code;
    this.details = options.details;
  }
}

export function isConsultChimpsError(
  error: unknown,
): error is ConsultChimpsError {
  return error instanceof ConsultChimpsError;
}
