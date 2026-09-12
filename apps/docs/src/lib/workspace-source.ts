import type { WorkspaceImportFile } from "./workspace-protocol";

const WORKSPACE_SOURCE_METADATA = " | workspace-input=";
const SOURCE_ORDINAL_WIDTH = String(Number.MAX_SAFE_INTEGER).length;

interface WorkspaceSourceMetadata {
  readonly version: 1;
  readonly ordinal?: number;
  readonly id: string;
  readonly fileName: string;
  readonly role: string;
  readonly revision: string;
}

function sourceDisplayName(metadata: WorkspaceSourceMetadata): string {
  return [
    metadata.fileName,
    metadata.role === "" ? "" : `role=${metadata.role}`,
    metadata.revision === "" ? "" : `revision=${metadata.revision}`,
  ]
    .filter(Boolean)
    .join(" | ");
}

function sourceMetadata(source: string): WorkspaceSourceMetadata | undefined {
  const marker = source.lastIndexOf(WORKSPACE_SOURCE_METADATA);
  if (marker < 0) return undefined;
  try {
    const encoded = source.slice(marker + WORKSPACE_SOURCE_METADATA.length);
    const sortablePrefix = new RegExp(`^\\d{${String(SOURCE_ORDINAL_WIDTH)}}:`);
    const payload = sortablePrefix.test(encoded)
      ? encoded.slice(SOURCE_ORDINAL_WIDTH + 1)
      : encoded;
    const value: unknown = JSON.parse(decodeURIComponent(payload));
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !("version" in value) ||
      value.version !== 1 ||
      !("id" in value) ||
      typeof value.id !== "string" ||
      !("fileName" in value) ||
      typeof value.fileName !== "string" ||
      !("role" in value) ||
      typeof value.role !== "string" ||
      !("revision" in value) ||
      typeof value.revision !== "string" ||
      ("ordinal" in value &&
        (typeof value.ordinal !== "number" ||
          !Number.isSafeInteger(value.ordinal) ||
          value.ordinal < 0))
    ) {
      return undefined;
    }
    return {
      version: 1,
      ...("ordinal" in value ? { ordinal: value.ordinal as number } : {}),
      id: value.id,
      fileName: value.fileName,
      role: value.role,
      revision: value.revision,
    };
  } catch {
    return undefined;
  }
}

export function workspaceSourceKey(
  source: WorkspaceImportFile,
  ordinal: number,
): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new Error(
      "The workbook source position must be a non-negative whole number",
    );
  }
  const metadata: WorkspaceSourceMetadata = {
    version: 1,
    ordinal,
    id: source.id,
    fileName: source.file.name,
    role: source.role.trim(),
    revision: source.revision.trim(),
  };
  const sortableOrdinal = String(ordinal).padStart(SOURCE_ORDINAL_WIDTH, "0");
  return `${sourceDisplayName(metadata)}${WORKSPACE_SOURCE_METADATA}${sortableOrdinal}:${encodeURIComponent(JSON.stringify(metadata))}`;
}

export function workspaceSourceFileName(source: string): string {
  return (
    sourceMetadata(source)?.fileName ?? source.split(" | ", 1)[0] ?? source
  );
}

export function workspaceSourceDescription(source: string): string {
  const metadata = sourceMetadata(source);
  return metadata === undefined ? source : sourceDisplayName(metadata);
}
