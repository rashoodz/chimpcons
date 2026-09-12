import { readFile } from "node:fs/promises";

import { ConsultChimpsError, type RandomAccessFile } from "@consultchimps/core";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  inspectWorkbookStream,
  openWorkbookRegionStream,
  openWorkbookStream,
  type ScratchFactory,
  type StreamRow,
  type WorkbookRegionReader,
  type WorkbookSelection,
} from "../src/stream.js";
import { BoundedXmlText } from "../src/stream/xml.js";

class MemoryFile implements RandomAccessFile {
  #bytes = new Uint8Array();
  closed = false;

  constructor(readonly name: string) {}

  get size(): number {
    return this.#bytes.byteLength;
  }

  async readAt(offset: number, length: number): Promise<Uint8Array> {
    return this.#bytes.slice(offset, offset + length);
  }

  async writeAt(offset: number, bytes: Uint8Array): Promise<void> {
    const required = offset + bytes.byteLength;
    if (required > this.#bytes.byteLength) {
      const expanded = new Uint8Array(required);
      expanded.set(this.#bytes);
      this.#bytes = expanded;
    }
    this.#bytes.set(bytes, offset);
  }

  async truncate(size: number): Promise<void> {
    const resized = new Uint8Array(size);
    resized.set(this.#bytes.subarray(0, size));
    this.#bytes = resized;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class MemoryScratch implements ScratchFactory {
  readonly files: MemoryFile[] = [];

  async create(): Promise<MemoryFile> {
    const file = new MemoryFile(`scratch-${this.files.length}`);
    this.files.push(file);
    return file;
  }
}

function source(bytes: Uint8Array, maximumRead = Number.MAX_SAFE_INTEGER) {
  let largestRead = 0;
  return {
    source: {
      name: "generated.xlsx",
      size: bytes.byteLength,
      async readAt(offset: number, length: number) {
        largestRead = Math.max(largestRead, length);
        if (length > maximumRead) throw new Error("unbounded read");
        return bytes.slice(offset, offset + length);
      },
    },
    largestRead: () => largestRead,
  };
}

interface WorkbookFixtureOptions {
  readonly date1904?: boolean;
  readonly dataSharedString?: string;
  readonly externalTable?: boolean;
  readonly inlineValue?: string;
  readonly malformedWorksheet?: boolean;
  readonly sharedStringCount?: number;
  readonly stored?: boolean;
}

async function workbookFixture(
  options: WorkbookFixtureOptions = {},
): Promise<Uint8Array> {
  const zip = new JSZip();
  const count = options.sharedStringCount ?? 6;
  const strings = [
    "ID & Code",
    "Exact",
    "Date",
    "Formula",
    options.dataSharedString ?? "A&B",
    "Rich text",
    ...Array.from(
      { length: Math.max(0, count - 6) },
      (_, index) => `string-${index}`,
    ),
  ];
  zip.file(
    "[Content_Types].xml",
    "<Types xmlns='http://schemas.openxmlformats.org/package/2006/content-types'></Types>",
  );
  zip.file(
    "_rels/.rels",
    "<Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'><Relationship Id='office' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument' Target='/xl/custom/../workbook.xml'></Relationship></Relationships>",
  );
  zip.file(
    "xl/workbook.xml",
    `<?xml version='1.0'?><x:workbook xmlns:x='http://schemas.openxmlformats.org/spreadsheetml/2006/main' xmlns:r='http://schemas.openxmlformats.org/officeDocument/2006/relationships'><x:workbookPr date1904='${options.date1904 === false ? "false" : "true"}'></x:workbookPr><x:sheets><x:sheet r:id='sheetRel' state='visible' name='Data &amp; More'></x:sheet><x:sheet name='Hidden' state='veryHidden' r:id='hiddenRel'></x:sheet></x:sheets><x:definedNames><x:definedName localSheetId='0' name='LocalData'>$B$2:$E$4</x:definedName><x:definedName name='DataRange'>'Data &amp; More'!$B$2:$E$4</x:definedName></x:definedNames></x:workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version='1.0'?><p:Relationships xmlns:p='http://schemas.openxmlformats.org/package/2006/relationships'><p:Relationship Target='worksheets/../worksheets/sheet1.xml' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet' Id='sheetRel'></p:Relationship><p:Relationship Id='hiddenRel' Target='worksheets/sheet2.xml' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet'></p:Relationship><p:Relationship Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings' Target='sharedStrings.xml' Id='stringsRel'></p:Relationship><p:Relationship Target='styles.xml' Id='stylesRel' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles'></p:Relationship></p:Relationships>`,
  );
  zip.file(
    "xl/worksheets/_rels/sheet1.xml.rels",
    `<?xml version='1.0'?><Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'><Relationship Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink' TargetMode='External' Target='https://example.invalid' Id='external'></Relationship><Relationship ${options.externalTable ? "TargetMode='External' Target='https://example.invalid/table.xml'" : "Target='../tables/table1.xml'"} Id='tableRel' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/table'></Relationship></Relationships>`,
  );
  zip.file(
    "xl/tables/table1.xml",
    `<?xml version='1.0'?><x:table xmlns:x='http://schemas.openxmlformats.org/spreadsheetml/2006/main' totalsRowCount='1' displayName='InventoryTable' ref='B2:E5' name='InventoryTable'><x:tableColumns count='4'><x:tableColumn name='ID &amp; Code' id='1'></x:tableColumn><x:tableColumn id='2' name='Exact'></x:tableColumn><x:tableColumn name='Date' id='3'></x:tableColumn><x:tableColumn id='4' name='Formula'></x:tableColumn></x:tableColumns></x:table>`,
  );
  zip.file(
    "xl/sharedStrings.xml",
    `<?xml version='1.0'?><x:sst xmlns:x='http://schemas.openxmlformats.org/spreadsheetml/2006/main' uniqueCount='${strings.length}' count='${strings.length}'>${strings
      .map((value, index) =>
        index === 5
          ? "<x:si><x:r><x:t>Rich </x:t></x:r><x:r><x:t>text</x:t></x:r><x:rPh><x:t>ignored phonetic</x:t></x:rPh></x:si>"
          : `<x:si><x:t>${value.replaceAll("&", "&amp;")}</x:t></x:si>`,
      )
      .join("")}</x:sst>`,
  );
  zip.file(
    "xl/styles.xml",
    `<?xml version='1.0'?><x:styleSheet xmlns:x='http://schemas.openxmlformats.org/spreadsheetml/2006/main'><x:numFmts count='1'><x:numFmt formatCode='yyyy-mm-dd' numFmtId='164'></x:numFmt></x:numFmts><x:cellXfs count='3'><x:xf numFmtId='0'></x:xf><x:xf applyNumberFormat='1' numFmtId='164'></x:xf><x:xf numFmtId='14'></x:xf></x:cellXfs></x:styleSheet>`,
  );
  const worksheet = options.malformedWorksheet
    ? "<worksheet><sheetData><row r='2'><c r='B2'><v>0</v></c></row><tableParts count='1'><tablePart r:id='tableRel'/></tableParts>"
    : `<?xml version='1.0'?><x:worksheet xmlns:x='http://schemas.openxmlformats.org/spreadsheetml/2006/main' xmlns:r='http://schemas.openxmlformats.org/officeDocument/2006/relationships'><x:sheetData><x:row r='2'><x:c t='s' r='B2'><x:v>0</x:v></x:c><x:c r='C2' t='s'><x:v>1</x:v></x:c><x:c r='D2' t='s'><x:v>2</x:v></x:c><x:c r='E2' t='s'><x:v>3</x:v></x:c></x:row><x:row r='3'><x:c r='B3' t='s'><x:v>${count > 6 ? count - 1 : 4}</x:v></x:c><x:c r='C3'><x:v>12345678901234567890.123456789</x:v></x:c><x:c s='1' r='D3'><x:v>1</x:v></x:c><x:c r='E3'><x:f>1+1</x:f><x:v>2</x:v></x:c></x:row><x:row r='4'><x:c t='inlineStr' r='B4'><x:is><x:r><x:t>${options.inlineValue ?? "Rich "}</x:t></x:r><x:r><x:t>inline</x:t></x:r></x:is></x:c><x:c r='C4'><x:f>NOW()</x:f></x:c><x:c s='2' r='D4'><x:v>0</x:v></x:c><x:c t='e' r='E4'><x:f>1/0</x:f><x:v>#DIV/0!</x:v></x:c></x:row><x:row r='5'><x:c t='inlineStr' r='B5'><x:is><x:t>Total</x:t></x:is></x:c></x:row></x:sheetData><x:tableParts count='1'><x:tablePart r:id='tableRel'></x:tablePart></x:tableParts></x:worksheet>`;
  zip.file("xl/worksheets/sheet1.xml", worksheet);
  zip.file(
    "xl/worksheets/sheet2.xml",
    "<worksheet xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'><sheetData></sheetData></worksheet>",
  );
  return zip.generateAsync({
    type: "uint8array",
    compression: options.stored ? "STORE" : "DEFLATE",
    ...(options.stored ? {} : { compressionOptions: { level: 6 } }),
  });
}

async function workbookFixtureWithParts(
  parts: Readonly<Record<string, string>>,
  options: WorkbookFixtureOptions = {},
): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await workbookFixture(options));
  for (const [name, contents] of Object.entries(parts)) {
    zip.file(name, contents);
  }
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

async function workbookFixtureWithoutPart(part: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await workbookFixture());
  zip.remove(part);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

async function rows(
  reader: WorkbookRegionReader,
): Promise<readonly StreamRow[]> {
  const result: StreamRow[] = [];
  for await (const batch of reader.batches({ batchSize: 1 })) {
    result.push(...batch);
  }
  await reader.close();
  return result;
}

const regionSelections: readonly [WorkbookSelection][] = [
  [{ table: "inventorytable" }],
  [{ range: "DataRange" }],
  [{ range: "LocalData" }],
  [{ range: "'Data & More'!B2:E4" }],
  [{ sheet: "data & more", headerRow: 2 }],
];

describe("bounded workbook streaming", () => {
  it("counts UTF-8 and CDATA delimiter candidates across input chunks", () => {
    const encoder = new TextEncoder();
    const valid = encoder.encode("<t><![CDATA[éA]B]]C]]></t>");
    const limiter = new BoundedXmlText(
      new Set(["t"]),
      8,
      () => "cell text is too large",
    );
    for (let index = 0; index < valid.length; index += 1) {
      limiter.consume(valid.subarray(index, index + 1));
    }

    const oversized = new BoundedXmlText(
      new Set(["t"]),
      7,
      () => "cell text is too large",
    );
    expect(() => oversized.consume(valid)).toThrow("cell text is too large");
  });

  it("bounds XML buffers outside recognized cell text", () => {
    const encoder = new TextEncoder();
    const large = "x".repeat(65_537);
    const createLimiter = () =>
      new BoundedXmlText(new Set(["t"]), 1024, () => "cell text is too large");

    expect(() =>
      createLimiter().consume(encoder.encode(`<worksheet>${large}`)),
    ).toThrow("XML text node");
    expect(() =>
      createLimiter().consume(encoder.encode(`<!--${large}-->`)),
    ).toThrow("XML comment");
    expect(() =>
      createLimiter().consume(encoder.encode(`<?target ${large}?>`)),
    ).toThrow("XML processing instruction");
    expect(() =>
      createLimiter().consume(encoder.encode(`<!DOCTYPE ${large}>`)),
    ).toThrow("Document type declarations");
  });

  it("inspects the repository workbook fixture through actual ZIP ranges", async () => {
    const bytes = new Uint8Array(
      await readFile(
        new URL("./fixtures/structured-table.xlsx", import.meta.url),
      ),
    );
    const input = source(bytes, 128);
    const inspection = await inspectWorkbookStream(input.source, {
      scratch: new MemoryScratch(),
      chunkBytes: 128,
    });
    expect(inspection.tables.length).toBeGreaterThan(0);
    expect(inspection.sheets.length).toBeGreaterThan(0);
    expect(input.largestRead()).toBeLessThanOrEqual(128);

    const table = inspection.tables[0];
    if (!table) throw new Error("The fixture has no table.");
    const reader = await openWorkbookRegionStream(
      input.source,
      { table: table.name },
      { scratch: new MemoryScratch(), chunkBytes: 128 },
    );
    const parsedRows = await rows(reader);
    expect(reader.region.columns.length).toBeGreaterThan(0);
    expect(parsedRows.length).toBeGreaterThan(0);
  });

  it("inspects namespaced metadata without inflating malformed worksheets", async () => {
    const input = source(await workbookFixture({ malformedWorksheet: true }));
    const inspection = await inspectWorkbookStream(input.source, {
      scratch: new MemoryScratch(),
    });
    expect(inspection).toMatchObject({
      sheets: [
        { name: "Data & More", visibility: "visible" },
        { name: "Hidden", visibility: "veryHidden" },
      ],
      tables: [
        {
          name: "InventoryTable",
          sheet: "Data & More",
          reference: "B2:E5",
          headerRow: 2,
          totalsRow: true,
          columns: ["ID & Code", "Exact", "Date", "Formula"],
        },
      ],
    });
    expect(inspection.namedRanges).toContainEqual({
      name: "DataRange",
      reference: "'Data & More'!$B$2:$E$4",
    });
  });

  it.each(["xl/styles.xml", "xl/sharedStrings.xml"])(
    "rejects a declared metadata relationship whose %s part is missing",
    async (part) => {
      const input = source(await workbookFixtureWithoutPart(part));

      await expect(
        inspectWorkbookStream(input.source, { scratch: new MemoryScratch() }),
      ).rejects.toMatchObject({
        code: "XLSX_READ_FAILED",
        cause: expect.objectContaining({
          message: expect.stringContaining(part),
        }),
      });
    },
  );

  it("accepts omitted optional metadata relationships and numeric cell types", async () => {
    const workbookRelationships =
      "<Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'>" +
      "<Relationship Id='sheetRel' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet' Target='worksheets/sheet1.xml'/>" +
      "<Relationship Id='hiddenRel' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet' Target='worksheets/sheet2.xml'/>" +
      "</Relationships>";
    const worksheet =
      "<worksheet xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'><sheetData>" +
      "<row r='1'><c r='A1' t='inlineStr'><is><t>Omitted</t></is></c><c r='B1' t='inlineStr'><is><t>ExplicitN</t></is></c></row>" +
      "<row r='2'><c r='A2'><v>1</v></c><c r='B2' t='n' s='0'><v>2.5</v></c></row>" +
      "</sheetData></worksheet>";
    const input = source(
      await workbookFixtureWithParts({
        "xl/_rels/workbook.xml.rels": workbookRelationships,
        "xl/worksheets/sheet1.xml": worksheet,
      }),
    );
    const reader = await openWorkbookRegionStream(
      input.source,
      { range: "'Data & More'!A1:B2" },
      { scratch: new MemoryScratch() },
    );

    expect(await rows(reader)).toEqual([
      {
        sourceRow: 2,
        cells: {
          Omitted: { kind: "number", raw: "1" },
          ExplicitN: { kind: "number", raw: "2.5" },
        },
      },
    ]);
  });

  it.each(regionSelections)(
    "reads table, named, explicit, and shifted-header selection %j",
    async (selection) => {
      const input = source(await workbookFixture());
      const reader = await openWorkbookRegionStream(input.source, selection, {
        scratch: new MemoryScratch(),
        chunkBytes: 97,
      });
      expect(reader.region.columns).toEqual([
        { name: "ID & Code", column: 1 },
        { name: "Exact", column: 2 },
        { name: "Date", column: 3 },
        { name: "Formula", column: 4 },
      ]);
      const data = await rows(reader);
      expect(data[0]).toEqual({
        sourceRow: 3,
        cells: {
          "ID & Code": { kind: "string", value: "A&B" },
          Exact: { kind: "number", raw: "12345678901234567890.123456789" },
          Date: { kind: "date", raw: "1", iso: "1904-01-02" },
          Formula: {
            kind: "formula",
            formula: "1+1",
            cached: { kind: "number", raw: "2" },
          },
        },
      });
      expect(data[1]?.cells).toMatchObject({
        "ID & Code": { kind: "string", value: "Rich inline" },
        Exact: {
          kind: "formula",
          formula: "NOW()",
          cached: { kind: "missing" },
        },
        Date: { kind: "date", raw: "0", iso: "1904-01-01" },
        Formula: {
          kind: "formula",
          formula: "1/0",
          cached: { kind: "error", error: "#DIV/0!" },
        },
      });
      if ("table" in selection || "range" in selection) {
        expect(data.map((row) => row.sourceRow)).toEqual([3, 4]);
      } else {
        expect(data.map((row) => row.sourceRow)).toEqual([3, 4, 5]);
      }
      expect(input.largestRead()).toBeLessThanOrEqual(97);
    },
  );

  it("keeps built-in time semantics for midnight and fractional serials", async () => {
    const styles =
      "<styleSheet xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'>" +
      "<numFmts count='2'><numFmt numFmtId='164' formatCode='yyyy-mm-dd hh:mm:ss'/><numFmt numFmtId='165' formatCode='yyyy-mm-dd'/></numFmts>" +
      "<cellXfs count='6'><xf numFmtId='0'/><xf numFmtId='14'/><xf numFmtId='18'/><xf numFmtId='22'/><xf numFmtId='164'/><xf numFmtId='165'/></cellXfs>" +
      "</styleSheet>";
    const worksheet =
      "<worksheet xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'><sheetData>" +
      "<row r='1'><c r='A1' t='inlineStr'><is><t>Date</t></is></c><c r='B1' t='inlineStr'><is><t>Time</t></is></c><c r='C1' t='inlineStr'><is><t>DateTime</t></is></c><c r='D1' t='inlineStr'><is><t>Noon</t></is></c><c r='E1' t='inlineStr'><is><t>CustomDateTime</t></is></c><c r='F1' t='inlineStr'><is><t>CustomDate</t></is></c></row>" +
      "<row r='2'><c r='A2' s='1'><v>0</v></c><c r='B2' s='2'><v>0</v></c><c r='C2' s='3'><v>0</v></c><c r='D2' s='3'><v>0.5</v></c><c r='E2' s='4'><v>0</v></c><c r='F2' s='5'><v>0</v></c></row>" +
      "</sheetData></worksheet>";
    const input = source(
      await workbookFixtureWithParts({
        "xl/styles.xml": styles,
        "xl/worksheets/sheet1.xml": worksheet,
      }),
    );
    const reader = await openWorkbookRegionStream(
      input.source,
      { range: "'Data & More'!A1:F2" },
      { scratch: new MemoryScratch(), chunkBytes: 41 },
    );

    expect((await rows(reader))[0]).toEqual({
      sourceRow: 2,
      cells: {
        Date: { kind: "date", raw: "0", iso: "1904-01-01" },
        Time: {
          kind: "date",
          raw: "0",
          iso: "1904-01-01T00:00:00.000",
        },
        DateTime: {
          kind: "date",
          raw: "0",
          iso: "1904-01-01T00:00:00.000",
        },
        Noon: {
          kind: "date",
          raw: "0.5",
          iso: "1904-01-01T12:00:00.000",
        },
        CustomDateTime: {
          kind: "date",
          raw: "0",
          iso: "1904-01-01T00:00:00.000",
        },
        CustomDate: { kind: "date", raw: "0", iso: "1904-01-01" },
      },
    });
  });

  it("retains built-in and bracketed elapsed times as numeric durations", async () => {
    const styles =
      "<styleSheet xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'>" +
      "<numFmts count='6'><numFmt numFmtId='164' formatCode='[h]:mm:ss'/><numFmt numFmtId='165' formatCode='[hh]:mm:ss'/><numFmt numFmtId='166' formatCode='[m]:ss'/><numFmt numFmtId='167' formatCode='[mm]:ss'/><numFmt numFmtId='168' formatCode='[s]'/><numFmt numFmtId='169' formatCode='[ss]'/></numFmts>" +
      "<cellXfs count='9'><xf numFmtId='0'/><xf numFmtId='46'/><xf numFmtId='164'/><xf numFmtId='165'/><xf numFmtId='166'/><xf numFmtId='167'/><xf numFmtId='168'/><xf numFmtId='169'/><xf numFmtId='45'/></cellXfs>" +
      "</styleSheet>";
    const worksheet =
      "<worksheet xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'><sheetData>" +
      "<row r='1'><c r='A1' t='inlineStr'><is><t>Built46</t></is></c><c r='B1' t='inlineStr'><is><t>Hours</t></is></c><c r='C1' t='inlineStr'><is><t>DoubleHours</t></is></c><c r='D1' t='inlineStr'><is><t>Minutes</t></is></c><c r='E1' t='inlineStr'><is><t>DoubleMinutes</t></is></c><c r='F1' t='inlineStr'><is><t>Seconds</t></is></c><c r='G1' t='inlineStr'><is><t>DoubleSeconds</t></is></c><c r='H1' t='inlineStr'><is><t>Clock</t></is></c></row>" +
      "<row r='2'><c r='A2' s='1'><v>1.5</v></c><c r='B2' s='2'><v>1.5</v></c><c r='C2' s='3'><v>1.5</v></c><c r='D2' s='4'><v>1.5</v></c><c r='E2' s='5'><v>1.5</v></c><c r='F2' s='6'><v>1.5</v></c><c r='G2' s='7'><v>1.5</v></c><c r='H2' s='8'><v>0.5</v></c></row>" +
      "</sheetData></worksheet>";
    const input = source(
      await workbookFixtureWithParts({
        "xl/styles.xml": styles,
        "xl/worksheets/sheet1.xml": worksheet,
      }),
    );
    const reader = await openWorkbookRegionStream(
      input.source,
      { range: "'Data & More'!A1:H2" },
      { scratch: new MemoryScratch() },
    );

    expect((await rows(reader))[0]?.cells).toEqual({
      Built46: { kind: "number", raw: "1.5" },
      Hours: { kind: "number", raw: "1.5" },
      DoubleHours: { kind: "number", raw: "1.5" },
      Minutes: { kind: "number", raw: "1.5" },
      DoubleMinutes: { kind: "number", raw: "1.5" },
      Seconds: { kind: "number", raw: "1.5" },
      DoubleSeconds: { kind: "number", raw: "1.5" },
      Clock: {
        kind: "date",
        raw: "0.5",
        iso: "1904-01-01T12:00:00.000",
      },
    });
  });

  it("uses an authored number format in place of its built-in time format", async () => {
    const styles =
      "<styleSheet xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'>" +
      "<numFmts count='1'><numFmt numFmtId='22' formatCode='yyyy-mm-dd'/></numFmts>" +
      "<cellXfs count='2'><xf numFmtId='0'/><xf numFmtId='22'/></cellXfs>" +
      "</styleSheet>";
    const worksheet =
      "<worksheet xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'><sheetData>" +
      "<row r='1'><c r='A1' t='inlineStr'><is><t>AuthoredDate</t></is></c></row>" +
      "<row r='2'><c r='A2' s='1'><v>0</v></c></row>" +
      "</sheetData></worksheet>";
    const input = source(
      await workbookFixtureWithParts({
        "xl/styles.xml": styles,
        "xl/worksheets/sheet1.xml": worksheet,
      }),
    );
    const reader = await openWorkbookRegionStream(
      input.source,
      { range: "'Data & More'!A1:A2" },
      { scratch: new MemoryScratch(), chunkBytes: 31 },
    );

    expect(await rows(reader)).toEqual([
      {
        sourceRow: 2,
        cells: {
          AuthoredDate: { kind: "date", raw: "0", iso: "1904-01-01" },
        },
      },
    ]);
  });

  it("applies declared-date blank and ISO rules to values and formula caches", async () => {
    const worksheet =
      "<worksheet xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'><sheetData>" +
      "<row r='1'><c r='A1' t='inlineStr'><is><t>Empty</t></is></c><c r='B1' t='inlineStr'><is><t>Whitespace</t></is></c><c r='C1' t='inlineStr'><is><t>Valid</t></is></c><c r='D1' t='inlineStr'><is><t>Malformed</t></is></c><c r='E1' t='inlineStr'><is><t>CachedValid</t></is></c><c r='F1' t='inlineStr'><is><t>CachedBlank</t></is></c><c r='G1' t='inlineStr'><is><t>MissingCache</t></is></c><c r='H1' t='inlineStr'><is><t>MissingBooleanCache</t></is></c></row>" +
      "<row r='2'><c r='A2' t='d'><v/></c><c r='B2' t='d'><v>   </v></c><c r='C2' t='d'><v>2024-01-02T03:04:05+05:30</v></c><c r='D2' t='d'><v>2024-13-01</v></c><c r='E2' t='d'><f>TODAY()</f><v>2024-01-02</v></c><c r='F2' t='d'><f>TODAY()</f><v> </v></c><c r='G2' t='d'><f>TODAY()</f></c><c r='H2' t='b'><f>1=1</f></c></row>" +
      "</sheetData></worksheet>";
    const input = source(
      await workbookFixtureWithParts({
        "xl/worksheets/sheet1.xml": worksheet,
      }),
    );
    const reader = await openWorkbookRegionStream(
      input.source,
      { range: "'Data & More'!A1:H2" },
      { scratch: new MemoryScratch(), chunkBytes: 29 },
    );

    expect(await rows(reader)).toEqual([
      {
        sourceRow: 2,
        cells: {
          Empty: { kind: "blank" },
          Whitespace: { kind: "blank" },
          Valid: {
            kind: "date",
            raw: "2024-01-02T03:04:05+05:30",
            iso: "2024-01-01T21:34:05.000Z",
          },
          Malformed: { kind: "string", value: "2024-13-01" },
          CachedValid: {
            kind: "formula",
            formula: "TODAY()",
            cached: {
              kind: "date",
              raw: "2024-01-02",
              iso: "2024-01-02T00:00:00.000Z",
            },
          },
          CachedBlank: {
            kind: "formula",
            formula: "TODAY()",
            cached: { kind: "blank" },
          },
          MissingCache: {
            kind: "formula",
            formula: "TODAY()",
            cached: { kind: "missing" },
          },
          MissingBooleanCache: {
            kind: "formula",
            formula: "1=1",
            cached: { kind: "missing" },
          },
        },
      },
    ]);
  });

  it.each([
    { range: "'Data & More'!A1:D2" },
    { sheet: "Data & More", headerRow: 1 },
  ] satisfies readonly WorkbookSelection[])(
    "reads implicit and mixed cell references for %j headers",
    async (selection) => {
      const worksheet =
        "<worksheet xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'><sheetData>" +
        "<row r='1'><c t='inlineStr'><is><t>First</t></is></c><c t='inlineStr'><is><t>Second</t></is></c><c r='C1' t='inlineStr'><is><t>Third</t></is></c><c t='inlineStr'><is><t>Fourth</t></is></c></row>" +
        "<row r='2'><c t='inlineStr'><is><t>North</t></is></c><c><v>2</v></c><c r='C2'><v>3</v></c><c t='b'><v>1</v></c></row>" +
        "</sheetData></worksheet>";
      const input = source(
        await workbookFixtureWithParts({
          "xl/worksheets/sheet1.xml": worksheet,
        }),
      );
      const reader = await openWorkbookRegionStream(input.source, selection, {
        scratch: new MemoryScratch(),
        chunkBytes: 37,
      });

      expect(reader.region.columns).toEqual([
        { name: "First", column: 0 },
        { name: "Second", column: 1 },
        { name: "Third", column: 2 },
        { name: "Fourth", column: 3 },
      ]);
      expect(await rows(reader)).toEqual([
        {
          sourceRow: 2,
          cells: {
            First: { kind: "string", value: "North" },
            Second: { kind: "number", raw: "2" },
            Third: { kind: "number", raw: "3" },
            Fourth: { kind: "boolean", value: true },
          },
        },
      ]);
    },
  );

  it.each([
    [
      "an interior explicit-range header",
      "<c r='A1' t='inlineStr'><is><t>First</t></is></c><c r='C1' t='inlineStr'><is><t>Third</t></is></c>",
      { range: "'Data & More'!A1:C2" },
    ],
    [
      "an interior sheet header",
      "<c r='A1' t='inlineStr'><is><t>First</t></is></c><c r='C1' t='inlineStr'><is><t>Third</t></is></c>",
      { sheet: "Data & More", headerRow: 1 },
    ],
    [
      "a leading explicit-range header",
      "<c r='B1' t='inlineStr'><is><t>Second</t></is></c><c r='C1' t='inlineStr'><is><t>Third</t></is></c>",
      { range: "'Data & More'!A1:C2" },
    ],
    [
      "a trailing explicit-range header",
      "<c r='A1' t='inlineStr'><is><t>First</t></is></c><c r='B1' t='inlineStr'><is><t>Second</t></is></c>",
      { range: "'Data & More'!A1:C2" },
    ],
  ] satisfies readonly [string, string, WorkbookSelection][])(
    "rejects a missing cell in %s",
    async (_case, headerCells, selection) => {
      const worksheet =
        "<worksheet xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'><sheetData>" +
        `<row r='1'>${headerCells}</row>` +
        "<row r='2'><c r='A2'><v>1</v></c><c r='B2'><v>2</v></c><c r='C2'><v>3</v></c></row>" +
        "</sheetData></worksheet>";
      const input = source(
        await workbookFixtureWithParts({
          "xl/worksheets/sheet1.xml": worksheet,
        }),
      );

      await expect(
        openWorkbookRegionStream(input.source, selection, {
          scratch: new MemoryScratch(),
        }),
      ).rejects.toMatchObject({ code: "XLSX_EMPTY_HEADER" });
    },
  );

  it("retains ordinary sparse data rows under complete headers", async () => {
    const worksheet =
      "<worksheet xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'><sheetData>" +
      "<row r='1'><c r='A1' t='inlineStr'><is><t>First</t></is></c><c r='B1' t='inlineStr'><is><t>Second</t></is></c><c r='C1' t='inlineStr'><is><t>Third</t></is></c></row>" +
      "<row r='2'><c r='A2'><v>1</v></c><c r='C2'><v>3</v></c></row>" +
      "</sheetData></worksheet>";
    const input = source(
      await workbookFixtureWithParts({
        "xl/worksheets/sheet1.xml": worksheet,
      }),
    );
    const reader = await openWorkbookRegionStream(
      input.source,
      { range: "'Data & More'!A1:C2" },
      { scratch: new MemoryScratch() },
    );

    expect(await rows(reader)).toEqual([
      {
        sourceRow: 2,
        cells: {
          First: { kind: "number", raw: "1" },
          Third: { kind: "number", raw: "3" },
        },
      },
    ]);
  });

  it.each([
    ["selected values", "<c r='A2'><v>1</v></c><c r='A2'><v>2</v></c>"],
    ["unselected blanks", "<c r='B2'/><c r='B2'/><c r='A2'><v>1</v></c>"],
    [
      "unselected formulas",
      "<c r='B2'><f>1+1</f></c><c r='B2'><f>2+2</f></c><c r='A2'><v>1</v></c>",
    ],
  ])(
    "rejects duplicate worksheet cells containing %s",
    async (_case, dataCells) => {
      const worksheet =
        "<worksheet xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'><sheetData>" +
        "<row r='1'><c r='A1' t='inlineStr'><is><t>Value</t></is></c></row>" +
        `<row r='2'>${dataCells}</row>` +
        "</sheetData></worksheet>";
      const input = source(
        await workbookFixtureWithParts({
          "xl/worksheets/sheet1.xml": worksheet,
        }),
      );
      await expect(
        (async () => {
          const reader = await openWorkbookRegionStream(
            input.source,
            { range: "'Data & More'!A1:A2" },
            { scratch: new MemoryScratch() },
          );
          return rows(reader);
        })(),
      ).rejects.toMatchObject({ code: "XLSX_READ_FAILED" });
    },
  );

  it.each([
    ["numeric payload", "unsupported", "<v>42</v>"],
    ["blank cell", "unknown", ""],
    ["uncached formula", "formula-result", "<f>1+1</f>"],
    ["empty type", "", "<v>1</v>"],
  ])("rejects an unsupported type on a %s", async (_case, type, contents) => {
    const worksheet =
      "<worksheet xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'><sheetData>" +
      "<row r='1'><c r='A1' t='inlineStr'><is><t>Value</t></is></c></row>" +
      `<row r='2'><c r='A2' t='${type}'>${contents}</c></row>` +
      "</sheetData></worksheet>";
    const input = source(
      await workbookFixtureWithParts({
        "xl/worksheets/sheet1.xml": worksheet,
      }),
    );

    await expect(
      (async () => {
        const reader = await openWorkbookRegionStream(
          input.source,
          { range: "'Data & More'!A1:A2" },
          { scratch: new MemoryScratch() },
        );
        return rows(reader);
      })(),
    ).rejects.toMatchObject({
      code: "XLSX_READ_FAILED",
      cause: expect.objectContaining({
        message: expect.stringMatching(/unsupported.*cell type/iu),
      }),
    });
  });

  it.each([
    ["repeated values", "<v>1</v><v>2</v>"],
    ["a repeated value after an empty value", "<v/><v>2</v>"],
    ["repeated formulas with a cached value", "<f>1+1</f><f>2+2</f><v>2</v>"],
    [
      "repeated inline-string containers",
      "<is><t>One</t></is><is><t>Two</t></is>",
    ],
    ["a nested value element", "<v>1<v>2</v></v>"],
    ["nested markup inside a value", "<v>1<r>2</r></v>"],
  ])("rejects a cell containing %s", async (_case, contents) => {
    const type = _case.includes("inline") ? " t='inlineStr'" : "";
    const worksheet =
      "<worksheet xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'><sheetData>" +
      "<row r='1'><c r='A1' t='inlineStr'><is><t>Value</t></is></c></row>" +
      `<row r='2'><c r='A2'${type}>${contents}</c><c r='B2'><v>3</v></c></row>` +
      "</sheetData></worksheet>";
    const input = source(
      await workbookFixtureWithParts({
        "xl/worksheets/sheet1.xml": worksheet,
      }),
    );

    await expect(
      (async () => {
        const reader = await openWorkbookRegionStream(
          input.source,
          { range: "'Data & More'!A1:A2" },
          { scratch: new MemoryScratch() },
        );
        return rows(reader);
      })(),
    ).rejects.toMatchObject({
      code: "XLSX_READ_FAILED",
      cause: expect.objectContaining({
        message: expect.stringMatching(
          /cell.*(?:direct|more than once|nested)/iu,
        ),
      }),
    });
  });

  it.each([
    ["numeric value", "<v>1</v>"],
    ["blank value", ""],
    ["uncached formula", "<f>1+1</f>"],
  ])("rejects an unavailable style on a %s", async (_case, contents) => {
    const styles =
      "<styleSheet xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'><cellXfs count='1'><xf numFmtId='0'/></cellXfs></styleSheet>";
    const worksheet =
      "<worksheet xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'><sheetData>" +
      "<row r='1'><c r='A1' t='inlineStr'><is><t>Value</t></is></c></row>" +
      `<row r='2'><c r='A2' s='1'>${contents}</c></row>` +
      "</sheetData></worksheet>";
    const input = source(
      await workbookFixtureWithParts({
        "xl/styles.xml": styles,
        "xl/worksheets/sheet1.xml": worksheet,
      }),
    );

    await expect(
      (async () => {
        const reader = await openWorkbookRegionStream(
          input.source,
          { range: "'Data & More'!A1:A2" },
          { scratch: new MemoryScratch() },
        );
        return rows(reader);
      })(),
    ).rejects.toMatchObject({
      code: "XLSX_READ_FAILED",
      cause: expect.objectContaining({
        message: expect.stringMatching(/style.*outside/iu),
      }),
    });
  });

  it.each([
    ["nested", "<sst><si><t>Outer</t><si><t>Inner</t></si></si></sst>"],
    ["misplaced", "<sst><ext><si><t>Inner</t></si></ext></sst>"],
  ])("rejects a %s shared-string item", async (_case, sharedStrings) => {
    const input = source(
      await workbookFixtureWithParts({
        "xl/sharedStrings.xml": sharedStrings,
      }),
    );

    await expect(
      openWorkbookRegionStream(
        input.source,
        { range: "'Data & More'!B2:E4" },
        { scratch: new MemoryScratch() },
      ),
    ).rejects.toMatchObject({
      code: "XLSX_READ_FAILED",
      cause: expect.objectContaining({
        message: expect.stringMatching(/shared-string item/iu),
      }),
    });
  });

  it.each([
    [
      "a nested row",
      "<row r='1'><row r='2'><c r='A2' t='inlineStr'><is><t>Value</t></is></c></row></row>",
    ],
    [
      "a nested cell",
      "<row r='1'><c r='A1' t='inlineStr'><c r='B1' t='inlineStr'><is><t>Value</t></is></c></c></row>",
    ],
    [
      "a cell after its row",
      "<row r='1'><c r='A1' t='inlineStr'><is><t>Value</t></is></c></row><c r='A1'><v>2</v></c>",
    ],
    [
      "a repeated row number",
      "<row r='1'><c r='A1' t='inlineStr'><is><t>Value</t></is></c></row><row r='2'><c r='A2'><v>1</v></c></row><row r='2'><c r='A2'><v>2</v></c></row>",
    ],
    [
      "an out-of-order row number",
      "<row r='1'><c r='A1' t='inlineStr'><is><t>Value</t></is></c></row><row r='3'><c r='A3'><v>3</v></c></row><row r='2'><c r='A2'><v>2</v></c></row>",
    ],
    [
      "a non-integer row spelling",
      "<row r='1'><c r='A1' t='inlineStr'><is><t>Value</t></is></c></row><row r='2e0'><c r='A2'><v>2</v></c></row>",
    ],
    [
      "a row number ending in a newline",
      "<row r='1'><c r='A1' t='inlineStr'><is><t>Value</t></is></c></row><row r='2&#10;'><c r='A2'><v>2</v></c></row>",
    ],
  ])("rejects worksheet structure containing %s", async (_case, sheetData) => {
    const input = source(
      await workbookFixtureWithParts({
        "xl/worksheets/sheet1.xml":
          "<worksheet xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'><sheetData>" +
          sheetData +
          "</sheetData></worksheet>",
      }),
    );

    await expect(
      (async () => {
        const reader = await openWorkbookRegionStream(
          input.source,
          { range: "'Data & More'!A1:A3" },
          { scratch: new MemoryScratch() },
        );
        return rows(reader);
      })(),
    ).rejects.toMatchObject({ code: "XLSX_READ_FAILED" });
  });

  it("accepts implicit rows, physical row gaps, and sparse values", async () => {
    const worksheet =
      "<worksheet xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'><sheetData>" +
      "<row><c t='inlineStr'><is><t>First</t></is></c><c t='inlineStr'><is><t>Second</t></is></c></row>" +
      "<row><c/><c><v>2</v></c></row>" +
      "<row r='4'><c r='A4'><v>4</v></c></row>" +
      "<row><c><v>5</v></c></row>" +
      "</sheetData></worksheet>";
    const input = source(
      await workbookFixtureWithParts({
        "xl/worksheets/sheet1.xml": worksheet,
      }),
    );
    const reader = await openWorkbookRegionStream(
      input.source,
      { range: "'Data & More'!A1:B5" },
      { scratch: new MemoryScratch() },
    );

    expect(await rows(reader)).toEqual([
      {
        sourceRow: 2,
        cells: {
          First: { kind: "blank" },
          Second: { kind: "number", raw: "2" },
        },
      },
      {
        sourceRow: 4,
        cells: { First: { kind: "number", raw: "4" } },
      },
      {
        sourceRow: 5,
        cells: { First: { kind: "number", raw: "5" } },
      },
    ]);
  });

  it("retains prototype-shaped column names in sole and mixed selections", async () => {
    const worksheet =
      "<worksheet xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'><sheetData>" +
      "<row r='1'><c r='A1' t='inlineStr'><is><t>__proto__</t></is></c><c r='B1' t='inlineStr'><is><t>Regular</t></is></c><c r='C1' t='inlineStr'><is><t>constructor</t></is></c><c r='D1' t='inlineStr'><is><t>toString</t></is></c></row>" +
      "<row r='2'><c r='A2' t='inlineStr'><is><t>prototype value</t></is></c><c r='B2' t='inlineStr'><is><t>regular value</t></is></c><c r='C2' t='inlineStr'><is><t>constructor value</t></is></c><c r='D2' t='inlineStr'><is><t>toString value</t></is></c></row>" +
      "</sheetData></worksheet>";
    const input = source(
      await workbookFixtureWithParts({
        "xl/worksheets/sheet1.xml": worksheet,
      }),
    );
    const soleReader = await openWorkbookRegionStream(
      input.source,
      { range: "'Data & More'!A1:A2" },
      { scratch: new MemoryScratch() },
    );
    const soleRows = await rows(soleReader);
    expect(soleRows).toHaveLength(1);
    expect(Object.keys(soleRows[0]?.cells ?? {})).toEqual(["__proto__"]);
    expect(soleRows[0]?.cells["__proto__"]).toEqual({
      kind: "string",
      value: "prototype value",
    });
    expect(Object.getPrototypeOf(soleRows[0]?.cells)).toBeNull();

    const mixedReader = await openWorkbookRegionStream(
      input.source,
      { range: "'Data & More'!A1:D2" },
      { scratch: new MemoryScratch() },
    );
    const mixedCells = (await rows(mixedReader))[0]?.cells;
    expect(Object.keys(mixedCells ?? {})).toEqual([
      "__proto__",
      "Regular",
      "constructor",
      "toString",
    ]);
    expect(mixedCells?.["__proto__"]).toEqual({
      kind: "string",
      value: "prototype value",
    });
    expect(mixedCells?.constructor).toEqual({
      kind: "string",
      value: "constructor value",
    });
    expect(mixedCells?.toString).toEqual({
      kind: "string",
      value: "toString value",
    });
    expect(Object.getPrototypeOf(mixedCells)).toBeNull();
  });

  it.each([
    ["text between column and row", "A!1"],
    ["an empty value", ""],
    ["a trailing space", "A1 "],
    ["a trailing newline", "A1&#10;"],
  ])("rejects a cell reference with %s", async (_case, reference) => {
    const worksheet =
      "<worksheet xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'><sheetData>" +
      `<row r='1'><c r='A1' t='inlineStr'><is><t>Value</t></is></c><c r='${reference}' t='inlineStr'><is><t>Alias</t></is></c></row>` +
      "<row r='2'><c r='A2'><v>1</v></c></row>" +
      "</sheetData></worksheet>";
    const input = source(
      await workbookFixtureWithParts({
        "xl/worksheets/sheet1.xml": worksheet,
      }),
    );

    await expect(
      openWorkbookRegionStream(
        input.source,
        { range: "'Data & More'!A1:A2" },
        { scratch: new MemoryScratch() },
      ),
    ).rejects.toMatchObject({ code: "XLSX_READ_FAILED" });
  });

  it("excludes inline phonetic guides from the cell value", async () => {
    const worksheet =
      "<worksheet xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'><sheetData>" +
      "<row r='1'><c r='A1' t='inlineStr'><is><t>Name</t></is></c></row>" +
      "<row r='2'><c r='A2' t='inlineStr'><is><r><t>東京</t></r><rPh sb='0' eb='2'><t>とうきょう</t></rPh></is></c></row>" +
      "</sheetData></worksheet>";
    const input = source(
      await workbookFixtureWithParts({
        "xl/worksheets/sheet1.xml": worksheet,
      }),
    );
    const reader = await openWorkbookRegionStream(
      input.source,
      { range: "'Data & More'!A1:A2" },
      { scratch: new MemoryScratch(), chunkBytes: 29 },
    );

    expect(await rows(reader)).toEqual([
      {
        sourceRow: 2,
        cells: { Name: { kind: "string", value: "東京" } },
      },
    ]);
  });

  it("skips blank selected rows while retaining typed cells and source row gaps", async () => {
    const worksheet =
      "<worksheet xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'><sheetData>" +
      "<row r='1'><c r='A1' t='inlineStr'><is><t>Value</t></is></c></row>" +
      "<row r='2' s='1' customFormat='1'/>" +
      "<row r='3'><c r='A3' s='1'/></row>" +
      "<row r='4'><c r='A4' t='inlineStr'><is><t></t></is></c></row>" +
      "<row r='5'><c r='B5' t='inlineStr'><is><t>Outside selection</t></is></c></row>" +
      "<row r='6'><c r='A6'><v>0</v></c></row>" +
      "<row r='7'><c r='A7' t='b'><v>0</v></c></row>" +
      "<row r='8'><c r='A8' t='e'><v>#N/A</v></c></row>" +
      "<row r='9'><c r='A9'><f>1/0</f></c></row>" +
      "</sheetData></worksheet>";
    const input = source(
      await workbookFixtureWithParts({
        "xl/worksheets/sheet1.xml": worksheet,
      }),
    );
    const reader = await openWorkbookRegionStream(
      input.source,
      { range: "'Data & More'!A1:A9" },
      { scratch: new MemoryScratch(), chunkBytes: 31 },
    );

    expect(await rows(reader)).toEqual([
      {
        sourceRow: 6,
        cells: { Value: { kind: "number", raw: "0" } },
      },
      {
        sourceRow: 7,
        cells: { Value: { kind: "boolean", value: false } },
      },
      {
        sourceRow: 8,
        cells: { Value: { kind: "error", error: "#N/A" } },
      },
      {
        sourceRow: 9,
        cells: {
          Value: {
            kind: "formula",
            formula: "1/0",
            cached: { kind: "missing" },
          },
        },
      },
    ]);
  });

  it("shares scratch-backed strings across regions and closes them with the session", async () => {
    const scratch = new MemoryScratch();
    const input = source(await workbookFixture({ sharedStringCount: 2_000 }));
    const session = await openWorkbookStream(input.source, { scratch });
    expect(scratch.files).toHaveLength(2);
    expect(scratch.files[1]?.size).toBe(2_000 * 12);
    const first = await session.openRegion({ table: "InventoryTable" });
    const second = await session.openRegion({ range: "DataRange" });
    const firstRows = await rows(first);
    expect(firstRows[0]?.cells["ID & Code"]).toEqual({
      kind: "string",
      value: "string-1993",
    });
    await rows(second);
    expect(scratch.files.every((file) => !file.closed)).toBe(true);
    await session.close();
    expect(scratch.files.every((file) => file.closed)).toBe(true);
  });

  it("uses the ordinary 1900 date system when workbookPr disables date1904", async () => {
    const input = source(await workbookFixture({ date1904: false }));
    const reader = await openWorkbookRegionStream(
      input.source,
      { table: "InventoryTable" },
      { scratch: new MemoryScratch() },
    );
    const data = await rows(reader);
    expect(data[0]?.cells.Date).toEqual({
      kind: "date",
      raw: "1",
      iso: "1900-01-01",
    });
  });

  it("refuses Excel's fictitious 1900 leap day while retaining adjacent dates", async () => {
    const worksheet =
      "<worksheet xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'><sheetData>" +
      "<row r='1'><c r='A1' t='inlineStr'><is><t>Before</t></is></c><c r='B1' t='inlineStr'><is><t>Fake</t></is></c><c r='C1' t='inlineStr'><is><t>FakeFraction</t></is></c><c r='D1' t='inlineStr'><is><t>After</t></is></c><c r='E1' t='inlineStr'><is><t>Exponent</t></is></c></row>" +
      "<row r='2'><c r='A2' s='2'><v>59</v></c><c r='B2' s='2'><v>60</v></c><c r='C2' s='2'><v>60.5</v></c><c r='D2' s='2'><v>61</v></c><c r='E2' s='2'><v>6.1E1</v></c></row>" +
      "</sheetData></worksheet>";
    const input = source(
      await workbookFixtureWithParts(
        { "xl/worksheets/sheet1.xml": worksheet },
        { date1904: false },
      ),
    );
    const reader = await openWorkbookRegionStream(
      input.source,
      { range: "'Data & More'!A1:E2" },
      { scratch: new MemoryScratch() },
    );

    expect(await rows(reader)).toEqual([
      {
        sourceRow: 2,
        cells: {
          Before: { kind: "date", raw: "59", iso: "1900-02-28" },
          Fake: { kind: "number", raw: "60" },
          FakeFraction: { kind: "number", raw: "60.5" },
          After: { kind: "date", raw: "61", iso: "1900-03-01" },
          Exponent: { kind: "date", raw: "6.1E1", iso: "1900-03-01" },
        },
      },
    ]);
  });

  it("treats serial 60 as a real date in the 1904 date system", async () => {
    const worksheet =
      "<worksheet xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'><sheetData>" +
      "<row r='1'><c r='A1' t='inlineStr'><is><t>Epoch</t></is></c><c r='B1' t='inlineStr'><is><t>Sixty</t></is></c></row>" +
      "<row r='2'><c r='A2' s='2'><v>0</v></c><c r='B2' s='2'><v>60</v></c></row>" +
      "</sheetData></worksheet>";
    const input = source(
      await workbookFixtureWithParts({
        "xl/worksheets/sheet1.xml": worksheet,
      }),
    );
    const reader = await openWorkbookRegionStream(
      input.source,
      { range: "'Data & More'!A1:B2" },
      { scratch: new MemoryScratch() },
    );

    expect(await rows(reader)).toEqual([
      {
        sourceRow: 2,
        cells: {
          Epoch: { kind: "date", raw: "0", iso: "1904-01-01" },
          Sixty: { kind: "date", raw: "60", iso: "1904-03-01" },
        },
      },
    ]);
  });

  it("refuses an external relationship when it is the selected table target", async () => {
    const input = source(await workbookFixture({ externalTable: true }));
    await expect(
      inspectWorkbookStream(input.source, { scratch: new MemoryScratch() }),
    ).rejects.toMatchObject({ code: "XLSX_READ_FAILED" });
  });

  it("cancels and awaits worksheet production when a consumer stops early", async () => {
    const input = source(await workbookFixture());
    const session = await openWorkbookStream(input.source, {
      scratch: new MemoryScratch(),
    });
    const first = await session.openRegion({
      sheet: "Data & More",
      headerRow: 2,
    });
    for await (const batch of first.batches({ batchSize: 1 })) {
      expect(batch).toHaveLength(1);
      break;
    }
    const second = await session.openRegion({ table: "InventoryTable" });
    expect(await rows(second)).toHaveLength(2);
    await first.close();
    await session.close();
  });

  it("stops between row batches when the caller cancels", async () => {
    const scratch = new MemoryScratch();
    const input = source(await workbookFixture());
    const reader = await openWorkbookRegionStream(
      input.source,
      { table: "InventoryTable" },
      { scratch },
    );
    const controller = new AbortController();
    const batches = reader.batches({
      batchSize: 1,
      signal: controller.signal,
    });
    const iterator = batches[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
    controller.abort("stop after preview");
    await expect(iterator.next()).rejects.toMatchObject({
      code: "OPERATION_ABORTED",
    });
    expect(scratch.files.every((file) => file.closed)).toBe(true);
  });

  it("returns structured errors for cancellation, malformed XML, and limits", async () => {
    const bytes = await workbookFixture();
    const controller = new AbortController();
    controller.abort("test cancellation");
    await expect(
      inspectWorkbookStream(source(bytes).source, {
        scratch: new MemoryScratch(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });

    const duringReadController = new AbortController();
    await expect(
      inspectWorkbookStream(
        {
          name: "cancel-during-read.xlsx",
          size: bytes.byteLength,
          async readAt(offset, length) {
            duringReadController.abort("cancel during source read");
            return bytes.slice(offset, offset + length);
          },
        },
        {
          scratch: new MemoryScratch(),
          signal: duringReadController.signal,
        },
      ),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });

    const malformed = source(
      await workbookFixture({ malformedWorksheet: true }),
    );
    const malformedReader = await openWorkbookRegionStream(
      malformed.source,
      { table: "InventoryTable" },
      { scratch: new MemoryScratch() },
    );
    await expect(rows(malformedReader)).rejects.toBeInstanceOf(
      ConsultChimpsError,
    );

    await expect(
      inspectWorkbookStream(source(bytes).source, {
        scratch: new MemoryScratch(),
        maximumExpandedBytes: 100,
      }),
    ).rejects.toMatchObject({ code: "XLSX_READ_FAILED" });
    await expect(
      inspectWorkbookStream(source(bytes).source, {
        scratch: new MemoryScratch(),
        maximumMetadataBytes: 50,
      }),
    ).rejects.toMatchObject({ code: "XLSX_READ_FAILED" });

    const smallCellScratch = new MemoryScratch();
    await expect(
      openWorkbookStream(source(bytes).source, {
        scratch: smallCellScratch,
        maximumCellBytes: 3,
      }),
    ).rejects.toMatchObject({ code: "XLSX_READ_FAILED" });
    expect(smallCellScratch.files.every((file) => file.closed)).toBe(true);
  });

  it("rejects oversized shared and inline text while it is being parsed", async () => {
    const oversized = "x".repeat(256 * 1024);
    await expect(
      openWorkbookStream(
        source(await workbookFixture({ dataSharedString: oversized })).source,
        {
          scratch: new MemoryScratch(),
          maximumCellBytes: 1024,
        },
      ),
    ).rejects.toMatchObject({ code: "XLSX_READ_FAILED" });

    const reader = await openWorkbookRegionStream(
      source(await workbookFixture({ inlineValue: oversized })).source,
      { table: "InventoryTable" },
      { scratch: new MemoryScratch(), maximumCellBytes: 1024 },
    );
    await expect(rows(reader)).rejects.toMatchObject({
      code: "XLSX_READ_FAILED",
    });
  });

  it("rejects an oversized ZIP central directory before listing entries", async () => {
    const input = source(await workbookFixture(), 128);
    await expect(
      inspectWorkbookStream(input.source, {
        scratch: new MemoryScratch(),
        chunkBytes: 128,
        maximumCentralDirectoryBytes: 128,
      }),
    ).rejects.toMatchObject({ code: "XLSX_READ_FAILED" });
    expect(input.largestRead()).toBeLessThanOrEqual(128);
  });

  it("detects CRC corruption while streaming worksheet rows", async () => {
    const zip = await JSZip.loadAsync(await workbookFixture({ stored: true }));
    zip.file(
      "xl/worksheets/_rels/sheet1.xml.rels",
      "<Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'></Relationships>",
    );
    const corrupted = await zip.generateAsync({
      type: "uint8array",
      compression: "STORE",
    });
    const marker = new TextEncoder().encode("12345678901234567890.123456789");
    let offset = -1;
    for (let index = 0; index <= corrupted.length - marker.length; index += 1) {
      if (marker.every((byte, inner) => corrupted[index + inner] === byte)) {
        offset = index;
        break;
      }
    }
    expect(offset).toBeGreaterThanOrEqual(0);

    const input = source(corrupted);
    const inspection = await inspectWorkbookStream(input.source, {
      scratch: new MemoryScratch(),
    });
    expect(inspection.tables).toHaveLength(0);
    const reader = await openWorkbookRegionStream(
      input.source,
      { range: "'Data & More'!B2:E4" },
      { scratch: new MemoryScratch() },
    );
    corrupted[offset] = "9".charCodeAt(0);
    await expect(rows(reader)).rejects.toMatchObject({
      code: "XLSX_READ_FAILED",
    });
  });

  it("checks the worksheet CRC when a row consumer stops early", async () => {
    const corrupted = await workbookFixture({ stored: true });
    const marker = new TextEncoder().encode("Total");
    let offset = -1;
    for (let index = 0; index <= corrupted.length - marker.length; index += 1) {
      if (marker.every((byte, inner) => corrupted[index + inner] === byte)) {
        offset = index;
        break;
      }
    }
    expect(offset).toBeGreaterThanOrEqual(0);

    const session = await openWorkbookStream(source(corrupted).source, {
      scratch: new MemoryScratch(),
    });
    const reader = await session.openRegion({ table: "InventoryTable" });
    corrupted[offset] = "X".charCodeAt(0);
    const consumeOne = async () => {
      for await (const batch of reader.batches({ batchSize: 1 })) {
        expect(batch).toHaveLength(1);
        break;
      }
    };
    await expect(consumeOne()).rejects.toMatchObject({
      code: "XLSX_READ_FAILED",
    });
    await session.close();
  });
});
