"use client";

/**
 * The shared shell every in-browser tool page is built from: the page frame,
 * the file picker, progress reporting, the results list, and the hook that
 * drives one byte-level operation.
 *
 * Everything here runs in the visitor's tab. Files are read with the File API,
 * processed in a Web Worker, and offered back as downloads. There is no upload,
 * no API route, and no server component work, which keeps the pages compatible
 * with the site's static export.
 *
 * The engines themselves live behind the worker, which imports them on demand,
 * so opening a tool page downloads neither a PDF nor a workbook engine before
 * anyone asks for one. `jszip` is likewise loaded only when someone asks for a
 * combined archive.
 */

import {
  isConsultChimpsError,
  type ByteArtifact,
  type OperationProgress,
  type OperationResult,
} from "@consultchimps/core";
import {
  formatHumanError,
  formatHumanResult,
  GENERIC_VOCABULARY,
  type MessageVocabulary,
} from "@consultchimps/messages";
import { runOperation } from "@/lib/operation-worker";
import type { ByteOperationTask } from "@/lib/operation-tasks";
import {
  ArrowRight,
  Ban,
  Download,
  FileArchive,
  FileText,
  LoaderCircle,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

/** Re-planning re-reads the source file, so wait for a pause in typing first. */
export const PREVIEW_DEBOUNCE_MS = 250;

/**
 * Entries in a combined download carry this timestamp rather than the visitor's
 * clock, so the same outputs always bundle into the same archive bytes. It
 * matches the fixed date the package writers stamp on the parts they write.
 */
const FIXED_ARCHIVE_DATE = new Date("1980-01-01T00:00:00.000Z");

/**
 * Browser wording for the shared explanations. Only the sentences that would
 * otherwise describe a terminal are replaced; everything else stays generic.
 */
export const WEB_VOCABULARY: MessageVocabulary = {
  ...GENERIC_VOCABULARY,
  artifactListReference: "shown under Results",
  examplesReference:
    "Open the guide linked at the top of this page if you need examples.",
  hiddenWorksheetOption:
    "If the data is on a hidden worksheet, turn on “Include hidden worksheets” on this page.",
  inputFormatReference:
    "Open the guide linked at the top of this page to review the expected input format.",
  pdfOptionsReference:
    "Open the guide linked at the top of this page to see the available PDF options and examples.",
  retryAfterChoosingDifferentOutput:
    "Choose a different output name on this page and start the task again.",
  retryWhenReady: "Choose Run again when you are ready.",
  spreadsheetOptionsReference:
    "Open the guide linked at the top of this page to see the available spreadsheet options and examples.",
};

export interface UploadedFile {
  readonly id: string;
  readonly name: string;
  readonly bytes: Uint8Array;
}

let fileCounter = 0;

/**
 * Read the files a visitor picked, dropping anything the tool cannot process.
 * Rejection is silent by design: the page simply stays in the state it was in,
 * which is what the "wrong file" test asserts.
 */
export async function readUploads(
  files: readonly File[],
  accepts: (file: File) => boolean,
): Promise<UploadedFile[]> {
  return Promise.all(
    files.filter(accepts).map(async (file) => {
      fileCounter += 1;
      return {
        id: `upload-${fileCounter}`,
        name: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
      };
    }),
  );
}

export function formatBytes(length: number): string {
  if (length < 1024) {
    return `${length} B`;
  }
  if (length < 1024 * 1024) {
    return `${(length / 1024).toFixed(1)} KB`;
  }
  return `${(length / (1024 * 1024)).toFixed(1)} MB`;
}

export function describeFailure(error: unknown): string {
  if (isConsultChimpsError(error)) {
    return formatHumanError(error.message, error.code, {
      vocabulary: WEB_VOCABULARY,
    });
  }
  const message =
    error instanceof Error ? error.message : "An unexpected problem occurred.";
  return formatHumanError(message, undefined, { vocabulary: WEB_VOCABULARY });
}

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on a later task so the browser has started reading the blob.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Offer a page-built text document as a download, the same way an operation's
 * own outputs are offered. Used by the mapping draft on the consolidate page,
 * which is assembled from what a visitor reviewed rather than handed over by
 * the worker.
 */
export function saveTextFile(
  text: string,
  name: string,
  mediaType: string,
): void {
  saveBlob(new Blob([text], { type: mediaType }), name);
}

/**
 * Offer page-built binary bytes as a download. This is the plain-download half
 * of saving a workspace: the fallback the workspace page uses wherever the File
 * System Access API is unavailable, and for a "download a copy" that is never an
 * in-place save. The bytes are copied into a fresh buffer first so the blob
 * never aliases memory the worker still holds.
 */
export function saveBinaryFile(
  bytes: Uint8Array,
  name: string,
  mediaType: string,
): void {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  saveBlob(new Blob([copy.buffer], { type: mediaType }), name);
}

function saveArtifact(artifact: ByteArtifact, fallbackMediaType: string): void {
  // Copy into a fresh buffer so the blob never aliases the operation's memory.
  const copy = new Uint8Array(artifact.bytes.byteLength);
  copy.set(artifact.bytes);
  saveBlob(
    new Blob([copy.buffer], { type: artifact.mediaType ?? fallbackMediaType }),
    artifact.name,
  );
}

/**
 * Bundle several outputs into one archive, written the way the package writers
 * write theirs: deflated so the download is no larger than it needs to be, and
 * deterministic: a fixed timestamp instead of the visitor's clock, no folder
 * entries, and DOS metadata so the file opens the same way everywhere.
 */
async function saveArchive(
  artifacts: readonly ByteArtifact[],
  archiveName: string,
): Promise<void> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  for (const artifact of artifacts) {
    zip.file(artifact.name, artifact.bytes, {
      createFolders: false,
      date: FIXED_ARCHIVE_DATE,
    });
  }
  saveBlob(
    await zip.generateAsync({
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
      platform: "DOS",
      type: "blob",
    }),
    archiveName,
  );
}

type RunStatus = "complete" | "failed" | "idle" | "running";

export interface RunState {
  readonly status: RunStatus;
  readonly progress: OperationProgress | null;
  readonly outputs: readonly ByteArtifact[];
  readonly message: string;
}

const IDLE_RUN: RunState = {
  status: "idle",
  progress: null,
  outputs: [],
  message: "",
};

export type OperationRun = RunState & {
  cancel: () => void;
  reset: () => void;
  run: (task: ByteOperationTask) => Promise<void>;
};

/**
 * Drives one byte-level operation in the worker: progress reporting,
 * cancellation, and the plain-language rendering of the outcome.
 *
 * An AbortSignal cannot cross into a worker, so the controller here is only a
 * local trigger: aborting it makes the client send a cancel command, and the
 * worker aborts the controller the operation actually observes.
 */
export function useOperationRun(): OperationRun {
  const [state, setState] = useState<RunState>(IDLE_RUN);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
    },
    [],
  );

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    setState(IDLE_RUN);
  }, []);

  const run = useCallback(async (task: ByteOperationTask): Promise<void> => {
    const controller = new AbortController();
    controllerRef.current = controller;
    setState({ ...IDLE_RUN, status: "running" });
    try {
      const outcome = await runOperation(task, {
        onProgress: (progress) => {
          setState((previous) =>
            previous.status === "running"
              ? { ...previous, progress }
              : previous,
          );
        },
        signal: controller.signal,
      });
      // Each operation reports its own metric names; the rendering only needs
      // the shared shape, so the union is widened once here.
      const result: OperationResult = outcome.result;
      setState({
        status: "complete",
        progress: null,
        outputs: outcome.outputs,
        message: formatHumanResult(result, { vocabulary: WEB_VOCABULARY }),
      });
    } catch (error) {
      setState({
        status: "failed",
        progress: null,
        outputs: [],
        message: describeFailure(error),
      });
    } finally {
      controllerRef.current = null;
    }
  }, []);

  return { ...state, cancel, reset, run };
}

export const primaryButtonClass =
  "inline-flex items-center justify-center gap-2 rounded-lg bg-fd-primary px-5 py-3 text-sm font-semibold text-fd-primary-foreground shadow-[3px_3px_0_var(--color-fd-foreground)] transition-transform hover:-translate-y-0.5 disabled:pointer-events-none disabled:opacity-50 disabled:shadow-none";
export const secondaryButtonClass =
  "inline-flex items-center justify-center gap-2 rounded-lg border bg-fd-card px-5 py-3 text-sm font-semibold transition-colors hover:bg-fd-accent disabled:pointer-events-none disabled:opacity-50";
export const compactButtonClass =
  "inline-flex items-center justify-center gap-1.5 rounded-md border bg-fd-card px-2.5 py-1.5 text-xs font-semibold transition-colors hover:bg-fd-accent disabled:pointer-events-none disabled:opacity-40";
export const inputClass =
  "w-full rounded-lg border bg-fd-card px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-fd-ring";
export const sectionClass =
  "rounded-xl border bg-fd-card/80 p-6 shadow-[0_12px_36px_hsl(15_10%_11%/6%)]";
export const noticeClass =
  "mt-4 overflow-x-auto whitespace-pre-wrap rounded-lg border border-fd-primary/40 bg-fd-accent/30 px-4 py-3 text-xs leading-6 text-fd-accent-foreground";
const kickerClass =
  "font-mono text-xs font-semibold uppercase tracking-[0.18em] text-fd-primary";

export interface FileSelection {
  /**
   * Put the selection back to nothing chosen, cancelling a read still in
   * flight. For an optional input a visitor can change their mind about, such
   * as the consolidate page's column mapping: without it the only way out of a
   * document that will not do is another document.
   */
  readonly clear: () => void;
  /** The chosen file, or null while nothing usable is selected. */
  readonly file: UploadedFile | null;
  /** Set when the last pick was rejected; cleared by the next one. */
  readonly rejected: string | null;
  /** True between choosing a file and finishing its read. */
  readonly reading: boolean;
  /**
   * Take a pick. `onChange` runs the instant the previous selection is
   * cleared, for a page holding answers of its own that the new file
   * invalidates; a page whose answers are keyed on the file itself needs none.
   */
  readonly choose: (files: readonly File[], onChange?: () => void) => void;
}

/**
 * One picker's selection, held so that at no instant does a page offer to act
 * on a document the visitor is not looking at.
 *
 * Reading an upload is asynchronous, and both hazards that follow from that
 * are handled here rather than at each call site:
 *
 * - The moment a pick starts, the previous selection is cleared. A large or
 *   cloud-backed replacement can take a noticeable time to read, and leaving
 *   the old file live for that window would let Run act on the very document
 *   that was just replaced.
 * - A read applies only while it is still the newest. Picking twice in quick
 *   succession leaves two reads in flight, and a big file picked first can
 *   finish after a small one picked second; without the token the older read
 *   would win.
 *
 * Exactly one file is read, however many arrive. A drag-and-drop carries the
 * whole drop even onto a picker whose input is single-file, and reading the
 * rest would pull documents nobody asked for into memory only to discard them,
 * which on a large batch of workbooks is enough to slow or exhaust the tab.
 */
export function useFileSelection(
  accepts: (file: File) => boolean,
  expected: string,
): FileSelection {
  const [file, setFile] = useState<UploadedFile | null>(null);
  const [rejected, setRejected] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const latest = useRef(0);

  const choose = useCallback(
    (files: readonly File[], onChange?: () => void) => {
      const token = (latest.current += 1);
      setFile(null);
      setRejected(null);
      setReading(true);
      onChange?.();

      // Filtering before reading keeps the selection rule exactly as it was,
      // the first file this tool accepts, while the read itself touches that
      // one file alone.
      const chosen = files.filter(accepts).slice(0, 1);

      void readUploads(chosen, accepts)
        .then((read) => {
          if (token !== latest.current) {
            return;
          }
          const [first] = read;
          setFile(first ?? null);
          setRejected(first ? null : rejectedUploadMessage(files, expected));
          setReading(false);
        })
        .catch(() => {
          // A cloud-backed or removable file can go unreadable mid-read.
          // Without this the picker would sit in its reading state forever,
          // with nothing selected and Run disabled, and say nothing about why.
          if (token !== latest.current) {
            return;
          }
          setFile(null);
          setRejected(
            "That file could not be read. It may have moved, gone offline, or been removed. Choose it again, or pick another file",
          );
          setReading(false);
        });
    },
    [accepts, expected],
  );

  // The token moves so a read still in flight cannot land after the clear and
  // put the document back.
  const clear = useCallback(() => {
    latest.current += 1;
    setFile(null);
    setRejected(null);
    setReading(false);
  }, []);

  return { choose, clear, file, reading, rejected };
}

/**
 * The message shown when a picker rejects everything it was given.
 *
 * `readUploads` drops files the tool cannot process and says nothing, which is
 * right when nothing was chosen yet. It is not right when a document is
 * already selected: silently keeping it would let someone who meant to replace
 * a file act on the old one instead. A page using `useFileSelection` therefore
 * clears the selection and says why, so a task can only ever use a file that
 * was chosen on purpose.
 */
function rejectedUploadMessage(
  files: readonly File[],
  expected: string,
): string {
  const [first] = files;
  const named = first ? `"${first.name}" is not` : "Those files are not";
  return `${named} ${expected}. Nothing is selected now, so choose ${expected} to continue`;
}

/** Shown in place of the file summary while a pick is still being read. */
export function ReadingFile({ testId }: { readonly testId: string }) {
  return (
    <p
      className="mt-3 text-sm text-fd-muted-foreground"
      data-testid={testId}
      role="status"
    >
      Reading the file…
    </p>
  );
}

/** The chosen file's name and size, shown under whichever picker took it. */
export function ChosenFile({
  file,
  testId,
}: {
  readonly file: UploadedFile;
  readonly testId: string;
}) {
  return (
    <p
      className="mt-3 flex items-center gap-2 text-sm text-fd-muted-foreground"
      data-testid={testId}
    >
      <FileText aria-hidden="true" className="size-4 shrink-0" />
      <span className="truncate font-mono">{file.name}</span>
      <span className="shrink-0">{formatBytes(file.bytes.byteLength)}</span>
    </p>
  );
}

function PrivacyNotice() {
  return (
    <p
      className="flex items-start gap-3 rounded-xl border border-fd-primary/35 bg-fd-accent/40 px-4 py-3 text-sm font-medium text-fd-accent-foreground"
      data-testid="privacy-notice"
    >
      <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      Files are processed locally in your browser and are not uploaded to
      ConsultChimps
    </p>
  );
}

interface ToolShellProps {
  readonly children: ReactNode;
  readonly description: string;
  readonly guideHref: string;
  readonly guideLabel: string;
  readonly kicker: string;
  readonly title: string;
}

export function ToolShell({
  children,
  description,
  guideHref,
  guideLabel,
  kicker,
  title,
}: ToolShellProps) {
  return (
    <main className="flex-1">
      <div className="mx-auto w-full max-w-[900px] px-6 pb-24 pt-16 lg:px-10 lg:pt-24">
        <div className={kickerClass}>{kicker}</div>
        <h1 className="mt-3 text-4xl font-bold tracking-[-0.05em] md:text-5xl">
          {title}
        </h1>
        <p className="mt-5 max-w-2xl text-lg leading-8 text-fd-muted-foreground">
          {description}
        </p>
        <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm font-semibold">
          <Link
            className="inline-flex items-center gap-1.5 text-fd-primary hover:underline"
            data-testid="guide-link"
            href={guideHref}
          >
            {guideLabel}
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </Link>
        </div>
        <div className="mt-8">
          <PrivacyNotice />
        </div>
        <div className="mt-8 flex flex-col gap-6">{children}</div>
      </div>
    </main>
  );
}

interface FilePickerProps {
  readonly accept: string;
  readonly description: string;
  readonly disabled: boolean;
  readonly label: string;
  readonly multiple: boolean;
  readonly onFiles: (files: File[]) => void;
}

export function FilePicker({
  accept,
  description,
  disabled,
  label,
  multiple,
  onFiles,
}: FilePickerProps) {
  const inputId = useId();
  const [isDragging, setIsDragging] = useState(false);

  return (
    <div
      className={`rounded-xl border-2 border-dashed p-6 transition-colors ${
        isDragging ? "border-fd-primary bg-fd-accent/40" : "bg-fd-card/60"
      }`}
      data-testid="file-picker"
      onDragEnter={(event) => {
        event.preventDefault();
        if (!disabled) {
          setIsDragging(true);
        }
      }}
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) {
          setIsDragging(true);
        }
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setIsDragging(false);
        if (!disabled) {
          onFiles([...event.dataTransfer.files]);
        }
      }}
    >
      <label className="block text-sm font-semibold" htmlFor={inputId}>
        {label}
      </label>
      <p className="mt-1 text-sm text-fd-muted-foreground">{description}</p>
      <input
        accept={accept}
        className="mt-4 block w-full cursor-pointer text-sm text-fd-muted-foreground file:mr-4 file:cursor-pointer file:rounded-lg file:border-0 file:bg-fd-foreground file:px-4 file:py-2 file:text-sm file:font-semibold file:text-fd-background disabled:cursor-not-allowed disabled:opacity-50"
        data-testid="file-input"
        disabled={disabled}
        id={inputId}
        multiple={multiple}
        onChange={(event) => {
          const selected = [...(event.target.files ?? [])];
          // Clear the control so re-picking the same file still fires change.
          event.target.value = "";
          onFiles(selected);
        }}
        type="file"
      />
    </div>
  );
}

export function ProgressReport({
  progress,
}: {
  readonly progress: OperationProgress;
}) {
  const percent =
    progress.total > 0
      ? Math.min(100, Math.round((progress.completed / progress.total) * 100))
      : 0;

  return (
    <div className="mt-4" data-testid="progress-report">
      <div className="flex items-center justify-between font-mono text-xs uppercase tracking-[0.12em] text-fd-muted-foreground">
        <span>
          {progress.stage} · {progress.completed} of {progress.total}
        </span>
        <span>{percent}%</span>
      </div>
      <div
        aria-label="Operation progress"
        aria-valuemax={progress.total}
        aria-valuemin={0}
        aria-valuenow={progress.completed}
        className="mt-2 h-2 w-full overflow-hidden rounded-full bg-fd-muted"
        role="progressbar"
      >
        <div
          className="h-full rounded-full bg-fd-primary transition-[width] duration-150"
          style={{ width: `${percent}%` }}
        />
      </div>
      {progress.detail ? (
        <p className="mt-2 truncate font-mono text-xs text-fd-muted-foreground">
          {progress.detail}
        </p>
      ) : null}
    </div>
  );
}

interface RunControlsProps {
  readonly busyLabel: string;
  readonly disabled: boolean;
  readonly onCancel: () => void;
  readonly onRun: () => void;
  readonly readingLabel: string;
  readonly runLabel: string;
  readonly state: RunState;
}

/** The Run and Cancel pair, plus whatever progress the operation reports. */
export function RunControls({
  busyLabel,
  disabled,
  onCancel,
  onRun,
  readingLabel,
  runLabel,
  state,
}: RunControlsProps) {
  const isRunning = state.status === "running";

  return (
    <>
      <div className="mt-4 flex flex-wrap gap-3">
        <button
          className={primaryButtonClass}
          data-testid="run-button"
          disabled={disabled || isRunning}
          onClick={onRun}
          type="button"
        >
          {isRunning ? (
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
          ) : null}
          {isRunning ? busyLabel : runLabel}
        </button>
        <button
          className={secondaryButtonClass}
          data-testid="cancel-button"
          disabled={!isRunning}
          onClick={onCancel}
          type="button"
        >
          <Ban className="size-4" aria-hidden="true" />
          Cancel
        </button>
      </div>
      {state.progress ? <ProgressReport progress={state.progress} /> : null}
      {isRunning && !state.progress ? (
        <p className="mt-4 text-sm text-fd-muted-foreground">{readingLabel}</p>
      ) : null}
    </>
  );
}

interface ResultsPanelProps {
  /**
   * The name of the combined download. Omitting it, like producing a single
   * output, leaves the bundle button out: a zip holding one file is friction
   * rather than a convenience.
   */
  readonly archiveName?: string | undefined;
  readonly fallbackMediaType: string;
  readonly state: RunState;
}

export function ResultsPanel({
  archiveName,
  fallbackMediaType,
  state,
}: ResultsPanelProps) {
  const headingId = useId();
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [isArchiving, setIsArchiving] = useState(false);

  if (state.status === "idle" || state.status === "running") {
    return null;
  }

  const failed = state.status === "failed";
  const bundleName = state.outputs.length > 1 ? archiveName : undefined;

  return (
    <section
      aria-labelledby={headingId}
      aria-live="polite"
      className={sectionClass}
      data-testid="results-section"
    >
      <h2 className="text-xl font-bold tracking-[-0.03em]" id={headingId}>
        Results
      </h2>

      {state.outputs.length > 0 ? (
        <>
          <ul className="mt-4 flex flex-col gap-2" data-testid="artifact-list">
            {state.outputs.map((output) => (
              <li
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-fd-background/60 px-3 py-2"
                data-testid="artifact-item"
                key={output.name}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <FileText
                    aria-hidden="true"
                    className="size-4 shrink-0 text-fd-muted-foreground"
                  />
                  <span
                    className="truncate font-mono text-sm"
                    data-testid="artifact-name"
                  >
                    {output.name}
                  </span>
                  <span className="shrink-0 text-xs text-fd-muted-foreground">
                    {formatBytes(output.bytes.byteLength)}
                  </span>
                </span>
                <button
                  className={compactButtonClass}
                  data-testid="artifact-download"
                  onClick={() => saveArtifact(output, fallbackMediaType)}
                  type="button"
                >
                  <Download className="size-3.5" aria-hidden="true" />
                  Download
                </button>
              </li>
            ))}
          </ul>
          {bundleName === undefined ? null : (
            <div className="mt-4">
              <button
                className={secondaryButtonClass}
                data-testid="archive-download"
                disabled={isArchiving}
                onClick={() => {
                  setArchiveError(null);
                  setIsArchiving(true);
                  void saveArchive(state.outputs, bundleName)
                    .catch((error: unknown) => {
                      setArchiveError(describeFailure(error));
                    })
                    .finally(() => setIsArchiving(false));
                }}
                type="button"
              >
                <FileArchive className="size-4" aria-hidden="true" />
                {isArchiving ? "Building archive…" : "Download all (.zip)"}
              </button>
            </div>
          )}
        </>
      ) : null}

      <pre
        className={`mt-5 overflow-x-auto whitespace-pre-wrap rounded-lg border px-4 py-3 text-xs leading-6 ${
          failed
            ? "border-fd-primary/40 bg-fd-accent/30 text-fd-accent-foreground"
            : "bg-fd-background/60"
        }`}
        data-testid={failed ? "failure-message" : "result-message"}
      >
        {state.message}
      </pre>

      {archiveError ? (
        <pre className={noticeClass} data-testid="archive-error">
          {archiveError}
        </pre>
      ) : null}
    </section>
  );
}
