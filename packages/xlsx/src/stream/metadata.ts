import type { RandomAccessSource } from "@consultchimps/core";
import type { FileEntry } from "@zip.js/zip.js";
import type { SaxesTagPlain } from "saxes";

import {
  attribute,
  localName,
  parseLocalRectangle,
  parseXml,
  relationshipId,
  resolvePart,
} from "./xml.js";
import { activeTableRelationshipIds } from "./table-parts.js";
import type {
  StreamNamedRange,
  StreamSheet,
  StreamTable,
  WorkbookStreamInspection,
  WorkbookStreamOptions,
} from "./types.js";
import {
  openZipPackage,
  readMetadataText,
  workbookFailure,
  type ZipPackage,
} from "./zip.js";

interface Relationship {
  readonly id: string;
  readonly type: string;
  readonly target: string;
  readonly external: boolean;
}

export interface LoadedSheet extends StreamSheet {
  readonly part: string;
}

export interface WorkbookMetadata {
  readonly source: RandomAccessSource;
  readonly archive: ZipPackage;
  readonly sheets: readonly LoadedSheet[];
  readonly inspection: WorkbookStreamInspection;
  readonly sharedStringsEntry: FileEntry | undefined;
  readonly stylesEntry: FileEntry | undefined;
  readonly date1904: boolean;
}

function relationshipPart(ownerPart: string): string {
  const slash = ownerPart.lastIndexOf("/");
  const directory = slash < 0 ? "" : ownerPart.slice(0, slash + 1);
  const filename = ownerPart.slice(slash + 1);
  return `${directory}_rels/${filename}.rels`;
}

function parseRelationships(xml: string): readonly Relationship[] {
  const relationships: Relationship[] = [];
  const relationshipIds = new Set<string>();
  parseXml(xml, (parser) => {
    parser.on("opentag", (tag) => {
      if (localName(tag.name) !== "Relationship") return;
      const id = attribute(tag, "Id");
      const type = attribute(tag, "Type");
      const target = attribute(tag, "Target");
      if (!id || !type || !target) {
        throw new Error(
          "A workbook relationship is missing Id, Type, or Target.",
        );
      }
      if (relationshipIds.has(id)) {
        throw new Error(`Relationship ID "${id}" is declared more than once.`);
      }
      relationshipIds.add(id);
      relationships.push({
        id,
        type,
        target,
        external: attribute(tag, "TargetMode")?.toLowerCase() === "external",
      });
    });
  });
  return relationships;
}

function internalTarget(ownerPart: string, relationship: Relationship): string {
  if (relationship.external) {
    throw new Error(
      `Relationship "${relationship.id}" uses an external target, which workbook streaming does not read.`,
    );
  }
  return resolvePart(ownerPart, relationship.target);
}

interface WorkbookDocument {
  readonly sheets: readonly {
    readonly name: string;
    readonly relationshipId: string;
    readonly visibility: StreamSheet["visibility"];
  }[];
  readonly namedRanges: readonly StreamNamedRange[];
  readonly date1904: boolean;
}

function parseWorkbook(xml: string): WorkbookDocument {
  const sheets: {
    name: string;
    relationshipId: string;
    visibility: StreamSheet["visibility"];
  }[] = [];
  const namedRanges: StreamNamedRange[] = [];
  let date1904 = false;
  let activeDefinedName:
    | { readonly name: string; readonly localSheetId?: number | undefined }
    | undefined;
  let definedNameText = "";

  parseXml(xml, (parser) => {
    parser.on("opentag", (tag) => {
      const name = localName(tag.name);
      if (name === "workbookPr") {
        const raw = attribute(tag, "date1904");
        date1904 = raw === "1" || raw?.toLowerCase() === "true";
      } else if (name === "sheet") {
        const sheetName = attribute(tag, "name");
        const id = relationshipId(tag);
        if (!sheetName || !id) {
          throw new Error(
            "A worksheet is missing its name or relationship ID.",
          );
        }
        const state = attribute(tag, "state");
        sheets.push({
          name: sheetName,
          relationshipId: id,
          visibility:
            state === "hidden" || state === "veryHidden" ? state : "visible",
        });
      } else if (name === "definedName") {
        const rangeName = attribute(tag, "name");
        if (!rangeName)
          throw new Error("A defined name has no name attribute.");
        const local = attribute(tag, "localSheetId");
        const localSheetId = local === undefined ? undefined : Number(local);
        if (
          localSheetId !== undefined &&
          (!Number.isSafeInteger(localSheetId) || localSheetId < 0)
        ) {
          throw new Error(
            `Defined name "${rangeName}" has an invalid sheet ID.`,
          );
        }
        activeDefinedName = {
          name: rangeName,
          ...(localSheetId === undefined ? {} : { localSheetId }),
        };
        definedNameText = "";
      }
    });
    const appendDefinedName = (text: string) => {
      if (activeDefinedName) definedNameText += text;
    };
    parser.on("text", appendDefinedName);
    parser.on("cdata", appendDefinedName);
    parser.on("closetag", (tag) => {
      if (localName(tag.name) !== "definedName" || !activeDefinedName) return;
      namedRanges.push({
        ...activeDefinedName,
        reference: definedNameText.trim(),
      });
      activeDefinedName = undefined;
    });
  });
  return { sheets, namedRanges, date1904 };
}

function parseTable(xml: string, sheet: string): StreamTable {
  let tableTag: SaxesTagPlain | undefined;
  const columns: string[] = [];
  parseXml(xml, (parser) => {
    parser.on("opentag", (tag) => {
      const name = localName(tag.name);
      if (name === "table" && tableTag === undefined) tableTag = tag;
      if (name === "tableColumn") {
        const columnName = attribute(tag, "name");
        if (columnName === undefined) {
          throw new Error("An Excel Table column has no name.");
        }
        columns.push(columnName);
      }
    });
  });
  if (!tableTag) throw new Error("An Excel Table part has no table element.");
  const name =
    attribute(tableTag, "name") ?? attribute(tableTag, "displayName");
  const reference = attribute(tableTag, "ref");
  const rectangle = reference ? parseLocalRectangle(reference) : undefined;
  const headerRowCount = Number(attribute(tableTag, "headerRowCount") ?? "1");
  const totalsRowCount = Number(attribute(tableTag, "totalsRowCount") ?? "0");
  if (
    !name ||
    !reference ||
    !rectangle ||
    headerRowCount !== 1 ||
    !Number.isSafeInteger(totalsRowCount) ||
    totalsRowCount < 0 ||
    totalsRowCount > 1 ||
    columns.length !== rectangle.endColumn - rectangle.startColumn + 1
  ) {
    throw new Error(
      `Excel Table "${name ?? "(unnamed)"}" does not have one header row and one declared column per worksheet column.`,
    );
  }
  return {
    name,
    sheet,
    reference,
    headerRow: rectangle.firstRow,
    totalsRow: totalsRowCount === 1,
    columns,
  };
}

function relationshipBySuffix(
  relationships: readonly Relationship[],
  suffix: string,
): Relationship | undefined {
  let match: Relationship | undefined;
  for (const relationship of relationships) {
    if (!relationship.type.endsWith(suffix)) continue;
    if (match !== undefined) {
      throw new Error(
        `Relationship role "${suffix.slice(1)}" is declared more than once.`,
      );
    }
    match = relationship;
  }
  return match;
}

export async function loadWorkbookMetadata(
  source: RandomAccessSource,
  options: WorkbookStreamOptions,
): Promise<WorkbookMetadata> {
  const archive = await openZipPackage(source, options);
  try {
    let workbookPart = "xl/workbook.xml";
    const packageRelationshipsEntry = archive.entries.get("_rels/.rels");
    if (packageRelationshipsEntry) {
      const packageRelationships = parseRelationships(
        await readMetadataText(
          packageRelationshipsEntry,
          archive.limits,
          options.signal,
        ),
      );
      const officeDocument = relationshipBySuffix(
        packageRelationships,
        "/officeDocument",
      );
      if (officeDocument) workbookPart = internalTarget("", officeDocument);
    }
    const workbookEntry = archive.entries.get(workbookPart);
    const workbookRelationshipsEntry = archive.entries.get(
      relationshipPart(workbookPart),
    );
    if (!workbookEntry || !workbookRelationshipsEntry) {
      throw new Error(
        "The ZIP package does not contain workbook.xml and its relationships.",
      );
    }
    const [workbookXml, relationshipXml] = await Promise.all([
      readMetadataText(workbookEntry, archive.limits, options.signal),
      readMetadataText(
        workbookRelationshipsEntry,
        archive.limits,
        options.signal,
      ),
    ]);
    const workbook = parseWorkbook(workbookXml);
    const relationships = parseRelationships(relationshipXml);
    const relationshipMap = new Map(
      relationships.map((relationship) => [relationship.id, relationship]),
    );
    const sheets: LoadedSheet[] = workbook.sheets.map((sheet) => {
      const relationship = relationshipMap.get(sheet.relationshipId);
      if (!relationship || !relationship.type.endsWith("/worksheet")) {
        throw new Error(
          `Worksheet "${sheet.name}" does not point to a worksheet part.`,
        );
      }
      const part = internalTarget(workbookPart, relationship);
      if (!archive.entries.has(part)) {
        throw new Error(`Worksheet "${sheet.name}" is missing part "${part}".`);
      }
      return { name: sheet.name, visibility: sheet.visibility, part };
    });

    const tables: StreamTable[] = [];
    for (const sheet of sheets) {
      const relationshipsEntry = archive.entries.get(
        relationshipPart(sheet.part),
      );
      if (!relationshipsEntry) continue;
      const sheetRelationships = parseRelationships(
        await readMetadataText(
          relationshipsEntry,
          archive.limits,
          options.signal,
        ),
      );
      if (
        !sheetRelationships.some((relationship) =>
          relationship.type.endsWith("/table"),
        )
      ) {
        continue;
      }
      const sheetEntry = archive.entries.get(sheet.part);
      if (!sheetEntry) {
        throw new Error(
          `Worksheet "${sheet.name}" is missing its worksheet part.`,
        );
      }
      const relationshipsById = new Map(
        sheetRelationships.map((relationship) => [
          relationship.id,
          relationship,
        ]),
      );
      const activeIds = await activeTableRelationshipIds(
        sheetEntry,
        new Set(relationshipsById.keys()),
        options,
      );
      for (const id of activeIds) {
        const relationship = relationshipsById.get(id);
        if (relationship === undefined) {
          throw new Error(
            `Worksheet "${sheet.name}" references missing table relationship "${id}".`,
          );
        }
        if (!relationship.type.endsWith("/table")) {
          throw new Error(
            `Worksheet "${sheet.name}" relationship "${id}" does not point to an Excel Table.`,
          );
        }
        const tablePart = internalTarget(sheet.part, relationship);
        const tableEntry = archive.entries.get(tablePart);
        if (!tableEntry) {
          throw new Error(
            `Worksheet "${sheet.name}" points to missing table part "${tablePart}".`,
          );
        }
        tables.push(
          parseTable(
            await readMetadataText(tableEntry, archive.limits, options.signal),
            sheet.name,
          ),
        );
      }
    }
    const sharedStringsRelationship = relationshipBySuffix(
      relationships,
      "/sharedStrings",
    );
    const stylesRelationship = relationshipBySuffix(relationships, "/styles");
    const partEntry = (
      relationship: Relationship | undefined,
    ): FileEntry | undefined => {
      if (relationship === undefined) return undefined;
      const part = internalTarget(workbookPart, relationship);
      const entry = archive.entries.get(part);
      if (entry === undefined) {
        throw new Error(
          `Relationship "${relationship.id}" points to missing part "${part}".`,
        );
      }
      return entry;
    };
    return {
      source,
      archive,
      sheets,
      inspection: {
        sheets: sheets.map(({ name, visibility }) => ({ name, visibility })),
        tables,
        namedRanges: workbook.namedRanges,
      },
      sharedStringsEntry: partEntry(sharedStringsRelationship),
      stylesEntry: partEntry(stylesRelationship),
      date1904: workbook.date1904,
    };
  } catch (cause) {
    await archive.reader.close().catch(() => undefined);
    throw workbookFailure(source, cause, options.signal);
  }
}
