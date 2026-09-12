# Persistent database files and auditable imports

Status: Accepted for implementation. This decision supersedes ADR 0003's
in-memory storage and save model. Analytics UI work from that spike is paused
indefinitely and requires an explicit product decision to resume.

## Context

Database imports can exceed the memory available to a browser or native process.
Loading a complete database into a JavaScript buffer and serializing it on save
makes file size a memory requirement. Materializing an Excel workbook before
insertion creates the same problem earlier in the import.

Repeated source content also has two meanings. An accidental retry must not
duplicate observations. A deliberately recorded delivery must remain visible in
the audit trail even when its contents were supplied before.

## Decision

Refactor the existing `@consultchimps/db` package into one asynchronous database
interface. SQLite and DuckDB are both persistent working formats and output
formats. Internal engine adapters implement storage, SQL, and transaction
mechanics. Shared operations implement schemas, identifiers, imports, receipts,
and delivery history. There is one `consultchimps db` command group and one
browser `/workspace` for database management and import review.

Native operations open a local database path. Browser operations use persistent
browser storage and identify its working location explicitly. An origin-private
working copy is distinct from the original selected file and from an exported
copy. Ordinary writes commit incrementally. Export produces a consistent copy or
a validated conversion; it is not required to make ordinary changes durable.

Memory is used for engine caches and bounded processing batches. Source reads,
shared-string lookup, import staging, previews, and export must avoid complete
workbook or database buffers. Temporary disk, transaction logs, and engine spill
space count toward the operation's storage budget.

`@consultchimps/xlsx/stream` owns bounded Excel decoding and physical source
coordinates. `@consultchimps/tabular` retains the general table and mapping
operations. The initial db recipe uses explicit typed source-to-destination
column routes and preserves raw numeric tokens until database conversion. It
does not pass captured values through the materialized tabular table model.
Packages use public exports when sharing behavior. Runtime-specific entry points
load their own native or browser engine assets. The root entry point does not
initialize an engine on import.

## Import and delivery identity

Separate the content hash, selected source capture, application receipt,
generated row identity, and delivery event. Identical content with the same
selection and import intent reuses its completed capture/application. An
intentional new delivery references existing captures without duplicating row
values. A retry key makes delivery recording idempotent.

Append source observations for changed submissions. Do not infer deletion from
an omitted row or turn a vendor identifier into an authoritative record key.
Retain typed business tables and queryable provenance. Reported totals and
coverage are delivery context, separate from measured row counts.

Preparation stores captured data and reviewed mapping decisions in a managed
staging artifact. Applying rechecks the destination identity and relevant live
schema, then commits a connected group of tables and its receipt together.
Cancellation and retry must not expose partially accepted observations.

## Conversion and external analysis

Conversion validates types, values, keys, and unsupported engine features before
publishing its destination. Unsupported or lossy conversions are refused by
default. Exported files are independent copies and do not remain synchronized.
Source files remain intact.

External tools can query the resulting file. DuckDB UI is a candidate for that
work, not an embedded dependency of ConsultChimps. Query editors, charts,
analytical browsing, and general grid migration are paused. Their old APIs do
not constrain the persistent database interface. Database creation, schemas,
bounded import previews, delivery history, and export remain in scope.

## Consequences and verification

- Replace the spike's in-memory lifecycle and migrate active callers together
- Retain useful behavioral tests and remove tests that only preserve replaced
  implementation details
- Verify the same import, duplicate, delivery, schema, and recovery rules
  against both engines
- Verify reopen after close and interrupted work, and read exported databases
  with independent native engines
- Measure browser support, memory, quota, and temporary disk costs before making
  capacity claims
- Package required native assets with the CLI distribution; the old single-file
  bundle shape is not a compatibility requirement
- Serve browser engine assets locally from the application origin
- Preserve saved user files; an unsupported spike file receives a clear error or
  an explicitly validated conversion, not an invented history

The [implementation proposal](../database-import-implementation.md) defines the
operation and command plan. Public documentation must describe verified behavior
as it ships, not treat this architecture record as proof of support.
