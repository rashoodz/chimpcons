"use client";

import {
  describeFailure,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
  sectionClass,
  ToolShell,
} from "@/components/tool-kit";
import { WorkspaceImport } from "@/components/workspace-import";
import { WorkspaceSchemaReview } from "@/components/workspace-schema-review";
import { isConsultChimpsError } from "@consultchimps/core";
import type {
  WorkspaceDatabaseFormat,
  WorkspaceDeliveryPage,
  WorkspaceDeliverySummary,
  WorkspaceProgress,
  WorkspaceSchemaDocument,
  WorkspaceSchemaPlan,
  WorkspaceSummary,
} from "@/lib/workspace-protocol";
import { WorkspaceClient } from "@/lib/workspace-worker";
import {
  browserExportCleanupIntervalMilliseconds,
  cleanupExpiredBrowserExports,
  retainBrowserExportLease,
} from "@/lib/workspace-files";
import {
  Database,
  Download,
  FilePlus,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

const DATABASE_ACCEPT = ".sqlite,.sqlite3,.db,.duckdb";
const RECENT_DATABASES_KEY = "consultchimps.workspace.databases.v1";
const DEFAULT_SCHEMA = `{
  "version": 1,
  "tables": [
    {
      "name": "datasets",
      "recordId": { "prefix": "DATASET", "padding": 6 },
      "columns": [
        { "name": "dataset_name", "type": "text", "nullable": false },
        { "name": "reported_cde", "type": "boolean" }
      ]
    }
  ]
}`;

interface WorkspaceStatus {
  readonly kind: "error" | "notice";
  readonly message: string;
}

interface RecentDatabase {
  readonly name: string;
  readonly format: WorkspaceDatabaseFormat;
}

function readRecentDatabases(): RecentDatabase[] {
  try {
    const stored: unknown = JSON.parse(
      window.localStorage.getItem(RECENT_DATABASES_KEY) ?? "[]",
    );
    if (!Array.isArray(stored)) return [];
    return stored.flatMap((entry): RecentDatabase[] => {
      if (!isRecord(entry) || typeof entry["name"] !== "string") return [];
      const format = entry["format"];
      return format === "sqlite" || format === "duckdb"
        ? [{ name: entry["name"], format }]
        : [];
    });
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSchema(text: string): WorkspaceSchemaDocument {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) {
    throw new Error("The schema must be a JSON object");
  }
  return value;
}

async function downloadFile(file: File, name: string): Promise<() => void> {
  const releaseLease = await retainBrowserExportLease(file.name);
  let url: string | undefined;
  let anchor: HTMLAnchorElement | undefined;
  try {
    const downloadUrl = URL.createObjectURL(file);
    url = downloadUrl;
    anchor = document.createElement("a");
    anchor.href = downloadUrl;
    anchor.download = name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    return () => {
      URL.revokeObjectURL(downloadUrl);
      releaseLease();
    };
  } catch (error) {
    anchor?.remove();
    if (url !== undefined) URL.revokeObjectURL(url);
    releaseLease();
    throw error;
  }
}

function ProgressNotice({
  progress,
}: {
  readonly progress: WorkspaceProgress;
}) {
  const percent =
    progress.total === null || progress.total === 0
      ? null
      : Math.min(100, Math.round((progress.completed / progress.total) * 100));
  return (
    <div
      className="rounded-lg border bg-fd-muted/45 px-4 py-3"
      data-testid="workspace-progress"
      role="status"
    >
      <div className="flex items-center justify-between gap-4 text-sm">
        <span>{progress.message}</span>
        {percent === null ? null : <span>{percent}%</span>}
      </div>
      {percent === null ? null : (
        <progress className="mt-2 w-full" max={100} value={percent} />
      )}
    </div>
  );
}

function Summary({ summary }: { readonly summary: WorkspaceSummary }) {
  return (
    <section className={sectionClass} data-testid="workspace-summary">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.16em] text-fd-primary">
            Persistent working database
          </p>
          <h2 className="mt-2 font-display text-2xl font-semibold">
            {summary.workingCopyName}
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-fd-muted-foreground">
            Stored in this browser&apos;s private file system. Changes commit to
            this working copy. A file you opened and any file you exported are
            separate copies
          </p>
        </div>
        <span
          className="rounded-full border px-3 py-1 font-mono text-xs uppercase"
          data-testid="workspace-format"
        >
          {summary.format}
        </span>
      </div>
      <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-fd-muted-foreground">Tables</dt>
          <dd data-testid="workspace-table-count">{summary.tables.length}</dd>
        </div>
        <div>
          <dt className="text-fd-muted-foreground">Applied imports</dt>
          <dd>{summary.importCount}</dd>
        </div>
        <div>
          <dt className="text-fd-muted-foreground">Deliveries</dt>
          <dd data-testid="workspace-delivery-count">
            {summary.deliveryCount}
          </dd>
        </div>
        <div>
          <dt className="text-fd-muted-foreground">Format version</dt>
          <dd>{summary.formatVersion}</dd>
        </div>
      </dl>
      {summary.tables.length === 0 ? (
        <p className="mt-5 rounded-lg border border-dashed p-4 text-sm text-fd-muted-foreground">
          This database has no user tables yet
        </p>
      ) : (
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {summary.tables.map((table) => (
            <article
              className="rounded-lg border p-4"
              key={table.id}
              data-testid="workspace-table"
            >
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="font-semibold">{table.name}</h3>
                <span className="text-xs text-fd-muted-foreground">
                  {table.rowCount.toLocaleString()}{" "}
                  {table.rowCount === 1 ? "row" : "rows"}
                </span>
              </div>
              <p className="mt-2 text-xs text-fd-muted-foreground">
                {table.columns
                  .map((column) => `${column.name} (${column.type})`)
                  .join(", ")}
              </p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function deliveryScopeText(scope: WorkspaceDeliverySummary["scope"]): string {
  switch (scope.kind) {
    case "full":
      return "Full coverage";
    case "partial":
      return `Partial coverage: ${scope.description}`;
    case "changes":
      return `Changes since ${scope.baseline}`;
    case "unknown":
      return "Unknown coverage";
  }
}

export function WorkspaceTool() {
  const clientRef = useRef<WorkspaceClient | null>(null);
  const openInputRef = useRef<HTMLInputElement | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const deliveriesRequestRef = useRef(0);
  const exportLeaseReleasesRef = useRef<Set<() => void>>(new Set());
  const schemaReviewRevisionRef = useRef(0);
  const [summary, setSummary] = useState<WorkspaceSummary | null>(null);
  const [workspaceGeneration, setWorkspaceGeneration] = useState(0);
  const [format, setFormat] = useState<WorkspaceDatabaseFormat>("sqlite");
  const [name, setName] = useState("consultchimps.sqlite");
  const [openName, setOpenName] = useState("");
  const [openOverwrite, setOpenOverwrite] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<WorkspaceProgress | null>(null);
  const [reviewActive, setReviewActive] = useState(false);
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [schemaText, setSchemaText] = useState(DEFAULT_SCHEMA);
  const [schemaPlan, setSchemaPlan] = useState<WorkspaceSchemaPlan | null>(
    null,
  );
  const [deliveries, setDeliveries] = useState<WorkspaceDeliveryPage | null>(
    null,
  );
  const [deliveriesLoading, setDeliveriesLoading] = useState(false);
  const [recentDatabases, setRecentDatabases] = useState<
    readonly RecentDatabase[]
  >([]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setRecentDatabases(readRecentDatabases());
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    const exportLeaseReleases = exportLeaseReleasesRef.current;
    const cleanup = (): void => {
      void cleanupExpiredBrowserExports().catch(() => undefined);
    };
    cleanup();
    const interval = window.setInterval(
      cleanup,
      browserExportCleanupIntervalMilliseconds,
    );
    return () => {
      window.clearInterval(interval);
      for (const release of exportLeaseReleases) release();
      exportLeaseReleases.clear();
    };
  }, []);

  const remember = useCallback((next: WorkspaceSummary) => {
    setRecentDatabases((current) => {
      const updated = [
        { name: next.workingCopyName, format: next.format },
        ...current.filter((entry) => entry.name !== next.workingCopyName),
      ].slice(0, 8);
      window.localStorage.setItem(
        RECENT_DATABASES_KEY,
        JSON.stringify(updated),
      );
      return updated;
    });
  }, []);

  const client = useCallback(() => {
    clientRef.current ??= new WorkspaceClient();
    return clientRef.current;
  }, []);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      clientRef.current?.terminate();
    },
    [],
  );

  const reportError = useCallback((error: unknown) => {
    setStatus({ kind: "error", message: describeFailure(error) });
  }, []);

  const clearDeliveries = useCallback(() => {
    deliveriesRequestRef.current += 1;
    setDeliveries(null);
    setDeliveriesLoading(false);
  }, []);

  const invalidateSchemaReview = useCallback(() => {
    schemaReviewRevisionRef.current += 1;
    setSchemaPlan(null);
  }, []);

  const runLong = useCallback(
    async <T,>(
      label: string,
      run: (options: {
        readonly signal: AbortSignal;
        readonly onProgress: (next: WorkspaceProgress) => void;
      }) => Promise<T>,
    ): Promise<T | null> => {
      const controller = new AbortController();
      controllerRef.current = controller;
      setBusy(label);
      setProgress(null);
      setStatus(null);
      try {
        return await run({
          signal: controller.signal,
          onProgress: setProgress,
        });
      } catch (error) {
        if (
          (error instanceof DOMException && error.name === "AbortError") ||
          (isConsultChimpsError(error) && error.code === "OPERATION_ABORTED")
        ) {
          setStatus({
            kind: "notice",
            message:
              "Cancelled. The accepted database state was left unchanged",
          });
        } else {
          reportError(error);
        }
        return null;
      } finally {
        controllerRef.current = null;
        setBusy(null);
        setProgress(null);
      }
    },
    [reportError],
  );

  useEffect(() => {
    if (busy === null && !reviewActive) return;
    const hold = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", hold);
    return () => window.removeEventListener("beforeunload", hold);
  }, [busy, reviewActive]);

  const create = useCallback(async () => {
    const created = await runLong("Creating database", (options) =>
      client().create(format, name.trim(), options),
    );
    if (created === null) return;
    setSummary(created);
    setWorkspaceGeneration((current) => current + 1);
    remember(created);
    invalidateSchemaReview();
    clearDeliveries();
    setStatus({
      kind: "notice",
      message: "Created a persistent browser working database",
    });
  }, [
    clearDeliveries,
    client,
    format,
    invalidateSchemaReview,
    name,
    remember,
    runLong,
  ]);

  const open = useCallback(
    async (file: File) => {
      const workingCopyName = openName.trim();
      const opened = await runLong(
        "Copying database into browser storage",
        (options) =>
          client().open(
            file,
            {
              ...(workingCopyName === "" ? {} : { name: workingCopyName }),
              overwrite: openOverwrite,
            },
            options,
          ),
      );
      if (opened === null) return;
      setSummary(opened);
      setWorkspaceGeneration((current) => current + 1);
      remember(opened);
      invalidateSchemaReview();
      clearDeliveries();
      setStatus({
        kind: "notice",
        message: `Opened "${file.name}" as browser working copy "${opened.workingCopyName}". The selected file will not change`,
      });
    },
    [
      clearDeliveries,
      client,
      invalidateSchemaReview,
      openName,
      openOverwrite,
      remember,
      runLong,
    ],
  );

  const reopen = useCallback(
    async (workingCopyName: string) => {
      const opened = await runLong("Opening browser working copy", (options) =>
        client().reopen(workingCopyName, options),
      );
      if (opened === null) return;
      setSummary(opened);
      setWorkspaceGeneration((current) => current + 1);
      remember(opened);
      invalidateSchemaReview();
      clearDeliveries();
      setStatus({
        kind: "notice",
        message: `Reopened "${workingCopyName}" from browser storage`,
      });
    },
    [clearDeliveries, client, invalidateSchemaReview, remember, runLong],
  );

  const planSchema = useCallback(async () => {
    try {
      const revision = schemaReviewRevisionRef.current;
      const schema = parseSchema(schemaText);
      setSchemaPlan(null);
      const plan = await runLong("Reviewing schema", (options) =>
        client().planSchema(schema, options),
      );
      if (plan === null || revision !== schemaReviewRevisionRef.current) return;
      setSchemaPlan(plan);
      setStatus({
        kind: "notice",
        message: plan.ready
          ? "Schema review is ready to apply"
          : "Schema conflicts need a decision before anything can change",
      });
    } catch (error) {
      reportError(error);
    }
  }, [client, reportError, runLong, schemaText]);

  const applySchema = useCallback(async () => {
    if (schemaPlan === null || !schemaPlan.ready) return;
    const revision = schemaReviewRevisionRef.current;
    const next = await runLong("Applying schema", (options) =>
      client().applySchema(schemaPlan.id, options),
    );
    if (next === null || revision !== schemaReviewRevisionRef.current) return;
    setSummary(next);
    invalidateSchemaReview();
    setStatus({
      kind: "notice",
      message: "Applied the reviewed schema changes",
    });
  }, [client, invalidateSchemaReview, runLong, schemaPlan]);

  const loadDeliveries = useCallback(
    async (cursor: string | null) => {
      const request = deliveriesRequestRef.current + 1;
      deliveriesRequestRef.current = request;
      setDeliveriesLoading(true);
      try {
        const page = await client().listDeliveries(cursor);
        if (deliveriesRequestRef.current === request) setDeliveries(page);
      } catch (error) {
        if (deliveriesRequestRef.current === request) reportError(error);
      } finally {
        if (deliveriesRequestRef.current === request) {
          setDeliveriesLoading(false);
        }
      }
    },
    [client, reportError],
  );

  const exportDatabase = useCallback(
    async (targetFormat: WorkspaceDatabaseFormat) => {
      const exported = await runLong(
        "Creating a consistent export",
        (options) => client().export(targetFormat, options),
      );
      if (exported === null) return;
      try {
        exportLeaseReleasesRef.current.add(
          await downloadFile(exported.file, exported.name),
        );
        setStatus({
          kind: "notice",
          message: `Exported an independent ${exported.format} copy. Later browser changes will not update it`,
        });
      } catch (error) {
        reportError(error);
      }
    },
    [client, reportError, runLong],
  );

  const disabled = busy !== null;
  return (
    <ToolShell
      description="Create or open a persistent local database, review workbook imports, record deliveries, and export a portable copy"
      guideHref="/docs/getting-started"
      guideLabel="Read the getting started guide"
      kicker="Local database"
      title="Data workspace"
    >
      <section className={sectionClass} data-testid="workspace-start">
        <div className="grid gap-6 lg:grid-cols-2">
          <div>
            <h2 className="font-display text-xl font-semibold">New database</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-[12rem_1fr]">
              <label className="text-sm">
                Format
                <select
                  className={`${inputClass} mt-1`}
                  data-testid="workspace-new-format"
                  disabled={disabled}
                  onChange={(event) => {
                    const next = event.target.value;
                    if (next !== "sqlite" && next !== "duckdb") return;
                    setFormat(next);
                    setName(
                      next === "sqlite"
                        ? "consultchimps.sqlite"
                        : "consultchimps.duckdb",
                    );
                  }}
                  value={format}
                >
                  <option value="sqlite">SQLite</option>
                  <option value="duckdb">DuckDB</option>
                </select>
              </label>
              <label className="text-sm">
                Working copy name
                <input
                  className={`${inputClass} mt-1`}
                  data-testid="workspace-new-name"
                  disabled={disabled}
                  onChange={(event) => setName(event.target.value)}
                  value={name}
                />
              </label>
            </div>
            <div className="mt-3">
              <button
                className={primaryButtonClass}
                data-testid="workspace-new"
                disabled={disabled || name.trim() === ""}
                onClick={() => void create()}
                type="button"
              >
                {busy === "Creating database" ? (
                  <LoaderCircle
                    aria-hidden="true"
                    className="size-4 animate-spin"
                  />
                ) : (
                  <FilePlus aria-hidden="true" className="size-4" />
                )}
                Create
              </button>
            </div>
          </div>
          <div>
            <h2 className="font-display text-xl font-semibold">
              Open database file
            </h2>
            <label className="mt-4 block text-sm">
              Imported working copy name
              <input
                className={`${inputClass} mt-1`}
                data-testid="workspace-open-name"
                disabled={disabled}
                onChange={(event) => {
                  const next = event.target.value;
                  setOpenName(next);
                  if (next.trim() === "") setOpenOverwrite(false);
                }}
                placeholder="Create a unique name from the file"
                value={openName}
              />
            </label>
            <p className="mt-2 text-xs text-fd-muted-foreground">
              Leave blank to create a unique name from the selected file
            </p>
            <label className="mt-3 flex items-start gap-2.5 text-sm font-medium leading-6">
              <input
                checked={openOverwrite}
                className="mt-1 size-4 shrink-0 rounded border-fd-border accent-fd-primary"
                data-testid="workspace-open-overwrite"
                disabled={disabled || openName.trim() === ""}
                onChange={(event) => setOpenOverwrite(event.target.checked)}
                type="checkbox"
              />
              Replace an existing browser working copy with this name
            </label>
            <div className="mt-3">
              <button
                className={secondaryButtonClass}
                data-testid="workspace-open"
                disabled={disabled}
                onClick={() => openInputRef.current?.click()}
                type="button"
              >
                <FolderOpen aria-hidden="true" className="size-4" />
                Open file
              </button>
            </div>
            <input
              accept={DATABASE_ACCEPT}
              className="sr-only"
              data-testid="workspace-open-input"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file !== undefined) void open(file);
              }}
              ref={openInputRef}
              type="file"
            />
          </div>
        </div>
        <p className="mt-4 text-sm text-fd-muted-foreground">
          The working database stays in origin-private browser storage. Opening
          a file copies it there in bounded chunks and leaves the selected file
          unchanged
        </p>
        {recentDatabases.length === 0 ? null : (
          <div className="mt-5" data-testid="workspace-recent">
            <h3 className="text-sm font-semibold">Browser working copies</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              {recentDatabases.map((entry) => (
                <button
                  className={secondaryButtonClass}
                  data-testid="workspace-reopen"
                  disabled={disabled}
                  key={entry.name}
                  onClick={() => void reopen(entry.name)}
                  type="button"
                >
                  <FolderOpen aria-hidden="true" className="size-4" />
                  {entry.name} ({entry.format})
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

      {progress === null ? null : <ProgressNotice progress={progress} />}
      {busy === null ? null : (
        <button
          className={secondaryButtonClass}
          data-testid="workspace-cancel"
          onClick={() => controllerRef.current?.abort()}
          type="button"
        >
          <TriangleAlert aria-hidden="true" className="size-4" />
          Cancel {busy.toLowerCase()}
        </button>
      )}

      {summary === null ? (
        <section className={sectionClass} data-testid="workspace-empty">
          <p className="text-sm text-fd-muted-foreground">
            No database is open
          </p>
        </section>
      ) : (
        <>
          <Summary summary={summary} />
          <section className={sectionClass} data-testid="workspace-schema">
            <h2 className="font-display text-xl font-semibold">Schema</h2>
            <p className="mt-2 text-sm text-fd-muted-foreground">
              Review additive table and column changes before applying them.
              Conflicting types stay blocked
            </p>
            <textarea
              className={`${inputClass} mt-4 min-h-56 font-mono text-xs`}
              data-testid="workspace-schema-input"
              disabled={disabled}
              onChange={(event) => {
                const hadReview = schemaPlan !== null;
                setSchemaText(event.target.value);
                invalidateSchemaReview();
                if (hadReview) {
                  setStatus({
                    kind: "notice",
                    message:
                      "Schema document changed. Review it again before applying",
                  });
                }
              }}
              spellCheck={false}
              value={schemaText}
            />
            <div className="mt-3 flex gap-3">
              <button
                className={secondaryButtonClass}
                data-testid="workspace-schema-plan"
                disabled={disabled}
                onClick={() => void planSchema()}
                type="button"
              >
                Review schema
              </button>
              <button
                className={primaryButtonClass}
                data-testid="workspace-schema-apply"
                disabled={disabled || schemaPlan?.ready !== true}
                onClick={() => void applySchema()}
                type="button"
              >
                Apply reviewed changes
              </button>
            </div>
            {schemaPlan === null ? null : (
              <WorkspaceSchemaReview plan={schemaPlan} />
            )}
          </section>

          <WorkspaceImport
            busy={disabled}
            client={client}
            key={workspaceGeneration}
            summary={summary}
            onSummary={(next) => {
              setSummary(next);
              invalidateSchemaReview();
            }}
            onReviewState={setReviewActive}
            reportError={reportError}
            runLong={runLong}
          />

          <section className={sectionClass} data-testid="workspace-deliveries">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="font-display text-xl font-semibold">
                  Delivery history
                </h2>
                <p className="mt-1 text-sm text-fd-muted-foreground">
                  Delivery events stay separate from captured file contents
                </p>
              </div>
              <button
                className={secondaryButtonClass}
                data-testid="workspace-deliveries-refresh"
                disabled={disabled || deliveriesLoading}
                onClick={() => void loadDeliveries(null)}
                type="button"
              >
                <RefreshCw aria-hidden="true" className="size-4" />
                Refresh
              </button>
            </div>
            {deliveries === null ? null : deliveries.deliveries.length === 0 ? (
              <p className="mt-4 text-sm text-fd-muted-foreground">
                No deliveries recorded
              </p>
            ) : (
              <ol className="mt-4 space-y-3">
                {deliveries.deliveries.map((delivery) => (
                  <li
                    className="rounded-lg border p-4"
                    data-testid="workspace-delivery"
                    key={delivery.id}
                  >
                    <div className="flex justify-between gap-3">
                      <span className="font-semibold">{delivery.label}</span>
                      <span className="font-mono text-xs text-fd-muted-foreground">
                        {delivery.id}
                      </span>
                    </div>
                    <p className="mt-1 text-sm">
                      {delivery.vendor || "Unspecified vendor"} ·{" "}
                      {delivery.entity || "Unspecified entity"} ·{" "}
                      {delivery.phase || "Unspecified phase"} ·{" "}
                      {deliveryScopeText(delivery.scope)}
                    </p>
                    {delivery.reusedCapture ? (
                      <p className="mt-1 text-xs text-fd-muted-foreground">
                        Reused captured data without adding observation rows
                      </p>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
            {deliveries?.nextCursor === null || deliveries === null ? null : (
              <button
                className={`${secondaryButtonClass} mt-4`}
                data-testid="workspace-deliveries-next"
                disabled={disabled || deliveriesLoading}
                onClick={() => void loadDeliveries(deliveries.nextCursor)}
                type="button"
              >
                Next deliveries
              </button>
            )}
          </section>

          <section className={sectionClass} data-testid="workspace-export">
            <h2 className="font-display text-xl font-semibold">
              Export a portable copy
            </h2>
            <p className="mt-2 text-sm text-fd-muted-foreground">
              The worker checkpoints the working database and streams an
              independent file. Exporting does not move the working copy
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <button
                className={primaryButtonClass}
                data-testid="workspace-export-same"
                disabled={disabled}
                onClick={() => void exportDatabase(summary.format)}
                type="button"
              >
                <Download aria-hidden="true" className="size-4" />
                Export {summary.format}
              </button>
              <button
                className={secondaryButtonClass}
                data-testid="workspace-export-convert"
                disabled={disabled}
                onClick={() =>
                  void exportDatabase(
                    summary.format === "sqlite" ? "duckdb" : "sqlite",
                  )
                }
                type="button"
              >
                <Database aria-hidden="true" className="size-4" />
                Convert to {summary.format === "sqlite" ? "DuckDB" : "SQLite"}
              </button>
            </div>
          </section>
        </>
      )}

      {status === null ? null : (
        <pre
          aria-live="polite"
          className="overflow-x-auto whitespace-pre-wrap rounded-lg border border-fd-primary/40 bg-fd-accent/30 px-4 py-3 text-xs leading-6"
          data-testid={
            status.kind === "error" ? "workspace-error" : "workspace-notice"
          }
          role={status.kind === "error" ? "alert" : "status"}
        >
          {status.message}
        </pre>
      )}
    </ToolShell>
  );
}
