import { attribute, localName, parseXml } from "./xml.js";
import { readMetadataText, type ZipPackage } from "./zip.js";
import type { FileEntry } from "@zip.js/zip.js";
import { calendarIsoText, serialCalendarParts } from "../model/calendar.js";

export interface WorkbookStyles {
  readonly date1904: boolean;
  hasStyle(styleIndex: number): boolean;
  isDateStyle(styleIndex: number): boolean;
  dateValue(raw: string, styleIndex: number): string | undefined;
}

const BUILT_IN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
]);

const LOCALE_INDEPENDENT_BUILT_IN_TIME_FORMATS = new Set([
  18, 19, 20, 21, 22, 45, 46, 47,
]);

function customDateFormat(format: string): boolean {
  const cleaned = format
    .replace(/"[^"]*"/gu, "")
    .replace(/\\./gu, "")
    .replace(/\[(?!h+\]|m+\]|s+\])[^\]]*\]/giu, "")
    .replace(/_.|\*./gu, "")
    .toLowerCase();
  return /(?:^|[^a-z])[ymdhs]+(?:[^a-z]|$)/u.test(cleaned);
}

function hasTime(format: string | undefined): boolean {
  if (!format) return false;
  const cleaned = format
    .replace(/"[^"]*"/gu, "")
    .replace(/\\./gu, "")
    .toLowerCase();
  return /[hs]/u.test(cleaned) || /\[[hms]+\]/u.test(cleaned);
}

function formatHasTime(format: {
  readonly id: number;
  readonly code?: string | undefined;
}): boolean {
  return format.code === undefined
    ? LOCALE_INDEPENDENT_BUILT_IN_TIME_FORMATS.has(format.id)
    : hasTime(format.code);
}

function isElapsedFormat(format: {
  readonly id: number;
  readonly code?: string | undefined;
}): boolean {
  if (format.code === undefined) return format.id === 46;
  const cleaned = format.code.replace(/"[^"]*"/gu, "").replace(/\\./gu, "");
  return /\[(?:h{1,2}|m{1,2}|s{1,2})\]/iu.test(cleaned);
}

function serialDate(
  raw: string,
  date1904: boolean,
  includeTime: boolean,
): string | undefined {
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/u.test(raw)) {
    return undefined;
  }
  const serial = Number(raw);
  const parts = serialCalendarParts(serial, date1904);
  if (parts === undefined) return undefined;
  const iso = calendarIsoText(parts);
  const carriesTime =
    parts.hour !== 0 ||
    parts.minute !== 0 ||
    parts.second !== 0 ||
    parts.millisecond !== 0;
  return !includeTime && !carriesTime ? iso.slice(0, 10) : iso.slice(0, -1);
}

export async function loadWorkbookStyles(
  archive: ZipPackage,
  entry: FileEntry | undefined,
  date1904: boolean,
  signal: AbortSignal | undefined,
): Promise<WorkbookStyles> {
  const customFormats = new Map<number, string>();
  const cellFormats: {
    readonly id: number;
    readonly code?: string | undefined;
  }[] = [];
  if (entry) {
    const xml = await readMetadataText(entry, archive.limits, signal);
    let insideCellFormats = false;
    parseXml(xml, (parser) => {
      parser.on("opentag", (tag) => {
        const name = localName(tag.name);
        if (name === "numFmt") {
          const id = Number(attribute(tag, "numFmtId"));
          const code = attribute(tag, "formatCode");
          if (Number.isSafeInteger(id) && id >= 0 && code !== undefined) {
            customFormats.set(id, code);
          }
        } else if (name === "cellXfs") {
          insideCellFormats = true;
        } else if (insideCellFormats && name === "xf") {
          const id = Number(attribute(tag, "numFmtId") ?? "0");
          if (!Number.isSafeInteger(id) || id < 0) {
            throw new Error("A cell style has an invalid number format ID.");
          }
          cellFormats.push({ id, code: customFormats.get(id) });
        }
      });
      parser.on("closetag", (tag) => {
        if (localName(tag.name) === "cellXfs") insideCellFormats = false;
      });
    });
  }
  const dateStyles = new Set<number>();
  for (const [index, format] of cellFormats.entries()) {
    if (
      !isElapsedFormat(format) &&
      ((format.code === undefined && BUILT_IN_DATE_FORMATS.has(format.id)) ||
        (format.code !== undefined && customDateFormat(format.code)))
    ) {
      dateStyles.add(index);
    }
  }
  return {
    date1904,
    hasStyle(styleIndex) {
      return entry === undefined
        ? styleIndex === 0
        : cellFormats[styleIndex] !== undefined;
    },
    isDateStyle(styleIndex) {
      return dateStyles.has(styleIndex);
    },
    dateValue(raw, styleIndex) {
      const format = cellFormats[styleIndex];
      if (!dateStyles.has(styleIndex)) return undefined;
      return serialDate(
        raw,
        date1904,
        format !== undefined && formatHasTime(format),
      );
    },
  };
}
