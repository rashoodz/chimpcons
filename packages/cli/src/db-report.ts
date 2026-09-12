import type {
  ConversionPlan,
  ColumnDefinition,
  DatabaseInspection,
  DeliveryPage,
  ImportCell,
  ImportConflict,
  ImportDestination,
  ImportInspection,
  PreparedImportRef,
  ReadyImportRef,
  SchemaConflict,
  SchemaPlan,
  TableSchema,
} from "@consultchimps/db";

const DETAIL_LIMIT = 20;
const VALUE_LIMIT = 80;

function count(value: number | bigint): string {
  return value.toLocaleString("en-US");
}

function status(state: string): string {
  return state === "ready" ? "Ready" : "Needs review";
}

function limitedDetails(details: readonly string[]): string[] {
  const visible = details.slice(0, DETAIL_LIMIT);
  if (details.length > DETAIL_LIMIT) {
    visible.push(
      `  ${count(details.length - DETAIL_LIMIT)} more items are omitted here. Use --json to read the full list.`,
    );
  }
  return visible;
}

function destination(destination: ImportDestination | null): string {
  if (destination === null) return "Excluded from loading";
  if (destination.kind === "existing-table") {
    return `Existing table "${destination.table}"`;
  }
  if (destination.kind === "new-table") {
    return `New table "${destination.schema.name}"`;
  }
  return `New inferred table "${destination.name}"`;
}

function compact(value: string): string {
  return value.length <= VALUE_LIMIT
    ? value
    : `${value.slice(0, VALUE_LIMIT)} [truncated]`;
}

function importConflict(conflict: ImportConflict): string {
  switch (conflict.kind) {
    case "missing-destination":
      return `Source "${compact(conflict.source)}", selection "${compact(conflict.selection)}" has no destination table.`;
    case "source-selection-not-found":
      return `Source "${compact(conflict.source)}", selection "${compact(conflict.selection)}" was not captured. Correct or remove this route.`;
    case "missing-column":
      return `Source "${compact(conflict.source)}", selection "${compact(conflict.selection)}" is missing mapped column "${compact(conflict.column)}".`;
    case "source-column-not-found":
      return `Source "${compact(conflict.source)}", selection "${compact(conflict.selection)}" does not contain source column "${compact(conflict.column)}".`;
    case "required-column-unmapped":
      return `Source "${compact(conflict.source)}", selection "${compact(conflict.selection)}" does not map required destination column "${compact(conflict.target)}".`;
    case "required-value":
      return `Source "${compact(conflict.source)}", selection "${compact(conflict.selection)}", row ${count(conflict.sourceRow)} has no value for required destination column "${compact(conflict.target)}".`;
    case "invalid-value":
      return `Source "${compact(conflict.source)}", selection "${compact(conflict.selection)}", row ${count(conflict.sourceRow)}, column "${compact(conflict.column)}" cannot load into "${compact(conflict.target)}" as ${conflict.expected}.`;
    case "foreign-key-value-not-found":
      return `Source "${compact(conflict.source)}", selection "${compact(conflict.selection)}", row ${count(conflict.sourceRow)}, column "${compact(conflict.column)}" has no matching record in "${compact(conflict.referencesTable)}" for destination "${compact(conflict.target)}".`;
    case "incompatible-column":
      return `Source column "${compact(conflict.column)}" in "${compact(conflict.source)}" / "${compact(conflict.selection)}" is incompatible with destination "${compact(conflict.target)}", which expects ${conflict.expected}.`;
    case "decimal-capacity":
      return `Source column "${compact(conflict.column)}" in "${compact(conflict.source)}" / "${compact(conflict.selection)}" needs decimal(${conflict.requiredPrecision}, ${conflict.requiredScale}), but destination "${compact(conflict.target)}" provides decimal(${conflict.targetPrecision}, ${conflict.targetScale}).`;
    case "inferred-schema":
      return `Confirm the inferred schema for new table "${compact(conflict.schema.name)}" from source "${compact(conflict.source)}", selection "${compact(conflict.selection)}".`;
    case "table-exists":
      return `Table "${compact(conflict.table)}" already exists. Route to the existing table or choose a new name.`;
    case "table-not-found":
      return `Destination table "${compact(conflict.table)}" does not exist. Correct the route or declare a new table.`;
    default: {
      const exhaustive: never = conflict;
      return exhaustive;
    }
  }
}

function schemaConflict(conflict: SchemaConflict): string {
  switch (conflict.kind) {
    case "table-definition":
      return `Table "${compact(conflict.table)}" has a conflicting ${conflict.property} definition.`;
    case "column-type":
      return `Column "${compact(conflict.column)}" in table "${compact(conflict.table)}" is ${conflict.existing.type}, but the proposed schema declares ${conflict.proposed.type}.`;
    case "required-column":
      return `Required column "${compact(conflict.column)}" cannot be added to populated table "${compact(conflict.table)}" without values.`;
    default: {
      const exhaustive: never = conflict;
      return exhaustive;
    }
  }
}

function columnDefinition(column: ColumnDefinition): string {
  const type =
    column.type === "decimal"
      ? `decimal(${column.precision}, ${column.scale})`
      : column.type;
  return `${compact(column.name)} ${type} ${column.nullable === false ? "required" : "optional"}`;
}

function summarizedList(values: readonly string[]): string {
  const visible = values.slice(0, 8);
  if (values.length > visible.length) {
    visible.push("more available with --json");
  }
  return visible.join(", ");
}

function tableDefinition(table: TableSchema): string {
  const separator = table.recordId.separator ?? "-";
  const relationships = (table.foreignKeys ?? []).map(
    (foreignKey) =>
      `${compact(foreignKey.column)} -> ${compact(foreignKey.referencesTable)}.record_id`,
  );
  return [
    `  Create table "${compact(table.name)}"`,
    `    Record IDs: prefix "${compact(table.recordId.prefix)}", separator "${compact(separator)}", padding ${count(table.recordId.padding)}`,
    `    Columns: ${summarizedList(table.columns.map(columnDefinition)) || "None"}`,
    `    Foreign keys: ${summarizedList(relationships) || "None"}`,
  ].join("\n");
}

function routeDetails(route: ImportInspection["routes"][number]): string {
  const mappings = route.columns.map(
    (column) =>
      `${compact(column.source)} -> ${compact(column.target)} (${column.type})`,
  );
  return [
    `  ${compact(route.source)} / ${compact(route.label)}`,
    `    Selection key: ${compact(route.selection)}`,
    `    Capture ID: ${route.captureId} (${route.reused ? "reused capture" : "captured in this plan"})`,
    `    Rows: ${count(route.rowCount)}`,
    `    Destination: ${destination(route.destination)}`,
    `    Column mappings: ${summarizedList(mappings) || "None"}`,
  ].join("\n");
}

function cellValue(cell: ImportCell): string {
  switch (cell.kind) {
    case "blank":
      return "(blank)";
    case "string":
      return JSON.stringify(compact(cell.value));
    case "number":
      return compact(cell.raw);
    case "boolean":
      return cell.value ? "true" : "false";
    case "date":
      return cell.iso;
    case "error":
      return `Excel error ${cell.error}`;
    case "formula":
      return cell.cached.kind === "missing"
        ? "formula result unavailable"
        : cellValue(cell.cached);
    default: {
      const exhaustive: never = cell;
      return exhaustive;
    }
  }
}

export function formatDatabaseInspection(
  inspection: DatabaseInspection,
): string {
  const lines = [
    "Database inspection",
    `Format: ${inspection.format === "duckdb" ? "DuckDB" : "SQLite"}`,
    `Revision: ${count(inspection.revision)}`,
    `Tables: ${count(inspection.tables.length)}`,
    `Completed source captures: ${count(inspection.captures)}`,
    `Completed imports: ${count(inspection.completedImports)}`,
    `Recorded deliveries: ${count(inspection.deliveries)}`,
    `Saved applied plans: ${count(inspection.appliedImportPlans)}`,
  ];
  if (inspection.tables.length > 0) {
    lines.push(
      "Table rows:",
      ...limitedDetails(
        inspection.tables.map(
          (table) => `  ${table.name}: ${count(table.rowCount)} rows`,
        ),
      ),
    );
  }
  lines.push(
    "Safety: This inspection did not change database tables or stored data.",
    "Next: Prepare a workbook import, review a saved plan, or inspect delivery history.",
  );
  return `${lines.join("\n")}\n`;
}

export function formatImportInspection(inspection: ImportInspection): string {
  const lines = [
    "Saved import plan inspection",
    `Status: ${status(inspection.prepared.state)}`,
    `Plan revision: ${count(inspection.prepared.planRevision)}`,
    `Rows newly captured in this plan: ${count(inspection.capturedRows)}`,
    `Routes: ${count(inspection.routes.length)}`,
    `Conflicts requiring review: ${count(inspection.conflicts.length)}`,
  ];
  if (inspection.routes.length > 0) {
    lines.push(
      "Route review:",
      ...limitedDetails(inspection.routes.map(routeDetails)),
    );
  }
  if (inspection.examples.length > 0) {
    lines.push(
      "Bounded row preview:",
      ...inspection.examples.map((example) => {
        const values = Object.entries(example.values)
          .slice(0, 8)
          .map(([name, value]) => `${compact(name)}=${cellValue(value)}`);
        if (Object.keys(example.values).length > 8) {
          values.push("more columns available with --json");
        }
        return `  ${compact(example.source)} / ${compact(example.selection)}, source row ${count(example.sourceRow)}: ${values.join(", ")}`;
      }),
    );
  }
  if (inspection.conflicts.length > 0) {
    lines.push(
      "Conflicts:",
      ...limitedDetails(
        inspection.conflicts.map((conflict) => `  ${importConflict(conflict)}`),
      ),
    );
  }
  if (inspection.previewWarnings.length > 0) {
    lines.push(
      "Preview warnings:",
      ...limitedDetails(
        inspection.previewWarnings.map((warning) => `  ${warning.message}`),
      ),
    );
  }
  if (inspection.nextCursor !== undefined) {
    lines.push(
      `Next preview cursor (data): ${inspection.nextCursor}`,
      "More preview rows are available. The --cursor option accepts this full value; quote it using your shell's rules.",
    );
  }
  lines.push(
    "Safety: This inspection did not change captured rows, routes, or decisions.",
    "Use --json to read full structured values and text marked [truncated].",
  );
  lines.push(
    inspection.prepared.state === "ready"
      ? "Next: Apply this reviewed plan with consultchimps db apply."
      : "Next: Correct the recipe and run consultchimps db resolve, then inspect the plan again.",
  );
  return `${lines.join("\n")}\n`;
}

export function formatImportResolution(
  prepared: PreparedImportRef | ReadyImportRef,
): string {
  return [
    "Saved import plan resolution",
    `Status: ${status(prepared.state)}`,
    `Plan revision: ${count(prepared.planRevision)}`,
    prepared.state === "ready"
      ? "The saved routing and column decisions are ready for application."
      : "Some routing or column decisions still require review.",
    prepared.state === "ready"
      ? "Next: Inspect the revised plan, then apply it with consultchimps db apply."
      : "Next: Inspect the remaining conflicts, correct the recipe, and run consultchimps db resolve again.",
    "Safety: No accepted database rows were changed.",
    "",
  ].join("\n");
}

export function formatSchemaPlan(plan: SchemaPlan): string {
  const addedColumns = plan.adds.reduce(
    (total, addition) => total + addition.columns.length,
    0,
  );
  const lines = [
    "Database schema review",
    `Status: ${status(plan.state)}`,
    `Tables to create: ${count(plan.creates.length)}`,
    `Columns to add: ${count(addedColumns)}`,
    `Conflicts requiring review: ${count(plan.conflicts.length)}`,
  ];
  const changes = [
    ...plan.creates.map(tableDefinition),
    ...plan.adds.map(
      (addition) =>
        `  Add columns to "${compact(addition.table)}": ${summarizedList(addition.columns.map(columnDefinition))}`,
    ),
  ];
  if (changes.length > 0)
    lines.push("Proposed changes:", ...limitedDetails(changes));
  if (plan.conflicts.length > 0) {
    lines.push(
      "Conflicts:",
      ...limitedDetails(
        plan.conflicts.map((conflict) => `  ${schemaConflict(conflict)}`),
      ),
    );
  }
  lines.push(
    "Safety: This dry run did not change database tables or stored data.",
    plan.state === "ready"
      ? "Next: Run the command again without --dry-run to apply these schema changes."
      : "Next: Correct the schema conflicts, then run the dry run again.",
  );
  return `${lines.join("\n")}\n`;
}

export function formatDeliveryPage(page: DeliveryPage): string {
  const lines = [
    "Delivery history",
    `Deliveries shown: ${count(page.deliveries.length)}`,
  ];
  if (page.deliveries.length > 0) {
    lines.push(
      "Recorded deliveries:",
      ...page.deliveries.flatMap((delivery) => {
        const scope =
          delivery.context.scope.kind === "partial"
            ? `Partial, ${compact(delivery.context.scope.description)}`
            : delivery.context.scope.kind === "changes"
              ? `Changes since ${compact(delivery.context.scope.baseline)}`
              : delivery.context.scope.kind === "full"
                ? "Full"
                : "Unknown";
        const details = [
          `  ${delivery.id}: ${compact(delivery.context.label)}`,
          `    Request ID: ${compact(delivery.requestId)}`,
          `    Scope: ${scope}`,
          `    Capture IDs: ${compact(delivery.captureIds.join(", ") || "None")}`,
          `    Reused capture IDs: ${compact(delivery.reusedCaptureIds.join(", ") || "None")}`,
        ];
        if (delivery.context.effectiveDate !== undefined) {
          details.push(`    Effective date: ${delivery.context.effectiveDate}`);
        }
        if (delivery.context.receivedDate !== undefined) {
          details.push(`    Received date: ${delivery.context.receivedDate}`);
        }
        const attributes = Object.entries(delivery.context.attributes ?? {});
        if (attributes.length > 0) {
          details.push(
            `    Reported attributes: ${compact(
              attributes
                .map(([name, value]) => `${name}=${String(value)}`)
                .join(", "),
            )}`,
          );
        }
        return details;
      }),
    );
  }
  if (page.nextCursor !== undefined) {
    lines.push(
      `More deliveries are available. Continue with --cursor ${page.nextCursor}.`,
    );
  }
  lines.push(
    "Safety: Reading delivery history did not change database tables or stored data.",
    "Use --json to read full structured delivery context and text marked [truncated].",
    "Next: Use a delivery ID and its linked captures to review the recorded submission history.",
  );
  return `${lines.join("\n")}\n`;
}

export function formatConversionPlan(plan: ConversionPlan): string {
  const lines = [
    "Database export review",
    `Status: ${plan.state === "ready" ? "Ready" : "Unsupported"}`,
    `Source format: ${plan.sourceFormat === "duckdb" ? "DuckDB" : "SQLite"}`,
    `Output format: ${plan.targetFormat === "duckdb" ? "DuckDB" : "SQLite"}`,
    `Tables to export: ${count(plan.tableCount)}`,
    `Rows to export: ${count(plan.rowCount)}`,
    `Storage representation changes: ${count(plan.changes.length)}`,
    `Unsupported objects: ${count(plan.issues.length)}`,
  ];
  if (plan.changes.length > 0) {
    lines.push(
      "Representation changes:",
      ...limitedDetails(
        plan.changes.map(
          (change) =>
            `  ${change.table}.${change.column}: ${change.logicalType}`,
        ),
      ),
    );
  }
  if (plan.issues.length > 0) {
    lines.push(
      "Issues:",
      ...limitedDetails(plan.issues.map((issue) => `  ${issue.message}`)),
    );
  }
  lines.push(
    "Safety: This dry run did not create or replace an output file.",
    plan.state === "ready"
      ? "Next: Run the command again without --dry-run to create the independent database export."
      : "Next: Remove or replace the unsupported objects, then run the dry run again.",
  );
  return `${lines.join("\n")}\n`;
}
