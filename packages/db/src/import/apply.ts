import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { throwIfAborted } from "@consultchimps/core";

import {
  engineOf,
  parseStoredTableSchema,
  valueAsBigInt,
  valueAsPositiveBigInt,
  valueAsString,
} from "../database.js";
import { databaseError } from "../errors.js";
import type { EngineTransaction, EngineValue } from "../internal/engine.js";
import { canonicalJson } from "../internal/json.js";
import {
  APPLICATION_TABLE,
  CAPTURE_TABLE,
  COUNTERS_TABLE,
  DATABASE_METADATA_TABLE,
  DELIVERY_MEMBERSHIP_TABLE,
  DELIVERY_TABLE,
  IMPORT_REQUEST_TABLE,
  PLAN_TABLE,
  SOURCE_CONTENT_TABLE,
  SOURCE_FILE_TABLE,
  SOURCE_NAME_TABLE,
  CAPTURE_ROW_TABLE,
  TABLE_REGISTRY_TABLE,
} from "../metadata.js";
import {
  PREPARED_ROW_TABLE,
  preparedEngineOf,
  preparedRef,
  readPreparedRecipe,
} from "../prepared.js";
import {
  createManagedTable,
  readSchemaFingerprint,
  sortTablesByReferences,
} from "../records.js";
import { formatRecordId, identifierKey, type TableSchema } from "../schema.js";
import { parseDeliveryContext } from "../validators.js";
import { parseStoredDeliveryContext } from "../internal/stored-delivery.js";
import { parseImportCellsJson, valueForColumn } from "./inference.js";
import {
  orderRoutesByReferences,
  preparedCaptures,
  routeColumns,
  routeKey,
} from "./planning.js";
import type { ApplyImportOptions, ImportResult } from "./types.js";

const CAPTURE_BATCH_ROWS = 2_000;

function receiptIds(value: unknown): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(valueAsString(value, "receipt identifiers"));
  } catch {
    parsed = undefined;
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((item: unknown) => typeof item === "string")
  ) {
    throw databaseError(
      "DB_CORRUPT_METADATA",
      "The saved import receipt contains invalid identifiers. Restore a verified database copy before retrying.",
    );
  }
  return parsed;
}

async function allocate(
  transaction: EngineTransaction,
  counter: string,
  prefix: string,
  padding = 6,
): Promise<string> {
  const rows = await transaction.query(
    `SELECT next_value FROM ${COUNTERS_TABLE} WHERE counter_name = ?`,
    [counter],
  );
  const value = valueAsPositiveBigInt(
    rows[0]?.["next_value"],
    `${counter} counter`,
  );
  await transaction.execute(
    `UPDATE ${COUNTERS_TABLE} SET next_value = ? WHERE counter_name = ?`,
    [value + 1n, counter],
  );
  return `${prefix}-${value.toString().padStart(padding, "0")}`;
}

async function registeredSchema(
  transaction: EngineTransaction,
  table: string,
): Promise<TableSchema | null> {
  const rows = await transaction.query(
    `SELECT schema_json FROM ${TABLE_REGISTRY_TABLE} WHERE table_name = ?`,
    [table],
  );
  const stored = rows[0]?.["schema_json"];
  return typeof stored === "string"
    ? parseStoredTableSchema(stored, table)
    : null;
}

export async function applyImport(
  options: ApplyImportOptions,
): Promise<ImportResult> {
  throwIfAborted(options.signal, "db.apply");
  if (options.requestId.trim().length === 0) {
    throw databaseError(
      "DB_IMPORT_REQUEST_ID_REQUIRED",
      "Give the import a request ID so retrying it cannot apply the same plan twice.",
    );
  }
  const delivery =
    options.delivery === undefined
      ? undefined
      : parseDeliveryContext(options.delivery);
  if (options.approved.state !== "ready") {
    throw databaseError(
      "DB_IMPORT_NEEDS_REVIEW",
      "The import plan still needs review.",
    );
  }
  const actual = await preparedRef(options.prepared);
  if (
    actual.state !== "ready" ||
    actual.id !== options.approved.id ||
    actual.planRevision !== options.approved.planRevision
  ) {
    throw databaseError(
      "DB_STALE_IMPORT_PLAN",
      "The approved import plan is no longer current. Inspect and approve its latest revision.",
    );
  }
  const target = engineOf(options.database);
  const preparedEngine = preparedEngineOf(options.prepared);
  const preparedPlan = await readPreparedRecipe(options.prepared);
  let recipe = preparedPlan.recipe;
  const { conflicts, decisions } = preparedPlan;
  const captures = await preparedCaptures(options.prepared);
  let rowsImported = 0;
  let rowsReused = 0;
  let tablesCreated = 0;
  let deliveryId: string | undefined;
  let deliveriesRecorded = 0;
  const importIds: string[] = [];
  const appliedCaptureIds = new Set<string>();
  await target.transaction(async (transaction) => {
    const existingRequest = await transaction.query(
      `SELECT plan_id, plan_revision, import_ids_json, capture_ids_json, row_count FROM ${IMPORT_REQUEST_TABLE} WHERE request_id = ?`,
      [options.requestId],
    );
    if (existingRequest[0] !== undefined) {
      const samePlan =
        valueAsString(existingRequest[0]["plan_id"], "plan ID") ===
          options.approved.id &&
        valueAsBigInt(existingRequest[0]["plan_revision"], "plan revision") ===
          options.approved.planRevision;
      if (!samePlan) {
        throw databaseError(
          "DB_REQUEST_ID_CONFLICT",
          "This request ID was already used for a different import. Choose a new request ID.",
          { requestId: options.requestId },
        );
      }
      importIds.push(...receiptIds(existingRequest[0]["import_ids_json"]));
      for (const captureId of receiptIds(
        existingRequest[0]["capture_ids_json"],
      ))
        appliedCaptureIds.add(captureId);
      rowsReused = Number(
        valueAsBigInt(existingRequest[0]["row_count"], "receipt row count"),
      );
      const deliveries = await transaction.query(
        `SELECT delivery_id, context_json FROM ${DELIVERY_TABLE} WHERE request_id = ?`,
        [options.requestId],
      );
      if (deliveries[0] !== undefined) {
        deliveryId = valueAsString(deliveries[0]["delivery_id"], "delivery ID");
        const storedDelivery = parseStoredDeliveryContext(
          deliveries[0]["context_json"],
        );
        if (
          delivery === undefined ||
          canonicalJson(storedDelivery) !== canonicalJson(delivery)
        ) {
          throw databaseError(
            "DB_REQUEST_ID_CONFLICT",
            "This request ID was already used with different delivery details. Choose a new request ID.",
            { requestId: options.requestId },
          );
        }
      } else if (delivery !== undefined) {
        throw databaseError(
          "DB_REQUEST_ID_CONFLICT",
          "This request ID was already used without delivery details. Choose a new request ID.",
          { requestId: options.requestId },
        );
      }
      return;
    }
    const revisionRows = await transaction.query(
      `SELECT revision FROM ${DATABASE_METADATA_TABLE}`,
    );
    const revision = valueAsBigInt(
      revisionRows[0]?.["revision"],
      "database revision",
    );
    const schemaFingerprint = await readSchemaFingerprint(
      transaction,
      options.database.format,
    );
    if (
      options.approved.databaseId !== options.database.id ||
      revision !== options.approved.baselineRevision ||
      schemaFingerprint !== options.approved.baselineSchemaFingerprint
    ) {
      throw databaseError(
        "DB_STALE_IMPORT_PLAN",
        "The database changed after this import was prepared. Prepare it again before applying.",
      );
    }
    const registeredRows = await transaction.query(
      `SELECT table_name, schema_json FROM ${TABLE_REGISTRY_TABLE}`,
    );
    const canonicalTableNames = new Map(
      registeredRows.map((row) => {
        const name = valueAsString(row["table_name"], "table name");
        return [identifierKey(name), name] as const;
      }),
    );
    for (const route of recipe.routes) {
      if (route.destination.kind !== "new-table") continue;
      const name = route.destination.schema.name;
      if (!canonicalTableNames.has(identifierKey(name))) {
        canonicalTableNames.set(identifierKey(name), name);
      }
    }
    recipe = {
      ...recipe,
      routes: recipe.routes.map((route) => {
        if (route.destination.kind === "existing-table") {
          return {
            ...route,
            destination: {
              kind: "existing-table" as const,
              table:
                canonicalTableNames.get(
                  identifierKey(route.destination.table),
                ) ?? route.destination.table,
            },
          };
        }
        if (route.destination.kind === "new-table") {
          const name =
            canonicalTableNames.get(
              identifierKey(route.destination.schema.name),
            ) ?? route.destination.schema.name;
          return {
            ...route,
            destination: {
              ...route.destination,
              schema: { ...route.destination.schema, name },
            },
          };
        }
        return route;
      }),
    };
    const captureIdByBinding = new Map<string, string>();
    const publishedCaptures = new Map<
      string,
      { readonly targetCaptureId: string; readonly sourceFileId: string }
    >();
    for (const capture of captures) {
      const published = publishedCaptures.get(capture.captureId);
      if (published !== undefined) {
        await transaction.execute(
          `INSERT INTO ${SOURCE_NAME_TABLE} VALUES (?, ?) ON CONFLICT DO NOTHING`,
          [published.sourceFileId, capture.displayName],
        );
        captureIdByBinding.set(
          routeKey(capture.sourceKey, capture.selectionKey),
          published.targetCaptureId,
        );
        continue;
      }
      let targetCaptureId =
        capture.sourceFileId === null ? null : capture.captureId;
      let sourceFileId = capture.sourceFileId;
      if (!capture.reused) {
        const contentRows = await transaction.query(
          `SELECT content_hash FROM ${SOURCE_CONTENT_TABLE} WHERE content_hash = ?`,
          [capture.contentHash],
        );
        if (contentRows.length === 0) {
          await transaction.execute(
            `INSERT INTO ${SOURCE_CONTENT_TABLE} VALUES (?, ?)`,
            [capture.contentHash, capture.byteCount],
          );
        }
        const fileRows = await transaction.query(
          `SELECT source_file_id FROM ${SOURCE_FILE_TABLE} WHERE content_hash = ?`,
          [capture.contentHash],
        );
        sourceFileId =
          fileRows[0] === undefined
            ? await allocate(transaction, "source_file", "SRC")
            : valueAsString(fileRows[0]["source_file_id"], "source file ID");
        if (fileRows.length === 0) {
          await transaction.execute(
            `INSERT INTO ${SOURCE_FILE_TABLE} VALUES (?, ?, ?)`,
            [sourceFileId, capture.contentHash, capture.displayName],
          );
        }
        const existingCapture = await transaction.query(
          `SELECT capture_id FROM ${CAPTURE_TABLE} WHERE source_file_id = ? AND selection_key = ? AND reader_version = ?`,
          [sourceFileId, capture.selectionKey, capture.readerVersion],
        );
        targetCaptureId =
          existingCapture[0] === undefined
            ? await allocate(transaction, "capture", "CAP")
            : valueAsString(existingCapture[0]["capture_id"], "capture ID");
        if (existingCapture.length === 0) {
          await transaction.execute(
            `INSERT INTO ${CAPTURE_TABLE} (capture_id, source_file_id, source_key, selection_key, selection_label, reader_version, state, row_count, columns_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              targetCaptureId,
              sourceFileId,
              capture.sourceKey,
              capture.selectionKey,
              capture.selectionLabel,
              capture.readerVersion,
              "completed",
              capture.rowCount,
              JSON.stringify(capture.columns),
            ],
          );
          let sourceRowCursor = -1n;
          while (true) {
            const staged = await preparedEngine.query(
              `SELECT source_row, values_json FROM ${PREPARED_ROW_TABLE} WHERE capture_id = ? AND source_row > ? ORDER BY source_row LIMIT ?`,
              [capture.captureId, sourceRowCursor, BigInt(CAPTURE_BATCH_ROWS)],
            );
            if (staged.length === 0) break;
            await transaction.bulkInsert({
              table: CAPTURE_ROW_TABLE,
              columns: ["capture_id", "source_row", "values_json"],
              rows: staged.map((row) => [
                targetCaptureId,
                valueAsBigInt(row["source_row"], "source row"),
                valueAsString(row["values_json"], "captured values"),
              ]),
              signal: options.signal,
            });
            sourceRowCursor = valueAsBigInt(
              staged.at(-1)?.["source_row"],
              "source row",
            );
          }
        }
      }
      if (targetCaptureId === null || sourceFileId === null) {
        throw databaseError(
          "DB_CORRUPT_PREPARED_IMPORT",
          "A prepared capture is missing its target identity.",
        );
      }
      await transaction.execute(
        `INSERT INTO ${SOURCE_NAME_TABLE} VALUES (?, ?) ON CONFLICT DO NOTHING`,
        [sourceFileId, capture.displayName],
      );
      captureIdByBinding.set(
        routeKey(capture.sourceKey, capture.selectionKey),
        targetCaptureId,
      );
      publishedCaptures.set(capture.captureId, {
        targetCaptureId,
        sourceFileId,
      });
      appliedCaptureIds.add(targetCaptureId);
    }
    const recipeJson = canonicalJson(recipe);
    const conflictsJson = canonicalJson(conflicts);
    const decisionsJson = canonicalJson(decisions);
    const bindingsJson = canonicalJson(
      captures.map((capture) => ({
        source: capture.sourceKey,
        displayName: capture.displayName,
        selection: capture.selectionKey,
        label: capture.selectionLabel,
        captureId: captureIdByBinding.get(
          routeKey(capture.sourceKey, capture.selectionKey),
        ),
      })),
    );
    const savedPlan = await transaction.query(
      `SELECT baseline_revision, state, recipe_json, conflicts_json, decisions_json, bindings_json FROM ${PLAN_TABLE} WHERE plan_id = ? AND plan_revision = ?`,
      [options.approved.id, options.approved.planRevision],
    );
    if (savedPlan[0] === undefined) {
      await transaction.execute(
        `INSERT INTO ${PLAN_TABLE} VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          options.approved.id,
          options.approved.planRevision,
          options.approved.baselineRevision,
          "applied",
          recipeJson,
          conflictsJson,
          decisionsJson,
          bindingsJson,
        ],
      );
    } else if (
      valueAsBigInt(savedPlan[0]["baseline_revision"], "baseline revision") !==
        options.approved.baselineRevision ||
      valueAsString(savedPlan[0]["state"], "plan state") !== "applied" ||
      valueAsString(savedPlan[0]["recipe_json"], "import recipe") !==
        recipeJson ||
      valueAsString(savedPlan[0]["conflicts_json"], "import conflicts") !==
        conflictsJson ||
      valueAsString(savedPlan[0]["decisions_json"], "import decisions") !==
        decisionsJson ||
      valueAsString(savedPlan[0]["bindings_json"], "source bindings") !==
        bindingsJson
    ) {
      throw databaseError(
        "DB_IMPORT_PLAN_HISTORY_CONFLICT",
        "This import plan revision conflicts with saved database history.",
        { planId: options.approved.id },
      );
    }
    const registeredNames = new Set<string>();
    const routeSchemas = new Map<string, TableSchema>();
    for (const row of registeredRows) {
      const name = valueAsString(row["table_name"], "table name");
      registeredNames.add(identifierKey(name));
      routeSchemas.set(
        identifierKey(name),
        parseStoredTableSchema(
          valueAsString(row["schema_json"], "table schema"),
          name,
        ),
      );
    }
    for (const route of recipe.routes) {
      if (route.destination.kind === "new-table") {
        routeSchemas.set(
          identifierKey(route.destination.schema.name),
          route.destination.schema,
        );
      }
    }
    for (const schema of routeSchemas.values()) {
      for (const foreignKey of schema.foreignKeys ?? []) {
        if (!routeSchemas.has(identifierKey(foreignKey.referencesTable))) {
          throw databaseError(
            "DB_FOREIGN_TABLE_NOT_FOUND",
            "An import relationship refers to a table that does not exist or appear in this plan.",
            { table: schema.name, referencesTable: foreignKey.referencesTable },
          );
        }
      }
    }
    const orderedRoutes = orderRoutesByReferences(recipe.routes, [
      ...routeSchemas.values(),
    ]);
    const plannedTableNames = new Set(
      recipe.routes.flatMap((route) =>
        route.destination.kind === "new-table"
          ? [identifierKey(route.destination.schema.name)]
          : [],
      ),
    );
    for (const schema of sortTablesByReferences([...routeSchemas.values()])) {
      const key = identifierKey(schema.name);
      if (!plannedTableNames.has(key) || registeredNames.has(key)) continue;
      await createManagedTable(transaction, options.database.format, schema);
      registeredNames.add(key);
      tablesCreated += 1;
    }
    for (const route of orderedRoutes) {
      const capture = captures.find(
        (candidate) =>
          candidate.sourceKey === route.source &&
          candidate.selectionKey === route.selection,
      );
      if (capture === undefined) {
        throw databaseError(
          "DB_STALE_IMPORT_PLAN",
          "An import route no longer has captured rows.",
        );
      }
      const captureId = captureIdByBinding.get(
        routeKey(route.source, route.selection),
      );
      if (captureId === undefined) {
        throw databaseError(
          "DB_STALE_IMPORT_PLAN",
          "An import route no longer has a captured identity.",
        );
      }
      if (route.destination.kind === "new-table-infer") {
        throw databaseError(
          "DB_IMPORT_NEEDS_REVIEW",
          "An inferred destination schema must be approved before applying.",
        );
      }
      const tableName =
        route.destination.kind === "new-table"
          ? route.destination.schema.name
          : route.destination.table;
      const applicationKey = bytesToHex(
        sha256(
          new TextEncoder().encode(
            canonicalJson([
              captureId,
              tableName,
              route.destination,
              routeColumns(route, capture),
            ]),
          ),
        ),
      );
      const existingApplication = await transaction.query(
        `SELECT import_id, row_count FROM ${APPLICATION_TABLE} WHERE application_key = ? OR (capture_id = ? AND table_name = ?) ORDER BY import_id LIMIT 1`,
        [applicationKey, captureId, tableName],
      );
      if (existingApplication[0] !== undefined) {
        importIds.push(
          valueAsString(existingApplication[0]["import_id"], "import ID"),
        );
        rowsReused += Number(
          valueAsBigInt(existingApplication[0]["row_count"], "row count"),
        );
        continue;
      }
      const schema = await registeredSchema(transaction, tableName);
      if (schema === null) {
        throw databaseError(
          "DB_STALE_IMPORT_PLAN",
          `The destination table "${tableName}" no longer exists.`,
        );
      }
      const importId = await allocate(transaction, "import", "IMP");
      const sourceFileRows = await transaction.query(
        `SELECT source_file_id FROM ${CAPTURE_TABLE} WHERE capture_id = ?`,
        [captureId],
      );
      const sourceFileId = valueAsString(
        sourceFileRows[0]?.["source_file_id"],
        "source file ID",
      );
      const recordRows = await transaction.query(
        `SELECT next_record_id FROM ${TABLE_REGISTRY_TABLE} WHERE table_name = ?`,
        [tableName],
      );
      let nextRecord = valueAsPositiveBigInt(
        recordRows[0]?.["next_record_id"],
        "Record ID counter",
      );
      const columns = routeColumns(route, capture);
      const targetColumns = new Map(
        schema.columns.map((column) => [identifierKey(column.name), column]),
      );
      const importedRowRows = await transaction.query(
        `SELECT next_value FROM ${COUNTERS_TABLE} WHERE counter_name = ?`,
        ["imported_row"],
      );
      let nextImportedRow = valueAsPositiveBigInt(
        importedRowRows[0]?.["next_value"],
        "imported row counter",
      );
      let sourceRowCursor = -1n;
      while (true) {
        throwIfAborted(options.signal, "db.apply");
        const batch = await transaction.query(
          `SELECT source_row, values_json FROM ${CAPTURE_ROW_TABLE} WHERE capture_id = ? AND source_row > ? ORDER BY source_row LIMIT ?`,
          [captureId, sourceRowCursor, BigInt(CAPTURE_BATCH_ROWS)],
        );
        if (batch.length === 0) break;
        const output: Array<readonly EngineValue[]> = [];
        for (const row of batch) {
          const importedRowId = nextImportedRow++;
          const values = parseImportCellsJson(
            valueAsString(row["values_json"], "captured values"),
          );
          output.push([
            formatRecordId(schema.recordId, nextRecord++),
            importedRowId,
            importId,
            sourceFileId,
            capture.selectionLabel,
            valueAsBigInt(row["source_row"], "source row"),
            ...columns.map((column) =>
              valueForColumn(
                values[column.source],
                targetColumns.get(identifierKey(column.target)) ?? {
                  name: column.target,
                  type: column.type,
                },
              ),
            ),
          ]);
        }
        await transaction.bulkInsert({
          table: tableName,
          columns: [
            "record_id",
            "_imported_row_id",
            "_import_id",
            "_source_file_id",
            "_source_selection",
            "_source_row",
            ...columns.map((column) => column.target),
          ],
          rows: output,
          signal: options.signal,
        });
        rowsImported += output.length;
        sourceRowCursor = valueAsBigInt(
          batch.at(-1)?.["source_row"],
          "source row",
        );
      }
      await transaction.execute(
        `UPDATE ${COUNTERS_TABLE} SET next_value = ? WHERE counter_name = ?`,
        [nextImportedRow, "imported_row"],
      );
      await transaction.execute(
        `UPDATE ${TABLE_REGISTRY_TABLE} SET next_record_id = ? WHERE table_name = ?`,
        [nextRecord, tableName],
      );
      await transaction.execute(
        `INSERT INTO ${APPLICATION_TABLE} VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          importId,
          applicationKey,
          options.requestId,
          captureId,
          tableName,
          options.approved.id,
          options.approved.planRevision,
          capture.rowCount,
        ],
      );
      importIds.push(importId);
    }
    await transaction.execute(
      `INSERT INTO ${IMPORT_REQUEST_TABLE} VALUES (?, ?, ?, ?, ?, ?)`,
      [
        options.requestId,
        options.approved.id,
        options.approved.planRevision,
        JSON.stringify(importIds),
        JSON.stringify([...appliedCaptureIds].sort()),
        BigInt(rowsImported + rowsReused),
      ],
    );
    if (delivery !== undefined) {
      deliveryId = await allocate(transaction, "delivery", "DEL");
      deliveriesRecorded = 1;
      await transaction.execute(
        `INSERT INTO ${DELIVERY_TABLE} VALUES (?, ?, ?)`,
        [deliveryId, options.requestId, canonicalJson(delivery)],
      );
      for (const captureId of new Set(captureIdByBinding.values())) {
        await transaction.execute(
          `INSERT INTO ${DELIVERY_MEMBERSHIP_TABLE} VALUES (?, ?)`,
          [deliveryId, captureId],
        );
      }
    }
    await transaction.execute(
      `UPDATE ${DATABASE_METADATA_TABLE} SET revision = revision + 1`,
    );
  });
  return {
    operation: "db.apply",
    artifacts: [],
    warnings: [],
    metrics: {
      rowsImported,
      rowsReused,
      tablesCreated,
      deliveriesRecorded,
    },
    importIds,
    captureIds: [...appliedCaptureIds].sort(),
    ...(deliveryId === undefined ? {} : { deliveryId }),
  };
}
