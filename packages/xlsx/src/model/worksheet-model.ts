/**
 * L1 - the worksheet document model.
 *
 * A worksheet part is parsed into rows and cells, plus the dependent
 * structures that describe them: merged ranges, conditional formatting, data
 * validation, hyperlinks and the sheet autoFilter. Every row edit goes through
 * `applyRowRelocation`, which updates all of them in a single pass. There is
 * no way to move a row that skips part of that pass, so "rows renumbered but
 * conditional formatting forgotten" is unrepresentable.
 *
 * Structure is parsed for decisions; the source text of each element is kept
 * for serialization, so an element no edit reached round-trips byte-identical.
 */
import {
  decodeXmlText,
  editElements,
  findElement,
  findElements,
  getAttribute,
  hasCachedValueElement,
  parseAttributes,
  setAttribute,
  writeAttribute,
} from "./xml.js";
import { worksheetDateValue } from "./calendar.js";
import {
  decodeCell,
  encodeCell,
  relocateFormulaRows,
  relocateReference,
  relocateSqref,
  RowRelocation,
  DELETED_REFERENCE,
} from "./references.js";
import type {
  CellFormula,
  CellModel,
  CellRange,
  CellRef,
  CellValue,
  DeleteRowsReport,
  FormulaKind,
  RelocateRowsOptions,
  RowModel,
  RowNumber,
  SheetInfo,
  WorksheetModel as WorksheetModelContract,
} from "./types.js";

/** Counters for the structures one relocation pass adjusted. */
export interface RelocationCounters {
  mergedRanges: number;
  conditionalFormatting: number;
  dataValidations: number;
  hyperlinks: number;
  formulaReferences: number;
  tableRefs: number;
  calcChainEntries: number;
  /**
   * Calculation-chain entries dropped outright, a subset of
   * `calcChainEntries`. The split reports removals and renumberings under
   * different metric names, so the pass counts them separately.
   */
  calcChainEntriesRemoved: number;
  /** `<dimension ref>` declarations rewritten to the surviving extent. */
  dimensions: number;
  /**
   * Comment anchors moved: `<comment ref>` in the comments part and the
   * zero-based `<x:Row>` in its legacy VML drawing. The frozen
   * `DeleteRowsReport.adjusted` has no field for these, so the count stays
   * internal until the seam gains one.
   */
  comments: number;
}

export function emptyCounters(): RelocationCounters {
  return {
    mergedRanges: 0,
    conditionalFormatting: 0,
    dataValidations: 0,
    hyperlinks: 0,
    formulaReferences: 0,
    tableRefs: 0,
    calcChainEntries: 0,
    calcChainEntriesRemoved: 0,
    dimensions: 0,
    comments: 0,
  };
}

/** A cell value in the shapes a grouping key can be built from. */
export type WorksheetCellValue = CellValue;

/**
 * What a worksheet needs from its workbook: the parts that live above the
 * worksheet but describe its rows and resolve its cell values.
 */
export interface WorksheetHost {
  /**
   * Resize the Excel Tables anchored on this worksheet. `resizeTables` is
   * false for the one binding that deliberately leaves a table claiming its
   * original range.
   */
  relocateTables(
    sheetName: string,
    relocation: RowRelocation,
    counters: RelocationCounters,
    resizeTables: boolean,
  ): void;
  /** Drop and renumber this worksheet's calculation-chain entries. */
  relocateCalcChain(
    sheetName: string,
    relocation: RowRelocation,
    counters: RelocationCounters,
  ): void;
  /** Move this worksheet's cell-comment anchors and their VML shapes. */
  relocateComments(
    sheetName: string,
    relocation: RowRelocation,
    counters: RelocationCounters,
  ): void;
  /** Record that this worksheet's part must be written back. */
  markWorksheetChanged(sheetName: string): void;
  /** Resolve a `t="s"` cell's shared-string index to its text. */
  sharedString(index: number): string | undefined;
  /** Whether a cell style formats its number as a date. */
  isDateStyle(styleIndex: number | undefined): boolean;
  /** Convert an Excel date serial to a `Date` in the workbook's date system. */
  /** The moment a serial names, or undefined when it names none. */
  serialToDate(serial: number): Date | undefined;
}

interface CellSegment {
  cell: WorksheetCell | undefined;
  text: string;
}

interface RowSegment {
  row: WorksheetRow | undefined;
  text: string;
}

/** One `<c>` element: parsed reference and formula, plus its source text. */
export class WorksheetCell {
  reference: string;
  readonly column: number;
  row: number;
  openTag: string;
  readonly selfClosing: boolean;
  body: string;
  readonly closeTag: string;

  /**
   * @param impliedColumn Where document order puts this cell when it carries no
   *   reference of its own: the previous cell's column plus one, or A for the
   *   first cell of a row.
   * @param impliedRow The row this cell was found in, for the same case.
   */
  constructor(text: string, impliedColumn: number, impliedRow: number) {
    const element = findElement(text, "c");
    if (!element) {
      throw new Error("Encountered an invalid worksheet cell element.");
    }
    const written = getAttribute(element.openTag, "r");
    // The reference is optional in the format: a cell without one sits where
    // document order puts it. A reference that is present but unreadable is a
    // different thing, and stays an error.
    const decoded = written === undefined ? undefined : decodeCell(written);
    if (written !== undefined && !decoded) {
      throw new Error(`Encountered an invalid cell reference: ${written}`);
    }
    const reference = written ?? encodeCell(impliedColumn, impliedRow);

    this.reference = reference;
    this.column = decoded?.column ?? impliedColumn;
    this.row = decoded?.row ?? impliedRow;
    // Written back explicitly rather than left implicit. An implicit position
    // is only meaningful in the document it was read from: once a later edit
    // adds or removes a row or a cell before it, the same bytes mean a
    // different cell. Making it explicit here costs the exact bytes of a
    // worksheet that omitted an optional attribute, and buys every consumer,
    // including the ones that renumber rows, a position that cannot shift.
    this.openTag =
      written === undefined
        ? writeAttribute(element.openTag, "r", reference)
        : element.openTag;
    this.selfClosing = element.selfClosing;
    this.body = element.selfClosing
      ? ""
      : text.slice(
          element.innerStart - element.start,
          element.innerEnd - element.start,
        );
    this.closeTag = element.selfClosing ? "" : `</${element.name}>`;
  }

  /** The cached value text, from `<v>` or an inline `<is><t>`. */
  get valueText(): string | undefined {
    const value = findElement(this.body, "v");
    if (value && !value.selfClosing) {
      return this.body.slice(value.innerStart, value.innerEnd);
    }
    const inline = findElement(this.body, "is");
    if (!inline || inline.selfClosing) {
      return undefined;
    }
    const runs = findElements(
      this.body,
      "t",
      inline.innerStart,
      inline.innerEnd,
    );
    return runs.length === 0
      ? undefined
      : runs
          .map((run) =>
            run.selfClosing
              ? ""
              : this.body.slice(run.innerStart, run.innerEnd),
          )
          .join("");
  }

  /**
   * Whether a cached value element is present, whatever it holds. `valueText`
   * cannot answer this: it returns `""` for `<v></v>` and `undefined` for a
   * self-closing `<v/>`, so neither an empty result nor an absent one can be
   * told from the other by looking at the text.
   */
  get hasCachedValue(): boolean {
    return hasCachedValueElement(this.body);
  }

  get formula(): CellFormula | undefined {
    const element = findElement(this.body, "f");
    if (!element) {
      return undefined;
    }
    const declared = getAttribute(element.openTag, "t");
    const kind: FormulaKind =
      declared === "shared" || declared === "array" ? declared : "normal";
    const span = getAttribute(element.openTag, "ref");
    const sharedIndex = getAttribute(element.openTag, "si");

    return {
      kind,
      text: element.selfClosing
        ? ""
        : this.body.slice(element.innerStart, element.innerEnd),
      range: span === undefined ? undefined : decodeRange(span),
      sharedIndex: sharedIndex === undefined ? undefined : Number(sharedIndex),
    };
  }

  /** The parsed, read-only view this cell presents to the layer above. */
  toCellModel(): CellModel {
    const styleIndex = getAttribute(this.openTag, "s");
    return {
      ref: { row: this.row, column: this.column },
      type: getAttribute(this.openTag, "t"),
      styleIndex: styleIndex === undefined ? undefined : Number(styleIndex),
      value: this.valueText,
      formula: this.formula,
      hasCachedValue: this.hasCachedValue,
    };
  }

  /** Move the cell to a new row, keeping its column and every attribute. */
  moveToRow(row: number): void {
    if (row === this.row) {
      return;
    }
    this.row = row;
    this.reference = encodeCell(this.column, row);
    this.openTag = writeAttribute(this.openTag, "r", this.reference);
  }

  /**
   * Rewrite this cell's formula for a row relocation: the A1 references in its
   * text, and the `ref` span a shared or array formula claims.
   */
  relocateFormula(relocation: RowRelocation): number {
    if (this.selfClosing || !this.body.includes("<")) {
      return 0;
    }
    let adjusted = 0;
    this.body = editElements(this.body, "f", (element, text) => {
      let openTag = element.openTag;
      const span = getAttribute(openTag, "ref");
      if (span !== undefined) {
        openTag = setAttribute(
          openTag,
          "ref",
          relocateReference(span, relocation),
        );
      }
      if (element.selfClosing) {
        if (openTag !== element.openTag) {
          adjusted += 1;
        }
        return openTag;
      }
      const inner = text.slice(
        element.innerStart - element.start,
        element.innerEnd - element.start,
      );
      const relocated = relocateFormulaRows(inner, relocation);
      if (relocated !== inner || openTag !== element.openTag) {
        adjusted += 1;
      }
      return `${openTag}${relocated}${text.slice(
        element.innerEnd - element.start,
      )}`;
    });
    return adjusted;
  }

  toXml(): string {
    return `${this.openTag}${this.body}${this.closeTag}`;
  }
}

/** One `<row>` element and the cells inside it. */
export class WorksheetRow {
  number: number;
  openTag: string;
  readonly selfClosing: boolean;
  readonly closeTag: string;
  readonly segments: CellSegment[];
  #cellIndex: Map<number, WorksheetCell> | undefined;

  /**
   * @param impliedNumber The row number document order gives this row when it
   *   carries none of its own: the previous row's number plus one, or 1 for the
   *   first row of the sheet.
   */
  constructor(text: string, impliedNumber: number) {
    const element = findElement(text, "row");
    if (!element) {
      throw new Error("Encountered an invalid worksheet row element.");
    }
    // The row number is optional in the format, the same way a cell reference
    // is. A number that is present but not a positive whole one is malformed
    // and stays an error.
    const written = getAttribute(element.openTag, "r");
    const number = written === undefined ? impliedNumber : Number(written);
    if (!Number.isInteger(number) || number < 1) {
      throw new Error(
        `Encountered a worksheet row with an invalid row number: ${String(written)}`,
      );
    }

    this.number = number;
    // Made explicit for the reason the cell above gives: an implicit number
    // moves when the rows before it do.
    this.openTag =
      written === undefined
        ? writeAttribute(element.openTag, "r", String(number))
        : element.openTag;
    this.selfClosing = element.selfClosing;
    this.closeTag = element.selfClosing ? "" : `</${element.name}>`;
    this.segments = element.selfClosing
      ? []
      : splitCells(
          number,
          text.slice(
            element.innerStart - element.start,
            element.innerEnd - element.start,
          ),
        );
  }

  get cells(): WorksheetCell[] {
    return this.segments
      .map((segment) => segment.cell)
      .filter((cell) => cell !== undefined);
  }

  /**
   * Column-keyed cells, built once. A row's cell membership is fixed at
   * construction - `segments` is never reassigned, and a row relocation moves
   * the row rather than adding or removing cells - so this never needs
   * invalidating.
   */
  get #cellsByColumn(): Map<number, WorksheetCell> {
    this.#cellIndex ??= new Map(this.cells.map((cell) => [cell.column, cell]));
    return this.#cellIndex;
  }

  cellAt(column: number): WorksheetCell | undefined {
    return this.#cellsByColumn.get(column);
  }

  /** The parsed, read-only view this row presents to the layer above. */
  toRowModel(): RowModel {
    const attributes: Record<string, string> = {};
    for (const attribute of parseAttributes(this.openTag)) {
      if (attribute.localName !== "r") {
        attributes[attribute.name] = attribute.value;
      }
    }
    return {
      number: this.number,
      cells: this.cells.map((cell) => cell.toCellModel()),
      attributes,
    };
  }

  /** Rewrite every formula in the row for a relocation, before it moves. */
  relocateFormulas(relocation: RowRelocation): number {
    return this.cells.reduce(
      (adjusted, cell) => adjusted + cell.relocateFormula(relocation),
      0,
    );
  }

  /** Move the row and every cell in it to a new row number. */
  moveTo(number: number): void {
    if (number === this.number) {
      return;
    }
    this.number = number;
    this.openTag = writeAttribute(this.openTag, "r", String(number));
    for (const cell of this.cells) {
      cell.moveToRow(number);
    }
  }

  toXml(): string {
    const inner = this.segments
      .map((segment) => segment.cell?.toXml() ?? segment.text)
      .join("");
    return `${this.openTag}${inner}${this.closeTag}`;
  }
}

function splitCells(rowNumber: number, inner: string): CellSegment[] {
  const segments: CellSegment[] = [];
  let cursor = 0;
  // Where the next cell sits if it does not say: the first column, then one
  // past whatever the last cell turned out to occupy.
  let impliedColumn = 0;

  for (const element of findElements(inner, "c")) {
    if (element.start > cursor) {
      segments.push({
        cell: undefined,
        text: inner.slice(cursor, element.start),
      });
    }
    const cell = new WorksheetCell(
      inner.slice(element.start, element.end),
      impliedColumn,
      rowNumber,
    );
    impliedColumn = cell.column + 1;
    segments.push({ cell, text: "" });
    cursor = element.end;
  }
  if (cursor < inner.length) {
    segments.push({ cell: undefined, text: inner.slice(cursor) });
  }

  return segments;
}

function decodeRange(reference: string): CellRange | undefined {
  const [start, end] = reference.split(":");
  const first = decodeCell((start ?? "").replace(/\$/gu, ""));
  if (!first) {
    return undefined;
  }
  const last = decodeCell((end ?? start ?? "").replace(/\$/gu, "")) ?? first;
  return {
    start: { row: first.row, column: first.column },
    end: { row: last.row, column: last.column },
  };
}

export class WorksheetModel implements WorksheetModelContract {
  readonly info: SheetInfo;
  readonly #host: WorksheetHost;
  /** Everything up to and including the `<sheetData>` opening tag. */
  #prefix: string;
  /** Everything from the `</sheetData>` closing tag onward. */
  #suffix: string;
  #segments: RowSegment[];
  #rowIndex: Map<RowNumber, WorksheetRow> | undefined;
  #changed = false;

  private constructor(
    info: SheetInfo,
    host: WorksheetHost,
    prefix: string,
    segments: RowSegment[],
    suffix: string,
  ) {
    this.info = info;
    this.#host = host;
    this.#prefix = prefix;
    this.#segments = segments;
    this.#suffix = suffix;
  }

  static parse(
    worksheetXml: string,
    info: SheetInfo,
    host: WorksheetHost,
  ): WorksheetModel {
    const sheetData = findElement(worksheetXml, "sheetData");
    if (!sheetData) {
      throw new Error("Worksheet package part does not contain sheetData.");
    }
    if (sheetData.selfClosing) {
      return new WorksheetModel(
        info,
        host,
        worksheetXml.slice(0, sheetData.end),
        [],
        worksheetXml.slice(sheetData.end),
      );
    }

    const inner = worksheetXml.slice(sheetData.innerStart, sheetData.innerEnd);
    const segments: RowSegment[] = [];
    let cursor = 0;
    // Where the next row sits if it does not say: the first row, then one past
    // whatever the last row turned out to be.
    let impliedRowNumber = 1;
    for (const element of findElements(inner, "row")) {
      if (element.start > cursor) {
        segments.push({
          row: undefined,
          text: inner.slice(cursor, element.start),
        });
      }
      const row = new WorksheetRow(
        inner.slice(element.start, element.end),
        impliedRowNumber,
      );
      impliedRowNumber = row.number + 1;
      segments.push({ row, text: "" });
      cursor = element.end;
    }
    if (cursor < inner.length) {
      segments.push({ row: undefined, text: inner.slice(cursor) });
    }

    return new WorksheetModel(
      info,
      host,
      worksheetXml.slice(0, sheetData.innerStart),
      segments,
      worksheetXml.slice(sheetData.innerEnd),
    );
  }

  // -- The L1 worksheet seam ----------------------------------------------

  rows(): readonly RowModel[] {
    return this.#rows.map((row) => row.toRowModel());
  }

  row(number: RowNumber): RowModel | undefined {
    return this.#rows.find((row) => row.number === number)?.toRowModel();
  }

  /**
   * A cell's text as a person reads it: a shared-string cell resolves through
   * the string table rather than handing back its index. Header matching and
   * value normalization both depend on this being the display text.
   */
  cellText(ref: CellRef): string | undefined {
    const cell = this.#cellAt(ref);
    const raw = cell?.valueText;
    if (!cell || raw === undefined) {
      return undefined;
    }
    if (getAttribute(cell.openTag, "t") !== "s") {
      return decodeXmlText(raw);
    }
    const index = Number(raw);
    return Number.isInteger(index)
      ? this.#host.sharedString(index)
      : decodeXmlText(raw);
  }

  /**
   * A cell's value, typed the way a grouping key needs it. A number whose
   * style formats it as a date comes back as a `Date`; everything else keeps
   * the type the OOXML cell declares.
   */
  cellValue(ref: CellRef): WorksheetCellValue {
    const cell = this.#cellAt(ref);
    const text = this.cellText(ref);
    if (!cell || text === undefined) {
      return undefined;
    }

    switch (getAttribute(cell.openTag, "t")) {
      case "b":
        return text.trim() === "1" || text.trim().toLowerCase() === "true";
      case "d":
        // Blank first, the same rule the numeric branch below applies: a cell
        // holding nothing, or nothing but spaces, holds no value at all. This
        // branch used to skip it and hand back the empty text, which is a
        // value, so an empty declared date above a worksheet's real header
        // counted as content and the header row was found one row too early.
        return text.trim() === ""
          ? undefined
          : (worksheetDateValue(text) ?? text);
      case "s":
      case "str":
      case "inlineStr":
      case "e":
        return text;
      default: {
        const trimmed = text.trim();
        if (trimmed === "") {
          return undefined;
        }
        const numeric = Number(trimmed);
        if (!Number.isFinite(numeric)) {
          return trimmed;
        }
        const styleIndex = getAttribute(cell.openTag, "s");
        if (
          !this.#host.isDateStyle(
            styleIndex === undefined ? undefined : Number(styleIndex),
          )
        ) {
          return numeric;
        }
        // A serial that names no moment that can be written is carried as the
        // number it is, the same decision the text path makes for text that
        // names none. Handing back a moment nothing could spell is how a cell
        // holding 1e100 came to be keyed by the same characters as every other
        // one, and a split gathered them into a single output.
        return this.#host.serialToDate(numeric) ?? numeric;
      }
    }
  }

  /**
   * Row-number-keyed rows, built once per structural state.
   *
   * `#rows` rebuilds an array from `#segments` on every access, so finding a
   * row by number used to cost a full pass over the sheet - which made reading
   * an R-row sheet cell by cell quadratic in R. Row numbers change when rows
   * relocate, so `applyRowRelocation` clears this.
   */
  get #rowsByNumber(): Map<RowNumber, WorksheetRow> {
    this.#rowIndex ??= new Map(this.#rows.map((row) => [row.number, row]));
    return this.#rowIndex;
  }

  #rowAt(number: RowNumber): WorksheetRow | undefined {
    return this.#rowsByNumber.get(number);
  }

  #cellAt(ref: CellRef): WorksheetCell | undefined {
    return this.#rowAt(ref.row)?.cellAt(ref.column);
  }

  /** The `<dimension>` the part declares, or the extent of its cells. */
  get usedRange(): CellRange | undefined {
    const dimension = findElement(this.#prefix, "dimension");
    const declared = dimension
      ? getAttribute(dimension.openTag, "ref")
      : undefined;
    if (declared !== undefined) {
      const decoded = decodeRange(declared);
      if (decoded) {
        return decoded;
      }
    }

    const cells = this.#rows.flatMap((row) => row.cells);
    if (cells.length === 0) {
      return undefined;
    }
    return {
      start: {
        row: Math.min(...cells.map((cell) => cell.row)),
        column: Math.min(...cells.map((cell) => cell.column)),
      },
      end: {
        row: Math.max(...cells.map((cell) => cell.row)),
        column: Math.max(...cells.map((cell) => cell.column)),
      },
    };
  }

  /**
   * Delete rows and maintain every row-dependent invariant in one pass. See
   * `applyRowRelocation` for the list; this entry point only decides where the
   * survivors land.
   */
  deleteRows(
    rows: ReadonlySet<RowNumber>,
    options: { readonly renumber: boolean },
  ): DeleteRowsReport {
    const lastRow = Math.max(this.lastRow, ...rows, 0);
    const present = this.#rows.filter((row) => rows.has(row.number)).length;
    const report = this.applyRowRelocation(
      RowRelocation.compacting(rows, lastRow, options.renumber),
    );
    return { ...report, deletedRows: present };
  }

  // -- Extensions the seam does not cover ----------------------------------

  /** The highest row number present in the sheet, or 0 when it has none. */
  get lastRow(): number {
    return this.#rows.reduce((last, row) => Math.max(last, row.number), 0);
  }

  /** Whether any edit has been applied since the part was parsed. */
  get changed(): boolean {
    return this.#changed;
  }

  get #rows(): WorksheetRow[] {
    return this.#segments
      .map((segment) => segment.row)
      .filter((row) => row !== undefined);
  }

  /**
   * Apply a row relocation to every structure that depends on row numbers.
   *
   * This is the invariant pass. Adding a new row-dependent structure means
   * adding a step here, which is the one place a reviewer has to look:
   *
   *  1. `<row r>` numbers and the `r` of every cell inside them.
   *  2. Formula text and shared/array formula `ref` spans.
   *  3. `mergeCells` entries, with the container's count.
   *  4. `conditionalFormatting/@sqref`.
   *  5. `dataValidation/@sqref`, with the container's count.
   *  6. `hyperlink/@ref`.
   *  7. The sheet-level `autoFilter/@ref`.
   *  8. The declared `dimension/@ref`, so the sheet does not advertise an
   *     extent that reaches past its last surviving row.
   *  9. Excel Table `ref` and the table's own `autoFilter`.
   * 10. Calculation-chain entries for this worksheet.
   *
   * Anything left describing only deleted rows is removed rather than kept
   * pointing at a row that no longer exists.
   */
  applyRowRelocation(
    relocation: RowRelocation,
    options: RelocateRowsOptions | undefined = undefined,
  ): DeleteRowsReport {
    this.#changed = true;
    // Row numbers are about to move; the number-keyed index cannot survive it.
    this.#rowIndex = undefined;
    this.#host.markWorksheetChanged(this.info.name);
    const counters = emptyCounters();

    // 1. Rows, and the cell references inside them. Destinations are resolved
    //    before anything moves, so no row is read after it was rewritten.
    const surviving: RowSegment[] = [];
    const destinations: Array<[WorksheetRow, number]> = [];
    let deletedRows = 0;
    for (const segment of this.#segments) {
      if (!segment.row) {
        surviving.push(segment);
        continue;
      }
      const destination = relocation.target(segment.row.number);
      if (destination === null) {
        deletedRows += 1;
        continue;
      }
      surviving.push(segment);
      destinations.push([segment.row, destination]);
    }
    assertAscending(destinations);

    for (const [row, destination] of destinations) {
      // 2. Formula text, rewritten before the row moves, because the formula
      //    describes the geometry it was written against.
      counters.formulaReferences += row.relocateFormulas(relocation);
      row.moveTo(destination);
    }
    this.#segments = surviving;
    this.#rowIndex = undefined;

    // 3-8. Merged ranges, conditional formatting, data validation, hyperlinks,
    //      the sheet autoFilter and the declared dimension all live outside
    //      sheetData.
    this.#suffix = relocateDependentStructures(
      this.#suffix,
      relocation,
      counters,
    );
    this.#prefix = relocateDependentStructures(
      this.#prefix,
      relocation,
      counters,
    );

    // 8-10. Parts above the worksheet that still describe its rows.
    this.#host.relocateTables(
      this.info.name,
      relocation,
      counters,
      options?.resizeTables !== false,
    );
    this.#host.relocateCalcChain(this.info.name, relocation, counters);
    this.#host.relocateComments(this.info.name, relocation, counters);

    return {
      deletedRows,
      retainedRows: destinations.length,
      // The seam fixes this shape, so it is built field by field rather than
      // handing over the internal counters wholesale.
      adjusted: {
        mergedRanges: counters.mergedRanges,
        conditionalFormatting: counters.conditionalFormatting,
        dataValidations: counters.dataValidations,
        hyperlinks: counters.hyperlinks,
        formulaReferences: counters.formulaReferences,
        tableRefs: counters.tableRefs,
        calcChainEntries: counters.calcChainEntries,
      },
    };
  }

  toXml(): string {
    const inner = this.#segments
      .map((segment) => segment.row?.toXml() ?? segment.text)
      .join("");
    return `${this.#prefix}${inner}${this.#suffix}`;
  }
}

/**
 * A relocation must keep surviving rows in their original order; otherwise the
 * rewritten sheetData would list rows out of sequence, which Excel rejects.
 */
function assertAscending(destinations: Array<[WorksheetRow, number]>): void {
  let previous = 0;
  for (const [, destination] of destinations) {
    if (destination <= previous) {
      throw new Error(
        "A row relocation would reorder worksheet rows; relocations must preserve row order.",
      );
    }
    previous = destination;
  }
}

/**
 * Relocate every row-dependent structure outside `sheetData`. Each structure
 * is located as an element and edited on its own attributes; nothing here is a
 * pattern applied blindly to the whole part, so `dimension`, styles, column
 * widths and unrelated markup are untouched.
 */
function relocateDependentStructures(
  xml: string,
  relocation: RowRelocation,
  counters: RelocationCounters,
): string {
  let result = relocateCountedList(
    xml,
    "mergeCells",
    "mergeCell",
    (openTag) => {
      const relocated = relocateRefAttribute(openTag, relocation);
      if (relocated !== openTag) {
        counters.mergedRanges += 1;
      }
      return relocated;
    },
  );

  result = editElements(result, "conditionalFormatting", (element, text) => {
    const sqref = getAttribute(element.openTag, "sqref");
    if (sqref === undefined) {
      return text;
    }
    const relocated = relocateSqref(sqref, relocation);
    if (relocated === undefined) {
      counters.conditionalFormatting += 1;
      return undefined;
    }
    if (relocated !== sqref) {
      counters.conditionalFormatting += 1;
    }
    return `${setAttribute(element.openTag, "sqref", relocated)}${text.slice(
      element.openTag.length,
    )}`;
  });

  result = relocateCountedList(
    result,
    "dataValidations",
    "dataValidation",
    (openTag) => {
      const sqref = getAttribute(openTag, "sqref");
      if (sqref === undefined) {
        return openTag;
      }
      const relocated = relocateSqref(sqref, relocation);
      if (relocated === undefined || relocated !== sqref) {
        counters.dataValidations += 1;
      }
      return relocated === undefined
        ? undefined
        : setAttribute(openTag, "sqref", relocated);
    },
  );

  result = relocateCountedList(result, "hyperlinks", "hyperlink", (openTag) => {
    const relocated = relocateRefAttribute(openTag, relocation);
    if (relocated !== openTag) {
      counters.hyperlinks += 1;
    }
    return relocated;
  });

  result = editElements(result, "autoFilter", (element, text) => {
    const relocated = relocateRefAttribute(element.openTag, relocation);
    return relocated === undefined
      ? undefined
      : `${relocated}${text.slice(element.openTag.length)}`;
  });

  // The declared extent is metadata, not content: it is rewritten to the span
  // its rows now occupy, and never removed. A sheet whose every listed row
  // disappeared keeps the declaration it arrived with rather than gaining a
  // `#REF!` where a range belongs.
  result = editElements(result, "dimension", (element, text) => {
    const reference = getAttribute(element.openTag, "ref");
    if (reference === undefined) {
      return text;
    }
    const relocated = relocateReference(reference, relocation);
    if (relocated === reference || relocated.includes(DELETED_REFERENCE)) {
      return text;
    }
    counters.dimensions += 1;
    return `${setAttribute(element.openTag, "ref", relocated)}${text.slice(
      element.openTag.length,
    )}`;
  });

  return result;
}

/** Relocate a `ref` attribute, dropping the element when nothing survives. */
function relocateRefAttribute(
  openTag: string,
  relocation: RowRelocation,
): string | undefined {
  const reference = getAttribute(openTag, "ref");
  if (reference === undefined) {
    return openTag;
  }
  const relocated = relocateReference(reference, relocation);
  return relocated.includes(DELETED_REFERENCE)
    ? undefined
    : setAttribute(openTag, "ref", relocated);
}

/**
 * Rewrite the children of a container that carries a `count` attribute,
 * keeping the count honest and removing the container when it empties.
 */
function relocateCountedList(
  xml: string,
  containerName: string,
  childName: string,
  edit: (openTag: string) => string | undefined,
): string {
  return editElements(xml, containerName, (container, containerText) => {
    let kept = 0;
    const inner = containerText.slice(
      container.innerStart - container.start,
      container.innerEnd - container.start,
    );
    const rewritten = editElements(inner, childName, (child, childText) => {
      const openTag = edit(child.openTag);
      if (openTag === undefined) {
        return undefined;
      }
      kept += 1;
      return `${openTag}${childText.slice(child.openTag.length)}`;
    });

    if (kept === 0) {
      return undefined;
    }
    const openTag =
      getAttribute(container.openTag, "count") === undefined
        ? container.openTag
        : setAttribute(container.openTag, "count", String(kept));
    return `${openTag}${rewritten}${containerText.slice(
      container.innerEnd - container.start,
    )}`;
  });
}
