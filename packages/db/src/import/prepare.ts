import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { throwIfAborted } from "@consultchimps/core";

import { valueAsString } from "../database.js";
import { databaseError } from "../errors.js";
import type { EngineValue } from "../internal/engine.js";
import {
  PREPARED_BINDING_TABLE,
  PREPARED_CAPTURE_TABLE,
  PREPARED_ROW_TABLE,
  preparedEngineOf,
  updatePreparedPlan,
} from "../prepared.js";
import {
  addToProfile,
  emptyProfile,
  inferColumns,
  type ColumnProfile,
} from "./inference.js";
import {
  evaluateConflicts,
  findReusableCapture,
  preparedCaptures,
} from "./planning.js";
import type {
  ImportRegionReader,
  PrepareImportOptions,
  PrepareImportOutcome,
} from "./types.js";
import { validateImportRecipe } from "../validators.js";

const HASH_CHUNK_BYTES = 1024 * 1024;
const CAPTURE_BATCH_ROWS = 2_000;

async function readAndClose<T>(
  reader: ImportRegionReader,
  read: () => Promise<T>,
): Promise<T> {
  let result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown };
  try {
    result = { ok: true, value: await read() };
  } catch (error) {
    result = { ok: false, error };
  }
  try {
    await reader.close();
  } catch (error) {
    if (!result.ok) {
      throw new AggregateError(
        [result.error, error],
        "The import reader failed and could not be closed.",
        { cause: error },
      );
    }
    throw error;
  }
  if (!result.ok) throw result.error;
  return result.value;
}

async function hashSource(
  source: PrepareImportOptions["sources"][number]["bytes"],
  signal?: AbortSignal,
): Promise<string> {
  const hash = sha256.create();
  for (let offset = 0; offset < source.size; offset += HASH_CHUNK_BYTES) {
    throwIfAborted(signal, "db.prepare");
    const expected = Math.min(HASH_CHUNK_BYTES, source.size - offset);
    const bytes = await source.readAt(offset, expected, signal);
    if (bytes.length !== expected) {
      throw databaseError(
        "DB_SOURCE_SHORT_READ",
        `The source "${source.name}" changed or ended while it was being hashed.`,
        { source: source.name, offset, expected, actual: bytes.length },
      );
    }
    hash.update(bytes);
  }
  return bytesToHex(hash.digest());
}

export async function prepareImport(
  options: PrepareImportOptions,
): Promise<PrepareImportOutcome> {
  throwIfAborted(options.signal, "db.prepare");
  validateImportRecipe(options.recipe);
  if (options.prepared.databaseId !== options.database.id) {
    throw databaseError(
      "DB_PREPARED_WRONG_DATABASE",
      "The import plan belongs to a different database.",
    );
  }
  const preparedEngine = preparedEngineOf(options.prepared);
  let sourcesRead = 0;
  let sourcesReused = 0;
  let rowsCaptured = 0;
  for (const source of options.sources) {
    let capturedSource = false;
    let reusedSource = false;
    const contentHash = await hashSource(source.bytes, options.signal);
    await source.verifyUnchanged?.();
    for (const selection of source.selections) {
      throwIfAborted(options.signal, "db.prepare");
      const existingBinding = await preparedEngine.query(
        `SELECT c.content_hash, c.reader_version FROM ${PREPARED_BINDING_TABLE} b JOIN ${PREPARED_CAPTURE_TABLE} c ON c.capture_id = b.capture_id WHERE b.source_key = ? AND b.selection_key = ?`,
        [source.key, selection.key],
      );
      if (existingBinding[0] !== undefined) {
        if (
          valueAsString(existingBinding[0]["content_hash"], "content hash") !==
            contentHash ||
          valueAsString(
            existingBinding[0]["reader_version"],
            "reader version",
          ) !== source.readerVersion
        ) {
          throw databaseError(
            "DB_PREPARED_SOURCE_CHANGED",
            `Source "${source.key}" selection "${selection.key}" differs from the content already stored in this import plan. Create a new plan for the changed source.`,
            { source: source.key, selection: selection.key },
          );
        }
        continue;
      }
      const duplicate = await preparedEngine.query(
        `SELECT capture_id FROM ${PREPARED_CAPTURE_TABLE} WHERE content_hash = ? AND selection_key = ? AND reader_version = ? LIMIT 1`,
        [contentHash, selection.key, source.readerVersion],
      );
      if (duplicate[0] !== undefined) {
        await preparedEngine.execute(
          `INSERT INTO ${PREPARED_BINDING_TABLE} VALUES (?, ?, ?, ?)`,
          [
            source.key,
            selection.key,
            valueAsString(duplicate[0]["capture_id"], "capture ID"),
            source.bytes.name,
          ],
        );
        reusedSource = true;
        continue;
      }
      const reusable = await findReusableCapture({
        database: options.database,
        contentHash,
        selectionKey: selection.key,
        readerVersion: source.readerVersion,
      });
      if (reusable !== null) {
        await preparedEngine.transaction(async (transaction) => {
          await transaction.execute(
            `INSERT INTO ${PREPARED_CAPTURE_TABLE} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              reusable.captureId,
              reusable.sourceFileId,
              source.key,
              source.bytes.name,
              selection.key,
              selection.label,
              source.readerVersion,
              contentHash,
              BigInt(source.bytes.size),
              1n,
              reusable.rowCount,
              reusable.columns,
            ],
          );
          await transaction.execute(
            `INSERT INTO ${PREPARED_BINDING_TABLE} VALUES (?, ?, ?, ?)`,
            [source.key, selection.key, reusable.captureId, source.bytes.name],
          );
        });
        reusedSource = true;
        continue;
      }
      const captureId = `CAPTURE-${globalThis.crypto.randomUUID()}`;
      const reader = await selection.open({
        signal: options.signal,
        onProgress: options.onProgress,
      });
      let rowCount = 0;
      let lastSourceRow = 0;
      try {
        const columns = await readAndClose(reader, async () => {
          const columnNames = [...reader.columns];
          const profiles = new Map<string, ColumnProfile>(
            columnNames.map((column) => [column, emptyProfile()]),
          );
          for await (const batch of reader.batches({
            batchSize: CAPTURE_BATCH_ROWS,
            signal: options.signal,
            onProgress: options.onProgress,
          })) {
            throwIfAborted(options.signal, "db.prepare");
            const rows: Array<readonly EngineValue[]> = [];
            for (const row of batch) {
              if (
                !Number.isSafeInteger(row.sourceRow) ||
                row.sourceRow < 1 ||
                row.sourceRow <= lastSourceRow
              ) {
                throw databaseError(
                  "DB_INVALID_SOURCE_ROW",
                  "Imported source rows must have unique positive row numbers in ascending order.",
                  {
                    source: source.key,
                    selection: selection.key,
                    sourceRow: row.sourceRow,
                    previousSourceRow: lastSourceRow,
                  },
                );
              }
              lastSourceRow = row.sourceRow;
              for (const column of columnNames) {
                const cell = row.cells[column] ?? { kind: "blank" };
                const profile = profiles.get(column);
                if (profile !== undefined) addToProfile(profile, cell);
              }
              rows.push([
                captureId,
                BigInt(row.sourceRow),
                JSON.stringify(row.cells),
              ]);
            }
            await preparedEngine.transaction(async (transaction) => {
              await transaction.bulkInsert({
                table: PREPARED_ROW_TABLE,
                columns: ["capture_id", "source_row", "values_json"],
                rows,
                signal: options.signal,
              });
            });
            rowCount += batch.length;
            rowsCaptured += batch.length;
          }
          return inferColumns(columnNames, profiles);
        });
        await source.verifyUnchanged?.();
        await preparedEngine.transaction(async (transaction) => {
          await transaction.execute(
            `INSERT INTO ${PREPARED_CAPTURE_TABLE} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              captureId,
              null,
              source.key,
              source.bytes.name,
              selection.key,
              selection.label,
              source.readerVersion,
              contentHash,
              BigInt(source.bytes.size),
              0n,
              BigInt(rowCount),
              JSON.stringify(columns),
            ],
          );
          await transaction.execute(
            `INSERT INTO ${PREPARED_BINDING_TABLE} VALUES (?, ?, ?, ?)`,
            [source.key, selection.key, captureId, source.bytes.name],
          );
        });
      } catch (error) {
        try {
          await preparedEngine.execute(
            `DELETE FROM ${PREPARED_ROW_TABLE} WHERE capture_id = ?`,
            [captureId],
          );
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Import preparation failed and its staged rows could not be removed.",
            { cause: cleanupError },
          );
        }
        throw error;
      }
      capturedSource = true;
    }
    if (capturedSource) sourcesRead += 1;
    if (reusedSource) sourcesReused += 1;
  }
  const captures = await preparedCaptures(options.prepared);
  const conflicts = await evaluateConflicts(
    options.database,
    options.prepared,
    captures,
    options.recipe,
  );
  const prepared = await updatePreparedPlan({
    prepared: options.prepared,
    recipe: options.recipe,
    conflicts,
    ready: conflicts.length === 0,
  });
  await preparedEngine.checkpoint();
  return {
    prepared,
    result: {
      operation: "db.prepare",
      artifacts: [],
      warnings: [],
      metrics: {
        sourcesRead,
        sourcesReused,
        rowsCaptured,
        conflicts: conflicts.length,
      },
    },
  };
}
