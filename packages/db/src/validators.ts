import { databaseError } from "./errors.js";
import {
  assertRecordIdConfig,
  assertSafeIdentifier,
  COLUMN_TYPES,
  identifierKey,
  validateTableSchema,
  type ColumnDefinition,
  type DatabaseSchema,
  type RecordIdConfig,
  type TableSchema,
} from "./schema.js";
import type {
  ColumnRoute,
  DeliveryContext,
  ImportConflict,
  ImportDecision,
  ImportDestination,
  ImportRecipe,
  ImportRoute,
} from "./import/types.js";

export function validateColumnMappings(
  source: string,
  selection: string,
  columns: readonly ColumnRoute[],
): void {
  const targets = new Map<string, string>();
  for (const column of columns) {
    assertSafeIdentifier(column.target, "column");
    const key = identifierKey(column.target);
    const priorSource = targets.get(key);
    if (priorSource !== undefined) {
      throw databaseError(
        "DB_INVALID_RECIPE",
        `Source "${source}" selection "${selection}" maps destination column "${column.target}" more than once. Map each destination column once within a route.`,
        {
          source,
          selection,
          target: column.target,
          firstSource: priorSource,
          secondSource: column.source,
        },
      );
    }
    targets.set(key, column.source);
  }
}

function validateImportRoute(route: ImportRoute): void {
  if (route.destination.kind === "new-table") {
    validateTableSchema(route.destination.schema);
  } else if (route.destination.kind === "new-table-infer") {
    assertSafeIdentifier(route.destination.name, "table");
    assertRecordIdConfig(route.destination.recordId);
  } else {
    assertSafeIdentifier(route.destination.table, "table");
  }
  validateColumnMappings(route.source, route.selection, route.columns);
}

export function validateImportRecipe(recipe: ImportRecipe): void {
  const keys = new Set<string>();
  for (const route of recipe.routes) {
    validateImportRoute(route);
    const key = JSON.stringify([route.source, route.selection]);
    if (keys.has(key)) {
      throw databaseError(
        "DB_INVALID_RECIPE",
        `The import recipe routes source "${route.source}" selection "${route.selection}" more than once.`,
        { source: route.source, selection: route.selection },
      );
    }
    keys.add(key);
  }
}

function objectValue(
  value: unknown,
  label: string,
  errorCode = "DB_INVALID_DOCUMENT",
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw databaseError(errorCode, `The ${label} must be a JSON object.`, {
      label,
    });
  }
  return value as Record<string, unknown>;
}

function stringValue(
  value: unknown,
  label: string,
  errorCode = "DB_INVALID_DOCUMENT",
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw databaseError(errorCode, `The ${label} must be non-empty text.`, {
      label,
    });
  }
  return value;
}

function parseColumn(value: unknown): ColumnDefinition {
  const column = objectValue(value, "column");
  const type = stringValue(column["type"], "column type");
  if (!COLUMN_TYPES.some((candidate) => candidate === type)) {
    throw databaseError(
      "DB_INVALID_DOCUMENT",
      `The column type "${type}" is not supported.`,
      { type },
    );
  }
  const nullable = column["nullable"];
  if (nullable !== undefined && typeof nullable !== "boolean") {
    throw databaseError(
      "DB_INVALID_DOCUMENT",
      "The column nullable setting must be true or false.",
    );
  }
  const precision = column["precision"];
  const scale = column["scale"];
  if (precision !== undefined && typeof precision !== "number") {
    throw databaseError(
      "DB_INVALID_DOCUMENT",
      "Column precision must be a number when provided.",
    );
  }
  if (scale !== undefined && typeof scale !== "number") {
    throw databaseError(
      "DB_INVALID_DOCUMENT",
      "Column scale must be a number when provided.",
    );
  }
  return {
    name: stringValue(column["name"], "column name"),
    type: type as ColumnDefinition["type"],
    ...(nullable === undefined ? {} : { nullable }),
    ...(typeof precision === "number" ? { precision } : {}),
    ...(typeof scale === "number" ? { scale } : {}),
  };
}

function parseRecordIdConfig(
  value: unknown,
  invalidCode: "DB_INVALID_DOCUMENT" | "DB_INVALID_RECIPE",
): RecordIdConfig {
  const recordId = objectValue(value, "Record ID configuration");
  const padding = recordId["padding"];
  if (typeof padding !== "number") {
    throw databaseError(invalidCode, "Record ID padding must be a number.");
  }
  const separator = recordId["separator"];
  if (separator !== undefined && typeof separator !== "string") {
    throw databaseError(
      invalidCode,
      "The Record ID separator must be text when provided.",
    );
  }
  const parsed: RecordIdConfig = {
    prefix: stringValue(recordId["prefix"], "Record ID prefix"),
    padding,
    ...(separator === undefined ? {} : { separator }),
  };
  assertRecordIdConfig(parsed);
  return parsed;
}

function parseTable(value: unknown): TableSchema {
  const table = objectValue(value, "table schema");
  const columns = table["columns"];
  if (!Array.isArray(columns)) {
    throw databaseError(
      "DB_INVALID_DOCUMENT",
      "A table schema needs a columns array.",
    );
  }
  const foreignKeys = table["foreignKeys"];
  if (foreignKeys !== undefined && !Array.isArray(foreignKeys)) {
    throw databaseError(
      "DB_INVALID_DOCUMENT",
      "Table foreign keys must be an array when provided.",
    );
  }
  const parsed: TableSchema = {
    name: stringValue(table["name"], "table name"),
    columns: columns.map(parseColumn),
    recordId: parseRecordIdConfig(table["recordId"], "DB_INVALID_DOCUMENT"),
    ...(foreignKeys === undefined
      ? {}
      : {
          foreignKeys: foreignKeys.map((value) => {
            const foreignKey = objectValue(value, "foreign key");
            return {
              column: stringValue(foreignKey["column"], "foreign-key column"),
              referencesTable: stringValue(
                foreignKey["referencesTable"],
                "referenced table",
              ),
            };
          }),
        }),
  };
  validateTableSchema(parsed);
  return parsed;
}

export function parseDatabaseSchema(value: unknown): DatabaseSchema {
  const document = objectValue(value, "database schema");
  if (document["version"] !== 1 || !Array.isArray(document["tables"])) {
    throw databaseError(
      "DB_INVALID_SCHEMA_DOCUMENT",
      "The schema must have version 1 and a tables array.",
    );
  }
  return { version: 1, tables: document["tables"].map(parseTable) };
}

function parseDestination(value: unknown): ImportDestination {
  const destination = objectValue(value, "import destination");
  if (destination["kind"] === "new-table") {
    return { kind: "new-table", schema: parseTable(destination["schema"]) };
  }
  if (destination["kind"] === "new-table-infer") {
    const parsed: ImportDestination = {
      kind: "new-table-infer",
      name: stringValue(destination["name"], "destination table"),
      recordId: parseRecordIdConfig(
        destination["recordId"],
        "DB_INVALID_RECIPE",
      ),
    };
    assertSafeIdentifier(parsed.name, "table");
    return parsed;
  }
  if (destination["kind"] === "existing-table") {
    return {
      kind: "existing-table",
      table: stringValue(destination["table"], "destination table"),
    };
  }
  throw databaseError(
    "DB_INVALID_RECIPE",
    "An import destination must select a new or existing table.",
  );
}

function parseColumnRoute(value: unknown): ColumnRoute {
  const route = objectValue(value, "column route");
  const type = stringValue(route["type"], "column route type");
  if (!COLUMN_TYPES.some((candidate) => candidate === type)) {
    throw databaseError(
      "DB_INVALID_RECIPE",
      `The column route type "${type}" is not supported.`,
    );
  }
  return {
    source: stringValue(route["source"], "source column"),
    target: stringValue(route["target"], "target column"),
    type: type as ColumnDefinition["type"],
  };
}

function parseRoute(value: unknown): ImportRoute {
  const route = objectValue(value, "import route");
  if (!Array.isArray(route["columns"])) {
    throw databaseError(
      "DB_INVALID_RECIPE",
      "An import route needs a columns array.",
    );
  }
  const parsed: ImportRoute = {
    source: stringValue(route["source"], "source key"),
    selection: stringValue(route["selection"], "selection key"),
    destination: parseDestination(route["destination"]),
    columns: route["columns"].map(parseColumnRoute),
  };
  validateImportRoute(parsed);
  return parsed;
}

export function parseImportRecipe(value: unknown): ImportRecipe {
  const document = objectValue(value, "import recipe");
  if (document["version"] !== 1 || !Array.isArray(document["routes"])) {
    throw databaseError(
      "DB_INVALID_RECIPE",
      "The import recipe must have version 1 and a routes array.",
    );
  }
  const routes = document["routes"].map(parseRoute);
  const recipe: ImportRecipe = { version: 1, routes };
  validateImportRecipe(recipe);
  return recipe;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw databaseError(
      "DB_INVALID_PREPARED_IMPORT",
      `The ${label} must be a non-negative integer.`,
      { label },
    );
  }
  return value;
}

export function parseImportConflicts(
  value: unknown,
): readonly ImportConflict[] {
  if (!Array.isArray(value)) {
    throw databaseError(
      "DB_INVALID_PREPARED_IMPORT",
      "The import plan conflicts must be a JSON array.",
    );
  }
  return value.map((entry): ImportConflict => {
    const conflict = objectValue(entry, "import conflict");
    const kind = conflict["kind"];
    switch (kind) {
      case "missing-destination":
      case "source-selection-not-found":
        return {
          kind,
          source: stringValue(conflict["source"], "source key"),
          selection: stringValue(conflict["selection"], "selection key"),
        };
      case "missing-column":
      case "source-column-not-found":
        return {
          kind,
          source: stringValue(conflict["source"], "source key"),
          selection: stringValue(conflict["selection"], "selection key"),
          column: stringValue(conflict["column"], "column name"),
        };
      case "required-column-unmapped":
        return {
          kind,
          source: stringValue(conflict["source"], "source key"),
          selection: stringValue(conflict["selection"], "selection key"),
          target: stringValue(conflict["target"], "target column"),
        };
      case "required-value":
        return {
          kind,
          source: stringValue(conflict["source"], "source key"),
          selection: stringValue(conflict["selection"], "selection key"),
          target: stringValue(conflict["target"], "target column"),
          sourceRow: nonNegativeInteger(conflict["sourceRow"], "source row"),
        };
      case "invalid-value":
        return {
          kind,
          source: stringValue(conflict["source"], "source key"),
          selection: stringValue(conflict["selection"], "selection key"),
          column: stringValue(conflict["column"], "source column"),
          target: stringValue(conflict["target"], "target column"),
          sourceRow: nonNegativeInteger(conflict["sourceRow"], "source row"),
          expected: parseColumnRoute({
            source: conflict["column"],
            target: conflict["target"],
            type: conflict["expected"],
          }).type,
        };
      case "foreign-key-value-not-found":
        return {
          kind,
          source: stringValue(conflict["source"], "source key"),
          selection: stringValue(conflict["selection"], "selection key"),
          column: stringValue(conflict["column"], "source column"),
          target: stringValue(conflict["target"], "target column"),
          sourceRow: nonNegativeInteger(conflict["sourceRow"], "source row"),
          referencesTable: stringValue(
            conflict["referencesTable"],
            "referenced table",
          ),
        };
      case "incompatible-column":
        return {
          kind,
          source: stringValue(conflict["source"], "source key"),
          selection: stringValue(conflict["selection"], "selection key"),
          column: stringValue(conflict["column"], "source column"),
          target: stringValue(conflict["target"], "target column"),
          expected: parseColumnRoute({
            source: conflict["column"],
            target: conflict["target"],
            type: conflict["expected"],
          }).type,
        };
      case "decimal-capacity":
        return {
          kind,
          source: stringValue(conflict["source"], "source key"),
          selection: stringValue(conflict["selection"], "selection key"),
          column: stringValue(conflict["column"], "source column"),
          target: stringValue(conflict["target"], "target column"),
          requiredPrecision: nonNegativeInteger(
            conflict["requiredPrecision"],
            "required decimal precision",
          ),
          requiredScale: nonNegativeInteger(
            conflict["requiredScale"],
            "required decimal scale",
          ),
          targetPrecision: nonNegativeInteger(
            conflict["targetPrecision"],
            "target decimal precision",
          ),
          targetScale: nonNegativeInteger(
            conflict["targetScale"],
            "target decimal scale",
          ),
        };
      case "inferred-schema":
        return {
          kind,
          source: stringValue(conflict["source"], "source key"),
          selection: stringValue(conflict["selection"], "selection key"),
          schema: parseTable(conflict["schema"]),
        };
      case "table-exists":
      case "table-not-found":
        return {
          kind,
          table: stringValue(conflict["table"], "table name"),
        };
      default:
        throw databaseError(
          "DB_INVALID_PREPARED_IMPORT",
          "The import plan contains an unknown conflict kind.",
          { kind },
        );
    }
  });
}

export function parseImportDecisions(
  value: unknown,
): readonly ImportDecision[] {
  if (!Array.isArray(value)) {
    throw databaseError(
      "DB_INVALID_IMPORT_DECISIONS",
      "Import decisions must be a JSON array.",
    );
  }
  const decisions = value.map((entry): ImportDecision => {
    const decision = objectValue(entry, "import decision");
    if (decision["kind"] === "exclude") {
      return {
        kind: "exclude",
        source: stringValue(decision["source"], "source key"),
        selection: stringValue(decision["selection"], "selection key"),
        reason: stringValue(decision["reason"], "exclusion reason"),
      };
    }
    if (decision["kind"] === "route") {
      return { kind: "route", ...parseRoute(decision) };
    }
    throw databaseError(
      "DB_INVALID_IMPORT_DECISIONS",
      "Each import decision must route or exclude one source selection.",
    );
  });
  const keys = new Set<string>();
  for (const decision of decisions) {
    const key = JSON.stringify([decision.source, decision.selection]);
    if (keys.has(key)) {
      throw databaseError(
        "DB_INVALID_IMPORT_DECISIONS",
        `Source "${decision.source}" selection "${decision.selection}" has more than one decision.`,
        { source: decision.source, selection: decision.selection },
      );
    }
    keys.add(key);
  }
  return decisions;
}

export function parseDeliveryContext(value: unknown): DeliveryContext {
  const errorCode = "DB_INVALID_DELIVERY_CONTEXT";
  const document = objectValue(value, "delivery context", errorCode);
  const scope = objectValue(document["scope"], "delivery scope", errorCode);
  let parsedScope: DeliveryContext["scope"];
  switch (scope["kind"]) {
    case "full":
      parsedScope = { kind: "full" };
      break;
    case "partial":
      parsedScope = {
        kind: "partial",
        description: stringValue(
          scope["description"],
          "partial delivery description",
          errorCode,
        ),
      };
      break;
    case "changes":
      parsedScope = {
        kind: "changes",
        baseline: stringValue(
          scope["baseline"],
          "delivery baseline",
          errorCode,
        ),
      };
      break;
    case "unknown":
      parsedScope = { kind: "unknown" };
      break;
    default:
      throw databaseError(
        "DB_INVALID_DELIVERY_CONTEXT",
        "The delivery scope must be full, partial, changes, or unknown.",
      );
  }
  const effectiveDate = document["effectiveDate"];
  const receivedDate = document["receivedDate"];
  if (effectiveDate !== undefined && typeof effectiveDate !== "string") {
    throw databaseError(
      "DB_INVALID_DELIVERY_CONTEXT",
      "The effective date must be text when provided.",
    );
  }
  if (receivedDate !== undefined && typeof receivedDate !== "string") {
    throw databaseError(
      "DB_INVALID_DELIVERY_CONTEXT",
      "The received date must be text when provided.",
    );
  }
  const attributes = document["attributes"];
  let parsedAttributes:
    Record<string, string | number | boolean | null> | undefined;
  if (attributes !== undefined) {
    const object = objectValue(attributes, "delivery attributes", errorCode);
    parsedAttributes = Object.create(null) as Record<
      string,
      string | number | boolean | null
    >;
    for (const [name, attribute] of Object.entries(object)) {
      if (
        attribute !== null &&
        typeof attribute !== "string" &&
        typeof attribute !== "number" &&
        typeof attribute !== "boolean"
      ) {
        throw databaseError(
          "DB_INVALID_DELIVERY_CONTEXT",
          `The delivery attribute "${name}" must be text, a number, true, false, or null.`,
          { attribute: name },
        );
      }
      if (typeof attribute === "number" && !Number.isFinite(attribute)) {
        throw databaseError(
          "DB_INVALID_DELIVERY_CONTEXT",
          `The delivery attribute "${name}" must be a finite number.`,
          { attribute: name },
        );
      }
      parsedAttributes[name] = attribute;
    }
  }
  return {
    label: stringValue(document["label"], "delivery label", errorCode),
    scope: parsedScope,
    ...(effectiveDate === undefined ? {} : { effectiveDate }),
    ...(receivedDate === undefined ? {} : { receivedDate }),
    ...(parsedAttributes === undefined ? {} : { attributes: parsedAttributes }),
  };
}
