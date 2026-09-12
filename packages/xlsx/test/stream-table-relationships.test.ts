import type { RandomAccessFile } from "@consultchimps/core";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { inspectWorkbookStream, type ScratchFactory } from "../src/stream.js";

const scratch: ScratchFactory = {
  async create(): Promise<RandomAccessFile> {
    throw new Error("Workbook inspection must not create scratch files.");
  },
};

function source(bytes: Uint8Array) {
  return {
    name: "table-relationships.xlsx",
    size: bytes.byteLength,
    async readAt(offset: number, length: number): Promise<Uint8Array> {
      return bytes.slice(offset, offset + length);
    },
  };
}

function table(name: string): string {
  return `<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" name="${name}" displayName="${name}" ref="A1:A2"><tableColumns count="1"><tableColumn id="1" name="Value"/></tableColumns></table>`;
}

async function workbook(options: {
  readonly tableParts: string;
  readonly relationships: string;
  readonly packageRelationships?: string;
  readonly workbookRelationships?: string;
}): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  );
  zip.file(
    "_rels/.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${options.packageRelationships ?? '<Relationship Id="office" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'}</Relationships>`,
  );
  zip.file(
    "xl/workbook.xml",
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="sheet"/></sheets></workbook>',
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${options.workbookRelationships ?? '<Relationship Id="sheet" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'}</Relationships>`,
  );
  zip.file(
    "xl/worksheets/sheet1.xml",
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Value</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Active</t></is></c></row></sheetData>${options.tableParts}</worksheet>`,
  );
  zip.file(
    "xl/worksheets/sheet2.xml",
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Substituted</t></is></c></row></sheetData></worksheet>',
  );
  zip.file(
    "xl/worksheets/_rels/sheet1.xml.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${options.relationships}</Relationships>`,
  );
  zip.file("xl/tables/table1.xml", table("ActiveTable"));
  zip.file("xl/tables/table2.xml", table("OrphanTable"));
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

const activeRelationship =
  '<Relationship Id="active" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/>';
const orphanRelationship =
  '<Relationship Id="orphan" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table2.xml"/>';

describe("streamed worksheet table relationships", () => {
  it("rejects more than one office document relationship", async () => {
    const bytes = await workbook({
      tableParts: "",
      relationships: "",
      packageRelationships:
        '<Relationship Id="office-one" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="office-two" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/substituted.xml"/>',
    });

    await expect(
      inspectWorkbookStream(source(bytes), { scratch }),
    ).rejects.toMatchObject({
      code: "XLSX_READ_FAILED",
      cause: expect.objectContaining({
        message: expect.stringMatching(/officeDocument.*more than once/iu),
      }),
    });
  });

  it.each(["styles", "sharedStrings"])(
    "rejects more than one %s relationship",
    async (role) => {
      const bytes = await workbook({
        tableParts: "",
        relationships: "",
        workbookRelationships: `<Relationship Id="sheet" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="first" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${role}" Target="first.xml"/><Relationship Id="second" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${role}" Target="second.xml"/>`,
      });

      await expect(
        inspectWorkbookStream(source(bytes), { scratch }),
      ).rejects.toMatchObject({
        code: "XLSX_READ_FAILED",
        cause: expect.objectContaining({
          message: expect.stringMatching(
            new RegExp(`${role}.*more than once`, "iu"),
          ),
        }),
      });
    },
  );

  it("rejects a duplicate workbook relationship ID with conflicting targets", async () => {
    const bytes = await workbook({
      tableParts: "",
      relationships: "",
      workbookRelationships:
        '<Relationship Id="sheet" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="sheet" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>',
    });

    await expect(
      inspectWorkbookStream(source(bytes), { scratch }),
    ).rejects.toMatchObject({
      code: "XLSX_READ_FAILED",
      cause: expect.objectContaining({
        message: expect.stringMatching(/relationship.*sheet.*more than once/iu),
      }),
    });
  });

  it("rejects a duplicate inactive worksheet relationship ID", async () => {
    const bytes = await workbook({
      tableParts: "",
      relationships:
        '<Relationship Id="duplicate" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://one.invalid" TargetMode="External"/><Relationship Id="duplicate" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://two.invalid" TargetMode="External"/>',
    });

    await expect(
      inspectWorkbookStream(source(bytes), { scratch }),
    ).rejects.toMatchObject({
      code: "XLSX_READ_FAILED",
      cause: expect.objectContaining({
        message: expect.stringMatching(
          /relationship.*duplicate.*more than once/iu,
        ),
      }),
    });
  });

  it("ignores stale table relationships that the worksheet does not activate", async () => {
    const bytes = await workbook({
      tableParts:
        '<tableParts count="1"><tablePart r:id="active"/></tableParts>',
      relationships: activeRelationship + orphanRelationship,
    });

    const inspection = await inspectWorkbookStream(source(bytes), { scratch });

    expect(inspection.tables).toEqual([
      expect.objectContaining({ name: "ActiveTable", sheet: "Data" }),
    ]);
  });

  it("reads namespaced references without treating comments, CDATA, or instructions as active", async () => {
    const bytes = await workbook({
      tableParts: `<!-- <tableParts><tablePart r:id="orphan"/></tableParts> --><![CDATA[<tableParts><tablePart r:id="orphan"/></tableParts>]]><?ignored <tablePart r:id="orphan"?>><x:tableParts xmlns:x="urn:worksheet" count="1"><x:tablePart note="quoted > delimiter" r:id="active"/></x:tableParts>`,
      relationships: activeRelationship + orphanRelationship,
    });

    const inspection = await inspectWorkbookStream(source(bytes), { scratch });

    expect(inspection.tables.map((entry) => entry.name)).toEqual([
      "ActiveTable",
    ]);
  });

  it.each([
    {
      case: "missing",
      tableParts:
        '<tableParts count="2"><tablePart r:id="active"/><tablePart r:id="missing"/></tableParts>',
      cause: "missing",
    },
    {
      case: "duplicate",
      tableParts:
        '<tableParts count="2"><tablePart r:id="active"/><tablePart r:id="active"/></tableParts>',
      cause: "more than once",
    },
    {
      case: "ID-less",
      tableParts: '<tableParts count="1"><tablePart/></tableParts>',
      cause: "missing its relationship ID",
    },
  ])(
    "rejects a $case active table relationship",
    async ({ tableParts, cause }) => {
      const bytes = await workbook({
        tableParts,
        relationships: activeRelationship,
      });

      await expect(
        inspectWorkbookStream(source(bytes), { scratch }),
      ).rejects.toMatchObject({
        code: "XLSX_READ_FAILED",
        cause: expect.objectContaining({
          message: expect.stringContaining(cause),
        }),
      });
    },
  );

  it("rejects an active ID declared by more than one relationship", async () => {
    const bytes = await workbook({
      tableParts:
        '<tableParts count="1"><tablePart r:id="active"/></tableParts>',
      relationships:
        activeRelationship +
        '<Relationship Id="active" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table2.xml"/>',
    });

    await expect(
      inspectWorkbookStream(source(bytes), { scratch }),
    ).rejects.toMatchObject({
      code: "XLSX_READ_FAILED",
      cause: expect.objectContaining({
        message: expect.stringContaining("more than once"),
      }),
    });
  });

  it("bounds retained worksheet tag markup", async () => {
    const bytes = await workbook({
      tableParts: `<tableParts count="1"><tablePart note="${"x".repeat(65_536)}" r:id="active"/></tableParts>`,
      relationships: activeRelationship,
    });

    await expect(
      inspectWorkbookStream(source(bytes), { scratch }),
    ).rejects.toMatchObject({
      code: "XLSX_READ_FAILED",
      cause: expect.objectContaining({
        message: expect.stringContaining("65536-byte parser limit"),
      }),
    });
  });
});
