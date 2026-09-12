# ConsultChimps

Composable, local-first operations tools for consultants.

`consultchimps` turns common document and data chores into deterministic
TypeScript modules that can run from a library, CLI, desktop application,
server, or automation. AI may assist with ambiguous work later, but the core
tools do not require Codex or any hosted service.

Documentation:
[consultchimps.github.io/consultchimps](https://consultchimps.github.io/consultchimps/)

## Operations

Every operation the toolkit ships, and which of its three surfaces you can use
it from today. The rows come from the operation registry in
[`apps/docs/src/lib/tools.ts`](apps/docs/src/lib/tools.ts), which is what the
documentation site renders its cards and tabs from;
`scripts/check-readme-operations.ts` fails `pnpm docs:check`, and therefore
`pnpm check` and CI, when this table and that registry disagree.

| Operation                        | CLI   | Library | Browser |
| -------------------------------- | ----- | ------- | ------- |
| Consolidate spreadsheets         | Works | Works   | Works   |
| Merge workbook tabs              | Works | Works   | Works   |
| Split spreadsheets               | Works | Works   | Works   |
| Populate PowerPoint templates    | Works | Works   | Works   |
| Split PDF pages                  | Works | Works   | Works   |
| Merge PDF packs                  | Works | Works   | Works   |
| Inspect PowerPoint templates     | Works | Works   | Works   |
| Inspect workbooks                | Works | Works   | Works   |
| Unprotect Excel workbooks        | Works | Works   | Works   |
| Import workbooks into a database | Works | Works   | Works   |

## Packages

| Package                   | Responsibility                                                             |
| ------------------------- | -------------------------------------------------------------------------- |
| `@consultchimps/core`     | Shared errors, artifacts, and operation results                            |
| `@consultchimps/files`    | Input discovery and safe output-path handling                              |
| `@consultchimps/tabular`  | Runtime-neutral table model, union, and column mapping                     |
| `@consultchimps/theme`    | Runtime-neutral palette model and colour validation                        |
| `@consultchimps/db`       | Persistent SQLite and DuckDB files, schemas, imports, and delivery history |
| `@consultchimps/xlsx`     | Excel workbook input and output                                            |
| `@consultchimps/pptx`     | PowerPoint template inspection and population                              |
| `@consultchimps/pdf`      | PDF split and merge operations                                             |
| `@consultchimps/messages` | Plain-language rendering of results and errors                             |
| `consultchimps`           | Command-line interface                                                     |

## Install

Requirements:

- Node.js 22 or later (development happens on Node 24)

Run the CLI without keeping a global installation:

```bash
npx consultchimps@latest --help
```

For releases containing the persistent database commands, portable CLI archives
include the native engine dependencies. Download the archive matching your
operating system, architecture, and Node major from the
[latest release](https://github.com/consultchimps/consultchimps/releases/latest)
and extract it. Keep `node_modules` beside `consultchimps.mjs`, then run:

```bash
node consultchimps.mjs --help
```

The portable build targets Node 24. The npm distribution supports the package's
declared Node versions and installs the corresponding native bindings. Older
releases' single-file bundles do not include the new database commands.

Or install it globally:

```bash
npm install --global consultchimps
consultchimps --help
```

Applications should install only the library boundary they need. For example,
the workbook adapter brings its internal ConsultChimps dependencies with it:

```bash
npm install @consultchimps/xlsx
```

All published packages are public on npm under the `consultchimps` name and
`@consultchimps` organization scope.

## Run from source

Development requires pnpm 11:

```bash
pnpm install
pnpm build

pnpm consultchimps sheets consolidate "inputs/**/*.xlsx" \
  --output outputs/consolidated.xlsx

pnpm consultchimps sheets merge "inputs/**/*.xlsx" \
  --values \
  --output outputs/all-sheets.xlsx

pnpm consultchimps sheets split "Sprint 2 Datasets.xlsx" \
  --column "Entity Name" \
  --output-dir outputs/by-entity \
  --values

pnpm consultchimps sheets split clients.xlsx \
  --table ClientData \
  --column Region \
  --output outputs/by-region

pnpm consultchimps sheets split clients.xlsx \
  --range ClientRange \
  --column Region \
  --output outputs/by-region

pnpm consultchimps pptx populate \
  --template profile-template.pptx \
  --data companies.xlsx \
  --sheet Companies \
  --template-slide 1 \
  --output outputs/company-profiles.pptx

pnpm consultchimps pdf split report.pdf --output outputs/pages

pnpm consultchimps pdf merge "inputs/**/*.pdf" \
  --output outputs/combined.pdf
```

Excel consolidation reads every visible, non-empty worksheet, unions columns by
case-insensitive header name, and adds `_source_file`, `_source_sheet`, and
`_source_row` columns. Consolidated cells are values rather than formulas.
Original files are never modified.

Excel splitting creates one workbook per normalized, non-blank value found in
the selected column across all worksheets. Each output retains every worksheet
in its original order; sheets containing the column are filtered and sheets
without it are copied unchanged. Matching trims whitespace, ignores case, and
treats ordinary numeric text like the equivalent number. Filenames are portable,
all destinations are checked before writing, and `.xlsx` and `.xlsm` sources are
supported. Add `--values` to replace formulas across the outputs with their
saved cached results while preserving formatting. A named Excel Table, named
range, or worksheet can still be selected for the established single-source
modes.

PowerPoint population reads `{{field_name}}` placeholders from one selected
template slide and creates one populated slide per nonempty Excel record. The
first slide and first worksheet are used by default, and both can be selected
explicitly. Placeholders may span adjacent PowerPoint text runs, while ordinary
text-shape formatting is retained. The output contains only generated slides, in
worksheet order. Source presentations and workbooks are never modified.

To preserve every source worksheet as a separate tab, use
`consultchimps sheets merge "inputs/**/*.xlsx" --output outputs/all-sheets.xlsx`.
It copies worksheet formatting/layout supported by Excel and adds a visible
`Sheet Index` tab recording source names and hidden/visible status. Use
`--no-index` to omit the index. Add `--values` to replace formulas with their
stored results. Formula removal edits the workbook cells directly, so formatting
is always preserved; a formula without a stored result becomes a formatted blank
cell.

## Design principles

- Deterministic and local-first
- Immutable inputs by default
- Small composable operations rather than one-off scripts
- Explicit provenance and structured errors
- Detailed, plain-language messages for non-technical users
- Versioned public APIs and recipes
- Optional, replaceable OCR or AI providers
- Cross-platform behavior with no shell-specific assumptions

Normal CLI output explains what the tool did, translates result counts into
plain language, lists every created file, calls out warnings, confirms that
source files were left unchanged, and suggests practical next steps. Use
`--json` when an automation needs the compact structured result instead.

## Development

```bash
pnpm install
pnpm check
```

The verification suite builds the distributable CLI and runs command-level tests
against generated Excel, PowerPoint, and PDF fixtures in addition to
package-level tests.

The Fumadocs guide lives in `apps/docs`:

```bash
pnpm docs:dev
```

The in-browser tool pages have a Playwright smoke suite that drives the static
export in a real browser. It serves `apps/docs/out`, so build the site first
(without `NEXT_PUBLIC_BASE_PATH`, so the routes are served from `/`):

```bash
pnpm --filter @consultchimps/docs... build
pnpm --filter @consultchimps/docs exec playwright install chromium
pnpm --filter @consultchimps/docs e2e
```

CI runs the same suite on Linux; see [apps/docs/e2e](apps/docs/e2e/README.md).

## Deploy the guide

The documentation site deploys to GitHub Pages. The `Docs` workflow
(`.github/workflows/docs.yml`) runs on every push to `main`: it builds the
Next.js site as a static export and publishes `apps/docs/out` with the official
Pages actions.

One-time repository setup: under **Settings → Pages**, set **Source** to
**GitHub Actions**.

The workflow derives the public URL and base path from the repository name, so
forks deploy without configuration. No secrets or environment variables are
required.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow and
[SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## License

Apache-2.0
