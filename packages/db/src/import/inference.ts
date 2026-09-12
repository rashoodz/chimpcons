import { databaseError } from "../errors.js";
import type { EngineValue } from "../internal/engine.js";
import {
  COLUMN_TYPES,
  type ColumnDefinition,
  type ColumnType,
} from "../schema.js";
import type { ImportCell } from "./types.js";

const SIGNED_BIGINT_MIN = -(2n ** 63n);
const SIGNED_BIGINT_MAX = 2n ** 63n - 1n;

export interface InferredColumn {
  readonly name: string;
  readonly type: ColumnType;
  readonly precision?: number | undefined;
  readonly scale?: number | undefined;
}

export interface ColumnProfile {
  seen: boolean;
  onlyBoolean: boolean;
  onlyDate: boolean;
  dateHasTime: boolean;
  onlyNumber: boolean;
  integerInRange: boolean;
  decimalCompatible: boolean;
  finiteNumber: boolean;
  integerDigits: number;
  scale: number;
}

function storedObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw databaseError(
      "DB_INVALID_PREPARED_IMPORT",
      `The import plan has invalid ${label}.`,
      { label },
    );
  }
  return value as Record<string, unknown>;
}

function storedString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw databaseError(
      "DB_INVALID_PREPARED_IMPORT",
      `The import plan has invalid ${label}.`,
      { label },
    );
  }
  return value;
}

function isColumnType(value: unknown): value is ColumnType {
  return COLUMN_TYPES.some((candidate) => candidate === value);
}

function parseStoredJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw databaseError(
      "DB_INVALID_PREPARED_IMPORT",
      `The import plan ${label} are not valid JSON.`,
      { label },
      cause,
    );
  }
}

export function parseInferredColumns(
  value: unknown,
): readonly InferredColumn[] {
  if (!Array.isArray(value)) {
    throw databaseError(
      "DB_INVALID_PREPARED_IMPORT",
      "The import plan has invalid captured columns.",
    );
  }
  return value.map((entry) => {
    const column = storedObject(entry, "captured column");
    const name = storedString(column["name"], "captured column name");
    const type = column["type"];
    if (!isColumnType(type)) {
      throw databaseError(
        "DB_INVALID_PREPARED_IMPORT",
        "The import plan has an unsupported captured column type.",
        { column: name, type },
      );
    }
    if (type !== "decimal") return { name, type };
    const precision = column["precision"];
    const scale = column["scale"];
    if (
      typeof precision !== "number" ||
      !Number.isInteger(precision) ||
      precision < 1 ||
      precision > 38 ||
      typeof scale !== "number" ||
      !Number.isInteger(scale) ||
      scale < 0 ||
      scale > precision
    ) {
      throw databaseError(
        "DB_INVALID_PREPARED_IMPORT",
        "The import plan has invalid captured decimal precision or scale.",
        { column: name },
      );
    }
    return { name, type, precision, scale };
  });
}

export function parseInferredColumnsJson(
  text: string,
): readonly InferredColumn[] {
  return parseInferredColumns(parseStoredJson(text, "captured columns"));
}

function parseStoredCell(value: unknown, allowFormula: boolean): ImportCell {
  const cell = storedObject(value, "captured cell");
  switch (cell["kind"]) {
    case "blank":
      return { kind: "blank" };
    case "string":
      return {
        kind: "string",
        value: storedString(cell["value"], "captured string value"),
      };
    case "number":
      return {
        kind: "number",
        raw: storedString(cell["raw"], "captured number value"),
      };
    case "boolean":
      if (typeof cell["value"] !== "boolean") break;
      return { kind: "boolean", value: cell["value"] };
    case "date":
      return {
        kind: "date",
        raw: storedString(cell["raw"], "captured date value"),
        iso: storedString(cell["iso"], "captured ISO date"),
      };
    case "error":
      return {
        kind: "error",
        error: storedString(cell["error"], "captured error value"),
      };
    case "formula": {
      if (!allowFormula) break;
      const cached = storedObject(cell["cached"], "cached formula value");
      const formula = cell["formula"];
      if (formula !== undefined && typeof formula !== "string") break;
      if (cached["kind"] === "missing") {
        return {
          kind: "formula",
          ...(formula === undefined ? {} : { formula }),
          cached: { kind: "missing" },
        };
      }
      const parsedCached = parseStoredCell(cached, false);
      if (parsedCached.kind === "formula") break;
      return {
        kind: "formula",
        ...(formula === undefined ? {} : { formula }),
        cached: parsedCached,
      };
    }
  }
  throw databaseError(
    "DB_INVALID_PREPARED_IMPORT",
    "The import plan contains an invalid captured cell.",
    { kind: cell["kind"] },
  );
}

export function parseImportCells(
  value: unknown,
): Readonly<Record<string, ImportCell>> {
  const cells = storedObject(value, "captured row values");
  const parsed: Record<string, ImportCell> = Object.create(null);
  for (const [name, cell] of Object.entries(cells)) {
    parsed[name] = parseStoredCell(cell, true);
  }
  return parsed;
}

export function parseImportCellsJson(
  text: string,
): Readonly<Record<string, ImportCell>> {
  return parseImportCells(parseStoredJson(text, "captured row values"));
}

function effectiveCell(
  cell: ImportCell,
): Exclude<ImportCell, { readonly kind: "formula" }> {
  if (cell.kind !== "formula") return cell;
  if (cell.cached.kind === "missing") {
    throw databaseError(
      "DB_IMPORT_UNCACHED_FORMULA",
      "A selected formula has no cached value. Recalculate and save the workbook before importing it.",
    );
  }
  return cell.cached;
}

function dateIso(cell: Extract<ImportCell, { readonly kind: "date" }>): string {
  const source = cell.raw.trim();
  return /^\d{4}-\d{2}-\d{2}$/u.test(source) &&
    cell.iso === `${source}T00:00:00.000Z`
    ? source
    : cell.iso;
}

function decimalShape(
  raw: string,
): { readonly precision: number; readonly scale: number } | null {
  const match = /^[-+]?(\d+)(?:\.(\d+))?$/u.exec(raw);
  if (match === null) return null;
  const whole = (match[1] ?? "0").replace(/^0+(?=\d)/u, "");
  const fraction = match[2] ?? "";
  return {
    precision: Math.max(1, whole.length + fraction.length),
    scale: fraction.length,
  };
}

export function emptyProfile(): ColumnProfile {
  return {
    seen: false,
    onlyBoolean: true,
    onlyDate: true,
    dateHasTime: false,
    onlyNumber: true,
    integerInRange: true,
    decimalCompatible: true,
    finiteNumber: true,
    integerDigits: 1,
    scale: 0,
  };
}

export function addToProfile(profile: ColumnProfile, input: ImportCell): void {
  const cell = effectiveCell(input);
  if (cell.kind === "blank") return;
  profile.seen = true;
  profile.onlyBoolean &&= cell.kind === "boolean";
  profile.onlyDate &&= cell.kind === "date";
  profile.dateHasTime ||= cell.kind === "date" && dateIso(cell).includes("T");
  profile.onlyNumber &&= cell.kind === "number";
  if (cell.kind !== "number") {
    profile.integerInRange = false;
    profile.decimalCompatible = false;
    profile.finiteNumber = false;
    return;
  }
  if (!/^-?\d+$/u.test(cell.raw)) {
    profile.integerInRange = false;
  } else {
    const integer = BigInt(cell.raw);
    profile.integerInRange &&=
      integer >= SIGNED_BIGINT_MIN && integer <= SIGNED_BIGINT_MAX;
  }
  const shape = decimalShape(cell.raw);
  if (shape === null || shape.precision > 38) {
    profile.decimalCompatible = false;
  } else {
    profile.integerDigits = Math.max(
      profile.integerDigits,
      shape.precision - shape.scale,
    );
    profile.scale = Math.max(profile.scale, shape.scale);
  }
  profile.finiteNumber &&= Number.isFinite(Number(cell.raw));
}

export function inferColumns(
  names: readonly string[],
  profiles: ReadonlyMap<string, ColumnProfile>,
): InferredColumn[] {
  return names.map((name) => {
    const profile = profiles.get(name) ?? emptyProfile();
    if (!profile.seen) return { name, type: "text" };
    if (profile.onlyBoolean) return { name, type: "boolean" };
    if (profile.onlyDate) {
      return {
        name,
        type: profile.dateHasTime ? "timestamp" : "date",
      };
    }
    if (profile.onlyNumber) {
      if (profile.integerInRange) return { name, type: "integer" };
      if (
        profile.decimalCompatible &&
        profile.integerDigits + profile.scale <= 38
      ) {
        return {
          name,
          type: "decimal",
          precision: profile.integerDigits + profile.scale,
          scale: profile.scale,
        };
      }
      if (profile.finiteNumber) return { name, type: "real" };
    }
    return { name, type: "text" };
  });
}

export function valueForColumn(
  cell: ImportCell | undefined,
  column: ColumnDefinition,
): EngineValue {
  const value = effectiveCell(cell ?? { kind: "blank" });
  const type = column.type;
  if (value.kind === "blank") {
    if (column.nullable === false) {
      throw databaseError(
        "DB_IMPORT_REQUIRED_VALUE",
        `The required column "${column.name}" cannot store a blank value.`,
        { column: column.name },
      );
    }
    return null;
  }
  if (value.kind === "error") {
    throw databaseError(
      "DB_IMPORT_ERROR_CELL",
      `A selected cell contains the Excel error ${value.error}. Fix it before importing.`,
    );
  }
  if (type === "text") {
    switch (value.kind) {
      case "string":
        return value.value;
      case "number":
      case "date":
        return value.raw;
      case "boolean":
        return value.value ? "true" : "false";
    }
  }
  if (type === "boolean" && value.kind === "boolean") return value.value;
  if (
    type === "integer" &&
    value.kind === "number" &&
    /^-?\d+$/u.test(value.raw)
  ) {
    const parsed = BigInt(value.raw);
    if (parsed >= SIGNED_BIGINT_MIN && parsed <= SIGNED_BIGINT_MAX) {
      return parsed;
    }
  }
  if (type === "real" && value.kind === "number") {
    const parsed = Number(value.raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (type === "decimal" && value.kind === "number") {
    const shape = decimalShape(value.raw);
    if (
      shape !== null &&
      column.precision !== undefined &&
      column.scale !== undefined &&
      shape.scale <= column.scale &&
      shape.precision - shape.scale <= column.precision - column.scale
    ) {
      return value.raw;
    }
  }
  if (value.kind === "date") {
    const iso = dateIso(value);
    if (type === "date" && !iso.includes("T")) return iso;
    if (type === "timestamp") {
      return iso.includes("T") ? iso : `${iso}T00:00:00.000Z`;
    }
  }
  throw databaseError(
    "DB_IMPORT_VALUE_CONFLICT",
    `A ${value.kind} value cannot be stored in a ${type} column without an explicit conversion.`,
    { sourceType: value.kind, targetType: type },
  );
}
