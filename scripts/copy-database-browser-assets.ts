import { createRequire } from "node:module";
import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";

const requireFromDocs = createRequire(
  path.join(import.meta.dirname, "../apps/docs/package.json"),
);
const outputDirectory = path.join(
  import.meta.dirname,
  "../apps/docs/public/database-wasm",
);

const assets = [
  {
    source: requireFromDocs.resolve("@sqlite.org/sqlite-wasm/sqlite3.wasm"),
    name: "sqlite3.wasm",
  },
  {
    source: requireFromDocs.resolve("@duckdb/duckdb-wasm/dist/duckdb-eh.wasm"),
    name: "duckdb-eh.wasm",
  },
  {
    source: requireFromDocs.resolve(
      "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js",
    ),
    name: "duckdb-browser-eh.worker.js",
  },
] as const;

await mkdir(outputDirectory, { recursive: true });
for (const asset of assets) {
  const destination = path.join(outputDirectory, asset.name);
  await copyFile(asset.source, destination);
  const copied = await stat(destination);
  process.stdout.write(
    `Copied ${asset.name} to the docs app (${copied.size.toLocaleString("en-US")} bytes)\n`,
  );
}
