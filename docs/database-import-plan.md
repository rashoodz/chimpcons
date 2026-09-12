# Excel-to-database delivery plan

Status: Staged implementation proposal. The storage experiment has produced
initial measurements. The db package will support SQLite and DuckDB as working
and output formats. Planned behavior is not shipped behavior. The existing
database spike is being developed into this unified capability. Its whole-file
in-memory lifecycle is retired in the target design. Analytics UI development is
paused indefinitely pending an explicit product decision.

The [runnable storage experiment](../experiments/database-import/README.md)
checks browser persistence, Excel reading, artifact portability, and the
DuckDB-versus-SQLite tradeoff before the first import API is published. See the
[measured results and limitations](../experiments/database-import/RESULTS.md).

The [implementation proposal](database-import-implementation.md) specifies
package ownership, public operations, CLI commands, staging artifacts, and
documentation changes. Those interfaces are proposed, not shipped.

## Outcome and scope

Create a local database from Excel through the browser and CLI. Import each
source once, then query and change the database directly. Persist changes
incrementally. The Excel files are not needed to reopen or continue work.

The synthetic stress fixture exercises seventy million rows through repeated
parsing of a generated seven-million-row workbook. It does not represent a
particular deployment or a supported capacity. The first performance target is
standalone DuckDB querying the artifact we produce. Browser analytics and
general grid editing are paused indefinitely. DuckDB UI is a candidate for
external analysis; its adoption is a separate decision. Database-management and
import-review UI remain in scope.

Later explicit imports can introduce new tables, new rows, and changed records.
They must respect database edits made after earlier imports. This is not a
continuous Excel synchronization service.

Dataset inventory examples illustrate submissions from multiple organizations
and contributors. Use-case mappings and critical data element classifications
can drift between revisions. These are optional domain examples of generic
import, provenance, and relationship operations, not a fixed project structure.

## Recommended decisions

Append source observations so queries can show what each uploaded file
contained. Recommend this as the default import model, with curated updates
handled by separate operations.

1. Append typed source observations for each distinct file and selection. Keep
   the source-file identity, import context, sheet, row, and reported values.
2. Skip a repeated successful import of the same content and context. Appending
   a new submission is different from duplicating an old one.
3. Keep observed CDE classification on the observation. Never replace an older
   file's classification with a later file's classification.
4. Generate our own import and source-row IDs. DQ can later link observations to
   a shared Record ID without changing the source evidence.
5. Treat table routing and schema compatibility separately from record matching.
   Conflicting business values can coexist as observations in one typed table.
6. Derive file-specific, revision-specific, and current views explicitly. Do not
   let an unscoped count of observations masquerade as a count of unique CDEs.
7. Make edits to curated records, DQ results, and classification decisions
   separate database operations. They do not rewrite what a file reported.
8. Support SQLite and DuckDB through the existing db package, common operations,
   and one workspace. Choose the working format explicitly and provide validated
   conversion. Use the measurements to explain performance tradeoffs.

Keep the public flow as plan, review, then apply. Browser and CLI use the same
saved recipes and import plans. A general reconciliation workflow is no longer
required just to ingest and query conflicting inventories.

## Import experience

### Select the destination and sources

Open an existing database or create a new one. Select files and identify their
entity, inventory or use-case role, phase, and source revision when known. These
values can come from a saved recipe. Unknown revision information stays unknown.

Hash file content before parsing worksheets. If the selected content and import
intent were already applied successfully, report the earlier import and skip it.
A renamed copy of a 300,000-attribute file must add zero rows. Hashing still
reads the bytes; it avoids Excel parsing and downstream processing.

Distinguish retrying that import from recording a new vendor delivery. A new
delivery event can reuse the same captured contents without copying its rows.
The review offers reuse of the earlier import or recording a new delivery that
references it. A matching hash cannot decide whether a business touch point
occurred. CLI callers make the same intent explicit.

### Route each selected sheet or range

Show the source, proposed destination, compatibility, and reasons for the match.
Use saved mappings first. Schema similarity can suggest a table but cannot
establish that the data belongs to the same entity or record population.

| Situation                           | Default proposal                              | Available resolution                                                         |
| ----------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------- |
| No suitable table exists            | Create a new typed table with a proposed name | Edit its name and schema, or choose an existing table                        |
| One known compatible destination    | Use the saved destination                     | Choose another table or create a separate table                              |
| Several plausible destinations      | Require a destination selection               | Select an existing table or create a new one                                 |
| Familiar table with renamed columns | Apply declared aliases                        | Review the mapping and save it for reuse                                     |
| New columns                         | Show an additive schema change                | Add permitted columns, map them, exclude them explicitly, or use a new table |
| Incompatible types or meaning       | Block application to that destination         | Convert explicitly, choose a different table, or create a separate table     |

Multiple sheets can feed one table when they describe the same kind of record.
One workbook can feed several tables. Preserve source attribution in both cases.

Creating a separate table is appropriate when the user wants to retain a
conflicting interpretation or distinct population. It is not the automatic fix
for a changed header. It gets a separate table identity; relationships must be
mapped explicitly. No existing foreign key silently changes its destination.

### Classify the planned observations

| Classification              | Meaning                                                                      | Default action                                               |
| --------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Repeated capture            | Same file content and selection already captured and applied in this context | Skip; add no observations                                    |
| New submission              | Selected source rows have not been imported in this context                  | Append with generated source-row IDs                         |
| Known subject               | DQ already identifies the entity described by the observation                | Keep the new observation and link it to that Record ID       |
| Unresolved subject          | Entity matching is absent or ambiguous                                       | Keep the source observation; leave its resolved link pending |
| Conflicting report          | Another file reports a different value for the same resolved subject         | Keep both reports and expose the disagreement in queries     |
| Invalid for selected schema | Values or columns cannot fit the chosen destination                          | Review mapping, type, destination, or explicit rejection     |

Show counts and representative examples before applying. Preview queries staged
data in pages; it does not load all rows into browser state. Sampled schema
inference is provisional until the full input validates.

A classification disagreement is not a schema conflict. A CDE and a non-CDE
observation can both be valid rows in the same attributes-observations table. A
new table is appropriate for different structure or meaning, not required merely
because vendors disagree.

### Apply and report

Check the target schema and recipe baseline under write ownership before
applying. A stale plan must be refreshed if its destination or interpretation
changed. Additive imports still need transactional receipts and duplicate
guards.

Report appended observations, duplicate observations skipped, unresolved subject
links, schema changes, and pending or rejected rows. Keep unresolved identity
separate from parse failure. An unresolved subject does not prevent querying
what its source file reported.

Commit observations and their receipt together. Preserve existing source
observations and curated database edits. No ordinary import updates their
values.

## Identity, deduplication, and DQ

Separate these identities:

| Identity            | Purpose                                                                          |
| ------------------- | -------------------------------------------------------------------------------- |
| Source content hash | Recognize identical file bytes, independent of filename                          |
| Source File ID      | Identify the captured file to which observations belong                          |
| Delivery event ID   | Identify a vendor touch point independently of file contents and import attempts |
| Import ID           | Identify the capture or application context and its outcome                      |
| Imported Row ID     | Identify a captured source row without trusting vendor IDs                       |
| Record ID           | Identify the resolved record used by business tables and relationships           |
| Record revision     | Identify the values a mapping or decision was based on                           |

Recommend SHA-256 for source content. Enforce uniqueness for successful
applications using source selection, target table identity, and relevant recipe
versions. A hash alone must not block a previously unselected sheet. Separate
capturing source content from applying it: changing a mapping should reuse
captured data where available, not create another raw copy or blindly append
another set of the same captured observations.

A different file hash does not establish new business subjects. Excel can change
its bytes through formatting or a resave. A row-value fingerprint can detect
unchanged values but does not establish business identity. Legitimately
identical rows may be distinct observations.

DQ rules normalize and validate source data in the database. Vendor identifiers
are evidence, not guaranteed keys. Only declared, scoped, unambiguous matching
rules can automatically combine source rows into a resolved record. Other
matches remain proposals. Entity, domain, dataset membership, and phase affect
scope only when the model says they do.

Repeated successful imports allocate no new observations or resolved records.
Recording a distinct delivery event creates its own metadata and membership
references, even when its contents were previously captured. Retry identity is
separate from content identity: repeating the same event operation creates
neither another event nor another membership. Do not deduplicate delivery events
by file hash, filename, or arrival time. Failed attempts remain retryable.
Duplicate files in the same batch cannot race past the receipt check.
Deterministic source ordering and recorded allocation state make retries
reproducible; do not allocate IDs according to worker completion order.

## Deliverable history and scoped snapshots

Retain a delivery event for each explicitly recorded vendor touch point. Record
the vendor and entity, deliverable type, phase or sprint, source references,
declared coverage, and the person or process recording it. Keep the vendor's
effective date, actual received date when known, and database recording time
separate. A late upload of older evidence must not become the current baseline
merely because it was recorded later. Unknown dates and coverage stay unknown.

A delivery can include several files, reported metrics, and relationship
assertions. A metric-only touch point does not require fabricated dataset rows
or a workbook. Link each claim to its source or a locally recorded note. Changes
to recorded claims or coverage create attributed corrections retaining the prior
statement. Record receipt, validation, and business acceptance separately.

Store captured row values once when safe to reuse them. Delivery membership
links each event to the selected captured data and interpretation version. Keep
event-specific scope on that association rather than overwriting the earlier
capture's context. Identical files in separate iterations therefore remain
visible in both delivery histories without duplicating 300,000 attribute values.
Changed selections or mapping rules still need validation before an earlier
capture can be reused. A hash proves content equality, not equal meaning or
coverage.

The following fictional example uses invented counts and iteration labels:

| Touch point           | Evidence retained                                                     | Interpretation                                                                       |
| --------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Planning              | Vendor reports 12 datasets, 80 attributes, and 16 CDEs                | Preserve the stated totals even without row-level evidence                           |
| Iteration 1 statement | Vendor reports 40 datasets, 320 attributes, and 64 CDEs               | Record the statement's scope and effective date; do not assume a delivered row count |
| Iteration 1 delivery  | Files containing only the first iteration population                  | Record partial coverage; absent datasets are not removed from the entity inventory   |
| Iteration 2 delivery  | Files for second-iteration cleansing and a claim of 8 additional CDEs | Preserve the claim and compare identities and scope before confirming net additions  |
| Repeated delivery     | Vendor submits previously captured contents at another touch point    | Record a new event and reuse contents; a retry of that event creates nothing further |

Keep three answers distinct: what the vendor claimed, what the delivered rows
contain, and what the accepted inventory currently contains. Report a difference
only for comparable units and coverage. Do not infer 72 current CDEs from the
first total and subsequent claim. The 8 may overlap prior subjects, represent
new classifications, or use a different counting unit. Unresolved overlap
remains visible instead of being treated as zero overlap.

Preserve submitted dataset-to-attribute and attribute-to-CDE mappings as
relationship assertions with delivery membership. Mapping rows can repeat or
change across submissions. Keep their reported endpoints and optional resolved
identities, and retain the baseline used for each accepted mapping. Several
attributes can reference one CDE; count distinct CDE subjects separately from
mapping rows. Do not assume the reported tree is globally one-to-one.

The latest received deliverable is selected within a declared deliverable scope.
It is distinct from the latest accepted inventory. Full snapshots, partial
snapshots, and explicit change sets have different rules. A partial snapshot
cannot supersede the entire entity inventory. Applying a change set requires a
named baseline and explicit additions, updates, or removals. Corrections and
superseding deliveries retain earlier evidence and dependent mappings.

Queries should answer both what was received at a touch point and what was known
as of a date. A later correction or identity resolution must not silently change
an earlier report. Retain the interpretation and resolution versions used by a
saved report, and distinguish a historical result from a later reassessment.
This is an application audit trail for recorded events, not proof against
arbitrary external database edits or proof that unrecorded deliveries occurred.

## Query file membership and changes

Proposed minimal shape for an attribute-observation table:

- Imported Row ID and Import ID.
- Source File ID, source sheet or range, and source row position.
- Entity, vendor role, phase, and reported revision when known.
- Original attribute reference or name and its reported CDE classification.
- Optional resolved Record ID established by DQ, preferably through a separate
  mapping so the observation remains unchanged.

Source File ID is necessary because a single import can contain multiple files.
Preserve the filename for display, but do not use it as identity. The source
registry holds the content hash; exact repeat uploads do not clone its rows. Use
typed observation tables per schema rather than a generic JSON cell store.
Delivery membership supplies event-specific context when several deliveries
reference that capture. Queries by delivery must follow those memberships rather
than treating the capture's original Import ID as its only delivery.

Example questions available before canonical matching is complete:

- Which rows did file A report as CDEs?
- How many CDE-designated rows did each file, entity, or phase report?
- What classifications did different files report for a resolved attribute?
- Which attributes changed designation between two selected inventories?

The first two need source provenance, not stable vendor identifiers. The latter
two require resolved identity or an explicit matching rule. An unresolved match
must not be reported as a confirmed reclassification.

Distinguish reported CDE rows, distinct resolved CDE subjects, and approved CDE
designations. Counts use explicit source or inventory scope. Unknown or invalid
CDE labels remain distinct from false; a use-case recommendation is not silently
converted to an inventory classification.

A current inventory view selects an explicit accepted revision per entity and
inventory, then applies any accepted curation policy. It must not pick the most
recently uploaded row globally. A use case spanning entities can retain several
different baseline revisions.

For full snapshots, absence from a later selected snapshot can mean no longer
present in that snapshot; it does not delete the earlier observation. For
partial or incremental submissions, absence says nothing about the subject.
Coverage and submission kind must therefore be recorded before making current
views.

## Master dataset register

Maintain one master record per resolved dataset alongside the delivery history.
Give it a generated Record ID independent of vendor identifiers and names. Link
submitted dataset records to that identity through scoped, versioned resolution
decisions. A rename, new sprint, or another delivery does not itself create a
new dataset. Equal names in different entities or source systems do not prove a
shared identity. Suspected duplicates remain pending until resolved; report
unresolved dataset observations separately from confirmed master counts.

The register should expose these fields without requiring users to reconstruct
the import history:

| Field                                | Meaning                                                                                      |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| Dataset ID, name, entity, and domain | Resolved identity and accepted descriptive details                                           |
| Source system and vendor references  | Scoped aliases retained with their supporting sources                                        |
| First seen and latest delivery       | Earliest known evidence and latest relevant receipt, distinct from acceptance                |
| Current accepted revision            | The dataset baseline selected by the acceptance policy                                       |
| Attribute count                      | Distinct active resolved attribute memberships in that baseline                              |
| CDE count                            | Distinct active CDE subjects linked to that dataset under the selected classification policy |
| Coverage and unresolved counts       | Whether counts describe a full inventory or a known subset, and what remains unresolved      |
| Cleansing status and dates           | Reported completion, latest verified completion, scope, and revision covered                 |
| Evidence and outstanding issues      | Supporting deliveries, decisions, disputed values, and unresolved mappings                   |

Vendor-reported totals remain separate from these calculated counts. Unknown
counts are not zero. If only a partial attribute submission is available, show
the observed count with partial coverage instead of implying a complete dataset
inventory. Dataset-level counts can overlap across datasets, so entity-wide
distinct totals must deduplicate subjects rather than sum dataset counts
blindly.

Keep attributes and CDEs in related tables with explicit dataset memberships and
attribute-to-CDE links. A CDE linked through five attributes contributes one to
that dataset's distinct CDE count. Repeated submissions of the same membership
do not increase its current count. Preserve the reported mapping and its
baseline even when the accepted mapping later changes.

Record cleansing as repeatable events. Each event identifies the dataset
revision, covered attributes or declared population, activity dates, vendor,
reported outcome, verification status, and supporting evidence. File receipt is
not cleansing completion. Retain the vendor's reported completion date even when
validation remains pending or fails. A later revision with additional attributes
can need further cleansing without erasing the previously verified work. Do not
mark an entire dataset cleansed from evidence covering only a subset. When the
source does not describe the scope, show it as unknown.

For example, two successive submissions can both map to dataset DS-0001. Its
register entry uses the accepted memberships, retains each delivery link, and
lists both cleansing events with their coverage. Reimporting the same
second-delivery contents changes neither the accepted attribute count nor the
CDE count. A newly recorded delivery is still visible in its receipt history.

Curated master edits and accepted reconciliation update affected memberships and
derived summaries together. Keep the supporting decision and prior values. An
implementation may cache counts for large inventories, but the cache must match
the selected baseline and policy and remain reproducible from the memberships.
Recompute affected datasets instead of scanning seventy million observations
after each edit. Explicit merge, split, retirement, and restoration operations
preserve historical identities and flag affected use-case links.

## Direct database edits and later reconciliation

The local database remains authoritative after import. Source observations are
immutable evidence inside it. Corrections, DQ mappings, decisions, and curated
records are edited there incrementally, without reopening Excel. A correction
must not change the answer to what the original file reported.

If a later explicit operation updates a curated table, compare the prior
accepted baseline B, current value C, and proposed value N. Agreement needs no
change; source-only change can be accepted under policy; database-only change is
preserved; competing changes require resolution. With no baseline, unequal
values are not automatically overwritten. This is a separate reconciliation
operation, not the default import path.

Explicit clearing, replacement, and deletion remain separate choices. They must
validate affected references. Retention or pruning must not discard the source
evidence needed by active use-case mappings.

## Schema and relationship behavior

Assign tables stable identities separate from their display names. Keep schema
versions with the import plan. Renaming a table does not create a new
population.

Prefer explicit schemas and reusable templates. Infer types for new inputs as
proposals, then validate the entire input. Preserve identifiers with leading
zeros, distinguish missing from empty values, and declare decimal precision,
date formats, time zones, and formula-value handling. Import cached Excel values
with clear handling of missing caches and error cells; Excel formula execution
is a separate capability.

Permit approved additive nullable columns. Do not silently narrow types, drop
columns, replace keys, or convert failed values to null. Adding a required
column needs a valid default or backfill plan. Whole-schema changes apply before
data publication and must preserve the existing database on failure.

Resolve referenced parents before publishing dependent records. Multiple foreign
keys cover different roles; link tables cover many-to-many relations. If an
attribute occurs in several datasets, model that membership explicitly. A
use-case mapping can target that membership and its revision rather than an
ambiguous attribute name. Parent and child selections can come from different
files in one import plan.

Check combinations as well as individual references. Valid domain and dataset
IDs can still form an invalid pair. Source records with unresolved references
remain queryable as source observations with unresolved links; they cannot
masquerade as resolved relationships in accepted current views.

Recommend restrict-on-delete for referenced records. Retiring a dataset
preserves historical links. Combining or splitting resolved records needs an
explicit operation that updates or flags dependent mappings transactionally.

## Synthetic dataset inventory example

Represent contributor assignments explicitly, without assuming a fixed number of
suppliers per organization. An inventory supplier and a use-case contributor can
reference the same dataset. Do not assume vendor names identify records or that
phase changes automatically create new datasets.

Keep inventory assertions, use-case requirements, CDE recommendations, and
accepted classification decisions distinct. Each carries source or author,
subject, scope, and the inventory revision it relies on. Who approves CDEs and
whether designation is global or scoped remain business decisions.

A use case can reference several entities at different inventory revisions.
Retain each baseline. When a referenced attribute changes, compare the relevant
fields and memberships; an unrelated inventory change should not invalidate all
use cases.

Example: revision 1 says non-CDE; the use-case contributor recommends CDE based
on revision 1; revision 2 already says CDE. Expose agreement with the current
inventory while retaining the recommendation. If the attribute was split or its
meaning changed, flag the mapping for revalidation rather than silently moving
the recommendation. A source assertion becoming CDE is not proof of formal
approval unless the agreed authority rule makes it so.

Recommend typed observation tables for per-file queries, with explicit current
inventory and mapping views for current-state questions. Retain per-submission
classifications and their decision context. Do not copy the entire database for
each new inventory. Benchmark the cost of repeated rows across distinct files.

## Storage and performance recommendation

Open or create one persistent local working file in the selected SQLite or
DuckDB format. Retire whole-database loading into application memory and full
serialization on save. Normal writes commit incrementally; export is a copy or
conversion operation, not the durability boundary. Engine caches and bounded
processing buffers remain necessary. Both are managed by @consultchimps/db
through common operations. DuckDB remains the analytical recommendation; SQLite
is also a working format, not only an export target. Conversion creates an
independent artifact with explicit type, constraint, and metadata validation,
not a second synchronized authority.

Compare this candidate against direct SQLite storage queried through DuckDB. Do
not assume SQLite indexes, DuckDB indexes, or sorted imports universally
accelerate joins. Evaluate types, join cardinalities, physical ordering,
statistics, and measured query plans against representative queries.

For browser operation, recommend a persistent local working database with an
explicit portable export. OPFS is a candidate, not a promise of support at this
scale. A browser-owned working file is distinct from the user-selected source
file; show that distinction explicitly. Copy and export must use bounded memory.
External DuckDB reads the exported artifact; the CLI operates on a local file.
Browser edits after export do not update that exported copy. Importing an
externally edited copy requires version checks, not automatic replacement.

The browser database must survive close and reopen without serializing its full
contents after every edit. Explain where it lives and how to export or remove
it. Browser quota, disk capacity, permission loss, eviction, and crash recovery
are release criteria. No source workbook remains a runtime dependency.

Use bounded batches end to end, including hashing, ZIP decompression, shared
strings, parsing, mapping, and writing. A streaming interface wrapped around a
whole-workbook parser does not meet this requirement. Profile existing xlsx
readers before choosing which internals can be reused.

Use bounded parallel readers and transformations with a queue that pauses
producers when writing falls behind. One owner applies database changes.
Parallelism is capped by measured memory use. Do not start ten full-workbook
parsers at once. Use bulk loading or prepared batches rather than per-row SQL
setup and metadata lookups.

Use typed business tables for large queryable data. Do not put all cells into
one generic JSON or attribute-value table. Keep import metadata small and source
snapshots stored once per capture. Retained source observations, resolved
mappings, optional current projections, temporary sort space, and transaction
logs all count toward disk cost. A later optimization may share identical
row-value versions while retaining per-file membership. Do not erase membership
merely because two values are equal. Evaluate compact generated key
representations, document the chosen contract, and migrate callers together.

Benchmark initial and post-update queries, refresh statistics where needed, and
make expensive reordering or compaction explicit operations. Do not rebuild a
large table after every edit. Export after a consistent checkpoint and verify
the exported file in a fresh native DuckDB process.

## Recovery and external writers

Recommend durable staging with an import state: captured, planned, needs review,
ready, applying, completed, or failed. Partial captured batches are never shown
as accepted business rows. A retry resumes a verified stage or discards only its
own unfinished stage.

Recommend a connected group of related target tables as the publication unit.
Schema changes, observations, links, and receipts for that unit commit
atomically. Independent groups may be selected separately; partial completion
must be reported explicitly. Test the transaction-log and disk footprint before
claiming full-workload atomic application is feasible.

Keep existing database data intact on invalid inputs, disk exhaustion, or failed
application. Plans can be saved and reviewed, but become stale when their target
schema, values, or relevant policy changes. Recheck under database write
ownership before applying. Do not trust only an application revision counter if
external SQL could have changed the file.

Recommend governed writes through the shared database operations initially.
External DuckDB querying is in scope from the start. If direct external SQL
writes are supported, inspect live values and schema on reopen and treat their
author as unknown. We cannot reconstruct unrecorded intermediate edits or claim
complete audit history. Concurrent application and external writers are not an
implicit capability.

## Modules and proposed interfaces

These are proposed contracts, not shipped commands. Reuse existing packages and
introduce new ones only for a distinct runtime or dependency boundary.

| Owner                    | Responsibility                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| xlsx                     | Select source regions and produce bounded batches with source coordinates                         |
| tabular                  | Validate mappings, normalize and convert batches, define reusable DQ rules                        |
| db import module         | Capture sources, identify duplicates, propose routing and changes, persist and apply import plans |
| db storage module        | Own engine resources, transactions, schema, references, incremental persistence, and export       |
| db reconciliation module | Match identities, compare baselines, resolve approved changes, validate dependent mappings        |
| core and files           | Shared results, progress, cancellation, artifact references, and safe CLI file destinations       |
| CLI and browser          | Collect options, render review, and call the same operations                                      |

The caller-facing shape should remain small:

```text
prepareImport(database, sources, recipe, staging, controls) -> PreparedImportRef
inspectImport(preparedImport, page) -> CountsAndExamples
resolveImport(preparedImport, decisions) -> ReadyImportRef
applyImport(database, readyPlan, controls) -> OperationResult
exportDatabase(database, destination, options) -> ArtifactRef
```

A plan or table reference names managed staged or persisted data; it is not an
array of millions of JavaScript objects. A recipe stores intent and rules; a
plan stores the exact changes against a particular baseline. Preview and
execution use the same derived plan so their decisions cannot drift.

Database create, schema apply, seed/import, inspect, and export are foundation
operations. Both SQLite and DuckDB are working formats, with validated
conversion between supported schemas. Validation and optimization can expand
later. Browser sequences and CLI recipes compose these operations. Do not build
a general workflow scheduler or visual pipeline editor before two real
compositions require it.

## Staged delivery

Each product PR ships browser and CLI behavior together where applicable. Small
fixtures belong in CI; the full-scale benchmark is reproducible outside routine
CI. Refactor the existing workspace into the same product, retaining useful
import and management behavior and updating their callers and tests together.
Paused analytics UI migration is not a delivery requirement.

| Stage                                       | Deliverable                                                                                                                                                                   | Exit evidence                                                                                                                                       |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storage experiment                          | Compare native DuckDB and SQLite, browser persistence, export/reopen, and bounded Excel parsing                                                                               | Measured memory, disk, and query behavior up to the target workload; an engine and storage recommendation                                           |
| PR 1: File-attributed database creation     | Create SQLite or DuckDB databases, apply schemas, seed typed tables, route sheets, map columns, generate IDs, hash sources, append observations, persist and validate exports | Query CDE rows by file in standalone DuckDB; repeated 300k-row file adds nothing after reopen; two different files retain separate classifications  |
| PR 2: Extend an existing database           | Select existing or new tables, append new submissions, review schema changes, retain incompatible inputs for resolution, save recipes                                         | Updated submission appends evidence without rewriting the earlier file; schema conflicts offer explicit choices; imports preserve database curation |
| PR 3: DQ, current views, and drift          | Resolve subjects, configure relationships, select current revisions, compare inventories, model use-case and CDE decisions                                                    | Old and new classifications remain queryable; unresolved identity is visible; affected use-case mappings are flagged without inventing authority    |
| PR 4: Standalone operations and composition | Richer schema templates, validation, explicit curated updates, optimization, and reusable sequences over foundation operations                                                | Browser and CLI compose the same operations without loading full tables between steps                                                               |
| Paused indefinitely: Analytics UI           | Query editor, analytical browsing, charts, and general grid editing                                                                                                           | Resume only after an explicit product decision; evaluate external tools separately                                                                  |

PR 1 establishes provenance and source-observation identity. It does not require
matching all vendor records before data can be imported or queried by file. CDE
matching and approval policy do not block the generic source importer. PR 1 also
establishes delivery events, declared coverage, reported metrics, and membership
references for reused contents. Prove a second recorded delivery can reuse a
300k-row capture while remaining separately queryable. PR 3 adds scoped current
views, reconciled counts, and versioned relationship interpretation. PR 3
includes the master dataset register and cleansing events. Its acceptance checks
cover repeated deliveries resolving to one dataset, equal names resolving to
different datasets, distinct CDE counts across repeated mapping rows, partial
coverage, and new attributes arriving after verified cleansing.

The storage experiment is an evidence gate, not a substitute for the first
usable import PR. A CLI-only result is not proof of browser support. If the
target browser cannot handle the workload, report that and propose an explicit
supported limit or local execution alternative rather than a silent server
fallback.

## Acceptance examples and benchmarks

Import file A with 300,000 attribute observations. Import file B, a distinct
submission, with another 300,000 observations. The baseline implementation holds
600,000 observations with separate file membership, regardless of how many
subjects later prove to overlap. Importing A or B again in the same context adds
zero. An optimization may share repeated value storage, but must preserve the
same 600,000 source-occurrence memberships.

If A reports attribute X as non-CDE and B reports X as CDE, each file-specific
query must return its own reported value. Comparing X across files requires a
validated identity mapping. A current view choosing B reports CDE without
erasing A. A use-case recommendation based on A retains its original baseline.

Verify distinct output metrics for observation count, distinct resolved
subjects, unresolved subjects, reported CDE rows, and approved designations. A
query should not label all 600,000 observations as unique attributes.

Also cover repeated files in one batch, renamed files, new sheet selections,
changed recipes, legitimate duplicate-looking rows, missing CDE values, new
tables, two sheets feeding one table, new nullable columns, incompatible types,
interrupted captures, disk exhaustion, and direct curation followed by another
source import.

Benchmark file-filtered CDE queries, entity/domain filters, subject comparisons,
dataset-to-attribute joins, use-case mappings, current-inventory views, and
computed expressions. Include one-to-many and many-to-many cases and report join
cardinality. Indexing or physical ordering should be evaluated against file and
revision filters as well as business queries.

Measure geometrically increasing synthetic row counts with narrow and wide
schemas until a documented resource limit is reached. Include multiple
submissions of overlapping data to expose storage growth. Record browser and
engine versions, worker count, peak memory, temporary disk, final size, import
time, query plans, cold and warm query times, curation cost, and export/reopen
cost. Publish results before setting performance promises.

## Remaining decisions and proposed defaults

Resolve engineering choices through focused implementation and verification.
Engineering owns the experiment, module boundaries, recovery behavior, and test
coverage.

| Question                                      | Proposed default or owner                                                                                                                 |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Working formats and engine capabilities       | Support both formats; select per database and publish measured tradeoffs rather than promising equal performance                          |
| Identity matching without reliable vendor IDs | Configurable scoped DQ rules; uncertain matches stay pending                                                                              |
| CDE authority and scope                       | Business decision; preserve recommendations without automatic approval until specified                                                    |
| Meaning of subset                             | Support explicit selected-attribute membership first; filtered-row subsets require a declared predicate contract                          |
| Blank updates and omitted records             | No overwrite for absent fields; explicit clearing; no inferred deletion                                                                   |
| Rejected-row behavior                         | Block apply by default; explicit exclude-and-retain-pending choice with counts and provenance                                             |
| External SQL writes                           | External reads supported first; governed operations for audited writes; direct writes need live validation and limited audit claims       |
| Version retention                             | Keep baseline and changed record evidence needed for active mappings; no full-database revision copies; define pruning before offering it |
| Actual performance envelope                   | Need representative widths, data distributions, file sizes, and target machines before publishing limits                                  |

## Existing constraints and decisions to revisit

The original db spike used sql.js and an in-memory database serialized on save.
Its xlsx reader materialized worksheets, and insertion performed per-row work.
The persistent implementation replaces these paths with file-backed engines,
streaming capture, and bounded batch insertion, as recorded in
[ADR 0005](adr/0005-persistent-database-imports.md).

[ADR 0003](adr/0003-local-database-workspace.md) records the spike's SQLite
engine, OPFS mirror role, generated text IDs, and foreign-key choices. These
decisions can be revised for the unified db implementation. Update the
architecture record, migrate callers, and remove replaced code without retaining
a separate legacy product. Validate any saved-file conversion and preserve
source data. Identity matching does not make a vendor identifier authoritative.

Preserve the repository's deterministic, local-first behavior, input safety,
structured errors, thin adapters, and source-region semantics. New outputs must
be validated before publication. SQL identifiers must be quoted and data bound;
source names and mapping files are untrusted inputs.

## Decision log

- Import Excel once; thereafter the local database is the working authority.
- Retire the whole-database in-memory lifecycle. Open persistent local files,
  commit incrementally, and use bounded memory for processing and export.
- Pause analytics UI work indefinitely, including general grid migration. Resume
  only after an explicit product decision. Keep browser database management and
  import review in scope; evaluate DuckDB UI separately for external analysis.
- Exercise generated fixtures at increasing scales and publish measured limits;
  do not publish private workload details as benchmark requirements.
- Generate import and source-row identities independently of vendor IDs; DQ can
  resolve multiple source rows into one business record later.
- Use content hashes to avoid repeating identical completed imports.
- Model contributor roles and assignments explicitly; inventory baselines,
  mappings, and CDE recommendations can drift across submissions.
- Support creating tables, selecting existing tables, and choosing separate
  tables for unresolved schema incompatibilities.
- Preserve distinct submissions as observations with membership queried per
  file; curated updates remain separate operations.
- Begin staged delivery with the storage experiment and import foundation.
- Repeated contents can be evidence of separate deliveries. Preserve touch
  points while reusing captured data. Record full versus sprint-only coverage,
  vendor totals separately from observed counts, and submitted attribute-to-CDE
  links.
- Support a master dataset register with unique resolved datasets, attribute and
  CDE counts, and cleansing history. Preserve the delivery trail separately and
  derive current counts from accepted memberships and coverage.
- Use the existing @consultchimps/db package and consultchimps db CLI group for
  SQLite and DuckDB working files and outputs. Refactor the database spike and
  workspace together; old APIs are not a compatibility requirement.
- Detailed identity rules and CDE authority remain configurable. Both storage
  adapters still require correctness, recovery, and conversion verification.

## Sources and principles

The DuckDB documentation supports the engine experiment, not a performance claim
about ConsultChimps:

- [Persistent browser storage and threading](https://duckdb.org/docs/current/clients/wasm/instantiation)
- [Browser limits](https://duckdb.org/docs/stable/clients/wasm/overview)
- [SQLite integration](https://duckdb.org/docs/current/core_extensions/sqlite)
- [Physical ordering](https://duckdb.org/2025/05/14/sorting-for-fast-selective-queries)
- [Index tradeoffs](https://duckdb.org/docs/current/guides/performance/indexing)
- [Join statistics](https://duckdb.org/docs/current/sql/statements/analyze)

Applied principles:

- Foundational thinking: choose persistent artifact and identity contracts
  before extending the browser editor.
- Model the domain: separate source observations, current views, revisions,
  mappings, and approval decisions. Separate delivery events from captured
  contents so duplicate protection does not erase the vendor paper trail.
- Make operations idempotent: bind receipts and changes so retries add no
  copies. Apply retry identity to the delivery operation independently of file
  hashes, preserving intentional repeat deliveries.
- Subtract before you add: reuse existing semantics, avoid a workflow framework,
  and keep recurring vendor synchronization out of scope.
- Prove it works: measure real exported artifacts and persistence at target
  scale.
- Sequence work into verifiable units: ship creation, reconciliation, DQ, and
  composition as independently usable increments with explicit exit checks.
- Log what the human decided: distinguish confirmed requirements from proposed
  defaults and unresolved business policies.
