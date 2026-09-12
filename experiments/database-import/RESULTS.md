# Storage experiment results

These measurements use generated synthetic fixtures. Personal machine details
are intentionally omitted, so the timings are illustrative observations rather
than a hardware-normalized benchmark or a sizing recommendation.

Node was 24.18.0 and Chromium was 151.0.7922.34. DuckDB-Wasm ran engine 1.5.4
with one worker. Native DuckDB used 1.5.5 and four threads for the format
comparison. Both used a 1 GB database memory setting.

These are development measurements, not a supported-capacity promise. Other
checks ran on the same machine during parts of the experiment. The fixtures are
narrow and repetitive. First and second executions are not cold-cache and
warm-cache measurements.

## Browser storage and artifact

The [storage result](results/storage.json) creates rows inside DuckDB. It does
not parse Excel.

| Check                                         | Measured result                             |
| --------------------------------------------- | ------------------------------------------- |
| Insert the first 300,000 rows                 | 117 ms                                      |
| Append to seven million rows                  | 1,899 ms                                    |
| Append to seventy million rows                | 17,123 ms                                   |
| Filtered dataset join and decimal calculation | 59 ms, then 37 ms                           |
| Reloaded database count                       | 70,000,000 rows, 7,000,000 CDE flags        |
| Exported database                             | 432,812,032 bytes                           |
| Stream the export to the local test server    | 329 ms                                      |
| Native reopen                                 | Counts and subsequent curation row verified |

The join filters one source file, selects seven million observations, joins
100,000 dataset records, and returns twenty domain groups. This measures one
specific many-to-one join, not the performance of arbitrary vendor queries.

The first OPFS attempt created tables that disappeared on reload. Explicit
registration of the database and WAL file handles with direct I/O passed the
reopen checks. That result establishes the tested graceful-close behavior. Crash
recovery, transaction interruption, quota failures, browser eviction, and
conflicting writers remain unverified.

## Excel parsing

The [small Excel result](results/excel-small.json) imports 300,000 rows from a
real generated workbook in 3,250 ms. It verifies 30,000 CDE flags after page
reload and native reopen. The resulting database is 2,109,440 bytes.

The existing ConsultChimps worksheet reader took 8,159 ms and reached about 1.96
GB maximum resident memory for the same 300,000-row source. This separate Node
measurement used the existing built xlsx byte API with a 2 GB JavaScript heap
limit. It is a baseline for the current whole-workbook reader, not a
browser-versus-native engine comparison.

The [seventy-million-row parsing run](results/excel-seventy-million.json) spent
873,917 ms, about 14.6 minutes, in its ten workbook parsing and insertion loops
and exported a 422,850,560-byte database. This excludes hashing, plan review,
final export, and application-level provenance work. Native DuckDB independently
[verified](results/excel-seventy-million-native.json) 70,000,000 observations,
7,000,000 reported CDE flags, and ten source scopes.

The run parsed one seven-million-row workbook ten times under different source
scope labels. The workbook is 170,663,567 bytes and contains seven sheets of
repeated narrow data. This deliberately bypasses deduplication to stress Excel
parsing. It is not a test of ten distinct vendor files or import receipts.

The [memory sample](results/excel-memory.json) reached about 4.0 GiB for the
Node server and Chromium process tree. Sampling began after the first two sheets
and ran every two seconds, so this is a sampled maximum over part of the run. It
is not a browser memory guarantee. The 1 GB database setting did not cap the
whole process group at 1 GB.

This long run used the exploratory runner before the checked-in harness was
consolidated. The checked-in `excel` command repeats its source-reading sequence
and adds assertions. The checked-in small-import and storage modes were run with
their assertions enabled. Repeating the consolidated long run is still required
before using it as an automated release check.

## DuckDB storage versus SQLite compatibility

The [format comparison](results/comparison.json) uses seven million typed
observations and 100,000 dataset records. DuckDB executes the query in both
cases. The filtered join returns 700,000 observations grouped into twenty rows.

| Working format                         | First measured join | Second measured join |
| -------------------------------------- | ------------------- | -------------------- |
| Native DuckDB                          | 6 ms                | 3 ms                 |
| SQLite through DuckDB, without indexes | 153 ms              | 152 ms               |
| SQLite through DuckDB, with indexes    | 153 ms              | 156 ms               |

The SQLite indexes cover source-file filtering and the dataset key. They did not
improve this DuckDB query path. Native DuckDB occupies 39,858,176 bytes. SQLite
including these indexes occupies 367,173,632 bytes.

DuckDB's SQLite exporter stored the decimal amount column as text. The measured
query explicitly converts amounts to `DECIMAL(18,2)` in both cases and verifies
a known result. A compatibility export therefore needs declared type mappings.
It cannot promise unchanged schemas and calculations just because both formats
accept SQL.

## Current import pipeline

The [pipeline result](results/pipeline.json) runs the current ConsultChimps
inspect, prepare, resolve, and apply operations. Unlike the direct storage
measurements above, these runs hash and parse a generated Excel workbook,
capture review rows in the prepared SQLite file, resolve the inferred schema,
copy provenance rows into DuckDB, convert captured JSON into typed rows, and
checkpoint the result.

| Check                    | 100,000 rows | 1,000,000 rows |
| ------------------------ | -----------: | -------------: |
| Source workbook          |       2.1 MB |        21.5 MB |
| Inspect workbook         |        28 ms |           3 ms |
| Parse and capture        |     1,371 ms |      13,426 ms |
| Time awaiting row parser |     1,040 ms |      10,329 ms |
| Review captured values   |       176 ms |       1,769 ms |
| Apply to DuckDB          |     1,104 ms |      11,273 ms |
| Prepared SQLite file     |      32.1 MB |       335.6 MB |
| Initial DuckDB file      |      17.3 MB |       109.9 MB |
| Peak sampled apply RSS   |       544 MB |         862 MB |

The one-million-row source, review file, and initial destination occupy about
467 MB while the review artifact remains available, or 22 times the compressed
source size. The destination intentionally contains both one million captured
JSON rows for provenance and reuse and one million typed destination rows. That
disk duplication is part of the current model, not appender buffering.

An earlier A/B run wrapped each bounded 2,000-row capture batch in one
prepared-database transaction and reduced prepare time by 41 percent at both
sizes. At one million rows, capture overhead outside the parser fell from 11,777
ms to 2,896 ms, a 75 percent reduction. Parser time changed from 9,793 ms to
9,898 ms. The 100,000 row run showed the same split: capture overhead fell from
1,215 ms to 313 ms, while parser time changed from 981 ms to 985 ms. These
comparisons use the runs of the same generated fixtures immediately before and
after the capture transaction change, rather than the latest measurements in the
table. The current prepare path sustained about 73,000 rows per second at
100,000 rows and 74,000 rows per second at one million rows.

The native appender sustained about 91,000 rows per second at 100,000 rows and
89,000 rows per second at one million rows through the complete apply path.
Apply timing varies independently of the prepared-database transaction change,
so this run does not attribute an apply-speed change to capture batching.

At one million rows, a count took less than 1 ms, a full-table boolean group
took 2 ms, and a join of the 10 percent CDE subset to 10,000 synthetic dataset
keys took 1 ms. The captured plans at 100,000 rows used sequential scans, hash
aggregation, and a hash join. The fixture makes `is_cde` true for every tenth
row, so the join reads 10,000 of 100,000 rows in that run and 100,000 of one
million rows in the larger run. These narrow, repetitive data make compression
and grouping especially favorable.

The baseline destination had a composite primary key on captured
`(capture_id, source_row)` values, plus a `record_id` text primary key and an
`_imported_row_id` unique key on each imported row. DuckDB backs primary and
unique constraints with adaptive radix tree indexes even though
`duckdb_indexes()` does not list those constraint indexes. The current DuckDB
schema retains the public `record_id` primary key and removes the other two
redundant constraints. SQLite staging keeps its captured-row composite key, and
the import reader now rejects non-positive, duplicate, or decreasing source-row
numbers before staging.

An earlier A/B run before the final parser guards and audit changes measured the
constraint change at one million rows. It reduced the initial DuckDB file from
124.5 MB to 105.4 MB, a 15 percent reduction. Apply changed from 11.1 to 12.5
seconds in the baseline runs to 11.0 seconds in the changed run. Peak apply RSS
changed from 809 to 866 MB in the baseline runs to 811 MB in the changed run.
The timing and memory values overlap the observed run-to-run variation, so this
experiment establishes the storage reduction but does not claim a throughput or
memory reduction.

The final database replayed its stored capture into a second one-million-row
table in 10.0 seconds. The file then occupied 165.2 MB. Converting both user
tables to SQLite copied and verified two million typed rows in 15.3 seconds; the
resulting SQLite file occupied 484.9 MB. The replay shows that ordered keyset
reads remain practical for this one-capture fixture without the DuckDB composite
key. It does not cover shuffled physical rows or many interleaved captures,
where repeated scans could behave differently despite zone maps.

The final benchmark runs both sizes in one process, so the larger run starts
with memory retained from the smaller run. The one-million-row apply phase
increased sampled RSS from about 634 MB during preparation to 862 MB, while
JavaScript heap during apply stayed below 117 MB. Conversion reached about 895
MB RSS. These are sampled process totals, not incremental memory costs. This
measurement does not isolate record ID index memory from DuckDB's buffers and
allocator, but it shows that bounded 2,000-row application batches do not bound
native process memory. Keep the reduced constraint layout for this phase, and
test browser memory with several interleaved captures before making another
key-model change.

The benchmark uses numeric, text, boolean, and integer dataset columns. It does
not put formulas, error cells, rich strings, dates, decimals, blobs, wide rows,
or a large shared-string dictionary into the scale fixture. Focused reader and
native adapter tests cover those value forms, but their memory and throughput at
one million rows remain unmeasured. These native RSS results also do not
establish a safe DuckDB-Wasm size in a browser process.

## Historical experiment decision

This was the experiment's recommendation. The later product decision in
[ADR 0004](../../docs/adr/0004-persistent-database-imports.md) supersedes it:
both formats are persistent working databases, the in-memory spike is retired,
and the analytics UI is paused. These measurements remain an engine baseline;
they do not measure the current import metadata and index layout.

The original experiment recommended bounded source reading, persistent import
receipts, immutable source observations, and file-attributed queries. The
current pipeline above implements those foundations and replaces the in-memory
SQLite lifecycle.

The DuckDB Excel extension supplies a useful performance baseline. It still
needs conformance checks for physical source rows, table regions, formula
caches, errors, dates, leading-zero identifiers, and shared strings before
adoption. The browser package's prerelease status also needs a production
release decision.

The direct-engine experiments above did not implement the import product. The
current package adds capture reuse, saved column routes, schemas, relationships,
and browser and CLI import operations. Business DQ policy, current-inventory
selection, and CDE approval remain later operations.
