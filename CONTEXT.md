# Glossary

The canonical vocabulary for ConsultChimps operations. Code, docs, CLI help, and
issues use these terms with exactly these meanings.

- **Consolidate**: stack rows from many worksheets into one table. Never called
  "merge".
- **Merge (workbooks)**: copy worksheets into one workbook as separate tabs.
  Never stacks rows.
- **Split (spreadsheets)**: produce one workbook per distinct value of a column.
- **Split (PDF)**: produce one file per page of a document.
- **Inspect**: describe an input's structure without producing files. The
  toolkit's single verb for this, used by PowerPoint template inspection and
  workbook inspection alike ("describe" appears only in library function names
  such as `describeWorkbook`).
- **Column key**: the case-folded, trimmed form of a header used for matching
  (`columnKey`).
- **Normalized column key**: the aggressive matching form, lowercased with every
  separator run collapsed to one underscore (`normalizedColumnKey`). Matching
  only; never shown as output.
- **Canonical column**: the output column name a mapping declares. Written
  verbatim to the output, never normalized.
- **Alias**: a source header spelling that a mapping folds into a canonical
  column. Aliases match by normalized column key.
- **Column mapping**: the declarative, versioned JSON document of canonical
  columns, their aliases, optional coercions, and constant columns, applied
  during consolidation.
- **Coercion**: a deterministic per-column value conversion declared in a
  mapping (dates from a declared format, number parsing).
- **Unmapped column**: an input column no mapping entry matches. Passes through
  under its own name, with a warning.
- **Assist / suggestion**: a drafted mapping produced from
  normalization-equivalence groups for the user to review. Never applied
  silently.
- **Surface**: one of the three ways an operation ships (CLI, library, browser),
  each with its own status in the tool registry (ADR 0001).
- **Source columns**: the provenance columns consolidation appends
  (`_source_file`, `_source_sheet`, `_source_row`).
- **Preservation matrix**: the published projection of the xlsx conformance
  contract, stating what each Excel operation does to each tracked workbook
  structure. Generated from `packages/xlsx/src/contract.ts` and checked by
  `pnpm docs:check`. Its statuses are the site's only words for a contract cell:
  "Preserved" (`preserve`), "Adjusted to stay correct" (`fix`), "Removed,
  reported as a warning" (`strip-warn`), "Refused before anything is written"
  (`refuse`), and "Needs review" (no declared cell).

## Database workspace

[ADR 0005](docs/adr/0005-persistent-database-imports.md) defines persistent
storage and import identity. Analytics UI work is paused indefinitely.

- **Workspace**: the stateful page for creating or opening a persistent local
  database, managing schemas, reviewing imports, and exporting copies. A browser
  working file can be distinct from the original selected file.
- **Database**: the local relational store for a project, held in a single file
  that carries its own tables, schema, and identifier state. After initial
  import, it is the authoritative working copy for subsequent queries and edits.
- **Database import**: the introduction of selected source data into a database.
  Continuing work on that database does not require repeating the import.
- **Import recipe**: reusable source selection, table routing, mapping,
  matching, and conflict rules for database imports.
- **Import plan**: the proposed table and record changes for particular captured
  sources against a particular database baseline, derived from an import recipe.
- **Import ID**: an identifier assigned by ConsultChimps to a captured database
  import, independent of identifiers in the source files.
- **Imported Row ID**: an identifier assigned by ConsultChimps to a captured
  source row. Distinct imported rows can later be found to describe one entity.
- **Source File ID**: an identifier for a captured file, distinct from its
  display filename and from an import that may include several files.
- **Delivery event**: a recorded touch point when a vendor supplies or reaffirms
  a deliverable or claim. Separate events can reference the same file contents.
- **Deliverable scope**: the entity, deliverable type, phase, sprint, and
  covered population that a submission describes. Coverage can be full, partial,
  an explicit set of changes, or unknown.
- **Reported metric**: a vendor's stated count with its unit, scope, and date,
  distinct from a count calculated from delivered rows.
- **Delivery membership**: the association between a delivery event and the
  captured observations or relationship assertions it supplied.
- **Source observation**: what a source row reported in a particular file and
  import context. Later classifications do not replace that observation.
- **Current inventory view**: the inventory selected as current under an
  explicit revision and curation policy, distinct from all source observations.
- **Data-quality rule**: a declared rule for checking or correcting imported
  data, abbreviated DQ rule.
- **Table**: a named set of columns and the records held under them.
- **Record**: one row of a table.
- **Record ID**: the human-readable, always-generated, immutable identifier for
  a record (for example `CUST-0001`) that relationships reference. Provisional
  name, agreed changeable.
- **Relationship**: a link from a column in one table to another table's Record
  ID (a foreign key).
- **Computed column** (defined for later): a column whose values are derived by
  a formula rather than entered by hand.
- **Dashboard** (defined for later): a saved arrangement of charts and figures
  drawn from the database.

## Dataset inventory terminology

- **Entity**: a participating organization in a data inventory. Distinct from a
  database record.
- **Inventory vendor**: a supplier of dataset and attribute inventory records.
- **Use-case contributor**: a person or organization defining use cases and
  mapping their data needs to submitted inventories.
- **Critical data element**: a data element designated as critical under a
  declared classification policy, abbreviated CDE.
- **Dataset record**: a row representing a dataset in a submitted Excel
  workbook.
- **Master dataset**: a resolved dataset identity that can be referenced by
  several submitted dataset records. Its identity persists through renames,
  vendor submissions, and phases unless an explicit split or merge changes it.
- **Master dataset register**: the list of resolved datasets with their current
  accepted details, attribute and CDE memberships, and cleansing history.
- **Cleansing event**: a reported or verified cleansing activity for a dataset
  revision and a declared scope, distinct from receiving its inventory file.
- **Inventory revision**: a particular version of an entity's inventory,
  including its dataset and attribute descriptions and classifications.
- **Use-case mapping**: a statement linking an AI use case to the datasets,
  attributes, or subsets it needs.
- **CDE recommendation**: a proposal to classify an attribute as a CDE because a
  use case requires it. Distinct from its existing inventory classification.
- **Inventory drift**: a relevant change between the inventory a use-case
  mapping was based on and the inventory now held in the database.

## Power BI (draft)

First draft, added with ADR 0004. The verb and nouns are proposed, not final.

- **Export (Power BI)**: write each exportable table of a Power BI file's model
  to a workbook, as one or more worksheets per table. Never called "extract" or
  "convert".
- **Exportable table**: a model table the export policy admits: not hidden
  (unless hidden tables are included), within the column limit, and with at
  least one column whose values can be decoded and represented in the workbook.
- **Model**: the tables and their loaded rows carried inside a `.pbix` file. A
  template (`.pbit`) or a live-connection file carries no model.
- **Model table**: one named table of the model, with its columns and rows.
- **Hidden table**: a model table the file marks as not user-visible, such as
  the date tables Power BI generates on its own.
- **Calculated table / calculated column**: a model table or column whose rows
  were produced by a DAX expression rather than loaded from a source. Exported
  as data.
- **Manifest**: the record an export returns alongside the workbook, naming
  skipped tables and columns, worksheet splits, and counts of values rounded,
  truncated, or encoded as text, grouped by column and reason.
