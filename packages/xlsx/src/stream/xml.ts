import { SaxesParser, type SaxesTagPlain } from "saxes";

const MAXIMUM_XML_MARKUP_BYTES = 64 * 1024;

function entityBytes(entity: readonly number[]): number {
  const value = String.fromCharCode(...entity);
  if (
    value === "amp" ||
    value === "lt" ||
    value === "gt" ||
    value === "apos" ||
    value === "quot"
  )
    return 1;
  const numeric = /^#(?:x([\dA-Fa-f]+)|(\d+))$/u.exec(value);
  if (!numeric) return entity.length + 2;
  const codePoint = Number.parseInt(
    numeric[1] ?? numeric[2] ?? "",
    numeric[1] ? 16 : 10,
  );
  if (!Number.isSafeInteger(codePoint) || codePoint < 0)
    return entity.length + 2;
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return codePoint <= 0x10ffff ? 4 : entity.length + 2;
}

/** Bounds XML text before Saxes can buffer an open text or CDATA node. */
export class BoundedXmlText {
  #mode: "text" | "tag" | "comment" | "cdata" | "instruction" = "text";
  #tagPrefix = "";
  #tagBytes = 0;
  #quote: number | undefined;
  #ending = "";
  #activeElement: string | undefined;
  #textBytes = 0;
  #genericTextBytes = 0;
  #tokenBytes = 0;
  #entity: number[] | undefined;
  readonly #genericMaximumBytes: number;

  constructor(
    private readonly elements: ReadonlySet<string>,
    private readonly maximumBytes: number,
    private readonly errorMessage: (element: string) => string,
  ) {
    this.#genericMaximumBytes = Math.max(
      maximumBytes,
      MAXIMUM_XML_MARKUP_BYTES,
    );
  }

  consume(chunk: Uint8Array): void {
    let index = 0;
    while (index < chunk.length) {
      if (this.#mode === "text" && this.#entity === undefined) {
        const start = index;
        while (
          index < chunk.length &&
          chunk[index] !== 0x3c &&
          chunk[index] !== 0x26
        ) {
          index += 1;
        }
        if (index > start) this.#addTextBytes(index - start);
        if (index === chunk.length) break;
      }
      if (this.#mode === "tag") {
        index = this.#consumeTagBytes(chunk, index);
        continue;
      }
      this.#consumeByte(chunk[index] ?? 0);
      index += 1;
    }
  }

  #consumeTagBytes(chunk: Uint8Array, start: number): number {
    let index = start;
    while (index < chunk.length) {
      const byte = chunk[index] ?? 0;
      index += 1;
      this.#tagBytes += 1;
      if (this.#tagBytes > MAXIMUM_XML_MARKUP_BYTES) {
        throw new Error("An XML tag exceeds the 65536-byte parser limit.");
      }
      if (this.#tagPrefix.length < 16) {
        this.#tagPrefix += String.fromCharCode(byte);
        if (this.#tagPrefix === "<!--") {
          this.#mode = "comment";
          this.#ending = "";
          this.#tokenBytes = this.#tagBytes;
          return index;
        }
        if (this.#tagPrefix === "<![CDATA[") {
          this.#mode = "cdata";
          this.#ending = "";
          this.#genericTextBytes = 0;
          return index;
        }
        if (this.#tagPrefix === "<?") {
          this.#mode = "instruction";
          this.#ending = "";
          this.#tokenBytes = this.#tagBytes;
          return index;
        }
        if (
          this.#tagPrefix === "<!DOCTYPE" ||
          this.#tagPrefix === "<!doctype"
        ) {
          throw new Error(
            "Document type declarations are not allowed in XLSX XML.",
          );
        }
      }
      if (this.#quote !== undefined) {
        if (byte === this.#quote) this.#quote = undefined;
      } else if (byte === 0x22 || byte === 0x27) {
        this.#quote = byte;
      } else if (byte === 0x3e) {
        this.#finishTag();
        this.#mode = "text";
        return index;
      }
    }
    return index;
  }

  #consumeByte(byte: number): void {
    if (this.#mode === "text") {
      if (byte === 0x3c) {
        this.#finishEntity();
        this.#genericTextBytes = 0;
        this.#mode = "tag";
        this.#tagPrefix = "<";
        this.#tagBytes = 1;
        this.#quote = undefined;
      } else {
        this.#consumeTextByte(byte);
      }
      return;
    }
    if (this.#mode === "cdata") {
      this.#ending = `${this.#ending}${String.fromCharCode(byte)}`.slice(-3);
      if (this.#ending === "]]>") {
        this.#mode = "text";
        this.#ending = "";
        this.#genericTextBytes = 0;
      } else if (!"]]>".startsWith(this.#ending)) {
        this.#addTextBytes(this.#ending.length);
        this.#ending = "";
      }
      return;
    }
    if (this.#mode === "comment" || this.#mode === "instruction") {
      const terminator = this.#mode === "comment" ? "-->" : "?>";
      this.#tokenBytes += 1;
      if (this.#tokenBytes > MAXIMUM_XML_MARKUP_BYTES) {
        throw new Error(
          `An XML ${this.#mode === "comment" ? "comment" : "processing instruction"} exceeds the 65536-byte parser limit.`,
        );
      }
      this.#ending = `${this.#ending}${String.fromCharCode(byte)}`.slice(
        -terminator.length,
      );
      if (this.#ending === terminator) {
        this.#mode = "text";
        this.#ending = "";
        this.#genericTextBytes = 0;
      }
      return;
    }

    throw new Error(`Unexpected XML scanner mode: ${this.#mode}`);
  }

  #consumeTextByte(byte: number): void {
    if (this.#entity !== undefined) {
      if (byte === 0x3b) {
        this.#addTextBytes(entityBytes(this.#entity));
        this.#entity = undefined;
      } else if (this.#entity.length < 32) {
        this.#entity.push(byte);
      } else {
        throw new Error("An XML entity exceeds the 32-byte parser limit.");
      }
    } else if (byte === 0x26) {
      this.#entity = [];
    } else {
      this.#addTextBytes(1);
    }
  }

  #finishEntity(): void {
    if (this.#entity === undefined) return;
    this.#addTextBytes(this.#entity.length + 1);
    this.#entity = undefined;
  }

  #addTextBytes(count: number): void {
    this.#genericTextBytes += count;
    if (this.#genericTextBytes > this.#genericMaximumBytes) {
      throw new Error(
        `An XML text node exceeds the ${this.#genericMaximumBytes}-byte parser limit.`,
      );
    }
    if (this.#activeElement !== undefined) {
      this.#textBytes += count;
    }
    if (
      this.#activeElement !== undefined &&
      this.#textBytes > this.maximumBytes
    ) {
      throw new Error(this.errorMessage(this.#activeElement));
    }
  }

  #finishTag(): void {
    const body = (
      this.#tagPrefix.endsWith(">")
        ? this.#tagPrefix.slice(1, -1)
        : this.#tagPrefix.slice(1)
    ).trim();
    const closing = body.startsWith("/");
    const name = body
      .slice(closing ? 1 : 0)
      .trimStart()
      .split(/[\s/>]/u, 1)[0];
    if (!name) return;
    const local = localName(name);
    if (!this.elements.has(local)) return;
    if (closing) {
      this.#finishEntity();
      this.#activeElement = undefined;
    } else if (!body.endsWith("/")) {
      this.#activeElement = local;
      this.#textBytes = 0;
      this.#entity = undefined;
    }
    this.#genericTextBytes = 0;
  }
}

export function localName(name: string): string {
  return name.slice(name.lastIndexOf(":") + 1);
}

export function attribute(
  tag: SaxesTagPlain,
  name: string,
): string | undefined {
  for (const [key, value] of Object.entries(tag.attributes)) {
    if (localName(key) === name) return String(value);
  }
  return undefined;
}

export function relationshipId(tag: SaxesTagPlain): string | undefined {
  const exact = tag.attributes["r:id"];
  if (exact !== undefined) return String(exact);
  return attribute(tag, "id");
}

export function parseXml(
  xml: string,
  configure: (parser: SaxesParser) => void,
): void {
  const parser = new SaxesParser();
  configure(parser);
  parser.write(xml);
  parser.close();
}

export function resolvePart(ownerPart: string, target: string): string {
  if (
    target.includes("?") ||
    target.includes("#") ||
    target.includes("\\") ||
    target.startsWith("//") ||
    /^[A-Za-z][A-Za-z\d+.-]*:/u.test(target)
  ) {
    throw new Error(
      `The relationship target "${target}" is not a package part.`,
    );
  }
  let decoded: string;
  try {
    decoded = decodeURI(target);
  } catch (cause) {
    throw new Error(`The relationship target "${target}" is not valid.`, {
      cause,
    });
  }
  const ownerSegments = ownerPart.split("/");
  ownerSegments.pop();
  const segments = decoded.startsWith("/") ? [] : ownerSegments;
  for (const segment of decoded.replace(/^\/+/, "").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) {
        throw new Error(
          `The relationship target "${target}" leaves the package.`,
        );
      }
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  const resolved = segments.join("/");
  if (resolved.length === 0) {
    throw new Error(`The relationship target "${target}" leaves the package.`);
  }
  return resolved;
}

export interface CellRectangle {
  readonly startColumn: number;
  readonly endColumn: number;
  readonly firstRow: number;
  readonly lastRow: number;
}

export function columnIndex(reference: string): number | undefined {
  const letters = /^\$?([A-Za-z]{1,3})/u.exec(reference)?.[1];
  if (!letters) return undefined;
  const index = [...letters.toUpperCase()].reduce(
    (result, letter) => result * 26 + letter.charCodeAt(0) - 64,
    0,
  );
  return index <= 16_384 ? index - 1 : undefined;
}

export function cellRow(reference: string): number | undefined {
  const value = Number(/\$?(\d+)$/u.exec(reference)?.[1]);
  return Number.isSafeInteger(value) && value >= 1 && value <= 1_048_576
    ? value
    : undefined;
}

export function parseLocalRectangle(
  reference: string,
): CellRectangle | undefined {
  const match =
    /^(\$?[A-Za-z]{1,3}\$?\d+)(?::(\$?[A-Za-z]{1,3}\$?\d+))?$/u.exec(
      reference.trim(),
    );
  if (!match?.[1]) return undefined;
  const end = match[2] ?? match[1];
  const startColumn = columnIndex(match[1]);
  const endColumn = columnIndex(end);
  const firstRow = cellRow(match[1]);
  const lastRow = cellRow(end);
  if (
    startColumn === undefined ||
    endColumn === undefined ||
    firstRow === undefined ||
    lastRow === undefined ||
    endColumn < startColumn ||
    lastRow < firstRow
  ) {
    return undefined;
  }
  return { startColumn, endColumn, firstRow, lastRow };
}

export function parseQualifiedRectangle(
  reference: string,
): (CellRectangle & { readonly sheet: string }) | undefined {
  const match = /^(?:'((?:[^']|'')+)'|([^'!,:]+))!(.+)$/u.exec(
    reference.trim(),
  );
  if (!match?.[3]) return undefined;
  const rectangle = parseLocalRectangle(match[3]);
  if (!rectangle) return undefined;
  return {
    ...rectangle,
    sheet: (match[1] ?? match[2] ?? "").replaceAll("''", "'"),
  };
}
