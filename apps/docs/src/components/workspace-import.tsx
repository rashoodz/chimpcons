"use client";

import {
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
  sectionClass,
} from "@/components/tool-kit";
import { WORKBOOK_FILES } from "@/lib/accepted-files";
import type {
  WorkspaceDeliveryContext,
  WorkspaceImportFile,
  WorkspacePreparedImport,
  WorkspacePreviewPage,
  WorkspaceProgress,
  WorkspaceRouteDecision,
  WorkspaceSummary,
} from "@/lib/workspace-protocol";
import type { WorkspaceClient } from "@/lib/workspace-worker";
import { isConsultChimpsError } from "@consultchimps/core";
import {
  FileSpreadsheet,
  LoaderCircle,
  PackageCheck,
  Truck,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useEffect } from "react";

interface ImportSourceState {
  readonly id: string;
  readonly file: File;
  readonly role: string;
  readonly revision: string;
}

interface WorkspaceImportProps {
  readonly busy: boolean;
  readonly client: () => WorkspaceClient;
  readonly summary: WorkspaceSummary;
  readonly onSummary: (summary: WorkspaceSummary) => void;
  readonly reportError: (error: unknown) => void;
  readonly onReviewState: (active: boolean) => void;
  readonly runLong: <T>(
    label: string,
    run: (options: {
      readonly signal: AbortSignal;
      readonly onProgress: (progress: WorkspaceProgress) => void;
    }) => Promise<T>,
  ) => Promise<T | null>;
}

const COLUMN_TYPES = [
  "text",
  "integer",
  "real",
  "decimal",
  "boolean",
  "date",
  "timestamp",
] as const;

const PENDING_IMPORTS_KEY = "consultchimps.workspace.pending-imports.v1";

interface PendingImportRequest {
  readonly databaseId: string;
  readonly planId: string;
  readonly delivery: WorkspaceDeliveryContext;
  readonly operation?: "apply" | "delivery" | undefined;
}

function isPendingImportRequest(value: unknown): value is PendingImportRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const request = value as Record<string, unknown>;
  const delivery = request["delivery"];
  if (
    typeof delivery !== "object" ||
    delivery === null ||
    Array.isArray(delivery)
  ) {
    return false;
  }
  const context = delivery as Record<string, unknown>;
  return (
    typeof request["databaseId"] === "string" &&
    typeof request["planId"] === "string" &&
    (request["operation"] === undefined ||
      request["operation"] === "apply" ||
      request["operation"] === "delivery") &&
    typeof context["requestId"] === "string" &&
    typeof context["vendor"] === "string" &&
    typeof context["entity"] === "string" &&
    typeof context["phase"] === "string" &&
    (context["coverage"] === "full" ||
      context["coverage"] === "partial" ||
      context["coverage"] === "unknown") &&
    (context["effectiveDate"] === null ||
      typeof context["effectiveDate"] === "string") &&
    (context["receivedDate"] === null ||
      typeof context["receivedDate"] === "string") &&
    typeof context["note"] === "string"
  );
}

function readPendingImports(): readonly PendingImportRequest[] {
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(PENDING_IMPORTS_KEY) ?? "[]",
    );
    return Array.isArray(parsed) ? parsed.filter(isPendingImportRequest) : [];
  } catch {
    return [];
  }
}

function pendingImport(
  databaseId: string,
  planId: string,
): PendingImportRequest | null {
  return (
    readPendingImports().find(
      (request) =>
        request.databaseId === databaseId && request.planId === planId,
    ) ?? null
  );
}

function writePendingImport(request: PendingImportRequest): void {
  const next = [
    request,
    ...readPendingImports().filter(
      (candidate) =>
        candidate.databaseId !== request.databaseId ||
        candidate.planId !== request.planId,
    ),
  ];
  window.localStorage.setItem(PENDING_IMPORTS_KEY, JSON.stringify(next));
}

function clearPendingImport(databaseId: string, planId: string): void {
  const next = readPendingImports().filter(
    (request) => request.databaseId !== databaseId || request.planId !== planId,
  );
  window.localStorage.setItem(PENDING_IMPORTS_KEY, JSON.stringify(next));
}

async function executePendingImport<T>(
  request: PendingImportRequest,
  execute: () => Promise<T>,
): Promise<T> {
  writePendingImport(request);
  try {
    return await execute();
  } catch (error) {
    if (
      isConsultChimpsError(error) &&
      [
        "DB_REQUEST_ID_CONFLICT",
        "DB_INVALID_DELIVERY_CONTEXT",
        "DB_DELIVERY_REQUEST_ID_REQUIRED",
        "DB_IMPORT_REQUEST_ID_REQUIRED",
      ].includes(error.code)
    ) {
      clearPendingImport(request.databaseId, request.planId);
    }
    throw error;
  }
}

function emptyDelivery(): WorkspaceDeliveryContext {
  return {
    requestId: "",
    vendor: "",
    entity: "",
    phase: "",
    coverage: "unknown",
    effectiveDate: null,
    receivedDate: null,
    note: "",
  };
}

function decisionsFor(plan: WorkspacePreparedImport): WorkspaceRouteDecision[] {
  return plan.regions.map((region) => {
    const route =
      region.route.kind === "unresolved"
        ? { kind: "create" as const, table: region.route.suggestedTable }
        : region.route;
    return {
      regionId: region.id,
      route,
      columns: region.columns.map((column) => ({
        source: column.source,
        destination: column.destination,
        type: column.destinationType ?? column.inferredType,
      })),
    };
  });
}

function sameDecisions(
  left: readonly WorkspaceRouteDecision[],
  right: readonly WorkspaceRouteDecision[],
): boolean {
  return (
    left.length === right.length &&
    left.every((decision, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        decision.regionId === other.regionId &&
        decision.route.kind === other.route.kind &&
        decision.route.table === other.route.table &&
        decision.columns.length === other.columns.length &&
        decision.columns.every((column, columnIndex) => {
          const otherColumn = other.columns[columnIndex];
          return (
            otherColumn !== undefined &&
            column.source === otherColumn.source &&
            column.destination === otherColumn.destination &&
            column.type === otherColumn.type
          );
        })
      );
    })
  );
}

function fileKey(file: File, index: number): string {
  return `${file.name}:${String(file.size)}:${String(file.lastModified)}:${String(index)}`;
}

export function WorkspaceImport({
  busy,
  client,
  summary,
  onSummary,
  reportError,
  onReviewState,
  runLong,
}: WorkspaceImportProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const decisionGenerationRef = useRef(0);
  const lastCompletedRequest = useRef<{
    readonly planId: string;
    readonly requestId: string;
  } | null>(null);
  const [sources, setSources] = useState<readonly ImportSourceState[]>([]);
  const [plan, setPlan] = useState<WorkspacePreparedImport | null>(null);
  const [savedPlans, setSavedPlans] = useState<
    readonly WorkspacePreparedImport[]
  >([]);
  const [ignoredPlanCount, setIgnoredPlanCount] = useState(0);
  const [decisions, setDecisions] = useState<readonly WorkspaceRouteDecision[]>(
    [],
  );
  const [approvedDecisions, setApprovedDecisions] = useState<
    readonly WorkspaceRouteDecision[] | null
  >(null);
  const [resolving, setResolving] = useState(false);
  const [preview, setPreview] = useState<WorkspacePreviewPage | null>(null);
  const [delivery, setDelivery] =
    useState<WorkspaceDeliveryContext>(emptyDelivery);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    onReviewState(plan !== null && result === null);
    return () => onReviewState(false);
  }, [onReviewState, plan, result]);

  useEffect(() => {
    let active = true;
    void client()
      .listImports()
      .then((listing) => {
        if (!active) return;
        setSavedPlans(
          listing.plans.filter(
            (saved) =>
              saved.application === "pending" ||
              pendingImport(summary.databaseId, saved.id) !== null,
          ),
        );
        setIgnoredPlanCount(listing.ignoredPlanCount);
      })
      .catch((error: unknown) => {
        if (active) reportError(error);
      });
    return () => {
      active = false;
    };
  }, [client, reportError, summary.databaseId, summary.workingCopyName]);

  const existingTables = useMemo(
    () => summary.tables.map((table) => table.name),
    [summary.tables],
  );

  const chooseFiles = useCallback(
    (files: FileList | null) => {
      if (files === null || resolving) return;
      const accepted = Array.from(files).filter(WORKBOOK_FILES.accepts);
      setSources(
        accepted.map((file, index) => ({
          id: fileKey(file, index),
          file,
          role: "",
          revision: "",
        })),
      );
      decisionGenerationRef.current += 1;
      setPlan(null);
      setApprovedDecisions(null);
      setPreview(null);
      setResult(null);
      setDelivery({
        ...emptyDelivery(),
        requestId: `delivery-${globalThis.crypto.randomUUID()}`,
      });
    },
    [resolving],
  );

  const updateSource = useCallback(
    (id: string, field: "revision" | "role", value: string) => {
      setSources((current) =>
        current.map((source) =>
          source.id === id ? { ...source, [field]: value } : source,
        ),
      );
    },
    [],
  );

  const prepare = useCallback(async () => {
    if (resolving) return;
    const selected: WorkspaceImportFile[] = sources.map((source) => ({
      id: source.id,
      file: source.file,
      role: source.role,
      revision: source.revision,
    }));
    const prepared = await runLong("Preparing import", (options) =>
      client().prepareImport(selected, options),
    );
    if (prepared === null) return;
    setPlan(prepared);
    setSavedPlans((current) => [
      prepared,
      ...current.filter((candidate) => candidate.id !== prepared.id),
    ]);
    const preparedDecisions = decisionsFor(prepared);
    decisionGenerationRef.current += 1;
    setDecisions(preparedDecisions);
    setApprovedDecisions(prepared.state === "ready" ? preparedDecisions : null);
    setPreview(null);
    setResult(null);
  }, [client, resolving, runLong, sources]);

  const updateRoute = useCallback(
    (regionId: string, kind: "append" | "create", table: string) => {
      setDecisions((current) =>
        current.map((decision) =>
          decision.regionId === regionId
            ? { ...decision, route: { kind, table } }
            : decision,
        ),
      );
      decisionGenerationRef.current += 1;
    },
    [],
  );

  const updateColumn = useCallback(
    (
      regionId: string,
      source: string,
      field: "destination" | "type",
      value: string,
    ) => {
      setDecisions((current) =>
        current.map((decision) =>
          decision.regionId === regionId
            ? {
                ...decision,
                columns: decision.columns.map((column) =>
                  column.source === source
                    ? {
                        ...column,
                        [field]:
                          field === "destination" && value === ""
                            ? null
                            : value,
                      }
                    : column,
                ),
              }
            : decision,
        ),
      );
      decisionGenerationRef.current += 1;
    },
    [],
  );

  const resolve = useCallback(async () => {
    if (plan === null || resolving || plan.application === "applied") return;
    const submittedDecisions = decisions;
    const submittedGeneration = decisionGenerationRef.current;
    setResolving(true);
    try {
      const resolved = await client().resolveImport(
        plan.id,
        submittedDecisions,
      );
      const resolvedDecisions = decisionsFor(resolved);
      setPlan(resolved);
      setSavedPlans((current) =>
        current.map((candidate) =>
          candidate.id === resolved.id ? resolved : candidate,
        ),
      );
      setApprovedDecisions(resolvedDecisions);
      if (decisionGenerationRef.current === submittedGeneration) {
        setDecisions(resolvedDecisions);
      }
    } catch (error) {
      reportError(error);
    } finally {
      setResolving(false);
    }
  }, [client, decisions, plan, reportError, resolving]);

  const reviewIsCurrent =
    !resolving &&
    plan?.state === "ready" &&
    approvedDecisions !== null &&
    sameDecisions(decisions, approvedDecisions);
  const reviewNeedsUpdate =
    plan?.state === "ready" &&
    approvedDecisions !== null &&
    !sameDecisions(decisions, approvedDecisions);
  const pendingRequest =
    plan === null ? null : pendingImport(summary.databaseId, plan.id);
  const mappingLocked =
    resolving || plan?.application === "applied" || pendingRequest !== null;

  const loadPreview = useCallback(
    async (regionId: string, cursor: string | null) => {
      if (plan === null) return;
      try {
        setPreview(await client().previewImport(plan.id, regionId, cursor));
      } catch (error) {
        reportError(error);
      }
    },
    [client, plan, reportError],
  );

  const apply = useCallback(async () => {
    if (plan === null || plan.state !== "ready" || !reviewIsCurrent) return;
    const pending = pendingImport(summary.databaseId, plan.id);
    const request = pending?.delivery ?? delivery;
    const operation = pending?.operation ?? "apply";
    setDelivery(request);
    const applied = await runLong("Applying import", (options) =>
      executePendingImport(
        {
          databaseId: summary.databaseId,
          planId: plan.id,
          delivery: request,
          operation,
        },
        () =>
          operation === "delivery"
            ? client().recordDelivery(plan.id, request, options)
            : client().applyImport(plan.id, request, options),
      ),
    );
    if (applied === null) return;
    clearPendingImport(summary.databaseId, plan.id);
    lastCompletedRequest.current = {
      planId: plan.id,
      requestId: request.requestId,
    };
    setSavedPlans((current) =>
      current.filter((candidate) => candidate.id !== plan.id),
    );
    onSummary(applied.summary);
    setResult(
      applied.outcome === "duplicate"
        ? `This capture was already applied. Added 0 rows and skipped ${applied.skippedRows.toLocaleString()} rows`
        : `Added ${applied.appendedRows.toLocaleString()} rows, skipped ${applied.skippedRows.toLocaleString()}, and left ${applied.unresolvedRows.toLocaleString()} subject links unresolved`,
    );
    setPlan({
      ...plan,
      application: "applied",
      duplicateOf: applied.outcome === "duplicate" ? applied.importId : null,
      captureIds: applied.captureIds,
    });
  }, [
    client,
    delivery,
    onSummary,
    plan,
    reviewIsCurrent,
    runLong,
    summary.databaseId,
  ]);

  const recordAgain = useCallback(async () => {
    if (plan === null || plan.state !== "ready" || resolving) return;
    const pending = pendingImport(summary.databaseId, plan.id);
    const operation =
      pending === null
        ? plan.application === "applied"
          ? "delivery"
          : "apply"
        : (pending.operation ?? "apply");
    if (operation === "apply" && !reviewIsCurrent) return;
    const completed = lastCompletedRequest.current;
    const request =
      pending?.delivery ??
      (completed?.planId === plan.id &&
      completed.requestId === delivery.requestId
        ? {
            ...delivery,
            requestId: `delivery-${globalThis.crypto.randomUUID()}`,
          }
        : delivery);
    setDelivery(request);
    const recorded = await runLong("Recording delivery", (options) =>
      executePendingImport(
        {
          databaseId: summary.databaseId,
          planId: plan.id,
          delivery: request,
          operation,
        },
        () =>
          operation === "delivery"
            ? client().recordDelivery(plan.id, request, options)
            : client().applyImport(plan.id, request, options),
      ),
    );
    if (recorded === null) return;
    clearPendingImport(summary.databaseId, plan.id);
    lastCompletedRequest.current = {
      planId: plan.id,
      requestId: request.requestId,
    };
    setSavedPlans((current) =>
      current.filter((candidate) => candidate.id !== plan.id),
    );
    onSummary(recorded.summary);
    setResult(
      recorded.deliveriesRecorded > 0
        ? "Recorded a separate delivery event and reused the captured rows"
        : "This delivery was already recorded; reused the captured rows without adding another event",
    );
    setPlan({
      ...plan,
      application: "applied",
      captureIds: recorded.captureIds,
    });
  }, [
    client,
    delivery,
    onSummary,
    plan,
    reviewIsCurrent,
    resolving,
    runLong,
    summary.databaseId,
  ]);

  const setDeliveryField = useCallback(
    (field: keyof WorkspaceDeliveryContext, value: string) => {
      setDelivery((current) => ({
        ...current,
        [field]:
          (field === "effectiveDate" || field === "receivedDate") &&
          value === ""
            ? null
            : value,
      }));
    },
    [],
  );

  return (
    <section className={sectionClass} data-testid="workspace-import">
      <h2 className="font-display text-xl font-semibold">Prepare an import</h2>
      <p className="mt-2 text-sm text-fd-muted-foreground">
        Choose one or more Excel workbooks. The worker hashes and reads them in
        bounded batches, then holds a durable review without changing accepted
        tables
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <button
          className={secondaryButtonClass}
          data-testid="workspace-import-choose"
          disabled={busy || resolving}
          onClick={() => inputRef.current?.click()}
          type="button"
        >
          <FileSpreadsheet aria-hidden="true" className="size-4" />
          Choose workbooks
        </button>
        <input
          accept={WORKBOOK_FILES.accept}
          className="sr-only"
          data-testid="workspace-import-input"
          multiple
          onChange={(event) => {
            chooseFiles(event.target.files);
            event.target.value = "";
          }}
          ref={inputRef}
          type="file"
        />
        <button
          className={primaryButtonClass}
          data-testid="workspace-import-prepare"
          disabled={busy || resolving || sources.length === 0}
          onClick={() => void prepare()}
          type="button"
        >
          {busy ? (
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
          ) : (
            <PackageCheck aria-hidden="true" className="size-4" />
          )}
          Prepare review
        </button>
      </div>

      {savedPlans.length === 0 ? null : (
        <div className="mt-4 rounded-lg border p-4">
          <h3 className="font-semibold">Saved import reviews</h3>
          <p className="mt-1 text-xs text-fd-muted-foreground">
            Captured rows stay in browser storage, so you can resume without
            choosing the original workbook again
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {savedPlans.map((saved) => (
              <button
                className={secondaryButtonClass}
                data-testid="workspace-import-resume"
                disabled={resolving}
                key={saved.id}
                onClick={() => {
                  const pending = pendingImport(summary.databaseId, saved.id);
                  const savedDecisions = decisionsFor(saved);
                  setPlan(saved);
                  decisionGenerationRef.current += 1;
                  setDecisions(savedDecisions);
                  setApprovedDecisions(
                    saved.state === "ready" ? savedDecisions : null,
                  );
                  setPreview(null);
                  setResult(null);
                  setDelivery(
                    pending?.delivery ?? {
                      ...emptyDelivery(),
                      requestId: `delivery-${globalThis.crypto.randomUUID()}`,
                    },
                  );
                }}
                type="button"
              >
                {saved.application === "applied"
                  ? "Finish recovery "
                  : "Resume "}
                {saved.regions.map((region) => region.fileName).join(", ")}
              </button>
            ))}
          </div>
        </div>
      )}
      {ignoredPlanCount === 0 ? null : (
        <p className="mt-4 rounded-lg border p-3 text-sm" role="status">
          {ignoredPlanCount.toLocaleString()} unreadable saved import files were
          ignored
        </p>
      )}

      {sources.length === 0 ? null : (
        <div className="mt-5 space-y-3" data-testid="workspace-import-sources">
          {sources.map((source) => (
            <article
              className="grid gap-3 rounded-lg border p-4 sm:grid-cols-[minmax(0,1fr)_12rem_12rem]"
              data-testid="workspace-import-source"
              key={source.id}
            >
              <div className="min-w-0">
                <p className="truncate font-mono text-sm">{source.file.name}</p>
                <p className="text-xs text-fd-muted-foreground">
                  {source.file.size.toLocaleString()} bytes
                </p>
              </div>
              <label className="text-xs">
                Business role
                <input
                  className={`${inputClass} mt-1`}
                  data-testid="workspace-import-role"
                  onChange={(event) =>
                    updateSource(source.id, "role", event.target.value)
                  }
                  placeholder="inventory"
                  value={source.role}
                />
              </label>
              <label className="text-xs">
                Source revision
                <input
                  className={`${inputClass} mt-1`}
                  data-testid="workspace-import-revision"
                  onChange={(event) =>
                    updateSource(source.id, "revision", event.target.value)
                  }
                  placeholder="Iteration 2"
                  value={source.revision}
                />
              </label>
            </article>
          ))}
        </div>
      )}

      {plan === null ? null : (
        <div className="mt-6" data-testid="workspace-import-review">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h3 className="font-semibold">
              Review {plan.totalRows.toLocaleString()} source rows
            </h3>
            <span className="font-mono text-xs uppercase">
              {plan.state.replace("-", " ")}
            </span>
          </div>
          {plan.duplicateOf === null ? null : (
            <p
              className="mt-3 rounded-lg border bg-fd-muted/40 p-3 text-sm"
              data-testid="workspace-import-duplicate"
            >
              The same captured contents and selection were already applied.
              Applying again adds no observation rows
            </p>
          )}
          <div className="mt-4 space-y-4">
            {plan.regions.map((region, regionIndex) => {
              const decision = decisions.find(
                (entry) => entry.regionId === region.id,
              );
              if (decision === undefined) return null;
              return (
                <article
                  className="rounded-lg border p-4"
                  data-testid="workspace-import-region"
                  key={region.id}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h4 className="font-semibold">
                        {region.fileName}: {region.label}
                      </h4>
                      <p className="text-xs text-fd-muted-foreground">
                        {region.rowCount.toLocaleString()} rows,{" "}
                        {region.columns.length} columns
                      </p>
                    </div>
                    <button
                      className={secondaryButtonClass}
                      data-testid="workspace-import-preview"
                      onClick={() => void loadPreview(region.id, null)}
                      type="button"
                    >
                      Preview rows
                    </button>
                  </div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-[10rem_1fr]">
                    <label className="text-xs">
                      Route
                      <select
                        className={`${inputClass} mt-1`}
                        data-testid="workspace-import-route"
                        disabled={busy || mappingLocked}
                        onChange={(event) =>
                          updateRoute(
                            region.id,
                            event.target.value === "append"
                              ? "append"
                              : "create",
                            decision.route.table,
                          )
                        }
                        value={decision.route.kind}
                      >
                        <option value="create">Create table</option>
                        <option value="append">Append to table</option>
                      </select>
                    </label>
                    <label className="text-xs">
                      Destination table
                      <input
                        className={`${inputClass} mt-1`}
                        data-testid="workspace-import-table"
                        disabled={busy || mappingLocked}
                        list={`workspace-tables-${regionIndex}`}
                        onChange={(event) =>
                          updateRoute(
                            region.id,
                            decision.route.kind,
                            event.target.value,
                          )
                        }
                        value={decision.route.table}
                      />
                      <datalist id={`workspace-tables-${regionIndex}`}>
                        {existingTables.map((table) => (
                          <option key={table} value={table} />
                        ))}
                      </datalist>
                    </label>
                  </div>
                  {region.conflicts.length === 0 ? null : (
                    <div
                      className="mt-3 rounded-lg border border-fd-primary/40 p-3 text-sm text-fd-primary"
                      data-testid="workspace-import-conflicts"
                    >
                      {region.conflicts.map((conflict) => (
                        <p key={conflict}>{conflict}</p>
                      ))}
                    </div>
                  )}
                  <div className="mt-4 overflow-x-auto">
                    <table className="w-full min-w-[42rem] text-left text-xs">
                      <thead>
                        <tr>
                          <th className="p-2">Source column</th>
                          <th className="p-2">Destination column</th>
                          <th className="p-2">Type</th>
                          <th className="p-2">Compatibility</th>
                        </tr>
                      </thead>
                      <tbody>
                        {region.columns.map((column) => {
                          const mapped = decision.columns.find(
                            (entry) => entry.source === column.source,
                          );
                          if (mapped === undefined) return null;
                          return (
                            <tr className="border-t" key={column.source}>
                              <td className="p-2 font-mono">{column.source}</td>
                              <td className="p-2">
                                <input
                                  aria-label={`${column.source} destination`}
                                  className={inputClass}
                                  disabled={busy || mappingLocked}
                                  onChange={(event) =>
                                    updateColumn(
                                      region.id,
                                      column.source,
                                      "destination",
                                      event.target.value,
                                    )
                                  }
                                  value={mapped.destination ?? ""}
                                />
                              </td>
                              <td className="p-2">
                                <select
                                  aria-label={`${column.source} type`}
                                  className={inputClass}
                                  disabled={busy || mappingLocked}
                                  onChange={(event) =>
                                    updateColumn(
                                      region.id,
                                      column.source,
                                      "type",
                                      event.target.value,
                                    )
                                  }
                                  value={mapped.type}
                                >
                                  {COLUMN_TYPES.map((type) => (
                                    <option key={type} value={type}>
                                      {type}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              <td className="p-2">
                                {column.compatible
                                  ? "Compatible"
                                  : (column.message ?? "Needs review")}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </article>
              );
            })}
          </div>
          <button
            className={secondaryButtonClass}
            data-testid="workspace-import-resolve"
            disabled={busy || mappingLocked}
            onClick={() => void resolve()}
            type="button"
          >
            Update review
          </button>
          {reviewNeedsUpdate ? (
            <p
              className="mt-3 rounded-lg border border-fd-primary/40 p-3 text-sm text-fd-primary"
              data-testid="workspace-import-review-stale"
              role="status"
            >
              The route or column mapping changed. Update the review before
              applying this import
            </p>
          ) : null}

          {preview === null ? null : (
            <div
              className="mt-5 overflow-x-auto rounded-lg border"
              data-testid="workspace-import-preview-page"
            >
              <table className="min-w-full text-left text-xs">
                <thead>
                  <tr>
                    {preview.columns.map((column) => (
                      <th className="bg-fd-muted p-2" key={column}>
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row, index) => (
                    <tr
                      className="border-t"
                      key={`${preview.cursor ?? "first"}:${String(index)}`}
                    >
                      {row.map((cell, columnIndex) => (
                        <td
                          className="max-w-64 truncate p-2"
                          key={`${String(index)}:${String(columnIndex)}`}
                        >
                          {cell === null ? "" : String(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.nextCursor === null ? null : (
                <button
                  className={`${secondaryButtonClass} m-3`}
                  data-testid="workspace-import-preview-next"
                  onClick={() =>
                    void loadPreview(preview.regionId, preview.nextCursor)
                  }
                  type="button"
                >
                  Next rows
                </button>
              )}
            </div>
          )}

          <fieldset
            className="mt-6 grid gap-3 rounded-lg border p-4 sm:grid-cols-2"
            data-testid="workspace-delivery-context"
          >
            <legend className="px-2 font-semibold">Delivery context</legend>
            <label className="text-xs">
              Request ID
              <input
                className={`${inputClass} mt-1`}
                onChange={(event) =>
                  setDeliveryField("requestId", event.target.value)
                }
                value={delivery.requestId}
              />
            </label>
            <label className="text-xs">
              Vendor
              <input
                className={`${inputClass} mt-1`}
                data-testid="workspace-delivery-vendor"
                onChange={(event) =>
                  setDeliveryField("vendor", event.target.value)
                }
                value={delivery.vendor}
              />
            </label>
            <label className="text-xs">
              Entity
              <input
                className={`${inputClass} mt-1`}
                data-testid="workspace-delivery-entity"
                onChange={(event) =>
                  setDeliveryField("entity", event.target.value)
                }
                value={delivery.entity}
              />
            </label>
            <label className="text-xs">
              Phase or sprint
              <input
                className={`${inputClass} mt-1`}
                data-testid="workspace-delivery-phase"
                onChange={(event) =>
                  setDeliveryField("phase", event.target.value)
                }
                value={delivery.phase}
              />
            </label>
            <label className="text-xs">
              Coverage
              <select
                className={`${inputClass} mt-1`}
                data-testid="workspace-delivery-coverage"
                onChange={(event) =>
                  setDeliveryField("coverage", event.target.value)
                }
                value={delivery.coverage}
              >
                <option value="unknown">Unknown</option>
                <option value="full">Full snapshot</option>
                <option value="partial">Partial snapshot</option>
              </select>
            </label>
            <label className="text-xs">
              Effective date
              <input
                className={`${inputClass} mt-1`}
                onChange={(event) =>
                  setDeliveryField("effectiveDate", event.target.value)
                }
                type="date"
                value={delivery.effectiveDate ?? ""}
              />
            </label>
            <label className="text-xs">
              Received date
              <input
                className={`${inputClass} mt-1`}
                onChange={(event) =>
                  setDeliveryField("receivedDate", event.target.value)
                }
                type="date"
                value={delivery.receivedDate ?? ""}
              />
            </label>
            <label className="text-xs sm:col-span-2">
              Note
              <input
                className={`${inputClass} mt-1`}
                onChange={(event) =>
                  setDeliveryField("note", event.target.value)
                }
                value={delivery.note}
              />
            </label>
          </fieldset>
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              className={primaryButtonClass}
              data-testid="workspace-import-apply"
              disabled={
                busy ||
                result !== null ||
                plan.state !== "ready" ||
                !reviewIsCurrent ||
                delivery.requestId.trim() === ""
              }
              onClick={() => void apply()}
              type="button"
            >
              <PackageCheck aria-hidden="true" className="size-4" />
              Apply import
            </button>
            {plan.duplicateOf === null ? null : (
              <button
                className={secondaryButtonClass}
                data-testid="workspace-delivery-record-reuse"
                disabled={
                  busy ||
                  resolving ||
                  plan.state !== "ready" ||
                  (plan.application === "pending" && !reviewIsCurrent) ||
                  delivery.requestId.trim() === ""
                }
                onClick={() => void recordAgain()}
                type="button"
              >
                <Truck aria-hidden="true" className="size-4" />
                Record another delivery
              </button>
            )}
          </div>
          {result === null ? null : (
            <p
              className="mt-4 rounded-lg border bg-fd-muted/40 p-3 text-sm"
              data-testid="workspace-import-result"
            >
              {result}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
