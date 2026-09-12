import type { RandomAccessFile } from "@consultchimps/core";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  openWorkbookRegionStream,
  openWorkbookStream,
  type ScratchFactory,
  type WorkbookRegionReader,
} from "../src/stream.js";

class MemoryFile implements RandomAccessFile {
  #bytes = new Uint8Array();

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
    this.#bytes = this.#bytes.slice(0, size);
  }

  async close(): Promise<void> {}
}

class MemoryScratch implements ScratchFactory {
  #nextId = 0;

  async create(): Promise<MemoryFile> {
    return new MemoryFile(`scratch-${this.#nextId++}`);
  }
}

function source(bytes: Uint8Array) {
  return {
    name: "selection-ambiguity.xlsx",
    size: bytes.byteLength,
    async readAt(offset: number, length: number) {
      return bytes.slice(offset, offset + length);
    },
  };
}

async function fixture(options: {
  readonly duplicateSheet?: boolean;
  readonly duplicateTable?: boolean;
}): Promise<Uint8Array> {
  const zip = new JSZip();
  const sheets = options.duplicateSheet
    ? "<sheet name='Data' sheetId='1' r:id='sheet1'/><sheet name='data' sheetId='2' r:id='sheet2'/>"
    : "<sheet name='Data' sheetId='1' r:id='sheet1'/>";
  const workbookRelationships = options.duplicateSheet
    ? "<Relationship Id='sheet1' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet' Target='worksheets/sheet1.xml'/><Relationship Id='sheet2' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet' Target='worksheets/sheet2.xml'/>"
    : "<Relationship Id='sheet1' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet' Target='worksheets/sheet1.xml'/>";
  const tableParts = options.duplicateTable
    ? "<tableParts count='2'><tablePart r:id='table1'/><tablePart r:id='table2'/></tableParts>"
    : "<tableParts count='1'><tablePart r:id='table1'/></tableParts>";
  const tableRelationships = options.duplicateTable
    ? "<Relationship Id='table1' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/table' Target='../tables/table1.xml'/><Relationship Id='table2' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/table' Target='../tables/table2.xml'/>"
    : "<Relationship Id='table1' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/table' Target='../tables/table1.xml'/>";

  zip.file(
    "[Content_Types].xml",
    "<Types xmlns='http://schemas.openxmlformats.org/package/2006/content-types'/>",
  );
  zip.file(
    "_rels/.rels",
    "<Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'><Relationship Id='office' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument' Target='xl/workbook.xml'/></Relationships>",
  );
  zip.file(
    "xl/workbook.xml",
    `<workbook xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main' xmlns:r='http://schemas.openxmlformats.org/officeDocument/2006/relationships'><sheets>${sheets}</sheets></workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'>${workbookRelationships}</Relationships>`,
  );
  zip.file(
    "xl/worksheets/sheet1.xml",
    `<worksheet xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main' xmlns:r='http://schemas.openxmlformats.org/officeDocument/2006/relationships'><sheetData><row r='1'><c r='A1' t='inlineStr'><is><t>Code</t></is></c><c r='B1' t='inlineStr'><is><t>Name</t></is></c></row><row r='2'><c r='A2'><v>1</v></c><c r='B2' t='inlineStr'><is><t>North</t></is></c></row></sheetData>${tableParts}</worksheet>`,
  );
  if (options.duplicateSheet) {
    zip.file(
      "xl/worksheets/sheet2.xml",
      "<worksheet xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'><sheetData><row r='1'><c r='A1' t='inlineStr'><is><t>Other</t></is></c></row><row r='2'><c r='A2'><v>2</v></c></row></sheetData></worksheet>",
    );
  }
  zip.file(
    "xl/worksheets/_rels/sheet1.xml.rels",
    `<Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'>${tableRelationships}</Relationships>`,
  );
  zip.file(
    "xl/tables/table1.xml",
    "<table xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main' id='1' name='Inventory' displayName='Inventory' ref='A1:A2'><tableColumns count='1'><tableColumn id='1' name='Code'/></tableColumns></table>",
  );
  if (options.duplicateTable) {
    zip.file(
      "xl/tables/table2.xml",
      "<table xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main' id='2' name='inventory' displayName='inventory' ref='B1:B2'><tableColumns count='1'><tableColumn id='1' name='Name'/></tableColumns></table>",
    );
  }
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

async function firstRow(reader: WorkbookRegionReader) {
  for await (const batch of reader.batches({ batchSize: 1 })) {
    await reader.close();
    return batch[0];
  }
  await reader.close();
  return undefined;
}

describe("stream selection name ambiguity", () => {
  it("rejects duplicate case-folded worksheet names even for exact spelling", async () => {
    const bytes = await fixture({ duplicateSheet: true });

    await expect(
      openWorkbookRegionStream(
        source(bytes),
        { sheet: "Data", headerRow: 1 },
        { scratch: new MemoryScratch() },
      ),
    ).rejects.toMatchObject({
      code: "XLSX_WORKSHEET_NOT_FOUND",
      message: expect.stringMatching(/matches more than one worksheet/i),
    });
  });

  it("rejects duplicate case-folded Excel Table names even for exact spelling", async () => {
    const bytes = await fixture({ duplicateTable: true });

    await expect(
      openWorkbookRegionStream(
        source(bytes),
        { table: "Inventory" },
        { scratch: new MemoryScratch() },
      ),
    ).rejects.toMatchObject({
      code: "XLSX_INVALID_EXCEL_TABLE",
      message: expect.stringMatching(/matches more than one Excel Table/i),
    });
  });

  it("keeps case-insensitive selection for unique worksheet and table names", async () => {
    const bytes = await fixture({});
    const workbook = await openWorkbookStream(source(bytes), {
      scratch: new MemoryScratch(),
    });

    const worksheet = await workbook.openRegion({
      sheet: "data",
      headerRow: 1,
    });
    expect(await firstRow(worksheet)).toMatchObject({
      sourceRow: 2,
      cells: { Code: { kind: "number", raw: "1" } },
    });

    const table = await workbook.openRegion({ table: "inventory" });
    expect(await firstRow(table)).toMatchObject({
      sourceRow: 2,
      cells: { Code: { kind: "number", raw: "1" } },
    });
    await workbook.close();
  });
});
