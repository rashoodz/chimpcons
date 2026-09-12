import { isConsultChimpsError } from "@consultchimps/core";

import {
  engineOf,
  inspectDatabase,
  valueAsBigInt,
  valueAsString,
} from "../database.js";
import { canonicalJson } from "../internal/json.js";
import {
  APPLICATION_TABLE,
  CAPTURE_ROW_TABLE,
  CAPTURE_TABLE,
  SOURCE_FILE_TABLE,
  TABLE_REGISTRY_TABLE,
} from "../metadata.js";
import {
  PREPARED_BINDING_TABLE,
  PREPARED_CAPTURE_TABLE,
  PREPARED_ROW_TABLE,
  preparedEngineOf,
} from "../prepared.js";
import { assertRegisteredColumns, sortTablesByReferences } from "../records.js";
import {
  formatRecordId,
  identifierKey,
  quoteIdentifier,
  validateTableSchema,
  type ColumnDefinition,
  type TableSchema,
} from "../schema.js";
import {
  parseImportCellsJson,
  parseInferredColumnsJson,
  valueForColumn,
  type InferredColumn,
} from "./inference.js";
import type {
  ColumnRoute,
  ImportConflict,
  ImportRecipe,
  PrepareImportOptions,
} from "./types.js";
import { validateColumnMappings, validateImportRecipe } from "../validators.js";

const REVIEW_BATCH_ROWS = 2_000;
const REFERENCE_QUERY_VALUES = 400;

export interface PreparedCapture {
  readonly captureId: string;
  readonly sourceFileId: string | null;
  readonly sourceKey: string;
  readonly displayName: string;
  readonly selectionKey: string;
  readonly selectionLabel: string;
  readonly readerVersion: string;
  readonly contentHash: string;
  readonly byteCount: bigint;
  readonly reused: boolean;
  readonly rowCount: bigint;
  readonly columns: readonly InferredColumn[];
}

export async function preparedCaptures(
  prepared: PrepareImportOptions["prepared"],
): Promise<PreparedCapture[]> {
  const rows = await preparedEngineOf(prepared).query(
    `SELECT c.capture_id, c.source_file_id, b.source_key, b.display_name, b.selection_key, c.selection_label, c.reader_version, c.content_hash, c.byte_count, c.reused, c.row_count, c.columns_json FROM ${PREPARED_CAPTURE_TABLE} c JOIN ${PREPARED_BINDING_TABLE} b ON b.capture_id = c.capture_id ORDER BY b.source_key, b.selection_key`,
  );
  return rows.map((row) => ({
    captureId: valueAsString(row["capture_id"], "capture ID"),
    sourceFileId:
      row["source_file_id"] === null
        ? null
        : valueAsString(row["source_file_id"], "source file ID"),
    sourceKey: valueAsString(row["source_key"], "source key"),
    displayName: valueAsString(row["display_name"], "source display name"),
    selectionKey: valueAsString(row["selection_key"], "selection key"),
    selectionLabel: valueAsString(row["selection_label"], "selection label"),
    readerVersion: valueAsString(row["reader_version"], "reader version"),
    contentHash: valueAsString(row["content_hash"], "content hash"),
    byteCount: valueAsBigInt(row["byte_count"], "byte count"),
    reused: valueAsBigInt(row["reused"], "reused flag") === 1n,
    rowCount: valueAsBigInt(row["row_count"], "row count"),
    columns: parseInferredColumnsJson(
      valueAsString(row["columns_json"], "captured columns"),
    ),
  }));
}

export function routeKey(source: string, selection: string): string {
  return JSON.stringify([source, selection]);
}

export function routeColumns(
  route: ImportRecipe["routes"][number],
  capture: PreparedCapture,
): readonly ColumnRoute[] {
  return route.columns.length === 0
    ? capture.columns.map((column) => ({
        source: column.name,
        target: column.name,
        type: column.type,
      }))
    : route.columns;
}

function sourceRowNumber(value: unknown): number {
  const sourceRow = valueAsBigInt(value, "source row");
  const result = Number(sourceRow);
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new Error("The prepared import contains an invalid source row.");
  }
  return result;
}

async function* captureRows(options: {
  readonly database: PrepareImportOptions["database"];
  readonly prepared: PrepareImportOptions["prepared"];
  readonly capture: PreparedCapture;
}) {
  const engine = options.capture.reused
    ? engineOf(options.database)
    : preparedEngineOf(options.prepared);
  const table = options.capture.reused ? CAPTURE_ROW_TABLE : PREPARED_ROW_TABLE;
  let cursor = -1n;
  for (;;) {
    const rows = await engine.query(
      `SELECT source_row, values_json FROM ${table} WHERE capture_id = ? AND source_row > ? ORDER BY source_row LIMIT ?`,
      [options.capture.captureId, cursor, BigInt(REVIEW_BATCH_ROWS)],
    );
    if (rows.length === 0) return;
    yield rows;
    cursor = valueAsBigInt(rows.at(-1)?.["source_row"], "source row");
  }
}

function destinationName(route: ImportRecipe["routes"][number]): string {
  return route.destination.kind === "new-table" ||
    route.destination.kind === "new-table-infer"
    ? route.destination.kind === "new-table"
      ? route.destination.schema.name
      : route.destination.name
    : route.destination.table;
}

function recordIdInRanges(
  value: string,
  schema: TableSchema,
  ranges: readonly (readonly [bigint, bigint])[],
): boolean {
  const separator = schema.recordId.separator ?? "-";
  const prefix = `${schema.recordId.prefix}${separator}`;
  if (!value.startsWith(prefix)) return false;
  const counterText = value.slice(prefix.length);
  if (!/^\d+$/u.test(counterText)) return false;
  const counter = BigInt(counterText);
  if (formatRecordId(schema.recordId, counter) !== value) return false;
  return ranges.some(([start, end]) => counter >= start && counter < end);
}

export async function findReusableCapture(options: {
  readonly database: PrepareImportOptions["database"];
  readonly contentHash: string;
  readonly selectionKey: string;
  readonly readerVersion: string;
}): Promise<{
  readonly captureId: string;
  readonly sourceFileId: string;
  readonly columns: string;
  readonly rowCount: bigint;
} | null> {
  const rows = await engineOf(options.database).query(
    `SELECT c.capture_id, c.source_file_id, c.columns_json, c.row_count FROM ${CAPTURE_TABLE} c JOIN ${SOURCE_FILE_TABLE} f ON f.source_file_id = c.source_file_id WHERE f.content_hash = ? AND c.selection_key = ? AND c.reader_version = ? AND c.state = 'completed'`,
    [options.contentHash, options.selectionKey, options.readerVersion],
  );
  const row = rows[0];
  return row === undefined
    ? null
    : {
        captureId: valueAsString(row["capture_id"], "capture ID"),
        sourceFileId: valueAsString(row["source_file_id"], "source file ID"),
        columns: valueAsString(row["columns_json"], "capture columns"),
        rowCount: valueAsBigInt(row["row_count"], "row count"),
      };
}

export function orderRoutesByReferences(
  routes: readonly ImportRecipe["routes"][number][],
  schemas: readonly TableSchema[],
): readonly ImportRecipe["routes"][number][] {
  const ordered = sortTablesByReferences(schemas);
  const rank = new Map(
    ordered.map((schema, index) => [identifierKey(schema.name), index]),
  );
  return routes
    .map((route, index) => ({ route, index }))
    .sort(
      (left, right) =>
        (rank.get(identifierKey(destinationName(left.route))) ??
          Number.MAX_SAFE_INTEGER) -
          (rank.get(identifierKey(destinationName(right.route))) ??
            Number.MAX_SAFE_INTEGER) || left.index - right.index,
    )
    .map(({ route }) => route);
}

async function plannedRecordRanges(options: {
  readonly database: PrepareImportOptions["database"];
  readonly captures: readonly PreparedCapture[];
  readonly recipe: ImportRecipe;
  readonly schemas: readonly TableSchema[];
}): Promise<ReadonlyMap<string, readonly (readonly [bigint, bigint])[]>> {
  const engine = engineOf(options.database);
  const counters = await engine.query(
    `SELECT table_name, next_record_id FROM ${TABLE_REGISTRY_TABLE}`,
  );
  const nextByTable = new Map(
    counters.map((row) => [
      identifierKey(valueAsString(row["table_name"], "table name")),
      valueAsBigInt(row["next_record_id"], "Record ID counter"),
    ]),
  );
  const ranges = new Map<string, Array<readonly [bigint, bigint]>>();
  const schemaByName = new Map(
    options.schemas.map((schema) => [identifierKey(schema.name), schema]),
  );
  const reservedCapturesByTable = new Map<string, Set<string>>();
  for (const route of orderRoutesByReferences(
    options.recipe.routes,
    options.schemas,
  )) {
    if (route.destination.kind === "new-table-infer") continue;
    const capture = options.captures.find(
      (candidate) =>
        candidate.sourceKey === route.source &&
        candidate.selectionKey === route.selection,
    );
    if (capture === undefined) continue;
    const requestedTable = destinationName(route);
    const table =
      schemaByName.get(identifierKey(requestedTable))?.name ?? requestedTable;
    const key = identifierKey(table);
    const reservedCaptures = reservedCapturesByTable.get(key) ?? new Set();
    if (reservedCaptures.has(capture.captureId)) continue;
    reservedCaptures.add(capture.captureId);
    reservedCapturesByTable.set(key, reservedCaptures);
    const applied = await engine.query(
      `SELECT import_id FROM ${APPLICATION_TABLE} WHERE capture_id = ? AND table_name = ? LIMIT 1`,
      [capture.captureId, table],
    );
    if (applied.length > 0) continue;
    const start = nextByTable.get(key) ?? 1n;
    const end = start + capture.rowCount;
    if (end > start) {
      const existing = ranges.get(key) ?? [];
      existing.push([start, end]);
      ranges.set(key, existing);
    }
    nextByTable.set(key, end);
  }
  return ranges;
}

async function existingRecordIds(options: {
  readonly database: PrepareImportOptions["database"];
  readonly table: string;
  readonly values: readonly string[];
}): Promise<ReadonlySet<string>> {
  const found = new Set<string>();
  for (
    let offset = 0;
    offset < options.values.length;
    offset += REFERENCE_QUERY_VALUES
  ) {
    const values = options.values.slice(
      offset,
      offset + REFERENCE_QUERY_VALUES,
    );
    if (values.length === 0) continue;
    const rows = await engineOf(options.database).query(
      `SELECT record_id FROM ${quoteIdentifier(options.table)} WHERE record_id IN (${values.map(() => "?").join(", ")})`,
      values,
    );
    for (const row of rows) {
      found.add(valueAsString(row["record_id"], "Record ID"));
    }
  }
  return found;
}

export async function evaluateConflicts(
  database: PrepareImportOptions["database"],
  prepared: PrepareImportOptions["prepared"],
  captures: readonly PreparedCapture[],
  recipe: ImportRecipe,
): Promise<ImportConflict[]> {
  validateImportRecipe(recipe);
  const inspection = await inspectDatabase({ database });
  await assertRegisteredColumns(
    engineOf(database),
    database.format,
    inspection.tables.map((table) => table.schema),
  );
  const tables = new Map(
    inspection.tables.map((table) => [identifierKey(table.name), table.schema]),
  );
  const proposedTables = new Map(tables);
  const plannedTables = new Map<string, TableSchema>();
  const conflictingPlannedTables = new Set<string>();
  for (const route of recipe.routes) {
    if (route.destination.kind === "new-table") {
      const key = identifierKey(route.destination.schema.name);
      const planned = plannedTables.get(key);
      if (
        planned !== undefined &&
        canonicalJson(planned) !== canonicalJson(route.destination.schema)
      ) {
        conflictingPlannedTables.add(key);
      } else if (planned === undefined) {
        plannedTables.set(key, route.destination.schema);
        if (!tables.has(key)) proposedTables.set(key, route.destination.schema);
      }
    }
  }
  const routes = new Map(
    recipe.routes.map((route) => [
      routeKey(route.source, route.selection),
      route,
    ]),
  );
  const conflicts: ImportConflict[] = [];
  const conflictKeys = new Set<string>();
  const addConflict = (key: string, conflict: ImportConflict): void => {
    if (conflictKeys.has(key)) return;
    conflictKeys.add(key);
    conflicts.push(conflict);
  };
  for (const table of conflictingPlannedTables) {
    addConflict(`planned-table:${table}`, {
      kind: "table-exists",
      table: plannedTables.get(table)?.name ?? table,
    });
  }
  const capturedRoutes = new Set(
    captures.map((capture) =>
      routeKey(capture.sourceKey, capture.selectionKey),
    ),
  );
  for (const route of recipe.routes) {
    const key = routeKey(route.source, route.selection);
    if (capturedRoutes.has(key)) continue;
    addConflict(`source-selection:${key}`, {
      kind: "source-selection-not-found",
      source: route.source,
      selection: route.selection,
    });
  }
  for (const route of recipe.routes) {
    if (route.destination.kind !== "new-table") continue;
    for (const foreignKey of route.destination.schema.foreignKeys ?? []) {
      if (!proposedTables.has(identifierKey(foreignKey.referencesTable))) {
        addConflict(
          `foreign-table:${identifierKey(foreignKey.referencesTable)}`,
          { kind: "table-not-found", table: foreignKey.referencesTable },
        );
      }
    }
  }
  const plannedRanges = await plannedRecordRanges({
    database,
    captures,
    recipe,
    schemas: [...proposedTables.values()],
  });
  for (const capture of captures) {
    const route = routes.get(routeKey(capture.sourceKey, capture.selectionKey));
    if (route === undefined) {
      addConflict(`destination:${capture.sourceKey}:${capture.selectionKey}`, {
        kind: "missing-destination",
        source: capture.sourceKey,
        selection: capture.selectionKey,
      });
      continue;
    }
    const mapped = routeColumns(route, capture);
    validateColumnMappings(route.source, route.selection, mapped);
    if (route.destination.kind === "new-table-infer") {
      const sourceColumns = new Map(
        capture.columns.map((column) => [column.name, column]),
      );
      const inferredColumns: ColumnDefinition[] = [];
      let missingSourceColumn = false;
      for (const column of mapped) {
        const sourceColumn = sourceColumns.get(column.source);
        if (sourceColumn === undefined) {
          missingSourceColumn = true;
          addConflict(
            `source:${capture.captureId}:${identifierKey(column.source)}`,
            {
              kind: "source-column-not-found",
              source: capture.sourceKey,
              selection: capture.selectionKey,
              column: column.source,
            },
          );
          continue;
        }
        inferredColumns.push({
          name: column.target,
          type: column.type,
          ...(column.type === "decimal" &&
          sourceColumn.precision !== undefined &&
          sourceColumn.scale !== undefined
            ? {
                precision: sourceColumn.precision,
                scale: sourceColumn.scale,
              }
            : {}),
        });
      }
      if (missingSourceColumn) continue;
      const schema: TableSchema = {
        name: route.destination.name,
        columns: inferredColumns,
        recordId: route.destination.recordId,
        foreignKeys: [],
      };
      validateTableSchema(schema);
      addConflict(`inferred:${capture.sourceKey}:${capture.selectionKey}`, {
        kind: "inferred-schema",
        source: capture.sourceKey,
        selection: capture.selectionKey,
        schema,
      });
      continue;
    }
    let destination: TableSchema | undefined;
    if (route.destination.kind === "new-table") {
      destination = route.destination.schema;
      const registeredDestination = tables.get(identifierKey(destination.name));
      if (registeredDestination !== undefined) {
        const reusable = await findReusableCapture({
          database,
          contentHash: capture.contentHash,
          selectionKey: capture.selectionKey,
          readerVersion: capture.readerVersion,
        });
        const existingApplication = await engineOf(database).query(
          `SELECT import_id FROM ${APPLICATION_TABLE} WHERE capture_id = ? AND table_name = ? LIMIT 1`,
          [
            reusable?.captureId ?? capture.captureId,
            registeredDestination.name,
          ],
        );
        if (existingApplication.length > 0) continue;
        addConflict(`table-exists:${identifierKey(destination.name)}`, {
          kind: "table-exists",
          table: registeredDestination.name,
        });
        continue;
      }
    } else {
      destination = proposedTables.get(identifierKey(route.destination.table));
    }
    if (
      destination === undefined &&
      route.destination.kind === "existing-table"
    ) {
      addConflict(`table-missing:${identifierKey(route.destination.table)}`, {
        kind: "table-not-found",
        table: route.destination.table,
      });
      continue;
    }
    if (destination === undefined) continue;
    const targetColumns = new Map(
      destination.columns.map((column) => [identifierKey(column.name), column]),
    );
    const sourceColumns = new Set(capture.columns.map((column) => column.name));
    const mappedTargets = new Set(
      mapped.map((column) => identifierKey(column.target)),
    );
    for (const target of destination.columns) {
      if (
        target.nullable === false &&
        !mappedTargets.has(identifierKey(target.name))
      ) {
        addConflict(
          `unmapped:${capture.captureId}:${identifierKey(target.name)}`,
          {
            kind: "required-column-unmapped",
            source: capture.sourceKey,
            selection: capture.selectionKey,
            target: target.name,
          },
        );
      }
    }
    const validMappings: Array<{
      readonly route: ColumnRoute;
      readonly target: TableSchema["columns"][number];
    }> = [];
    for (const column of mapped) {
      if (!sourceColumns.has(column.source)) {
        addConflict(
          `source:${capture.captureId}:${identifierKey(column.source)}`,
          {
            kind: "source-column-not-found",
            source: capture.sourceKey,
            selection: capture.selectionKey,
            column: column.source,
          },
        );
        continue;
      }
      const target = targetColumns.get(identifierKey(column.target));
      if (target === undefined) {
        addConflict(
          `target:${capture.captureId}:${identifierKey(column.target)}`,
          {
            kind: "missing-column",
            source: capture.sourceKey,
            selection: capture.selectionKey,
            column: column.target,
          },
        );
      } else if (target.type !== column.type) {
        addConflict(
          `type:${capture.captureId}:${identifierKey(column.source)}:${identifierKey(column.target)}`,
          {
            kind: "incompatible-column",
            source: capture.sourceKey,
            selection: capture.selectionKey,
            column: column.source,
            target: column.target,
            expected: target.type,
          },
        );
      } else if (target.type === "decimal") {
        const source = capture.columns.find(
          (candidate) =>
            identifierKey(candidate.name) === identifierKey(column.source),
        );
        if (
          source?.type === "decimal" &&
          source.precision !== undefined &&
          source.scale !== undefined &&
          target.precision !== undefined &&
          target.scale !== undefined &&
          (source.scale > target.scale ||
            source.precision - source.scale > target.precision - target.scale)
        ) {
          addConflict(
            `decimal:${capture.captureId}:${identifierKey(column.source)}:${identifierKey(column.target)}`,
            {
              kind: "decimal-capacity",
              source: capture.sourceKey,
              selection: capture.selectionKey,
              column: column.source,
              target: target.name,
              requiredPrecision: source.precision,
              requiredScale: source.scale,
              targetPrecision: target.precision,
              targetScale: target.scale,
            },
          );
          continue;
        }
      }
      if (target !== undefined && target.type === column.type) {
        validMappings.push({ route: column, target });
      }
    }

    const foreignKeys = new Map(
      (destination.foreignKeys ?? []).map((foreignKey) => [
        identifierKey(foreignKey.column),
        foreignKey,
      ]),
    );
    for await (const rows of captureRows({ database, prepared, capture })) {
      const referenceCandidates = new Map<
        string,
        Array<{
          readonly value: string;
          readonly sourceRow: number;
          readonly column: ColumnRoute;
          readonly referencesTable: string;
        }>
      >();
      for (const row of rows) {
        const sourceRow = sourceRowNumber(row["source_row"]);
        const values = parseImportCellsJson(
          valueAsString(row["values_json"], "captured values"),
        );
        for (const mapping of validMappings) {
          let value;
          try {
            value = valueForColumn(
              values[mapping.route.source],
              mapping.target,
            );
          } catch (error) {
            if (!isConsultChimpsError(error)) throw error;
            addConflict(
              `${error.code}:${capture.captureId}:${identifierKey(mapping.route.source)}:${identifierKey(mapping.route.target)}`,
              error.code === "DB_IMPORT_REQUIRED_VALUE"
                ? {
                    kind: "required-value",
                    source: capture.sourceKey,
                    selection: capture.selectionKey,
                    target: mapping.target.name,
                    sourceRow,
                  }
                : {
                    kind: "invalid-value",
                    source: capture.sourceKey,
                    selection: capture.selectionKey,
                    column: mapping.route.source,
                    target: mapping.target.name,
                    sourceRow,
                    expected: mapping.target.type,
                  },
            );
            continue;
          }
          const foreignKey = foreignKeys.get(
            identifierKey(mapping.target.name),
          );
          if (foreignKey === undefined || value === null) continue;
          if (typeof value !== "string") {
            addConflict(
              `foreign-type:${capture.captureId}:${identifierKey(mapping.target.name)}`,
              {
                kind: "invalid-value",
                source: capture.sourceKey,
                selection: capture.selectionKey,
                column: mapping.route.source,
                target: mapping.target.name,
                sourceRow,
                expected: "text",
              },
            );
            continue;
          }
          const referencedSchema = proposedTables.get(
            identifierKey(foreignKey.referencesTable),
          );
          if (
            referencedSchema !== undefined &&
            recordIdInRanges(
              value,
              referencedSchema,
              plannedRanges.get(identifierKey(referencedSchema.name)) ?? [],
            )
          ) {
            continue;
          }
          const key = identifierKey(foreignKey.referencesTable);
          const candidates = referenceCandidates.get(key) ?? [];
          candidates.push({
            value,
            sourceRow,
            column: mapping.route,
            referencesTable: foreignKey.referencesTable,
          });
          referenceCandidates.set(key, candidates);
        }
      }
      for (const candidates of referenceCandidates.values()) {
        const reference = candidates[0];
        if (reference === undefined) continue;
        const existingSchema = tables.get(
          identifierKey(reference.referencesTable),
        );
        const found =
          existingSchema === undefined
            ? new Set<string>()
            : await existingRecordIds({
                database,
                table: existingSchema.name,
                values: [
                  ...new Set(candidates.map((candidate) => candidate.value)),
                ],
              });
        for (const candidate of candidates) {
          if (found.has(candidate.value)) continue;
          addConflict(
            `foreign-value:${capture.captureId}:${identifierKey(candidate.column.target)}`,
            {
              kind: "foreign-key-value-not-found",
              source: capture.sourceKey,
              selection: capture.selectionKey,
              column: candidate.column.source,
              target: candidate.column.target,
              sourceRow: candidate.sourceRow,
              referencesTable: candidate.referencesTable,
            },
          );
        }
      }
    }
  }
  return conflicts;
}
