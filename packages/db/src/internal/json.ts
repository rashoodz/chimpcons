import { databaseError } from "../errors.js";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

function sortedJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(sortedJson).join(",")}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${sortedJson(child)}`)
    .join(",")}}`;
}

export function canonicalJson(value: unknown): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw databaseError(
      "DB_INVALID_JSON_VALUE",
      "Database metadata must contain JSON-compatible values without circular references or BigInt values.",
      undefined,
      error,
    );
  }
  if (serialized === undefined) {
    throw databaseError(
      "DB_INVALID_JSON_VALUE",
      "Provide a JSON value for database metadata. The top-level value cannot be undefined, a function, or a symbol.",
    );
  }
  return sortedJson(JSON.parse(serialized) as JsonValue);
}
