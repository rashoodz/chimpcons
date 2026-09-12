/**
 * Test fixtures and shared locators for the in-browser tool suite.
 *
 * PDFs are generated in-process with pdf-lib, and workbooks and presentations
 * are assembled with jszip, so nothing binary is checked in and no temporary
 * files are left behind. All three are handed to the pages as in-memory
 * uploads.
 *
 * Pages are addressed through the `data-testid` attributes the tool shell
 * renders rather than through heading text, so wording changes do not break
 * the suite. `e2e/README.md` lists the identifiers.
 */
import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import JSZip from "jszip";
import { readFile } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";

const WORKBOOK_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * The media type a browser reports for a macro-enabled workbook. It is the
 * registered spelling, mixed case and all; a browser lower-cases it before a
 * page ever sees it, which is exactly what the pages' predicate has to cope
 * with.
 */
const MACRO_WORKBOOK_MEDIA_TYPE =
  "application/vnd.ms-excel.sheet.macroEnabled.12";

/** Content type of the main workbook part in an ordinary `.xlsx` package. */
const WORKBOOK_MAIN_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";

/** Content type of the main workbook part in a macro-enabled `.xlsm` package. */
const MACRO_WORKBOOK_MAIN_CONTENT_TYPE =
  "application/vnd.ms-excel.sheet.macroEnabled.main+xml";

/** The opaque VBA project part a macro-enabled workbook carries. */
export const VBA_PROJECT_PART = "xl/vbaProject.bin";

const PRESENTATION_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** An in-memory upload in the shape Playwright's setInputFiles accepts. */
export interface UploadFile {
  readonly name: string;
  readonly mimeType: string;
  readonly buffer: Buffer;
}

/** An Excel Table anchored on a worksheet, declared by its own package part. */
export interface ExcelTableFixture {
  /** The column names the table part declares, in table order. */
  readonly columns: readonly string[];
  readonly name: string;
  /** The A1 range the table covers, header row included. */
  readonly ref: string;
}

/**
 * A cell holding a formula that the workbook carries no calculated value for,
 * which is what a generator writes when it has no calculation engine. Excel
 * would write the formula and its last result side by side; here the result
 * exists nowhere in the file, so every reader sees an empty cell.
 */
export interface UncalculatedFormulaCell {
  readonly formula: string;
}

/** A formula and its last numeric result, both stored as workbook text. */
export interface CachedNumberFormulaCell {
  readonly formula: string;
  readonly cachedNumber: string;
}

/** A numeric cell whose source spelling must not pass through JavaScript number. */
export interface ExactNumberCell {
  readonly numericText: string;
}

/**
 * A cell holding an error value: `#REF!`, `#DIV/0!` and their kind, which the
 * format stores as `t="e"`. A reader built on a spreadsheet engine sees the
 * internal code Excel numbers the error by, not the text the cell shows, so
 * such a cell arrives as an ordinary-looking number.
 */
export interface ErrorValueCell {
  /** The error as the cell shows it, such as `#REF!`. */
  readonly error: string;
}

/**
 * A cell holding a date the way Excel holds one: a count of days from the
 * workbook's epoch, wearing a date number format. The number alone says
 * nothing, so the format is what makes it a date; the styles part below
 * declares the one format these fixtures use.
 */
export interface DateSerialCell {
  /** Days from 30 December 1899, which is serial 45292 for 1 January 2024. */
  readonly serial: number;
}

/**
 * A cell that declares itself a date and writes ISO 8601 text, which the format
 * allows and Excel opens. It wears no number format, so the only thing saying
 * it is a date is the declaration.
 */
export interface DeclaredDateCell {
  /** ISO 8601, as the format writes it: a date, or a date and a time. */
  readonly date: string;
}

/** One cell of a worksheet fixture. */
export type WorksheetCellFixture =
  | number
  | string
  | UncalculatedFormulaCell
  | CachedNumberFormulaCell
  | ExactNumberCell
  | ErrorValueCell
  | DateSerialCell
  | DeclaredDateCell;

/** One worksheet: a name and its rows, top-left aligned at A1. */
export interface WorksheetFixture {
  readonly name: string;
  readonly rows: ReadonlyArray<ReadonlyArray<WorksheetCellFixture>>;
  /**
   * How Excel presents the tab. Absent means visible. `veryHidden` is the
   * state only the VBA editor can reverse, which the workbook part spells
   * exactly this way.
   */
  readonly state?: "hidden" | "veryHidden";
  /** An Excel Table anchored on this worksheet, if it declares one. */
  readonly table?: ExcelTableFixture;
}

/** One workbook-level defined name, as the workbook part stores it. */
export interface DefinedNameFixture {
  readonly name: string;
  /** The reference, sheet-qualified: `'Review Log'!$A$1:$C$4`. */
  readonly reference: string;
}

/**
 * Builds the smallest useful PDF: `pageCount` blank Letter pages, no fonts
 * and no content streams, which keeps every fixture under a kilobyte.
 */
export async function createPdfUpload(
  name: string,
  pageCount: number,
): Promise<UploadFile> {
  const document = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) {
    document.addPage([612, 792]);
  }
  return {
    name,
    mimeType: "application/pdf",
    buffer: Buffer.from(await document.save()),
  };
}

const XML_ESCAPES: Record<string, string> = {
  '"': "&quot;",
  "&": "&amp;",
  "'": "&apos;",
  "<": "&lt;",
  ">": "&gt;",
};

function escapeXml(value: string): string {
  return value.replaceAll(/["&'<>]/gu, (character) => XML_ESCAPES[character]!);
}

/** Spreadsheet column letters for the fixture widths this suite uses. */
function columnLetter(index: number): string {
  let remaining = index;
  let letters = "";
  do {
    letters = String.fromCodePoint(65 + (remaining % 26)) + letters;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return letters;
}

/** Content type of an Excel Table part. */
const TABLE_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml";

/** The relationship a worksheet uses to point at its Excel Table part. */
const TABLE_RELATIONSHIP_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/table";

function tableXml(table: ExcelTableFixture, id: number): string {
  const columns = table.columns
    .map(
      (name, index) =>
        `<tableColumn id="${index + 1}" name="${escapeXml(name)}"/>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="${id}" name="${escapeXml(table.name)}" displayName="${escapeXml(table.name)}" ref="${table.ref}" totalsRowCount="0"><autoFilter ref="${table.ref}"/><tableColumns count="${table.columns.length}">${columns}</tableColumns></table>`;
}

function worksheetXml(
  rows: WorksheetFixture["rows"],
  hasTable: boolean,
): string {
  const body = rows
    .map((cells, rowIndex) => {
      const reference = rowIndex + 1;
      const cellXml = cells
        .map((value, columnIndex) => {
          const address = `${columnLetter(columnIndex)}${reference}`;
          if (typeof value === "object") {
            if ("formula" in value) {
              const cached =
                "cachedNumber" in value
                  ? `<v>${escapeXml(value.cachedNumber)}</v>`
                  : "";
              return `<c r="${address}"><f>${escapeXml(value.formula)}</f>${cached}</c>`;
            }
            if ("error" in value) {
              return `<c r="${address}" t="e"><v>${escapeXml(value.error)}</v></c>`;
            }
            if ("date" in value) {
              return `<c r="${address}" t="d"><v>${escapeXml(value.date)}</v></c>`;
            }
            if ("numericText" in value) {
              return `<c r="${address}"><v>${escapeXml(value.numericText)}</v></c>`;
            }
            // Style 1 is the date format the styles part declares.
            return `<c r="${address}" s="1"><v>${value.serial}</v></c>`;
          }
          return typeof value === "number"
            ? `<c r="${address}"><v>${value}</v></c>`
            : `<c r="${address}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
        })
        .join("");
      return `<row r="${reference}">${cellXml}</row>`;
    })
    .join("");
  // The relationship namespace and the tableParts element travel together:
  // a worksheet declares its Excel Table by relationship id, and a package
  // reader finds the table part through that relationship, not by guessing.
  const namespaces = hasTable
    ? ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`
    : "";
  const tableParts = hasTable
    ? `<tableParts count="1"><tablePart r:id="rIdTable"/></tableParts>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"${namespaces}><sheetData>${body}</sheetData>${tableParts}</worksheet>`;
}

/** How a workbook fixture should differ from a plain `.xlsx` package. */
export interface WorkbookUploadOptions {
  /**
   * Workbook-level defined names, written into the workbook part verbatim.
   * A name beginning `_xlnm.` is one of Excel's own reserved names, which an
   * inspection deliberately leaves out of its named ranges.
   */
  readonly definedNames?: readonly DefinedNameFixture[];
  /**
   * Build a macro-enabled package: the main workbook part declares the
   * macro-enabled content type and a stub `xl/vbaProject.bin` travels with it.
   * The declared content type is the only thing the library reads to decide
   * what a package is, which is what lets a test name a package wrongly on
   * purpose.
   */
  readonly macroEnabled?: boolean;
  /**
   * Report this media type instead of the one the package declares. Used to
   * hand a page the mismatched name-and-bytes combination a real visitor
   * produces by renaming a file.
   */
  readonly mimeType?: string;
}

/**
 * Assembles a minimal but valid `.xlsx` package: one part per worksheet, cell
 * text stored inline so no shared-string table is needed. This is the smallest
 * thing the workbook reader accepts, which keeps every fixture a few hundred
 * bytes and every test fast.
 *
 * With `macroEnabled` it assembles the `.xlsm` equivalent instead, so the
 * macro-enabled path is exercised without a binary in the repository.
 */
export async function createWorkbookUpload(
  name: string,
  sheets: readonly WorksheetFixture[],
  options: WorkbookUploadOptions = {},
): Promise<UploadFile> {
  const archive = new JSZip();
  const macroEnabled = options.macroEnabled === true;

  const overrides = sheets
    .map(
      (sheet, index) =>
        `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
        (sheet.table
          ? `<Override PartName="/xl/tables/table${index + 1}.xml" ContentType="${TABLE_CONTENT_TYPE}"/>`
          : ""),
    )
    .join("");
  const vbaDefault = macroEnabled
    ? `<Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/>`
    : "";
  archive.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${vbaDefault}<Override PartName="/xl/workbook.xml" ContentType="${macroEnabled ? MACRO_WORKBOOK_MAIN_CONTENT_TYPE : WORKBOOK_MAIN_CONTENT_TYPE}"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${overrides}</Types>`,
  );

  archive.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );

  const sheetEntries = sheets
    .map(
      (sheet, index) =>
        `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"${
          sheet.state ? ` state="${sheet.state}"` : ""
        }/>`,
    )
    .join("");
  const definedNames = options.definedNames ?? [];
  const definedNameEntries =
    definedNames.length === 0
      ? ""
      : `<definedNames>${definedNames
          .map(
            (definedName) =>
              `<definedName name="${escapeXml(definedName.name)}">${escapeXml(
                definedName.reference,
              )}</definedName>`,
          )
          .join("")}</definedNames>`;
  archive.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetEntries}</sheets>${definedNameEntries}</workbook>`,
  );

  const macroRelationship = macroEnabled
    ? `<Relationship Id="rIdVba" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/>`
    : "";
  const relationships = sheets
    .map(
      (_sheet, index) =>
        `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
    )
    .join("");
  archive.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}${macroRelationship}<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  );

  // Two cell formats: 0 is General, and 1 is Excel's built-in date format 14.
  // A date-serial cell points at 1, which is the only thing that tells a reader
  // its number is a date rather than a quantity.
  archive.file(
    "xl/styles.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`,
  );

  for (const [index, sheet] of sheets.entries()) {
    archive.file(
      `xl/worksheets/sheet${index + 1}.xml`,
      worksheetXml(sheet.rows, sheet.table !== undefined),
    );
    if (sheet.table) {
      archive.file(
        `xl/worksheets/_rels/sheet${index + 1}.xml.rels`,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdTable" Type="${TABLE_RELATIONSHIP_TYPE}" Target="../tables/table${index + 1}.xml"/></Relationships>`,
      );
      archive.file(
        `xl/tables/table${index + 1}.xml`,
        tableXml(sheet.table, index + 1),
      );
    }
  }

  if (macroEnabled) {
    // The VBA project is opaque to every operation here, so a recognisable
    // stub is enough to prove the part travelled into the outputs.
    archive.file(
      VBA_PROJECT_PART,
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    );
  }

  return {
    name,
    mimeType:
      options.mimeType ??
      (macroEnabled ? MACRO_WORKBOOK_MEDIA_TYPE : WORKBOOK_MEDIA_TYPE),
    buffer: await archive.generateAsync({
      compression: "DEFLATE",
      type: "nodebuffer",
    }),
  };
}

function slideXml(runs: ReadonlyArray<string>): string {
  const shape = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Body"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p>${runs
    .map(
      (text) =>
        `<a:r><a:rPr lang="en-US"/><a:t xml:space="preserve">${escapeXml(text)}</a:t></a:r>`,
    )
    .join("")}</a:p></p:txBody></p:sp>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shape}</p:spTree></p:cSld></p:sld>`;
}

/**
 * Assembles a minimal but valid `.pptx` package: one text shape per slide,
 * whose single paragraph carries one `<a:r>` run per string given for that
 * slide. Splitting the placeholder text across runs the way PowerPoint does is
 * the point: the populate engine has to stitch runs back together before it
 * can see a `{{field}}`, so a checked-in deck would hide that behaviour behind
 * an opaque binary. Generating the package here keeps every fixture a few
 * hundred bytes, keeps the run layout visible in the test that depends on it,
 * and leaves nothing binary in the repository.
 *
 * Parts are written with `createFolders: false`, which is how PowerPoint
 * writes a package: entries for parts only, never for directories.
 */
export async function createPresentationUpload(
  name: string,
  slides: ReadonlyArray<ReadonlyArray<string>>,
): Promise<UploadFile> {
  const archive = new JSZip();
  const write = (partPath: string, content: string): void => {
    archive.file(partPath, content, { createFolders: false });
  };

  const overrides = slides
    .map(
      (_slide, index) =>
        `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    )
    .join("");
  write(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>${overrides}</Types>`,
  );

  write(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
  );

  const slideReferences = slides
    .map(
      (_slide, index) =>
        `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`,
    )
    .join("");
  write(
    "ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${slideReferences}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
  );

  const relationships = slides
    .map(
      (_slide, index) =>
        `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`,
    )
    .join("");
  write(
    "ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`,
  );

  for (const [index, runs] of slides.entries()) {
    write(`ppt/slides/slide${index + 1}.xml`, slideXml(runs));
  }

  return {
    name,
    mimeType: PRESENTATION_MEDIA_TYPE,
    buffer: await archive.generateAsync({
      compression: "DEFLATE",
      type: "nodebuffer",
    }),
  };
}

/**
 * A column mapping document, in the shape the consolidate page's mapping
 * picker takes one. The value is written verbatim, so a test can hand the page
 * a document the engine will refuse as easily as one it accepts.
 */
export function createMappingUpload(
  name: string,
  mapping: unknown,
): UploadFile {
  return {
    name,
    mimeType: "application/json",
    buffer: Buffer.from(`${JSON.stringify(mapping, null, 2)}\n`, "utf8"),
  };
}

/**
 * A file a workbook picker accepts and the operation then cannot read: an
 * accepted name and media type over bytes that are not an OOXML package, which
 * is what a renamed, truncated, or half-synced file looks like to a picker.
 * Unlike `createTextUpload`, this one reaches the worker, so it exercises the
 * operation's own refusal rather than the picker's.
 */
export function createUnreadableWorkbookUpload(name: string): UploadFile {
  return {
    name,
    mimeType: WORKBOOK_MEDIA_TYPE,
    buffer: Buffer.from("This is not a workbook package.\n", "utf8"),
  };
}

/** A file the tools must refuse: right shape, wrong media type. */
export function createTextUpload(name: string): UploadFile {
  return {
    name,
    mimeType: "text/plain",
    buffer: Buffer.from("This is not a PDF.\n", "utf8"),
  };
}

/** The file input a tool page renders, whichever tool it is. */
export function fileInput(page: Page): Locator {
  return page.getByTestId("file-input");
}

/**
 * The file input inside one named section. A page that takes two kinds of file
 * renders two of them, so the bare helper above would be ambiguous there.
 */
export function sectionFileInput(page: Page, section: string): Locator {
  return page.getByTestId(section).getByTestId("file-input");
}

/**
 * The Results panel. Scoping matters on the split pages, where the preview
 * lists the same output names as the results.
 */
export function resultsPanel(page: Page): Locator {
  return page.getByTestId("results-section");
}

/** The produced outputs, in the order the operation reported them. */
export function resultArtifacts(page: Page): Locator {
  return resultsPanel(page).getByTestId("artifact-item");
}

/** The preview panel, which renders the plan for a split before it runs. */
export function previewPanel(page: Page): Locator {
  return page.getByTestId("preview-section");
}

async function downloadedBytes(
  page: Page,
  trigger: () => Promise<void>,
  expectedFileName: string,
): Promise<Buffer> {
  const downloadPromise = page.waitForEvent("download");
  await trigger();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(expectedFileName);

  const bytes = await readFile(await download.path());
  expect(bytes.byteLength).toBeGreaterThan(0);
  return bytes;
}

/**
 * Clicks a Download button and asserts the saved bytes are a non-empty PDF.
 * Downloads arrive from a blob: URL created in the page, so this also covers
 * the artifact-to-Blob copy in the tool components.
 */
export async function expectPdfDownload(
  page: Page,
  trigger: () => Promise<void>,
  expectedFileName: string,
): Promise<void> {
  const bytes = await downloadedBytes(page, trigger, expectedFileName);
  expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
}

/**
 * Clicks a Download button and asserts the saved bytes are a ZIP package. Both
 * Office formats the tools produce are ZIP containers, so a `.xlsx` workbook
 * and a `.pptx` presentation share one header check: a tool that "finishes"
 * while producing empty or corrupt bytes fails here.
 */
async function expectOfficePackageDownload(
  page: Page,
  trigger: () => Promise<void>,
  expectedFileName: string,
): Promise<void> {
  const bytes = await downloadedBytes(page, trigger, expectedFileName);
  expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
}

/** Asserts a downloaded `.xlsx` workbook is a non-empty ZIP package. */
export const expectWorkbookDownload = expectOfficePackageDownload;

/**
 * Clicks a download control and hands back the saved text, for the outputs
 * that are documents rather than packages: the consolidate page's reviewed
 * mapping draft, which the page assembles itself.
 */
export async function readTextDownload(
  page: Page,
  trigger: () => Promise<void>,
  expectedFileName: string,
): Promise<string> {
  return (await downloadedBytes(page, trigger, expectedFileName)).toString(
    "utf8",
  );
}

/** Asserts a downloaded `.pptx` presentation is a non-empty ZIP package. */
export const expectPresentationDownload = expectOfficePackageDownload;

/** One worksheet of a downloaded workbook, read back from its own part. */
export interface DownloadedWorksheet {
  /** The worksheet's tab name. */
  readonly name: string;
  /**
   * The text of the first row's cells, in column order: the headers of a table
   * this toolkit wrote. Shared strings are resolved, because the table writer
   * deduplicates repeated text through the workbook's shared-strings table the
   * way Excel does, so a header is rarely stored in the worksheet part itself.
   */
  readonly headers: readonly string[];
  /** The part's raw XML, for assertions this helper does not cover. */
  readonly xml: string;
  /** The Excel row numbers the part still declares, in document order. */
  readonly rowNumbers: readonly number[];
  /** Every numeric cell value in the part, in document order. */
  readonly numbers: readonly number[];
}

/** A downloaded workbook, addressed by worksheet tab name. */
export interface DownloadedWorkbook {
  /**
   * Every part path the package holds. Worksheets are read through the
   * workbook's relationships, so this is here for the parts that have no
   * worksheet to hang off - the VBA project a macro-enabled split must carry
   * into each output, above all.
   */
  readonly parts: readonly string[];
  /** Every worksheet tab name, in workbook order. */
  readonly sheetNames: readonly string[];
  /** The named worksheet; fails the test when the workbook has no such tab. */
  sheet(name: string): DownloadedWorksheet;
}

const XML_UNESCAPES: Record<string, string> = {
  "&amp;": "&",
  "&apos;": "'",
  "&gt;": ">",
  "&lt;": "<",
  "&quot;": '"',
};

function unescapeXml(value: string): string {
  return value.replaceAll(
    /&(?:amp|apos|gt|lt|quot);/gu,
    (entity) => XML_UNESCAPES[entity]!,
  );
}

function attribute(element: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`, "u").exec(element)?.[1];
}

function rowNumbersOf(xml: string): number[] {
  return [...xml.matchAll(/<row\b[^>]*>/gu)].flatMap((match) => {
    const reference = attribute(match[0], "r");
    return reference === undefined ? [] : [Number(reference)];
  });
}

/**
 * Numeric cell values only. Cells carrying a `t` attribute hold text, either
 * inline or through the shared-string table, so skipping them keeps these
 * assertions independent of how the writer chose to store strings.
 */
function numbersOf(xml: string): number[] {
  return [...xml.matchAll(/<c\b([^>]*)>(.*?)<\/c>/gsu)].flatMap((match) => {
    const type = attribute(match[1]!, "t");
    if (type !== undefined && type !== "n") {
      return [];
    }
    const value = /<v>([^<]*)<\/v>/u.exec(match[2]!)?.[1];
    return value === undefined || value.trim() === "" ? [] : [Number(value)];
  });
}

/** The concatenated runs of each entry in a workbook's shared-string table. */
function sharedStringsOf(xml: string): string[] {
  return [...xml.matchAll(/<si\b[^>]*>(.*?)<\/si>/gsu)].map((entry) =>
    textRunsOf(entry[1]!),
  );
}

function textRunsOf(xml: string): string {
  return [...xml.matchAll(/<t\b[^>]*>(.*?)<\/t>/gsu)]
    .map((run) => unescapeXml(run[1]!))
    .join("");
}

/**
 * The text of the first row's cells, however the writer chose to store it: a
 * shared-string index, an inline string, or a plain value.
 */
function headersOf(xml: string, strings: readonly string[]): string[] {
  const firstRow = /<row\b[^>]*>(.*?)<\/row>/su.exec(xml)?.[1];
  if (firstRow === undefined) {
    return [];
  }
  return [...firstRow.matchAll(/<c\b([^>]*)>(.*?)<\/c>/gsu)].map((cell) => {
    const type = attribute(cell[1]!, "t");
    if (type === "inlineStr") {
      return textRunsOf(cell[2]!);
    }
    const value = /<v>([^<]*)<\/v>/u.exec(cell[2]!)?.[1] ?? "";
    return type === "s" ? (strings[Number(value)] ?? "") : unescapeXml(value);
  });
}

async function readPart(archive: JSZip, path: string): Promise<string> {
  const part = archive.file(path);
  expect(part, `the workbook is missing ${path}`).not.toBeNull();
  return part!.async("string");
}

/**
 * Clicks a Download button and reads the saved workbook back, so a test can
 * assert what actually reached the user rather than only that bytes arrived.
 * Worksheets are resolved through the workbook's own relationships, so the
 * assertions do not depend on which part file a worksheet landed in.
 */
export async function readWorkbookDownload(
  page: Page,
  trigger: () => Promise<void>,
  expectedFileName: string,
): Promise<DownloadedWorkbook> {
  const bytes = await downloadedBytes(page, trigger, expectedFileName);
  expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");

  const archive = await JSZip.loadAsync(bytes);
  const relationships = new Map<string, string>();
  for (const match of (
    await readPart(archive, "xl/_rels/workbook.xml.rels")
  ).matchAll(/<Relationship\b[^>]*>/gu)) {
    const id = attribute(match[0], "Id");
    const target = attribute(match[0], "Target");
    if (id !== undefined && target !== undefined) {
      relationships.set(id, target);
    }
  }

  const sharedStrings = archive.file("xl/sharedStrings.xml")
    ? sharedStringsOf(await readPart(archive, "xl/sharedStrings.xml"))
    : [];
  const worksheets = new Map<string, DownloadedWorksheet>();
  const sheetNames: string[] = [];
  for (const match of (await readPart(archive, "xl/workbook.xml")).matchAll(
    /<sheet\b[^>]*>/gu,
  )) {
    const name = unescapeXml(attribute(match[0], "name") ?? "");
    const target = relationships.get(attribute(match[0], "r:id") ?? "");
    expect(target, `no worksheet part is related to "${name}"`).toBeDefined();
    const path = target!.startsWith("/")
      ? target!.slice(1)
      : `xl/${target!.replace(/^\.\//u, "")}`;
    const xml = await readPart(archive, path);
    sheetNames.push(name);
    worksheets.set(name, {
      headers: headersOf(xml, sharedStrings),
      name,
      numbers: numbersOf(xml),
      rowNumbers: rowNumbersOf(xml),
      xml,
    });
  }

  return {
    parts: Object.keys(archive.files),
    sheet(name: string): DownloadedWorksheet {
      const worksheet = worksheets.get(name);
      expect(
        worksheet,
        `the workbook has no worksheet named "${name}"`,
      ).toBeDefined();
      return worksheet!;
    },
    sheetNames,
  };
}
