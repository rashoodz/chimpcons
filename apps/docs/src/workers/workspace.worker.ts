import {
  applyImport,
  applySchema,
  createWorkbookImportSource,
  identifierKey,
  inspectDatabase,
  inspectImport,
  listDeliveries,
  parseDatabaseSchema,
  planSchema,
  prepareImport,
  recordDelivery,
  resolveImport,
  type ColumnDefinition,
  type Database,
  type DeliveryContext,
  type DeliveryRecord,
  type ImportCell,
  type ImportConflict,
  type ImportDecision,
  type ImportInspection,
  type ImportRecipe,
  type PreparedImport,
  type PreparedImportRef,
  type ReadyImportRef,
  type SchemaPlan,
  type TableSchema,
} from "@consultchimps/db";
import {
  configureBrowserDatabaseRuntime,
  type BrowserDatabaseRuntime,
} from "@consultchimps/db/browser";
import {
  isConsultChimpsError,
  throwIfAborted,
  type OperationProgress,
} from "@consultchimps/core";

import { basePath } from "@/lib/shared";
import {
  BrowserBlobSource,
  BrowserOpfsFile,
  browserScratchFactory,
  createBrowserExportName,
  removeOpfsFile,
  withBrowserExportLease,
} from "@/lib/workspace-files";
import {
  workspaceSourceDescription,
  workspaceSourceFileName,
  workspaceSourceKey,
} from "@/lib/workspace-source";
import type {
  WorkspaceCommand,
  WorkspaceDeliveryContext,
  WorkspaceDeliveryPage,
  WorkspaceDeliverySummary,
  WorkspaceEvent,
  WorkspaceImportColumn,
  WorkspaceImportRegion,
  WorkspacePreparedImport,
  WorkspacePreviewPage,
  WorkspaceProgress,
  WorkspaceRouteDecision,
  WorkspaceSchemaPlan,
  WorkspaceSummary,
} from "@/lib/workspace-protocol";

const scope = self as unknown as {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<WorkspaceCommand>) => void,
  ): void;
  postMessage(message: WorkspaceEvent): void;
};

interface OpenWorkspace {
  readonly database: Database;
  readonly workingCopyName: string;
}

interface RegionMetadata {
  readonly id: string;
  readonly source: string;
  readonly selection: string;
  readonly fileName: string;
  readonly label: string;
  readonly schema: TableSchema;
  readonly destinationSchema?: TableSchema | undefined;
  readonly rowCount: bigint;
  readonly captureId: string;
}

interface HeldImport {
  readonly prepared: PreparedImport;
  ref: PreparedImportRef | ReadyImportRef;
  recipe: ImportRecipe;
  readonly regions: readonly RegionMetadata[];
  readonly duplicate: boolean;
  readonly application: "applied" | "pending";
}

let browserRuntime: Promise<BrowserDatabaseRuntime> | null = null;
let workspace: OpenWorkspace | null = null;
const schemaPlans = new Map<string, SchemaPlan>();
const imports = new Map<string, HeldImport>();
const controllers = new Map<number, AbortController>();

function runtime(): Promise<BrowserDatabaseRuntime> {
  const configured =
    browserRuntime ??
    configureBrowserDatabaseRuntime({
      sqlite: {
        wasmUrl: `${basePath}/database-wasm/sqlite3.wasm`,
        directory: "/consultchimps-sqlite",
        initialCapacity: 16,
      },
      duckdb: {
        wasmUrl: `${basePath}/database-wasm/duckdb-eh.wasm`,
        workerUrl: `${basePath}/database-wasm/duckdb-browser-eh.worker.js`,
      },
      opfsDirectory: "consultchimps-databases",
    });
  browserRuntime = configured;
  return configured;
}

function current(): OpenWorkspace {
  if (workspace === null) {
    throw new Error("Create or open a database before using this operation");
  }
  return workspace;
}

function boundedNumber(value: bigint, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new Error(`The ${label} is too large to display safely`);
  }
  return result;
}

async function summaryOf(open: OpenWorkspace): Promise<WorkspaceSummary> {
  const inspection = await inspectDatabase({ database: open.database });
  return {
    databaseId: inspection.id,
    format: inspection.format,
    formatVersion: inspection.formatVersion,
    workingCopyName: open.workingCopyName,
    tables: inspection.tables.map((table) => ({
      id: identifierKey(table.name),
      name: table.name,
      rowCount: boundedNumber(table.rowCount, `row count for ${table.name}`),
      columns: table.schema.columns.map((column) => ({
        name: column.name,
        type: column.type,
        nullable: column.nullable !== false,
      })),
    })),
    importCount: boundedNumber(inspection.completedImports, "import count"),
    deliveryCount: boundedNumber(inspection.deliveries, "delivery count"),
  };
}

function progressOf(progress: OperationProgress): WorkspaceProgress {
  return {
    phase: progress.stage,
    completed: progress.completed,
    total: progress.total,
    message: progress.detail ?? progress.stage,
  };
}

function onProgress(id: number): (progress: OperationProgress) => void {
  return (progress) => {
    scope.postMessage({ type: "progress", id, progress: progressOf(progress) });
  };
}

function postError(id: number, error: unknown): void {
  const aborted =
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError";
  scope.postMessage({
    type: "error",
    id,
    message: aborted
      ? "The operation was cancelled"
      : error instanceof Error
        ? error.message
        : "An unexpected problem occurred",
    ...(aborted
      ? { code: "OPERATION_ABORTED" }
      : isConsultChimpsError(error)
        ? { code: error.code }
        : {}),
  });
}

async function closeImports(): Promise<void> {
  const held = [...imports.values()];
  imports.clear();
  await Promise.all(held.map(({ prepared }) => prepared.close()));
}

async function replaceWorkspace(next: OpenWorkspace): Promise<void> {
  await closeImports();
  schemaPlans.clear();
  const previous = workspace;
  workspace = next;
  await previous?.database.close();
}

function safeWorkingName(fileName: string): string {
  const extension = fileName.toLowerCase().endsWith(".duckdb")
    ? ".duckdb"
    : ".sqlite";
  const stem = fileName
    .replace(/\.[^.]+$/u, "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/^\.+/u, "")
    .slice(0, 80);
  return `${stem || "database"}-${globalThis.crypto.randomUUID()}${extension}`;
}

function schemaPlanDto(id: string, plan: SchemaPlan): WorkspaceSchemaPlan {
  const columnDto = (
    value: SchemaPlan["creates"][number]["columns"][number],
  ) => ({
    name: value.name,
    type: value.type,
    nullable: value.nullable !== false,
    ...(value.precision === undefined ? {} : { precision: value.precision }),
    ...(value.scale === undefined ? {} : { scale: value.scale }),
  });
  return {
    id,
    changes: [
      ...plan.creates.map((table) => ({
        kind: "create-table" as const,
        table: {
          name: table.name,
          recordId: {
            prefix: table.recordId.prefix,
            separator: table.recordId.separator ?? "-",
            padding: table.recordId.padding,
          },
          columns: table.columns.map(columnDto),
          foreignKeys: (table.foreignKeys ?? []).map((foreignKey) => ({
            column: foreignKey.column,
            referencesTable: foreignKey.referencesTable,
          })),
        },
      })),
      ...plan.adds.flatMap((addition) =>
        addition.columns.map((column) => ({
          kind: "add-column" as const,
          table: addition.table,
          column: columnDto(column),
        })),
      ),
    ],
    conflicts: plan.conflicts.map((conflict) => ({
      table: conflict.table,
      column: "column" in conflict ? conflict.column : null,
      message:
        conflict.kind === "column-type"
          ? `Type conflict: column ${conflict.column} is ${conflict.existing.type}, but the proposed schema uses ${conflict.proposed.type}`
          : conflict.kind === "table-definition"
            ? conflict.message
            : `Column ${conflict.column} is required and cannot be added to existing rows without a value`,
    })),
    ready: plan.state === "ready",
  };
}

function regionId(source: string, selection: string): string {
  return JSON.stringify([source, selection]);
}

function reviewRowCount(regions: readonly RegionMetadata[]): bigint {
  const countedCaptures = new Set<string>();
  let total = 0n;
  for (const region of regions) {
    if (countedCaptures.has(region.captureId)) continue;
    countedCaptures.add(region.captureId);
    total += region.rowCount;
  }
  return total;
}

function conflictText(conflict: ImportConflict): string {
  switch (conflict.kind) {
    case "missing-destination":
      return "Choose a destination table";
    case "source-selection-not-found":
      return `Source ${workspaceSourceDescription(conflict.source)} selection ${conflict.selection} was not captured; choose an available source and selection`;
    case "missing-column":
      return `Destination column ${conflict.column} does not exist`;
    case "source-column-not-found":
      return `Source column ${conflict.column} does not exist in the captured rows`;
    case "required-column-unmapped":
      return `Required destination column ${conflict.target} needs a source column`;
    case "required-value":
      return `Row ${String(conflict.sourceRow)} needs a value for required column ${conflict.target}`;
    case "invalid-value":
      return `Row ${String(conflict.sourceRow)} column ${conflict.column} cannot be stored as ${conflict.expected} in ${conflict.target}`;
    case "foreign-key-value-not-found":
      return `Row ${String(conflict.sourceRow)} column ${conflict.column} does not match a record in ${conflict.referencesTable}`;
    case "incompatible-column":
      return `Column ${conflict.target} needs the ${conflict.expected} type`;
    case "decimal-capacity":
      return `Column ${conflict.target} needs decimal(${conflict.requiredPrecision}, ${conflict.requiredScale}), but the destination allows decimal(${conflict.targetPrecision}, ${conflict.targetScale})`;
    case "inferred-schema":
      return "Review the inferred columns and approve the destination";
    case "table-exists":
      return `Table ${conflict.table} already exists`;
    case "table-not-found":
      return `Table ${conflict.table} does not exist`;
  }
}

function columnsFor(
  region: RegionMetadata,
  recipe: ImportRecipe,
  conflicts: readonly ImportConflict[],
  tables: WorkspaceSummary["tables"],
): WorkspaceImportColumn[] {
  const route = recipe.routes.find(
    (candidate) =>
      candidate.source === region.source &&
      candidate.selection === region.selection,
  );
  const tableName =
    route?.destination.kind === "existing-table"
      ? route.destination.table
      : route?.destination.kind === "new-table"
        ? route.destination.schema.name
        : undefined;
  const destinationTable = tables.find(
    (table) =>
      tableName !== undefined &&
      identifierKey(table.name) === identifierKey(tableName),
  );
  const proposedTable =
    route?.destination.kind === "new-table"
      ? route.destination.schema
      : undefined;
  return region.schema.columns.map((column) => {
    const mapped = route?.columns.find((entry) => entry.source === column.name);
    const destination = mapped?.target ?? column.name;
    const target = (destinationTable?.columns ?? proposedTable?.columns)?.find(
      (candidate) =>
        identifierKey(candidate.name) === identifierKey(destination),
    );
    const conflict = conflicts.find(
      (candidate) =>
        "source" in candidate &&
        candidate.source === region.source &&
        candidate.selection === region.selection &&
        "column" in candidate &&
        candidate.column === column.name,
    );
    return {
      source: column.name,
      destination,
      inferredType: column.type,
      destinationType: mapped?.type ?? target?.type ?? column.type,
      compatible: conflict === undefined,
      message: conflict === undefined ? null : conflictText(conflict),
    };
  });
}

async function importDto(held: HeldImport): Promise<WorkspacePreparedImport> {
  const inspection = await inspectImport({
    database: current().database,
    prepared: held.prepared,
    page: { limit: 1 },
  });
  held.ref = inspection.prepared;
  const workspaceSummary = await summaryOf(current());
  const regions: WorkspaceImportRegion[] = held.regions.map((region) => {
    const route = held.recipe.routes.find(
      (candidate) =>
        candidate.source === region.source &&
        candidate.selection === region.selection,
    );
    const regionConflicts = inspection.conflicts.filter(
      (conflict) =>
        (!("source" in conflict) || conflict.source === region.source) &&
        (!("selection" in conflict) || conflict.selection === region.selection),
    );
    return {
      id: region.id,
      sourceId: region.source,
      fileName: region.fileName,
      label: region.label,
      rowCount: boundedNumber(region.rowCount, "captured row count"),
      columns: columnsFor(
        region,
        held.recipe,
        inspection.conflicts,
        workspaceSummary.tables,
      ),
      route:
        route?.destination.kind === "existing-table"
          ? { kind: "append", table: route.destination.table }
          : route?.destination.kind === "new-table"
            ? { kind: "create", table: route.destination.schema.name }
            : {
                kind: "unresolved",
                suggestedTable:
                  route?.destination.kind === "new-table-infer"
                    ? route.destination.name
                    : region.schema.name,
              },
      conflicts: regionConflicts.map(conflictText),
    };
  });
  return {
    id: held.ref.id,
    state: held.ref.state,
    application: held.application,
    duplicateOf: held.duplicate ? "existing-capture" : null,
    captureIds: held.regions.map((region) => region.captureId),
    regions,
    totalRows: boundedNumber(reviewRowCount(held.regions), "review row count"),
    warningCount: inspection.conflicts.length,
  };
}

function deliveryContext(input: WorkspaceDeliveryContext): DeliveryContext {
  const scopeValue: DeliveryContext["scope"] =
    input.coverage === "full"
      ? { kind: "full" }
      : input.coverage === "partial"
        ? {
            kind: "partial",
            description: input.note.trim() || "Partial delivery",
          }
        : { kind: "unknown" };
  return {
    label:
      [input.vendor, input.entity, input.phase]
        .map((value) => value.trim())
        .filter(Boolean)
        .join(" | ") || input.requestId,
    scope: scopeValue,
    ...(input.effectiveDate === null
      ? {}
      : { effectiveDate: input.effectiveDate }),
    ...(input.receivedDate === null
      ? {}
      : { receivedDate: input.receivedDate }),
    attributes: {
      vendor: input.vendor,
      entity: input.entity,
      phase: input.phase,
      note: input.note,
    },
  };
}

function deliveryDto(delivery: DeliveryRecord): WorkspaceDeliverySummary {
  const attributes = delivery.context.attributes ?? {};
  return {
    id: delivery.id,
    requestId: delivery.requestId,
    label: delivery.context.label,
    vendor:
      typeof attributes["vendor"] === "string" ? attributes["vendor"] : "",
    entity:
      typeof attributes["entity"] === "string" ? attributes["entity"] : "",
    phase: typeof attributes["phase"] === "string" ? attributes["phase"] : "",
    scope: delivery.context.scope,
    effectiveDate: delivery.context.effectiveDate ?? null,
    receivedDate: delivery.context.receivedDate ?? null,
    captureIds: delivery.captureIds,
    reusedCapture: delivery.reusedCaptureIds.length > 0,
  };
}

function cellValue(
  cell: ImportCell | undefined,
): boolean | null | number | string {
  if (cell === undefined || cell.kind === "blank") return null;
  if (cell.kind === "boolean") return cell.value;
  if (cell.kind === "string") return cell.value;
  if (cell.kind === "number") return cell.raw;
  if (cell.kind === "date") return cell.iso;
  if (cell.kind === "error") return cell.error;
  return cell.cached.kind === "missing"
    ? "Formula has no cached value"
    : cellValue(cell.cached);
}

function decisionFor(
  decision: WorkspaceRouteDecision,
  region: RegionMetadata,
): ImportDecision {
  const columns = decision.columns
    .filter(
      (column): column is typeof column & { readonly destination: string } =>
        column.destination !== null,
    )
    .map((column) => ({
      source: column.source,
      target: column.destination,
      type: column.type as ColumnDefinition["type"],
    }));
  const schemaColumns = columns.map((column): ColumnDefinition => {
    const inferred = region.schema.columns.find(
      (candidate) => candidate.name === column.source,
    );
    const destination = region.destinationSchema?.columns.find(
      (candidate) =>
        identifierKey(candidate.name) === identifierKey(column.target),
    );
    if (destination?.type === column.type) {
      return { ...destination, name: column.target };
    }
    if (column.type === "decimal") {
      return {
        name: column.target,
        type: "decimal",
        nullable: inferred?.nullable,
        precision: inferred?.type === "decimal" ? inferred.precision : 38,
        scale: inferred?.type === "decimal" ? inferred.scale : 10,
      };
    }
    return {
      name: column.target,
      type: column.type,
      ...(inferred?.nullable === undefined
        ? {}
        : { nullable: inferred.nullable }),
    };
  });
  return {
    kind: "route",
    source: region.source,
    selection: region.selection,
    destination:
      decision.route.kind === "append"
        ? { kind: "existing-table", table: decision.route.table }
        : {
            kind: "new-table",
            schema: {
              ...(region.destinationSchema ?? region.schema),
              name: decision.route.table,
              columns: schemaColumns,
            },
          },
    columns,
  };
}

function recipeFrom(decisions: readonly ImportDecision[]): ImportRecipe {
  return {
    version: 1,
    routes: decisions.flatMap((decision) =>
      decision.kind === "route"
        ? [
            {
              source: decision.source,
              selection: decision.selection,
              destination: decision.destination,
              columns: decision.columns,
            },
          ]
        : [],
    ),
  };
}

async function handleCreate(
  id: number,
  command: Extract<WorkspaceCommand, { readonly type: "create" }>,
  signal: AbortSignal,
): Promise<void> {
  const created = await (
    await runtime()
  ).createDatabase({
    name: command.name,
    format: command.format,
    ...(command.schema === undefined
      ? {}
      : { schema: parseDatabaseSchema(command.schema) }),
    ...(command.overwrite === undefined
      ? {}
      : { overwrite: command.overwrite }),
    signal,
  });
  const next = {
    database: created.database,
    workingCopyName: command.name,
  };
  await replaceWorkspace(next);
  scope.postMessage({ type: "ready", id, summary: await summaryOf(next) });
}

async function handleOpen(
  id: number,
  command: Extract<WorkspaceCommand, { readonly type: "open" }>,
  signal: AbortSignal,
): Promise<void> {
  const name =
    command.name === undefined
      ? safeWorkingName(command.file.name)
      : command.name;
  const database = await (
    await runtime()
  ).importDatabase({
    name,
    source: new BrowserBlobSource(command.file.name, command.file),
    ...(command.overwrite === undefined
      ? {}
      : { overwrite: command.overwrite }),
    signal,
    onProgress: onProgress(id),
  });
  const next = { database, workingCopyName: name };
  await replaceWorkspace(next);
  scope.postMessage({ type: "ready", id, summary: await summaryOf(next) });
}

async function handleReopen(
  id: number,
  command: Extract<WorkspaceCommand, { readonly type: "reopen" }>,
): Promise<void> {
  const database = await (
    await runtime()
  ).openDatabase({
    name: command.name,
    ...(command.readonly === undefined ? {} : { readonly: command.readonly }),
  });
  const next = { database, workingCopyName: command.name };
  await replaceWorkspace(next);
  scope.postMessage({ type: "ready", id, summary: await summaryOf(next) });
}

async function handleSchema(
  id: number,
  command: Extract<
    WorkspaceCommand,
    { readonly type: "applySchema" | "planSchema" }
  >,
  signal: AbortSignal,
): Promise<void> {
  if (command.type === "planSchema") {
    const plan = await planSchema({
      database: current().database,
      schema: parseDatabaseSchema(command.schema),
    });
    throwIfAborted(signal, "db.schema.plan");
    const planId = globalThis.crypto.randomUUID();
    schemaPlans.clear();
    schemaPlans.set(planId, plan);
    scope.postMessage({
      type: "schemaPlanned",
      id,
      plan: schemaPlanDto(planId, plan),
    });
    return;
  }
  const plan = schemaPlans.get(command.planId);
  if (plan === undefined) {
    throw new Error("Review the schema again before applying it");
  }
  await applySchema({ database: current().database, plan, signal });
  await current().database.checkpoint();
  schemaPlans.delete(command.planId);
  scope.postMessage({
    type: "schemaApplied",
    id,
    summary: await summaryOf(current()),
  });
}

function suggestedTable(label: string): string {
  return (
    label
      .normalize("NFKC")
      .trim()
      .replace(/[^\p{L}\p{N}_]+/gu, "_")
      .replace(/^_+|_+$/gu, "") || "Imported_Data"
  );
}

function heldFromInspection(
  prepared: PreparedImport,
  inspection: ImportInspection,
  application: "applied" | "pending" = "pending",
): HeldImport {
  const recipe: ImportRecipe = {
    version: 1,
    routes: inspection.routes.flatMap((route) =>
      route.destination === null
        ? []
        : [
            {
              source: route.source,
              selection: route.selection,
              destination: route.destination,
              columns: route.columns,
            },
          ],
    ),
  };
  const regions = inspection.routes.map((route): RegionMetadata => {
    const inferredName = suggestedTable(route.label);
    const destinationSchema =
      route.destination?.kind === "new-table"
        ? route.destination.schema
        : undefined;
    const schema: TableSchema = {
      name:
        destinationSchema?.name ??
        (route.destination?.kind === "new-table-infer"
          ? route.destination.name
          : inferredName),
      recordId:
        destinationSchema?.recordId ??
        (route.destination?.kind === "new-table-infer"
          ? route.destination.recordId
          : {
              prefix: inferredName.slice(0, 8).toUpperCase(),
              padding: 6,
            }),
      columns: route.inferredColumns,
    };
    return {
      id: regionId(route.source, route.selection),
      source: route.source,
      selection: route.selection,
      fileName: workspaceSourceFileName(route.source),
      label: route.label,
      schema,
      ...(destinationSchema === undefined ? {} : { destinationSchema }),
      rowCount: route.rowCount,
      captureId: route.captureId,
    };
  });
  return {
    prepared,
    ref: inspection.prepared,
    recipe,
    regions,
    duplicate:
      inspection.routes.length > 0 &&
      inspection.routes.every((route) => route.reused),
    application,
  };
}

async function listSavedImports(id: number): Promise<void> {
  await closeImports();
  const listing = await (
    await runtime()
  ).listPreparedImports({ database: current().database });
  let ignoredPlanCount = listing.ignored.length;
  for (const entry of listing.imports) {
    if (entry.databaseId !== current().database.id) continue;
    let prepared: PreparedImport | undefined;
    try {
      prepared = await (
        await runtime()
      ).openPreparedImport({ name: entry.name });
      const inspection = await inspectImport({
        database: current().database,
        prepared,
        page: { limit: 1 },
      });
      const held = heldFromInspection(prepared, inspection, entry.application);
      imports.set(held.ref.id, held);
      prepared = undefined;
    } catch {
      ignoredPlanCount += 1;
      await prepared?.close().catch(() => undefined);
    }
  }
  const plans = [];
  for (const held of imports.values()) plans.push(await importDto(held));
  scope.postMessage({
    type: "importsListed",
    id,
    plans,
    ignoredPlanCount,
  });
}

async function prepareSources(
  id: number,
  command: Extract<WorkspaceCommand, { readonly type: "prepareImport" }>,
  signal: AbortSignal,
): Promise<void> {
  const workbookSources = [];
  const sourceInputs = command.sources.map((source, ordinal) => ({
    source,
    key: workspaceSourceKey(source, ordinal),
  }));
  const sourceByKey = new Map(
    sourceInputs.map(({ key, source }) => [key, source] as const),
  );
  let privatePlan:
    { readonly name: string; readonly prepared: PreparedImport } | undefined;
  try {
    for (const { key, source } of sourceInputs) {
      workbookSources.push(
        await createWorkbookImportSource({
          key,
          bytes: new BrowserBlobSource(source.file.name, source.file),
          scratch: browserScratchFactory,
          signal,
          onProgress: onProgress(id),
        }),
      );
    }
    const sources = workbookSources.map((source) => source.source);
    const recipe: ImportRecipe = {
      version: 1,
      routes: sources.flatMap((source) =>
        source.selections.map((selection) => {
          const name = suggestedTable(selection.label);
          return {
            source: source.key,
            selection: selection.key,
            destination: {
              kind: "new-table-infer" as const,
              name,
              recordId: {
                prefix: name.slice(0, 8).toUpperCase(),
                padding: 6,
              },
            },
            columns: [],
          };
        }),
      ),
    };
    const databaseInspection = await inspectDatabase({
      database: current().database,
    });
    const privatePlanName = `.consultchimps-import-${globalThis.crypto.randomUUID()}.sqlite`;
    const prepared = await (
      await runtime()
    ).createPreparedImport({
      name: privatePlanName,
      database: current().database,
      recipe,
      baselineRevision: databaseInspection.revision,
      signal,
    });
    privatePlan = { name: privatePlanName, prepared };
    const outcome = await prepareImport({
      database: current().database,
      prepared,
      sources,
      recipe,
      signal,
      onProgress: onProgress(id),
    });
    const firstInspection = await inspectImport({
      database: current().database,
      prepared,
      page: { limit: 1 },
    });
    const regions = firstInspection.routes.map((route) => {
      const inferred = firstInspection.conflicts.find(
        (
          conflict,
        ): conflict is Extract<
          ImportConflict,
          { readonly kind: "inferred-schema" }
        > =>
          conflict.kind === "inferred-schema" &&
          conflict.source === route.source &&
          conflict.selection === route.selection,
      );
      const destinationSchema =
        route.destination?.kind === "new-table"
          ? route.destination.schema
          : inferred?.schema;
      if (destinationSchema === undefined) {
        throw new Error("The import region is missing its inferred columns");
      }
      return {
        id: regionId(route.source, route.selection),
        source: route.source,
        selection: route.selection,
        fileName:
          sourceByKey.get(route.source)?.file.name ??
          workspaceSourceFileName(route.source),
        label: route.label,
        schema: destinationSchema,
        rowCount: route.rowCount,
        captureId: route.captureId,
      };
    });
    const held: HeldImport = {
      prepared,
      ref: outcome.prepared,
      recipe,
      regions,
      duplicate: firstInspection.routes.every((route) => route.reused),
      application: "pending",
    };
    const automatic = firstInspection.conflicts.flatMap(
      (conflict): ImportDecision[] => {
        if (conflict.kind !== "inferred-schema") return [];
        const existing = databaseInspection.tables.find(
          (table) =>
            identifierKey(table.name) === identifierKey(conflict.schema.name),
        );
        if (existing === undefined) return [];
        const matches = conflict.schema.columns.every((column) =>
          existing.schema.columns.some(
            (target) =>
              identifierKey(target.name) === identifierKey(column.name) &&
              target.type === column.type,
          ),
        );
        if (!matches) return [];
        return [
          {
            kind: "route",
            source: conflict.source,
            selection: conflict.selection,
            destination: { kind: "existing-table", table: existing.name },
            columns: conflict.schema.columns.map((column) => ({
              source: column.name,
              target: column.name,
              type: column.type,
            })),
          },
        ];
      },
    );
    if (automatic.length > 0) {
      held.ref = await resolveImport({
        database: current().database,
        prepared,
        decisions: automatic,
      });
      const replacements = new Map(
        automatic.flatMap((decision) =>
          decision.kind === "route"
            ? [
                [
                  regionId(decision.source, decision.selection),
                  decision,
                ] as const,
              ]
            : [],
        ),
      );
      held.recipe = {
        version: 1,
        routes: recipe.routes.map((route) => {
          const replacement = replacements.get(
            regionId(route.source, route.selection),
          );
          return replacement === undefined || replacement.kind !== "route"
            ? route
            : {
                source: replacement.source,
                selection: replacement.selection,
                destination: replacement.destination,
                columns: replacement.columns,
              };
        }),
      };
    }
    imports.set(held.ref.id, held);
    privatePlan = undefined;
    scope.postMessage({
      type: "importPrepared",
      id,
      plan: await importDto(held),
    });
  } catch (error) {
    if (privatePlan !== undefined) {
      const plan = privatePlan;
      const cleanupFailures: unknown[] = [];
      try {
        await plan.prepared.close();
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
      try {
        await (await runtime()).discardPreparedImport({ name: plan.name });
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          "Preparing the import failed, and its private plan could not be removed",
        );
      }
    }
    throw error;
  } finally {
    await Promise.all(workbookSources.map((source) => source.close()));
  }
}

async function previewImport(
  id: number,
  command: Extract<WorkspaceCommand, { readonly type: "previewImport" }>,
): Promise<void> {
  const held = imports.get(command.planId);
  if (held === undefined) {
    throw new Error("Prepare the import again before previewing it");
  }
  const region = held.regions.find(
    (candidate) => candidate.id === command.regionId,
  );
  if (region === undefined) {
    throw new Error("The selected import region is no longer available");
  }
  const inspection = await inspectImport({
    database: current().database,
    prepared: held.prepared,
    page: {
      limit: command.limit,
      ...(command.cursor === null ? {} : { cursor: command.cursor }),
      source: region.source,
      selection: region.selection,
    },
  });
  const columns = region.schema.columns.map((column) => column.name);
  const page: WorkspacePreviewPage = {
    planId: command.planId,
    regionId: command.regionId,
    columns,
    rows: inspection.examples.map((example) =>
      columns.map((column) => cellValue(example.values[column])),
    ),
    cursor: command.cursor,
    nextCursor: inspection.nextCursor ?? null,
  };
  scope.postMessage({ type: "importPreview", id, page });
}

async function updateImport(
  id: number,
  command: Extract<WorkspaceCommand, { readonly type: "resolveImport" }>,
): Promise<void> {
  const held = imports.get(command.planId);
  if (held === undefined) {
    throw new Error("Prepare the import again before updating it");
  }
  const decisions = command.decisions.map((decision) => {
    const region = held.regions.find(
      (candidate) => candidate.id === decision.regionId,
    );
    if (region === undefined) {
      throw new Error("An import decision refers to an unavailable region");
    }
    return decisionFor(decision, region);
  });
  held.ref = await resolveImport({
    database: current().database,
    prepared: held.prepared,
    decisions,
  });
  held.recipe = recipeFrom(decisions);
  scope.postMessage({
    type: "importResolved",
    id,
    plan: await importDto(held),
  });
}

async function applyPreparedImport(
  id: number,
  command: Extract<WorkspaceCommand, { readonly type: "applyImport" }>,
  signal: AbortSignal,
): Promise<void> {
  const held = imports.get(command.planId);
  if (held === undefined || held.ref.state !== "ready") {
    throw new Error("Resolve the import review before applying it");
  }
  const result = await applyImport({
    database: current().database,
    prepared: held.prepared,
    approved: held.ref,
    requestId: command.delivery.requestId,
    delivery: deliveryContext(command.delivery),
    signal,
    onProgress: onProgress(id),
  });
  await current().database.checkpoint();
  scope.postMessage({
    type: "importApplied",
    id,
    result: {
      importId: result.importIds[0] ?? command.delivery.requestId,
      receiptId: result.deliveryId ?? command.delivery.requestId,
      outcome:
        result.metrics.rowsImported === 0 && result.metrics.rowsReused > 0
          ? "duplicate"
          : "applied",
      appendedRows: result.metrics.rowsImported,
      skippedRows: result.metrics.rowsReused,
      unresolvedRows: 0,
      schemaChanges: result.metrics.tablesCreated,
      deliveriesRecorded: result.metrics.deliveriesRecorded,
      captureIds: result.captureIds,
      summary: await summaryOf(current()),
    },
  });
}

async function recordPreparedDelivery(
  id: number,
  command: Extract<WorkspaceCommand, { readonly type: "recordDelivery" }>,
  signal: AbortSignal,
): Promise<void> {
  const held = imports.get(command.planId);
  if (held === undefined || held.ref.state !== "ready") {
    throw new Error("Resolve the import review before recording its delivery");
  }
  signal.throwIfAborted();
  const record = await recordDelivery({
    database: current().database,
    captureIds: [...new Set(held.regions.map((region) => region.captureId))],
    context: deliveryContext(command.delivery),
    requestId: command.delivery.requestId,
  });
  await current().database.checkpoint();
  scope.postMessage({
    type: "importApplied",
    id,
    result: {
      importId: record.delivery.id,
      receiptId: record.delivery.id,
      outcome: "duplicate",
      appendedRows: 0,
      skippedRows: boundedNumber(
        reviewRowCount(held.regions),
        "review row count",
      ),
      unresolvedRows: 0,
      schemaChanges: 0,
      deliveriesRecorded: record.metrics.deliveriesRecorded,
      captureIds: record.delivery.captureIds,
      summary: await summaryOf(current()),
    },
  });
}

async function deliveryHistory(
  id: number,
  command: Extract<WorkspaceCommand, { readonly type: "listDeliveries" }>,
): Promise<void> {
  const page = await listDeliveries({
    database: current().database,
    limit: command.limit,
    ...(command.cursor === null ? {} : { cursor: command.cursor }),
  });
  const dto: WorkspaceDeliveryPage = {
    deliveries: page.deliveries.map(deliveryDto),
    nextCursor: page.nextCursor ?? null,
  };
  scope.postMessage({ type: "deliveries", id, page: dto });
}

async function exportWorkspace(
  id: number,
  command: Extract<WorkspaceCommand, { readonly type: "export" }>,
  signal: AbortSignal,
): Promise<void> {
  const extension = command.format === "duckdb" ? "duckdb" : "sqlite";
  const name = `${current().workingCopyName.replace(/\.[^.]+$/u, "")}.${extension}`;
  const destinationName = createBrowserExportName(extension);
  await withBrowserExportLease(destinationName, async () => {
    let destination: BrowserOpfsFile;
    try {
      destination = await BrowserOpfsFile.open(destinationName, true, false);
    } catch (error) {
      try {
        await removeOpfsFile(destinationName);
      } catch (cleanupError) {
        if (!(
          cleanupError instanceof DOMException &&
          cleanupError.name === "NotFoundError"
        )) {
          throw new AggregateError(
            [error, cleanupError],
            "The browser export could not finish cleaning its private storage",
          );
        }
      }
      throw error;
    }
    let completed = false;
    let destinationClosed = false;
    let operationError: unknown;
    try {
      await current().database.checkpoint();
      await (
        await runtime()
      ).exportDatabase({
        database: current().database,
        name,
        destination,
        format: command.format,
        overwrite: true,
        signal,
        onProgress: onProgress(id),
      });
      const file = await destination.file();
      await destination.close();
      destinationClosed = true;
      scope.postMessage({
        type: "exported",
        id,
        file,
        name,
        format: command.format,
      });
      completed = true;
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      const cleanupFailures: unknown[] = [];
      if (!destinationClosed) {
        try {
          await destination.close();
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      if (!completed) {
        try {
          await removeOpfsFile(destinationName);
        } catch (error) {
          if (!(
            error instanceof DOMException && error.name === "NotFoundError"
          )) {
            cleanupFailures.push(error);
          }
        }
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          operationError === undefined
            ? cleanupFailures
            : [operationError, ...cleanupFailures],
          "The browser export could not finish cleaning its private storage",
        );
      }
    }
  });
}

async function handle(id: number, command: WorkspaceCommand): Promise<void> {
  const controller = new AbortController();
  controllers.set(id, controller);
  try {
    switch (command.type) {
      case "cancel":
        controllers.get(command.targetId)?.abort();
        scope.postMessage({ type: "closed", id });
        return;
      case "create":
        await handleCreate(id, command, controller.signal);
        return;
      case "open":
        await handleOpen(id, command, controller.signal);
        return;
      case "reopen":
        await handleReopen(id, command);
        return;
      case "planSchema":
      case "applySchema":
        await handleSchema(id, command, controller.signal);
        return;
      case "prepareImport":
        await prepareSources(id, command, controller.signal);
        return;
      case "listImports":
        await listSavedImports(id);
        return;
      case "previewImport":
        await previewImport(id, command);
        return;
      case "resolveImport":
        await updateImport(id, command);
        return;
      case "applyImport":
        await applyPreparedImport(id, command, controller.signal);
        return;
      case "recordDelivery":
        await recordPreparedDelivery(id, command, controller.signal);
        return;
      case "listDeliveries":
        await deliveryHistory(id, command);
        return;
      case "export":
        await exportWorkspace(id, command, controller.signal);
        return;
      case "close":
        await closeImports();
        schemaPlans.clear();
        await workspace?.database.close();
        workspace = null;
        scope.postMessage({ type: "closed", id });
        return;
    }
  } finally {
    controllers.delete(id);
  }
}

scope.addEventListener("message", (event) => {
  if (event.data.type === "cancel") {
    controllers.get(event.data.targetId)?.abort();
    scope.postMessage({ type: "closed", id: event.data.id });
    return;
  }
  void handle(event.data.id, event.data).catch((error: unknown) => {
    postError(event.data.id, error);
  });
});
