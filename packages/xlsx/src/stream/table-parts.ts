import type { FileEntry } from "@zip.js/zip.js";

import type { WorkbookStreamOptions } from "./types.js";
import { parseXml, relationshipId } from "./xml.js";
import { entryChunks } from "./zip.js";

const MAXIMUM_WORKSHEET_TAG_BYTES = 64 * 1024;

function xmlSpace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function asciiEquals(
  bytes: readonly number[],
  start: number,
  end: number,
  expected: string,
): boolean {
  if (end - start !== expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[start + index] !== expected.charCodeAt(index)) return false;
  }
  return true;
}

function worksheetTableTag(bytes: readonly number[]): {
  readonly name: "tablePart" | "tableParts";
  readonly closing: boolean;
  readonly selfClosing: boolean;
} | null {
  let index = 1;
  while (xmlSpace(bytes[index] ?? 0)) index += 1;
  const closing = bytes[index] === 0x2f;
  if (closing) index += 1;
  while (xmlSpace(bytes[index] ?? 0)) index += 1;
  let localStart = index;
  while (index < bytes.length) {
    const byte = bytes[index] ?? 0;
    if (xmlSpace(byte) || byte === 0x2f || byte === 0x3e) break;
    if (byte === 0x3a) localStart = index + 1;
    index += 1;
  }
  const name = asciiEquals(bytes, localStart, index, "tablePart")
    ? "tablePart"
    : asciiEquals(bytes, localStart, index, "tableParts")
      ? "tableParts"
      : undefined;
  if (name === undefined) return null;
  let ending = bytes.length - 2;
  while (ending >= 0 && xmlSpace(bytes[ending] ?? 0)) ending -= 1;
  return { name, closing, selfClosing: bytes[ending] === 0x2f };
}

class TablePartScanner {
  #mode: "text" | "tag" | "comment" | "cdata" | "instruction" = "text";
  #tag: number[] = [];
  #quote: number | undefined;
  #previousByte = 0;
  #penultimateByte = 0;
  #insideTableParts = 0;
  readonly #activeRelationshipIds: string[] = [];
  readonly #seenRelationshipIds = new Set<string>();
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(private readonly relationshipIds: ReadonlySet<string>) {}

  consume(chunk: Uint8Array): void {
    for (const byte of chunk) this.#consumeByte(byte);
  }

  finish(): readonly string[] {
    if (this.#mode !== "text") {
      throw new Error(
        "A worksheet ended inside XML markup while reading its table references.",
      );
    }
    return this.#activeRelationshipIds;
  }

  #consumeByte(byte: number): void {
    if (
      this.#mode === "comment" ||
      this.#mode === "cdata" ||
      this.#mode === "instruction"
    ) {
      this.#skipMarkup(byte);
      return;
    }
    if (this.#mode === "text") {
      if (byte === 0x3c) {
        this.#mode = "tag";
        this.#tag = [byte];
        this.#quote = undefined;
      }
      return;
    }

    this.#tag.push(byte);
    if (this.#tag.length > MAXIMUM_WORKSHEET_TAG_BYTES) {
      throw new Error(
        `A worksheet tag exceeds the ${MAXIMUM_WORKSHEET_TAG_BYTES}-byte parser limit.`,
      );
    }
    if (this.#tag.length === 4 && asciiEquals(this.#tag, 0, 4, "<!--")) {
      this.#startSkipping("comment");
      return;
    }
    if (this.#tag.length === 9 && asciiEquals(this.#tag, 0, 9, "<![CDATA[")) {
      this.#startSkipping("cdata");
      return;
    }
    if (this.#tag.length === 2 && asciiEquals(this.#tag, 0, 2, "<?")) {
      this.#startSkipping("instruction");
      return;
    }
    if (
      this.#tag.length === 9 &&
      String.fromCharCode(...this.#tag).toUpperCase() === "<!DOCTYPE"
    ) {
      throw new Error(
        "Document type declarations are not allowed in XLSX XML.",
      );
    }
    if (this.#quote !== undefined) {
      if (byte === this.#quote) this.#quote = undefined;
      return;
    }
    if (byte === 0x22 || byte === 0x27) {
      this.#quote = byte;
      return;
    }
    if (byte !== 0x3e) return;
    this.#readTag(this.#tag);
    this.#mode = "text";
    this.#tag = [];
  }

  #startSkipping(mode: "comment" | "cdata" | "instruction"): void {
    this.#mode = mode;
    this.#tag = [];
    this.#previousByte = 0;
    this.#penultimateByte = 0;
  }

  #skipMarkup(byte: number): void {
    const finished =
      this.#mode === "instruction"
        ? this.#previousByte === 0x3f && byte === 0x3e
        : this.#mode === "comment"
          ? this.#penultimateByte === 0x2d &&
            this.#previousByte === 0x2d &&
            byte === 0x3e
          : this.#penultimateByte === 0x5d &&
            this.#previousByte === 0x5d &&
            byte === 0x3e;
    this.#penultimateByte = this.#previousByte;
    this.#previousByte = byte;
    if (finished) {
      this.#mode = "text";
      this.#previousByte = 0;
      this.#penultimateByte = 0;
    }
  }

  #readTag(bytes: readonly number[]): void {
    const tag = worksheetTableTag(bytes);
    if (tag === null) return;
    if (tag.name === "tableParts") {
      if (tag.closing) {
        this.#insideTableParts = Math.max(0, this.#insideTableParts - 1);
      } else if (!tag.selfClosing) {
        this.#insideTableParts += 1;
      }
      return;
    }
    if (tag.closing || this.#insideTableParts === 0) return;
    const markup = this.#decoder.decode(new Uint8Array(bytes));
    let id: string | undefined;
    const standalone = tag.selfClosing ? markup : `${markup.slice(0, -1)}/>`;
    parseXml(standalone, (parser) => {
      parser.on("opentag", (element) => {
        id = relationshipId(element);
      });
    });
    if (!id) {
      throw new Error("A worksheet tablePart is missing its relationship ID.");
    }
    if (!this.relationshipIds.has(id)) {
      throw new Error(
        `A worksheet tablePart references missing relationship "${id}".`,
      );
    }
    if (this.#seenRelationshipIds.has(id)) {
      throw new Error(
        `Worksheet table relationship "${id}" is referenced more than once.`,
      );
    }
    this.#seenRelationshipIds.add(id);
    this.#activeRelationshipIds.push(id);
  }
}

export async function activeTableRelationshipIds(
  entry: FileEntry,
  relationshipIds: ReadonlySet<string>,
  options: WorkbookStreamOptions,
): Promise<readonly string[]> {
  const scanner = new TablePartScanner(relationshipIds);
  for await (const chunk of entryChunks(entry, {
    signal: options.signal,
    onProgress: options.onProgress,
    stage: "worksheet-metadata",
  })) {
    scanner.consume(chunk);
  }
  return scanner.finish();
}
