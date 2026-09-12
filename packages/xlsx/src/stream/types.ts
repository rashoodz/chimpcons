import type { ProgressReporter, RandomAccessFile } from "@consultchimps/core";

export type WorkbookSelection =
  | { readonly table: string }
  | { readonly range: string }
  | { readonly sheet: string; readonly headerRow: number };

/** Each call returns a new caller-owned scratch file. The reader closes it. */
export interface ScratchFactory {
  create(options: {
    readonly purpose: "xlsx-shared-strings";
    readonly signal?: AbortSignal | undefined;
  }): Promise<RandomAccessFile>;
}

export interface WorkbookStreamOptions {
  readonly scratch: ScratchFactory;
  /** Maximum compressed-source range read. Defaults to 1 MiB. */
  readonly chunkBytes?: number | undefined;
  readonly maximumEntries?: number | undefined;
  /** Maximum size of the ZIP central directory. Defaults to 64 MiB. */
  readonly maximumCentralDirectoryBytes?: number | undefined;
  /** Maximum expanded size across the ZIP package. Defaults to 8 GiB. */
  readonly maximumExpandedBytes?: number | undefined;
  /** Maximum expanded size of one worksheet. Defaults to 4 GiB. */
  readonly maximumEntryBytes?: number | undefined;
  /** Maximum expanded size of an XML metadata part. Defaults to 16 MiB. */
  readonly maximumMetadataBytes?: number | undefined;
  readonly maximumSharedStrings?: number | undefined;
  /** Maximum UTF-8 size of one cell value or formula. Defaults to 16 MiB. */
  readonly maximumCellBytes?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ProgressReporter | undefined;
}

export interface StreamSheet {
  readonly name: string;
  readonly visibility: "visible" | "hidden" | "veryHidden";
}

export interface StreamTable {
  readonly name: string;
  readonly sheet: string;
  readonly reference: string;
  readonly headerRow: number;
  readonly totalsRow: boolean;
  readonly columns: readonly string[];
}

export interface StreamNamedRange {
  readonly name: string;
  readonly reference: string;
  readonly localSheetId?: number | undefined;
}

export interface WorkbookStreamInspection {
  readonly sheets: readonly StreamSheet[];
  readonly tables: readonly StreamTable[];
  readonly namedRanges: readonly StreamNamedRange[];
}

export interface StreamColumn {
  readonly name: string;
  /** Zero-based worksheet column index. */
  readonly column: number;
}

export interface StreamRegion {
  readonly sheet: string;
  readonly origin:
    | { readonly kind: "table"; readonly tableName: string }
    | { readonly kind: "named-range"; readonly rangeName: string }
    | { readonly kind: "explicit-range"; readonly reference: string }
    | { readonly kind: "declared-header" };
  readonly headerRow: number;
  readonly firstRow: number;
  readonly lastRow: number;
  readonly startColumn: number;
  readonly endColumn: number;
  readonly columns: readonly StreamColumn[];
}

export type StreamScalarCell =
  | { readonly kind: "blank" }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly raw: string }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "date"; readonly raw: string; readonly iso: string }
  | { readonly kind: "error"; readonly error: string };

export type StreamCell =
  | StreamScalarCell
  | {
      readonly kind: "formula";
      readonly formula?: string | undefined;
      readonly cached: StreamScalarCell | { readonly kind: "missing" };
    };

export interface StreamRow {
  readonly sourceRow: number;
  readonly cells: Readonly<Record<string, StreamCell>>;
}

export interface WorkbookRegionReader {
  readonly region: StreamRegion;
  batches(options: {
    readonly batchSize: number;
    readonly signal?: AbortSignal | undefined;
    readonly onProgress?: ProgressReporter | undefined;
  }): AsyncIterable<readonly StreamRow[]>;
  close(): Promise<void>;
}

export interface WorkbookStream {
  readonly inspection: WorkbookStreamInspection;
  openRegion(selection: WorkbookSelection): Promise<WorkbookRegionReader>;
  close(): Promise<void>;
}
