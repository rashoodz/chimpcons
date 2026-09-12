import { DuckDBInstance } from "@duckdb/node-api";
import JSZip from "jszip";
import { mkdir, readFile, stat, lstat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import process from "node:process";

for (const name of [
  "attributes-100000.xlsx",
  "attributes-300000.xlsx",
  "attributes-1000000.xlsx",
  "seven-million.xlsx",
]) {
  try {
    await lstat(`dist/${name}`);
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  throw new Error(`Fixture already exists: dist/${name}`);
}
await mkdir("dist", { recursive: true });
const instance = await DuckDBInstance.create(":memory:");
const connection = await instance.connect();
try {
  await connection.run("INSTALL excel; LOAD excel");
  for (const rows of [100000, 300000, 1000000]) {
    const path = `dist/attributes-${rows}.xlsx`;
    await connection.run(
      `COPY (SELECT i AS attribute_id, 'attribute_'||i AS attribute_name, i%10=0 AS is_cde, i%10000 AS dataset_id FROM range(${rows}) t(i)) TO '${path}' WITH (FORMAT xlsx, HEADER true)`,
    );
  }
} finally {
  connection.closeSync();
  instance.closeSync();
}
const archive = await JSZip.loadAsync(
  await readFile("dist/attributes-1000000.xlsx"),
);
const originalSheet = await archive
  .file("xl/worksheets/sheet1.xml")
  .async("nodebuffer");
const book = await archive.file("xl/workbook.xml").async("string");
archive.file(
  "xl/workbook.xml",
  book.replace(
    /<sheets>.*?<\/sheets>/s,
    "<sheets>" +
      Array.from(
        { length: 7 },
        (_, i) =>
          `<sheet name="Sheet${i + 1}" sheetId="${i + 1}" r:id="rId${i + 3}"/>`,
      ).join("") +
      "</sheets>",
  ),
);
const relationships = await archive
  .file("xl/_rels/workbook.xml.rels")
  .async("string");
const contentTypes = await archive.file("[Content_Types].xml").async("string");
archive.file(
  "xl/_rels/workbook.xml.rels",
  relationships.replace(
    "</Relationships>",
    Array.from(
      { length: 6 },
      (_, i) =>
        `<Relationship Id="rId${i + 4}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 2}.xml"/>`,
    ).join("") + "</Relationships>",
  ),
);
archive.file(
  "[Content_Types].xml",
  contentTypes.replace(
    "</Types>",
    Array.from(
      { length: 6 },
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 2}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    ).join("") + "</Types>",
  ),
);
for (let sheet = 1; sheet <= 7; sheet++)
  archive.file(`xl/worksheets/sheet${sheet}.xml`, originalSheet);
await pipeline(
  archive.generateNodeStream({
    streamFiles: true,
    compression: "DEFLATE",
    compressionOptions: { level: 1 },
  }),
  createWriteStream("dist/seven-million.xlsx", { flags: "wx" }),
);
process.stdout.write(
  JSON.stringify({
    workbookBytes: (await stat("dist/seven-million.xlsx")).size,
  }) + "\n",
);
