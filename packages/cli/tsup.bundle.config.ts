import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

// Native database bindings are installed beside this entry in the portable
// archive. Its Node major, operating system, and architecture identify the ABI.
export default defineConfig({
  entry: { consultchimps: "src/index.ts" },
  format: "esm",
  outDir: "dist-bundle",
  noExternal: [/^(?!better-sqlite3(?:\/|$)|@duckdb\/node-api(?:\/|$)).*/],
  external: ["better-sqlite3", "@duckdb/node-api"],
  splitting: false,
  metafile: true,
  clean: true,
  outExtension: () => ({ js: ".mjs" }),
  define: {
    CONSULTCHIMPS_BUNDLED_VERSION: JSON.stringify(version),
  },
  banner: {
    // Bundled CommonJS dependencies require() node builtins at runtime;
    // ESM output has no require in scope unless we create one.
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});
