# Database package and import implementation proposal

Status: design reference for the persistent import phase. This document records
the proposed interfaces that guided implementation, including provisional JSON
examples. [ADR 0005](adr/0005-persistent-database-imports.md) records the
accepted storage decision. The
[user guide](../apps/docs/content/docs/tools/data-workspace.mdx) and
[library reference](../apps/docs/content/docs/libraries/index.mdx) describe the
implemented commands and schemas. Use those references for executable examples.
Examples in this document are synthetic.

## Package ownership

Extend the existing `@consultchimps/db` package at `packages/db`. The package
owns SQLite and DuckDB support, database creation, schema operations, imports,
delivery records, and export. The CLI uses one `consultchimps db` command group.
There is no separate database-import package or parallel database product.

Keep one working format per open database. Both formats are supported
explicitly; opening a file does not silently convert it or maintain a second
authoritative copy. Engine-specific storage and SQL behavior stays in internal
adapters, while import decisions and audit rules are shared.

| Package or application    | Existing capability reused                                                                           | New responsibility                                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@consultchimps/core`     | `ConsultChimpsError`, `OperationResult`, `OperationControlOptions`, artifact and progress contracts  | A small random-access byte-source contract shared by hashing and readers; extend progress only if unknown totals cannot be expressed honestly                         |
| `@consultchimps/files`    | `discoverFiles`, `refuseInputOverwrite`, `ensureOutputAvailable`, path comparison                    | Native byte-source adapter and safe staged-file publication; strengthen collision handling for aliases and concurrent creation where current helpers are insufficient |
| `@consultchimps/tabular`  | `ColumnMapping`, `validateColumnMapping`, `suggestColumnMapping`, header matching and coercion rules | Compile a mapping once, apply it to batches, and accumulate type profiles without holding a complete table                                                            |
| `@consultchimps/xlsx`     | Excel selection semantics, formula/error/date rules, conformance fixtures                            | Public `./stream` entry point for bounded workbook inspection and row batches with physical source coordinates                                                        |
| `@consultchimps/db`       | Existing SQLite workspace, identifiers, schema and record operations                                 | Refactor into shared asynchronous operations, native/browser engine adapters, import history, and conversion between supported SQLite and DuckDB schemas              |
| `@consultchimps/messages` | `formatHumanResult`, `formatHumanError`, vocabulary                                                  | Import-specific summaries, metric labels, recovery guidance, and correct labels for database and review artifacts                                                     |
| `consultchimps`           | Commander, JSON mode, progress, built CLI tests                                                      | Thin `db` command group in `packages/cli/src/commands/db.ts`                                                                                                          |
| `apps/docs`               | Worker request/reply patterns, source pickers, review controls, theme                                | Persistent import page, review components, worker adapter, and browser tests                                                                                          |

The existing `db.importTables` creates SQLite tables from materialized `Table`
objects. It is not the new persistence implementation. The existing xlsx
`readWorkbookTablesBytes` and `readWorkbookWorksheetsBytes` also materialize
their inputs. A generator around either function would not provide bounded
memory use.

`RegionSelector`, `resolveRegions`, `WorkbookRead`, and `DataRegion` are
internal xlsx symbols. Reuse and extract their semantics inside that package; do
not import private source paths from `db`. Keep the existing readers for their
current callers.

## Persistent local files and paused analytics UI

Decision: retire the spike's whole-database in-memory lifecycle. Production
operations open or create a persistent local SQLite or DuckDB file, commit
changes incrementally, and reopen that file without reconstructing it from
Excel. Export creates a portable copy or a validated format conversion; export
is not the mechanism that makes ordinary changes durable.

Memory remains available for engine caches, bounded row batches, and working
state. The requirement is to avoid holding the database or a whole workbook in
application memory. Temporary spill files, transaction logs, and checkpoints
remain engine responsibilities with measured memory and disk budgets. A file
handle backed by a complete in-memory byte buffer does not meet this contract.

The CLI opens an operating-system file directly. In a browser, distinguish a
user-selected file from an origin-private working file. If the selected engine
cannot write the selected file directly, use an explicitly identified persistent
working copy and a bounded copy/export path. Do not imply that OPFS edits update
the original selected file. Validate storage access, quota, and reopen behavior
for each engine and browser before advertising support. Any native local bridge
would be an explicit additional execution mode, not a silent fallback.

Analytics UI development is paused indefinitely and resumes only after an
explicit product decision. Do not schedule query editors, charts, general data
grids, or analytical browsing as a later automatic phase. DuckDB UI is a
candidate for external analysis, not a new embedded dependency or an approved
replacement integration. The active browser scope is database creation/opening,
schemas, import preparation and review, delivery history, and export. Bounded
import previews remain in scope. Porting or expanding the spike's analytics UI
is not a prerequisite for the storage and import work.

## Package entry points and internal modules

Refactor the spike into one shared asynchronous database contract. The root
`@consultchimps/db` exports logical schema, identifiers, database operations,
imports, and results. `@consultchimps/db/schema` can remain a lightweight schema
entry point, but its types can be redesigned with its callers.

Two runtime entry points construct the same database abstraction:

- `@consultchimps/db/node`: native lifecycle and file operations for both
  formats.
- `@consultchimps/db/browser`: worker-safe lifecycle for both formats and
  browser-owned persistence. No React or Next.js dependency.

Do not preserve a second legacy SQLite API or add a parallel workspace facade.
Replace synchronous SQLite-shaped methods where the unified interface needs
asynchronous behavior. Migrate callers in the same change and remove replaced
exports and wrappers. Treat published API changes with the appropriate Changeset
rather than using release metadata as a reason to retain the spike's shape.

The database contract identifies its format and supported capabilities. SQLite
and DuckDB obey the same import, receipt, and error contracts while retaining
explicit SQL, type, storage, and optimization differences. Define a shared
logical schema and deliberate engine-specific extensions.

Load engines through explicit runtime imports. Optional peers can let the CLI
supply native bindings and the application supply browser assets; verify final
declarations with isolated-consumer packaging tests. Replace the spike's sql.js
in-memory lifecycle with a SQLite runtime that supports persistent file access.
Do not initialize engines merely by importing common contracts or load native
bindings in browser bundles.

Proposed target structure, refactoring the existing files into these roles:

```text
packages/db/src/
  index.ts
  database.ts              one asynchronous database contract
  schema.ts                shared logical types and constraints
  identifiers.ts
  records.ts               shared validated record operations
  bridge.ts                tabular integration
  import/
    recipe.ts
    prepare.ts
    apply.ts
    deliveries.ts
  conversion.ts
  metadata.ts
  errors.ts
  engines/
    sqlite/
    duckdb/
  node.ts
  browser.ts
```

The internal adapter contract covers schema introspection, validated schema
changes, bulk insertion, transactions, cancellation, identity allocation, and
checkpoint/export. Shared operations own transaction order, duplicate rules, and
metadata semantics once. SQLite and DuckDB adapters implement their actual SQL
and persistence mechanics. Do not expose arbitrary SQL as the shared operation
interface or pretend performance is equal across engines.

Excel decoding stays in xlsx; format-independent mapping stays in tabular. The
db package does not depend on the CLI or application. CDE approval and cleansing
status are ordinary domain data and later operations, not hardcoded storage
fields.

## Refactoring the existing spike

The existing database work is the starting implementation for this feature, not
an independent compatibility product. Refactor it freely within the agreed
scope:

| Existing work                                           | Treatment                                                                                                                                                |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Database` and `SqlDatabase`                            | Replace the exposed SQLite-specific contract with one asynchronous database interface; keep raw engine handles internal                                  |
| Schema and ID helpers                                   | Retain useful validation and identity rules, redesign types where necessary, and share them across engines                                               |
| `importTables` and row insertion                        | Replace materialized/per-row execution with prepared imports and bounded bulk writes                                                                     |
| Record updates and table bridge                         | Move onto the same database contract; check numeric conversions when bridging to other tools                                                             |
| Browser worker and protocol                             | Refactor to use the shared contract for either format                                                                                                    |
| Grid, source controls, page state and navigation guards | Reuse source and import controls; analytics grid work is paused and does not block the persistent storage refactor                                       |
| Tests                                                   | Retain valuable behavioral cases, update APIs, and run common cases against both engines; discard tests that only freeze replaced implementation details |
| sql.js and whole-file serialization                     | Retire the whole-database in-memory lifecycle; ordinary persistence must use incremental file writes                                                     |

Retire replaced code in the same series of changes. There is no requirement to
preserve old method signatures, metadata version numbers, or a compatibility
facade. Record the new file format and architecture deliberately in an ADR.

Freedom to refactor code does not authorize deletion of saved user data. Inspect
existing files before modifying them. Where an older spike format needs
conversion, offer an explicit validated copy or a clear unsupported-format
error. Do not invent provenance for older rows or overwrite source files.

Use the existing `/workspace` for the unified database-management and import
product. Adapt the controls needed for that scope to the persistent contract.
Analytics and general grid editing remain paused; their migration does not
define the new database API or block delivery.

## Public operation contracts

These names describe the intended interface. Concrete TypeScript types are
implemented and tested before they become a published compatibility promise.

| Operation         | Input                                                                  | Result and side effect                                                                                          |
| ----------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `createDatabase`  | Destination, format, and optional schema                               | Creates a managed database in the selected SQLite or DuckDB format and returns an operation result              |
| `inspectDatabase` | Open database handle                                                   | Schema, format version, table summaries, and import/delivery summaries without loading table contents           |
| `planSchema`      | Database schema and proposed schema                                    | Validated additive schema changes or explicit conflicts; no database writes                                     |
| `applySchema`     | Database and approved schema plan                                      | Transactional schema changes after checking the baseline                                                        |
| `prepareImport`   | Database, source readers, recipe, and private staging destination      | A durable prepared import containing captured rows and a review plan; accepted database tables remain unchanged |
| `inspectImport`   | Prepared import and page/cursor                                        | Counts, table routing, type choices, warnings, and bounded examples                                             |
| `resolveImport`   | Prepared import and explicit mapping/routing decisions                 | A new validated plan revision, ready only when its conflicts are resolved                                       |
| `applyImport`     | Database, prepared import, delivery intent, and operation controls     | Validates the baseline and atomically publishes observations, memberships, and receipts                         |
| `recordDelivery`  | Database, existing capture references, delivery context, and retry key | Records another delivery without copying captured row values                                                    |
| `listDeliveries`  | Database and filters/cursor                                            | Paginated event history and referenced captures                                                                 |
| `planConversion`  | Source database and target format/options                              | Type, constraint, metadata, and engine-feature compatibility report; no output writes                           |
| `exportDatabase`  | Database and destination                                               | Consistent same-format artifact, or a validated conversion to the selected output format                        |

`prepareImport` deliberately says prepare rather than dry run: it writes staging
data. Its review plan describes intended mutations. A recipe is reusable intent;
a prepared import is a specific captured input and destination baseline.
Changing reviewed mappings produces a new plan revision and invalidates the old
approval. Data-dependent conversions must be revalidated against captured values
rather than reparsing Excel unnecessarily.

Use opaque database and plan references. Prepared imports have `needs-review`
and `ready` states; `applyImport` accepts a ready reference and rechecks its
stored state at runtime. Runtime `openDatabase` returns a disposable database
handle. Create and export also return structured operation results. Do not
expose a public SQL connection as a shortcut around import invariants.

Node adapters own paths; browser adapters own browser handles. Shared operations
receive explicit handles and controls. Browser messages carry references and
bounded pages, not complete JavaScript arrays of imported rows.

## Command design

There is currently no `db` group in the CLI. Add the following commands, with
help examples and built-CLI tests. The executable remains `consultchimps`.

```sh
# Create an empty database, optionally with declared tables
consultchimps db create -o inventory.duckdb --format duckdb --schema schema.json
consultchimps db create -o inventory.sqlite --format sqlite --schema schema.json

# Inspect its tables, schema, and import summaries
consultchimps db inspect inventory.duckdb --json

# Review or apply an explicit additive schema change
consultchimps db schema apply inventory.duckdb --file schema.json --dry-run
consultchimps db schema apply inventory.duckdb --file schema.json

# Capture workbook data and produce a durable review artifact
consultchimps db plan inventory.duckdb \
  --input inventory=inputs/inventory.xlsx \
  --input attributes=inputs/attributes.xlsx \
  --recipe import.json -o review.ccplan

# Inspect a saved review artifact without reading the original workbooks
consultchimps db inspect review.ccplan --json

# Apply the captured plan, including its approved delivery context
consultchimps db apply inventory.duckdb --plan review.ccplan

# Convenience form for an already explicit recipe
consultchimps db import inventory.duckdb \
  --input inventory=inputs/inventory.xlsx \
  --input attributes=inputs/attributes.xlsx --recipe import.json

# Record another delivery of previously captured data
consultchimps db delivery record inventory.duckdb \
  --capture CAP-0001 --context delivery.json --request-id receipt-example-2

consultchimps db deliveries inventory.duckdb --json
consultchimps db export inventory.duckdb -o inventory-copy.duckdb

# Review conversion, then create a SQLite copy
consultchimps db export inventory.duckdb --format sqlite \
  -o inventory-copy.sqlite --dry-run
consultchimps db export inventory.duckdb --format sqlite -o inventory-copy.sqlite

# Convert a supported SQLite database to DuckDB
consultchimps db export inventory.sqlite --format duckdb -o inventory-copy.duckdb
```

`db import` composes preparation and application. It stops on unresolved routing
or type conflicts; it does not infer approval or overwrite policy. For a single
source region, provide `--sheet`, `--table`, or `--range` selection and a
distinct `--into` destination flag. `--table` refers to an Excel Table, not a
destination. Complex multiple-source routing belongs in a recipe.

Seeding uses `db import` with a recipe and known target schema. Do not create a
second seed implementation. Database creation can later offer an import shortcut
by composing these operations, without another execution path.

Use `-o, --output` for new artifacts and `-f, --force` only to explicitly
replace an output artifact. It must not mean replace rows or override a stale
plan. Appending is the initial data operation. Upsert, source replacement, and
deletion are separate later operations. Both working formats and validated
conversion belong to this design; conversion is not implicit import behavior.

`--json` returns structured data on stdout; progress and errors go to stderr.
Recipes, schemas, context files, and review artifacts have versioned formats and
reject unknown versions. Relative input bindings resolve against the recipe
location, with explicit CLI bindings available when files move.

## Recipe and schema separation

A schema declares destination tables and types. A recipe selects source regions,
routes them, refers to an existing `ColumnMapping`, and declares import intent.
A delivery context records a business event. Do not mix machine paths, source
matching, and relational constraints into one unversioned configuration file.

Example recipe shape:

```json
{
  "formatVersion": 1,
  "sources": [
    {
      "input": "inventory",
      "select": { "table": "DatasetInventory" },
      "destination": { "kind": "append", "table": "datasets" },
      "mapping": "dataset-columns.json"
    },
    {
      "input": "attributes",
      "select": { "sheet": "Attributes", "headerRow": 2 },
      "destination": { "kind": "create", "table": "attributes" },
      "mapping": "attribute-columns.json"
    }
  ],
  "delivery": { "kind": "new", "context": "delivery.json" }
}
```

Bind logical input aliases with `--input`; do not guess bindings from sheet
names. Positional paths and quoted globs are supported for simple selections
without recipe aliases. `create` encountering an existing destination is a
conflict. A saved recipe can explicitly permit create-if-absent with a declared
schema and append only when compatible. This is a distinct validated choice, not
a hidden change to `create` semantics.

Schema types need exact integer and decimal handling. Replace SQLite-specific
type assumptions with a logical schema contract that maps explicitly to either
engine. Use explicit decimal precision/scale, distinguish dates from timestamps,
retain text identifiers with leading zeros, and preserve raw numeric tokens
until conversion to avoid a JavaScript-number round trip.

## Format choice and conversion

`createDatabase` requires an explicit format in its library options. The CLI
accepts `--format sqlite|duckdb`, or infers creation intent from a recognized
extension; ambiguous names require the flag. Reject a conflicting flag and
extension. On open, inspect file contents, not only the filename. An optional
format flag asserts the expected format; it never requests conversion.

The same `db import`, schema, delivery, and inspection commands operate on
either managed format. Default export preserves format. `--format` on export
requests conversion. Source identity, record IDs, delivery memberships, and
receipt history are preserved only where the conversion contract can verify
them. Give the output its own artifact identity and invalidate source-bound
pending plans. The resulting files are independent snapshots, not synchronized
databases.

Conversion is a schema-and-data operation, not a renamed file or a generic copy
of SQL strings. `planConversion` must inspect:

- Exact integer ranges and decimal representation, including whether a SQLite
  representation preserves values but changes arithmetic semantics
- Dates, timestamps, timezone policy, boolean storage, blobs, and nullability
- Primary/unique keys and foreign-key validity and enforcement
- Views, generated columns, indexes, collations, triggers, sequences, and custom
  types or functions that depend on an engine
- Managed metadata versions, IDs, row totals, and provenance memberships

Default to refusing unsupported or lossy conversion. Explicit conversion rules
can choose a representation or exclude an unsupported feature, with the effect
listed before writing. Do not turn exact decimals into floating point, silently
omit constraints, or call converted SQLite text a native decimal type. Derived
indexes are rebuilt only where supported; their physical layouts are not copied.
Validate the final artifact with the destination engine and report converted,
unchanged, and unsupported items. SQLite-to-DuckDB-to-SQLite tests cover the
supported common schema, not arbitrary database round trips.

Distinguish managed ConsultChimps files from arbitrary SQLite or DuckDB files.
Inspect unmanaged files without adding metadata. Enabling managed writes
requires an explicit adoption/schema-validation operation; existing ordinary
keys are retained as data and are not silently replaced or treated as vendor
identity. Do not promise migration of arbitrary applications, triggers, or
extension data.

## Stored data and audit records

User data stays in typed tables. Proposed reserved metadata tables describe:

- Database format, managed table identities, and schema versions
- Source contents identified by hash and byte length
- Captures identified by selected region and reader interpretation
- Applied imports, plan revisions, and successful application receipts
- Delivery events, supplied filenames, coverage, and reported metrics
- Membership links between deliveries and captured observations

Names and layouts are versioned in the follow-up ADR before publication. Do not
create one generic cell-value table or copy the database for every delivery.
Use-case terminology belongs in example schemas, not the reserved namespace.

An accidental repeat application reuses its receipt. An intentional new delivery
gets a new event and references the capture. Retrying that delivery operation
with the same request ID creates neither another event nor another membership.
File equality, application identity, and business event identity are distinct.

Generated record IDs remain independent of vendor identifiers. Identifier
allocation and formatting are shared inside db; their representation can be
redesigned with the spike and its callers. Source coordinates identify original
rows, including gaps and excluded totals rows. Do not reconstruct coordinates
from a compacted batch index.

## Preparation, failure, and resource limits

The optional `review.ccplan` is a managed staging artifact containing a
manifest, newly captured data, and references to captures already in its target
database. It is bound to that database identity and baseline. It can contain
sensitive source values and belongs only on the operator's device. It is not a
small shareable JSON report. Its format marker distinguishes it from a final
database; its manifest records the storage format, and the extension alone is
not trusted. Use staging compatible with the selected runtime rather than
requiring DuckDB merely to prepare a SQLite import. After successful
application, the final database contains the accepted values and audit records
and needs neither the plan nor Excel files.

Account for staging, the destination, transaction logs, and temporary engine
space together when checking available storage. Test quota exhaustion and
cleanup without treating the final database size as the required free space.

Hash source bytes in chunks before parsing. Use a stable captured snapshot or
detect a changing input and fail; a hash of one file version must not label rows
from another. The workbook reader uses range reads, bounded ZIP inflation, SAX
row parsing, and a scratch-backed shared-string lookup. Reuse `saxes`; evaluate
a maintained ZIP reader rather than building another ZIP implementation by
default. Impose limits on entries, metadata, expanded size, and cell payloads.

Validate and stage before applying. Acquire write ownership, recheck the
destination schema and relevant baseline, then publish a connected group of
tables and its receipts in one transaction. Cancellation rolls back that unit.
Recovery records distinguish prepared, applying, completed, and failed work. Do
not mark partially loaded data as accepted. Safe retry is required; arbitrary
mid-row resume is not promised.

One owner writes the database. Reader concurrency is bounded by memory and
backpressure; do not launch one full parser per file. Import previews are paged.
Browser persistence uses OPFS through the worker adapter; export copies from a
consistent checkpoint. Document quota and unsupported-browser errors explicitly.
An exported copy does not remain synchronized with subsequent browser edits.

## Distribution and browser placement

Native DuckDB requires platform-specific runtime assets. Refactor release
packaging for the whole CLI: npm installation or a platform archive can supply
the same `consultchimps` executable, document commands, and database commands
with their required assets. The existing single-file `consultchimps.mjs` shape
is replaceable; do not create a separate database executable to preserve it.
Update distribution documentation and verify document and database operations in
the resulting package. Verify supported operating systems and Node versions
against the actual binaries before advertising availability.

DuckDB-Wasm assets are pinned and served from the application origin. The
current experiment uses a prerelease; dependency review must settle the
production version and offline asset requirements. The Excel extension is a
benchmark candidate, not a replacement for the workbook conformance contract.

Use the existing `/workspace` for database creation/opening, schema operations,
import review, delivery history, and export. New and Open identify the database
format and working location. Keep bounded previews and navigation protections
needed by those operations. Analytics UI development, including migration of the
general grid, is paused indefinitely. Do not preserve the old in-memory save
lifecycle to keep paused UI code active.

The current browser completion checklist describes stateless bytes-only tools.
Add an explicit persistent-workspace checklist and amend ADR 0003 before marking
this browser capability working. Verify the active management and import
operations against both engines; analytics UI acceptance is outside this scope.

## Documentation and verification

Keep this proposal and the delivery plan under `docs/`. Record storage
ownership, metadata versioning, persistence, and distribution in a follow-up
ADR. Update xlsx architecture for its read-only bounded path and document the db
package's new public contracts in its README. Add Changesets for affected public
packages.

Ship a synthetic import tutorial, a recipe/schema reference, repeat-delivery and
recovery how-to guides, and an explanation of captures versus deliveries. Update
`apps/docs/content/docs/reference/cli.mdx`, the libraries guide, getting
started, tool navigation, root README, and registry/category metadata together.
Examples must execute in tests. Personal context does not enter docs or
fixtures.

Verify through the public library, built CLI, and real browser. Test region
selection, physical coordinates, exact numeric conversion, formula-cache and
error handling, schema conflicts, source changes, repeat import, repeat
delivery, stale plans, cancellation, reopen, and export. Verify the exported
database with independent native DuckDB queries. Run small synthetic fixtures in
CI and larger reproducible measurements separately; publish limitations rather
than capacity claims. Useful existing database and document behavior remains
covered by regression checks, with database contract tests exercised against
both engines. Add acceptance checks that open and reopen persistent files
without whole-file buffers, commit changes without full-database serialization,
and export with bounded memory. Verify persistence after worker termination and
recovery after interrupted writes. External analytics must read a consistent
closed/checkpointed artifact; do not assume concurrent external writers are
safe.

## Applied principles

- Foundational thinking: define source, prepared import, application receipt,
  and delivery identities before implementing their storage.
- Subtract before you add: retire the in-memory lifecycle and remove analytics
  UI migration from this delivery; reuse the db package and useful import rules.
- Redesign from first principles: treat SQLite and DuckDB as two supported
  formats in one package, with real capability and conversion contracts.
- Migrate callers, then delete legacy APIs: refactor the spike and its callers
  together instead of maintaining an old SQLite path beside the new work.
- Boundary discipline: keep filesystem and browser handles in runtime adapters;
  validate recipes and schemas before shared operations use them.
- Prove it works: require library, built-CLI, browser, and independent artifact
  evidence instead of calling a materialized reader streaming.
