import {
  ConsultChimpsError,
  throwIfAborted,
  type OperationControlOptions,
  type RandomAccessSource,
} from "@consultchimps/core";
import {
  inspectWorkbookStream,
  openWorkbookStream,
  type ScratchFactory,
  type WorkbookSelection,
  type WorkbookStream,
  type WorkbookStreamInspection,
} from "@consultchimps/xlsx/stream";

import type { ImportSelectionSource, ImportSource } from "./import/types.js";

export interface WorkbookImportSourceOptions extends OperationControlOptions {
  readonly key: string;
  readonly bytes: RandomAccessSource;
  readonly scratch: ScratchFactory;
  readonly selection?: WorkbookSelection | undefined;
  readonly selectionKeys?: readonly string[] | undefined;
  readonly hidden?: boolean | undefined;
  readonly headerRow?: number | undefined;
  readonly verifyUnchanged?: (() => Promise<void>) | undefined;
}

export interface WorkbookImportSource {
  readonly source: ImportSource;
  readonly inspection: WorkbookStreamInspection;
  close(): Promise<void>;
}

function selectionLabel(selection: WorkbookSelection): string {
  if ("sheet" in selection) return selection.sheet;
  if ("table" in selection) return selection.table;
  return selection.range;
}

function parseSelectionKey(key: string): WorkbookSelection {
  let value: unknown;
  try {
    value = JSON.parse(key);
  } catch {
    value = undefined;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    if (
      "sheet" in value &&
      typeof value.sheet === "string" &&
      "headerRow" in value &&
      typeof value.headerRow === "number" &&
      Number.isSafeInteger(value.headerRow) &&
      value.headerRow >= 1 &&
      value.headerRow <= 1_048_576 &&
      Object.keys(value).length === 2
    )
      return { sheet: value.sheet, headerRow: value.headerRow };
    if (Object.keys(value).length === 1) {
      if ("table" in value && typeof value.table === "string")
        return { table: value.table };
      if ("range" in value && typeof value.range === "string")
        return { range: value.range };
    }
  }
  throw new ConsultChimpsError(
    "DB_INVALID_WORKBOOK_SELECTION",
    "Use the workbook selection key from the import review, containing a sheet and headerRow, a table, or a range.",
  );
}

/** Inspects metadata eagerly and opens row readers only after import deduplication. */
export async function createWorkbookImportSource(
  options: WorkbookImportSourceOptions,
): Promise<WorkbookImportSource> {
  if (options.key.trim().length === 0) {
    throw new ConsultChimpsError(
      "DB_INVALID_SOURCE_KEY",
      "Give each workbook a nonempty source key.",
    );
  }
  const headerRow = options.headerRow ?? 1;
  if (
    !Number.isSafeInteger(headerRow) ||
    headerRow < 1 ||
    headerRow > 1_048_576
  ) {
    throw new ConsultChimpsError(
      "DB_INVALID_HEADER_ROW",
      "Choose a whole header row number from 1 to 1048576.",
    );
  }
  throwIfAborted(options.signal, "db.prepare");
  if (options.selection && options.selectionKeys)
    throw new ConsultChimpsError(
      "DB_AMBIGUOUS_SELECTION",
      "Choose either one workbook region or the selections from a recipe.",
    );
  const inspection = await inspectWorkbookStream(options.bytes, {
    scratch: options.scratch,
    signal: options.signal,
    onProgress: options.onProgress,
  });
  const selections: readonly WorkbookSelection[] = options.selectionKeys
    ? options.selectionKeys.map(parseSelectionKey)
    : options.selection
      ? [options.selection]
      : inspection.sheets
          .filter(
            (sheet) =>
              options.hidden === true || sheet.visibility === "visible",
          )
          .map((sheet) => ({ sheet: sheet.name, headerRow }));
  let session: Promise<WorkbookStream> | undefined;
  let closed = false;
  const sources: ImportSelectionSource[] = selections.map(
    (selection, index) => ({
      key: options.selectionKeys?.[index] ?? JSON.stringify(selection),
      label: selectionLabel(selection),
      async open(controls) {
        if (closed)
          throw new ConsultChimpsError(
            "DB_SOURCE_CLOSED",
            "The workbook source is closed. Select it again before preparing another import.",
          );
        throwIfAborted(controls.signal, "db.prepare");
        session ??= openWorkbookStream(options.bytes, {
          scratch: options.scratch,
          signal: controls.signal,
          onProgress: controls.onProgress,
        });
        const reader = await (await session).openRegion(selection);
        return {
          columns: reader.region.columns.map((column) => column.name),
          batches: (batchOptions) => reader.batches(batchOptions),
          close: () => reader.close(),
        };
      },
    }),
  );
  return {
    inspection,
    source: {
      key: options.key,
      bytes: options.bytes,
      readerVersion: "consultchimps-xlsx-stream-1",
      selections: sources,
      verifyUnchanged: options.verifyUnchanged,
    },
    async close() {
      closed = true;
      if (session) await (await session).close();
    },
  };
}
