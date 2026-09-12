import { databaseError } from "../errors.js";
import { assertSafeIdentifier } from "../schema.js";
import type { ImportRecipe, ImportRoute, ImportSource } from "./types.js";

function safeSuggestedName(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replace(/[^\p{L}\p{N}_]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 200);
  const result =
    normalized.length === 0 || normalized.startsWith("_consultchimps")
      ? "Imported_Data"
      : normalized;
  assertSafeIdentifier(result, "table");
  return result;
}

function prefixFor(name: string): string {
  const letters = name
    .split(/[^\p{L}\p{N}]+/gu)
    .filter((part) => part.length > 0)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  return (letters || name.slice(0, 3)).slice(0, 8).toUpperCase();
}

export async function draftImportRecipe(options: {
  readonly sources: readonly ImportSource[];
  readonly into?: string | undefined;
}): Promise<ImportRecipe> {
  if (options.sources.length === 0) {
    throw databaseError(
      "DB_IMPORT_NO_SOURCES",
      "Choose at least one source before drafting an import recipe.",
    );
  }
  const routes: ImportRoute[] = [];
  let selectionCount = 0;
  for (const source of options.sources) {
    for (const selection of source.selections) {
      selectionCount += 1;
      const name = safeSuggestedName(
        options.into ??
          (source.selections.length === 1 ? source.key : selection.label),
      );
      routes.push({
        source: source.key,
        selection: selection.key,
        destination: {
          kind: "new-table-infer",
          name,
          recordId: { prefix: prefixFor(name), padding: 6 },
        },
        columns: [],
      });
    }
  }
  if (options.into !== undefined && selectionCount !== 1) {
    throw databaseError(
      "DB_IMPORT_INTO_AMBIGUOUS",
      "The destination override can be used only when exactly one source region is selected.",
    );
  }
  return { version: 1, routes };
}
