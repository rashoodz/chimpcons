# Database import storage experiment

This private experiment evaluates the storage and parsing choices in the
[staged database import plan](../../docs/database-import-plan.md). It does not
change the published SQLite package or the existing browser workspace.

See the [measured results and limits](RESULTS.md).

## Run

Use Node 24 and the repository's pinned pnpm. Install this isolated experiment
from its directory. Its dependencies do not enter the published packages.

```sh
cd experiments/database-import
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm fixtures
pnpm exec node run.mjs excel-small
pnpm storage
pnpm compare
pnpm excel
node --expose-gc pipeline.mjs
```

The first installation and Excel extension loading require internet access.
DuckDB downloads executable extension assets. The fixture contents are generated
locally. The benchmark does not upload source data to a service. Browser export
streams a synthetic database to its temporary loopback HTTP server so native
DuckDB can verify the file.

`fixtures` creates new files under `dist`. It refuses to overwrite an existing
fixture. Run it once per checkout. Each measurement uses a new results directory
and a fresh browser context. It keeps its JSON results and exported database
there for inspection. The experiment does not remove these files automatically.

The seven-million-row workbook contains seven worksheets with one million data
rows each. Columns are attribute ID, attribute name, reported CDE flag, and
dataset ID. The sheets deliberately repeat the same values. No fixture contains
client data.

## What the checks establish

- `excel-small` imports a real 300,000-row Excel file in Chromium, closes the
  worker, reloads the page, and verifies 300,000 rows and 30,000 CDE flags. It
  adds a curation row after reopening, exports the database, and checks both
  tables through native DuckDB.
- `storage` creates 300,000, seven million, then seventy million typed rows
  directly inside DuckDB. It checks CDE counts, a filtered join and decimal
  calculation, page reload, a later curation write, export, and native reopen.
  These timings exclude Excel parsing.
- `compare` writes seven million rows to native DuckDB, exports them to SQLite,
  and runs DuckDB queries against each format. It records SQLite's resulting
  column types and repeats the query after adding source-file and dataset-key
  indexes. The query explicitly converts the amount column to decimal so both
  formats answer the same calculation.
- `excel` repeatedly parses the seven-sheet workbook ten times into one browser
  database. It verifies seventy million observations after reload and export.
  This is a parser and storage stress test. It intentionally bypasses
  deduplication and uses one workbook ten times, not ten independent vendor
  submissions. It does not establish import identity or reconciliation.
- `pipeline.mjs` runs the current ConsultChimps inspect, prepare, resolve, and
  apply operations against generated 100,000-row and one-million-row Excel
  workbooks. It records bounded-reader activity, phase throughput, sampled
  process memory, prepared and target storage, and count, group, and join
  queries. Build the `db`, `files`, and `xlsx` packages before running it.

Results contain engine and browser versions, operation times, row counts, and
output size. They do not claim a statistically controlled benchmark. Runs can
compete with other processes on the development machine. The first query in a
pair is a first measured execution, not an operating-system cold-cache run.

## Constraints exposed so far

The tested DuckDB-Wasm package is `1.33.1-dev57.0`, containing engine `v1.5.4`.
Its npm latest tag points to a prerelease. That is an experiment input, not a
production dependency decision. Native DuckDB uses `1.5.5-r.4`.

Using `open({ path: "opfs://observations.duckdb" })` alone lost the created
tables on reload in the initial experiment. Registering the database and WAL
file handles explicitly with direct I/O passed the tested reopen case. The
browser script preserves that registration. This does not establish crash or
quota-exhaustion recovery.

The browser runs a single DuckDB worker. It does not enable cross-origin
isolation or the threaded bundle. The `1GB` database memory setting is not a cap
on browser process memory or parser allocations.

The Excel extension is an engine candidate for bulk reading. It has not passed
ConsultChimps' worksheet-region, formula-cache, error-cell, physical-row
provenance, or untrusted-workbook conformance checks. Do not replace the
existing xlsx reader with it based on this benchmark.

The fixtures use narrow, repetitive data and inline strings. Wide schemas, large
shared-string dictionaries, multiple distinct workbooks, concurrent tabs, other
browsers, crash recovery, import receipts, incremental hashing, and
representative vendor submissions need separate verification before declaring an
import capacity.
