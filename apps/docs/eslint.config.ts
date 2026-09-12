import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

export default defineConfig([
  ...nextVitals,
  globalIgnores([
    ".next/**",
    ".source/**",
    "blob-report/**",
    "out/**",
    "playwright-report/**",
    "public/database-wasm/**",
    "test-results/**",
    "next-env.d.ts",
  ]),
]);
