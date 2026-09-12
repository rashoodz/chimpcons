import {
  ConsultChimpsError,
  type RandomAccessSource,
} from "@consultchimps/core";
import type { FileEntry } from "@zip.js/zip.js";

import { XLSX_ERRORS } from "../errors.js";
import { loadWorkbookMetadata, type WorkbookMetadata } from "./metadata.js";
import { parseWorksheetBatches, readWorksheetRow } from "./rows.js";
import { loadSharedStrings, type SharedStrings } from "./strings.js";
import { loadWorkbookStyles, type WorkbookStyles } from "./styles.js";
import type {
  StreamCell,
  StreamColumn,
  StreamRegion,
  StreamRow,
  StreamScalarCell,
  StreamTable,
  WorkbookRegionReader,
  WorkbookSelection,
  WorkbookStream,
  WorkbookStreamInspection,
  WorkbookStreamOptions,
} from "./types.js";
import {
  columnIndex,
  parseLocalRectangle,
  parseQualifiedRectangle,
} from "./xml.js";
import { workbookFailure } from "./zip.js";

export type {
  ScratchFactory,
  StreamCell,
  StreamColumn,
  StreamNamedRange,
  StreamRegion,
  StreamRow,
  StreamScalarCell,
  StreamSheet,
  StreamTable,
  WorkbookRegionReader,
  WorkbookSelection,
  WorkbookStream,
  WorkbookStreamInspection,
  WorkbookStreamOptions,
} from "./types.js";

function foldedName(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function sameName(left: string, right: string): boolean {
  return foldedName(left) === foldedName(right);
}

function scalarHeader(cell: StreamScalarCell): string {
  switch (cell.kind) {
    case "blank":
      return "";
    case "string":
      return cell.value;
    case "number":
      return cell.raw;
    case "boolean":
      return cell.value ? "TRUE" : "FALSE";
    case "date":
      return cell.iso;
    case "error":
      return cell.error;
  }
}

function headerValue(cell: StreamCell): string {
  if (cell.kind !== "formula") return scalarHeader(cell);
  return cell.cached.kind === "missing" ? "" : scalarHeader(cell.cached);
}

function validateColumns(columns: readonly StreamColumn[]): void {
  if (columns.length === 0) {
    throw new ConsultChimpsError(
      XLSX_ERRORS.XLSX_NO_COLUMNS,
      "The selected header row has no columns. Choose a row that contains column names.",
    );
  }
  const names = new Map<string, string>();
  for (const column of columns) {
    if (column.name.trim().length === 0) {
      throw new ConsultChimpsError(
        XLSX_ERRORS.XLSX_EMPTY_HEADER,
        `Column ${column.column + 1} has an empty header. Give each selected column a name and try again.`,
        { details: { column: column.column + 1 } },
      );
    }
    const key = foldedName(column.name);
    const previous = names.get(key);
    if (previous !== undefined) {
      throw new ConsultChimpsError(
        XLSX_ERRORS.XLSX_DUPLICATE_HEADER,
        `The selected region contains duplicate header "${column.name}". Rename one of the columns and try again.`,
        { details: { header: column.name, previous } },
      );
    }
    names.set(key, column.name);
  }
}

interface SelectedRectangle {
  readonly sheet: string;
  readonly startColumn: number;
  readonly endColumn: number;
  readonly headerRow: number;
  readonly lastRow: number;
  readonly table: StreamTable | undefined;
  readonly origin: StreamRegion["origin"];
}

function matchesName<T>(
  candidates: readonly T[],
  requested: string,
  nameOf: (candidate: T) => string,
): readonly T[] {
  return candidates.filter((candidate) =>
    sameName(nameOf(candidate), requested),
  );
}

function selectionRectangle(
  metadata: WorkbookMetadata,
  selection: WorkbookSelection,
): SelectedRectangle | undefined {
  if ("table" in selection) {
    const matchingTables = matchesName(
      metadata.inspection.tables,
      selection.table,
      (candidate) => candidate.name,
    );
    if (matchingTables.length > 1) {
      throw new ConsultChimpsError(
        XLSX_ERRORS.XLSX_INVALID_EXCEL_TABLE,
        `Excel Table "${selection.table}" matches more than one Excel Table in the workbook. Rename the duplicate Tables so their names differ and try again.`,
        { details: { table: selection.table } },
      );
    }
    const table = matchingTables[0];
    if (!table) return undefined;
    const rectangle = parseLocalRectangle(table.reference);
    if (!rectangle) return undefined;
    return {
      sheet: table.sheet,
      startColumn: rectangle.startColumn,
      endColumn: rectangle.endColumn,
      headerRow: rectangle.firstRow,
      lastRow: rectangle.lastRow - (table.totalsRow ? 1 : 0),
      table,
      origin: { kind: "table", tableName: table.name },
    };
  }
  if ("sheet" in selection) {
    return {
      sheet: selection.sheet,
      startColumn: 0,
      endColumn: 16_383,
      headerRow: selection.headerRow,
      lastRow: 1_048_576,
      table: undefined,
      origin: { kind: "declared-header" },
    };
  }
  const matchingNames = metadata.inspection.namedRanges.filter((candidate) =>
    sameName(candidate.name, selection.range),
  );
  if (matchingNames.length > 1) return undefined;
  const namedRange = matchingNames[0];
  const reference = namedRange?.reference.replace(/^=/u, "") ?? selection.range;
  let rectangle = parseQualifiedRectangle(reference);
  if (!rectangle && namedRange?.localSheetId !== undefined) {
    const local = parseLocalRectangle(reference);
    const sheet = metadata.sheets[namedRange.localSheetId];
    if (local && sheet) rectangle = { ...local, sheet: sheet.name };
  }
  if (!rectangle) return undefined;
  return {
    sheet: rectangle.sheet,
    startColumn: rectangle.startColumn,
    endColumn: rectangle.endColumn,
    headerRow: rectangle.firstRow,
    lastRow: rectangle.lastRow,
    table: undefined,
    origin: namedRange
      ? { kind: "named-range", rangeName: namedRange.name }
      : { kind: "explicit-range", reference: selection.range },
  };
}

function worksheetEntry(
  metadata: WorkbookMetadata,
  sheetName: string,
): { readonly name: string; readonly entry: FileEntry } | undefined {
  const matchingSheets = matchesName(
    metadata.sheets,
    sheetName,
    (candidate) => candidate.name,
  );
  if (matchingSheets.length > 1) {
    throw new ConsultChimpsError(
      XLSX_ERRORS.XLSX_WORKSHEET_NOT_FOUND,
      `Worksheet "${sheetName}" matches more than one worksheet in the workbook. Rename the duplicate worksheets so their names differ and try again.`,
      { details: { sheet: sheetName } },
    );
  }
  const sheet = matchingSheets[0];
  const entry = sheet ? metadata.archive.entries.get(sheet.part) : undefined;
  return sheet && entry ? { name: sheet.name, entry } : undefined;
}

interface SessionResources {
  readonly sharedStrings: SharedStrings;
  readonly styles: WorkbookStyles;
}

async function regionColumns(
  metadata: WorkbookMetadata,
  selected: SelectedRectangle,
  entry: FileEntry,
  resources: SessionResources,
  options: WorkbookStreamOptions,
): Promise<readonly StreamColumn[]> {
  if (selected.table) {
    const columns = selected.table.columns.map((name, index) => ({
      name,
      column: selected.startColumn + index,
    }));
    validateColumns(columns);
    return columns;
  }
  const header = await readWorksheetRow(entry, selected.headerRow, {
    sharedStrings: resources.sharedStrings,
    styles: resources.styles,
    limits: metadata.archive.limits,
    signal: options.signal,
    onProgress: options.onProgress,
  });
  if (!header) {
    throw new ConsultChimpsError(
      XLSX_ERRORS.XLSX_NO_COLUMNS,
      `Header row ${selected.headerRow} has no cells. Choose a row that contains column names.`,
      { details: { headerRow: selected.headerRow, sheet: selected.sheet } },
    );
  }
  const headerByColumn = new Map<number, string>();
  for (const [reference, cell] of Object.entries(header.cells)) {
    const index = columnIndex(reference);
    if (
      index !== undefined &&
      index >= selected.startColumn &&
      index <= selected.endColumn
    ) {
      headerByColumn.set(index, headerValue(cell));
    }
  }
  const populatedColumns = [...headerByColumn]
    .filter(([, value]) => value.trim().length > 0)
    .map(([column]) => column)
    .sort((left, right) => left - right);
  const firstColumn =
    selected.origin.kind === "declared-header"
      ? populatedColumns[0]
      : selected.startColumn;
  const lastColumn =
    selected.origin.kind === "declared-header"
      ? populatedColumns.at(-1)
      : selected.endColumn;
  const columns: StreamColumn[] = [];
  if (firstColumn !== undefined && lastColumn !== undefined) {
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      columns.push({ name: headerByColumn.get(column) ?? "", column });
    }
  }
  validateColumns(columns);
  return columns;
}

class RegionReader implements WorkbookRegionReader {
  #closed = false;

  constructor(
    private readonly metadata: WorkbookMetadata,
    private readonly entry: FileEntry,
    private readonly resources: SessionResources,
    private readonly options: WorkbookStreamOptions,
    private readonly closeResources: (() => Promise<void>) | undefined,
    readonly region: StreamRegion,
  ) {}

  async *batches(options: {
    readonly batchSize: number;
    readonly signal?: AbortSignal | undefined;
    readonly onProgress?: WorkbookStreamOptions["onProgress"];
  }): AsyncIterable<readonly StreamRow[]> {
    if (this.#closed) {
      throw new ConsultChimpsError(
        XLSX_ERRORS.XLSX_READ_FAILED,
        "The workbook region reader is closed. Open the region again before reading rows.",
      );
    }
    if (!Number.isSafeInteger(options.batchSize) || options.batchSize < 1) {
      throw new ConsultChimpsError(
        XLSX_ERRORS.XLSX_READ_FAILED,
        "batchSize must be a positive whole number.",
        { details: { batchSize: options.batchSize } },
      );
    }
    const columns = new Map(
      this.region.columns.map((column) => [column.column, column.name]),
    );
    const signal = options.signal ?? this.options.signal;
    try {
      yield* parseWorksheetBatches(this.entry, {
        firstRow: this.region.firstRow,
        lastRow: this.region.lastRow,
        columns,
        batchSize: options.batchSize,
        sharedStrings: this.resources.sharedStrings,
        styles: this.resources.styles,
        limits: this.metadata.archive.limits,
        signal,
        onProgress: options.onProgress ?? this.options.onProgress,
      });
    } catch (cause) {
      if (this.closeResources) await this.close().catch(() => undefined);
      throw workbookFailure(this.metadata.source, cause, signal);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.closeResources?.();
  }
}

async function createRegionReader(
  metadata: WorkbookMetadata,
  selection: WorkbookSelection,
  resources: SessionResources,
  options: WorkbookStreamOptions,
  closeResources?: () => Promise<void>,
): Promise<WorkbookRegionReader> {
  const selected = selectionRectangle(metadata, selection);
  if (!selected) {
    if ("table" in selection) {
      throw new ConsultChimpsError(
        XLSX_ERRORS.XLSX_INVALID_EXCEL_TABLE,
        `Excel Table "${selection.table}" was not found in the workbook. Check the Table name in Excel and try again.`,
        { details: { table: selection.table } },
      );
    }
    throw new ConsultChimpsError(
      XLSX_ERRORS.XLSX_INVALID_NAMED_RANGE,
      "The selected range is missing, ambiguous, or is not one rectangular worksheet range.",
      {
        details: { range: "range" in selection ? selection.range : undefined },
      },
    );
  }
  if (
    !Number.isSafeInteger(selected.headerRow) ||
    selected.headerRow < 1 ||
    selected.headerRow > 1_048_576
  ) {
    throw new ConsultChimpsError(
      XLSX_ERRORS.XLSX_INVALID_HEADER_ROW,
      "Choose a whole header row number from 1 to 1048576.",
      { details: { headerRow: selected.headerRow } },
    );
  }
  const worksheet = worksheetEntry(metadata, selected.sheet);
  if (!worksheet) {
    throw new ConsultChimpsError(
      XLSX_ERRORS.XLSX_WORKSHEET_NOT_FOUND,
      `Worksheet "${selected.sheet}" was not found in the workbook.`,
      { details: { sheet: selected.sheet } },
    );
  }
  const columns = await regionColumns(
    metadata,
    selected,
    worksheet.entry,
    resources,
    options,
  );
  const startColumn = selected.table
    ? selected.startColumn
    : Math.max(
        selected.startColumn,
        columns[0]?.column ?? selected.startColumn,
      );
  const endColumn = selected.table
    ? selected.endColumn
    : Math.min(
        selected.endColumn,
        columns.at(-1)?.column ?? selected.endColumn,
      );
  return new RegionReader(
    metadata,
    worksheet.entry,
    resources,
    options,
    closeResources,
    {
      sheet: worksheet.name,
      origin: selected.origin,
      headerRow: selected.headerRow,
      firstRow: selected.headerRow + 1,
      lastRow: selected.lastRow,
      startColumn,
      endColumn,
      columns,
    },
  );
}

async function loadResources(
  metadata: WorkbookMetadata,
  options: WorkbookStreamOptions,
): Promise<SessionResources> {
  const styles = await loadWorkbookStyles(
    metadata.archive,
    metadata.stylesEntry,
    metadata.date1904,
    options.signal,
  );
  const sharedStrings = await loadSharedStrings(
    metadata.sharedStringsEntry,
    options,
    metadata.archive.limits,
  );
  return { styles, sharedStrings };
}

async function closeSession(
  metadata: WorkbookMetadata,
  resources: SessionResources | undefined,
): Promise<void> {
  const results = await Promise.allSettled([
    metadata.archive.reader.close(),
    resources?.sharedStrings.close(),
  ]);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) throw workbookFailure(metadata.source, failure.reason);
}

export async function inspectWorkbookStream(
  source: RandomAccessSource,
  options: WorkbookStreamOptions,
): Promise<WorkbookStreamInspection> {
  const metadata = await loadWorkbookMetadata(source, options);
  try {
    return metadata.inspection;
  } finally {
    await metadata.archive.reader
      .close()
      .catch((cause) => Promise.reject(workbookFailure(source, cause)));
  }
}

export async function openWorkbookStream(
  source: RandomAccessSource,
  options: WorkbookStreamOptions,
): Promise<WorkbookStream> {
  const metadata = await loadWorkbookMetadata(source, options);
  let resources: SessionResources | undefined;
  try {
    resources = await loadResources(metadata, options);
  } catch (cause) {
    await closeSession(metadata, resources).catch(() => undefined);
    throw workbookFailure(source, cause, options.signal);
  }
  let closed = false;
  const currentResources = resources;
  return {
    inspection: metadata.inspection,
    async openRegion(selection) {
      if (closed) {
        throw new ConsultChimpsError(
          XLSX_ERRORS.XLSX_READ_FAILED,
          "The workbook stream is closed. Open the workbook again before selecting a region.",
        );
      }
      try {
        return await createRegionReader(
          metadata,
          selection,
          currentResources,
          options,
        );
      } catch (cause) {
        throw workbookFailure(source, cause, options.signal);
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await closeSession(metadata, currentResources);
    },
  };
}

export async function openWorkbookRegionStream(
  source: RandomAccessSource,
  selection: WorkbookSelection,
  options: WorkbookStreamOptions,
): Promise<WorkbookRegionReader> {
  const metadata = await loadWorkbookMetadata(source, options);
  let resources: SessionResources | undefined;
  try {
    resources = await loadResources(metadata, options);
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await closeSession(metadata, resources);
    };
    return await createRegionReader(
      metadata,
      selection,
      resources,
      options,
      close,
    );
  } catch (cause) {
    await closeSession(metadata, resources).catch(() => undefined);
    throw workbookFailure(source, cause, options.signal);
  }
}
