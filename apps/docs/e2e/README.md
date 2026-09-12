# In-browser tool smoke tests

Playwright drives the statically exported site, not the dev server, so these
tests exercise the same bundles GitHub Pages serves, including the operation Web
Worker, the engines it imports on demand, and the blob download path.

## Running the suite

The suite serves `apps/docs/out`, so the export has to exist first, and it must
be built **without** `NEXT_PUBLIC_BASE_PATH` so the routes are served from `/`:

```bash
pnpm --filter @consultchimps/docs... build
pnpm --filter @consultchimps/docs exec playwright install chromium
pnpm --filter @consultchimps/docs e2e
```

`pnpm --filter @consultchimps/docs e2e` fails with a pointer to the build
command when `out/` is missing.

## What is covered

- `pdf-split.spec.ts`: splitting a two-page PDF into zero-padded page files,
  downloading one of them, and refusing a file that is not a PDF.
- `pdf-merge.spec.ts`: merging two single-page PDFs into `combined.pdf` and
  downloading the result.
- `excel-split.spec.ts`: detecting a workbook's column headers, splitting on one
  of them into a workbook per distinct value, downloading one of them, reading a
  downloaded workbook back to confirm it keeps every source worksheet and
  removes only the other values' rows, reporting a column the workbook does not
  have, inspecting the chosen workbook from the page, and refusing a file that
  is not a workbook.
- `excel-merge.spec.ts`: merging two workbooks into one, reordering and removing
  sources, and downloading the result.
- `excel-consolidate.spec.ts`: stacking two workbooks whose headers drifted
  apart into one table, downloading the result, checking that the "Normalize
  headers" and "Add source columns" checkboxes change the columns the finished
  workbook holds, inspecting one of the added workbooks, applying a column
  mapping end to end and reading the consolidated headers back, refusing an
  ambiguous mapping on selection with its stable error reference, and drafting a
  mapping: the proposed groups, the reviewed draft as valid version 1 JSON, and
  the round trip that applies a draft only after it is added back.
- `excel-inspect.spec.ts`: describing a workbook's worksheets, hidden tabs,
  header rows, Excel Table, named range, and sample column values, turning the
  hidden-worksheet option off to get the description an operation would see,
  inspecting a macro-enabled workbook, refusing a file that is not a workbook,
  explaining a workbook the picker accepts but the operation cannot read (the
  stable error reference included), shortening a 120-column worksheet until the
  toggle asks for the rest, and replacing a workbook mid-inspection so the
  withdrawn report cannot describe the file that was replaced.
- `pptx.spec.ts`: populating a template slide from workbook records into one
  deck, naming the output, downloading it, reporting a placeholder no column
  feeds, refusing a template that is not a presentation, and inspecting a
  template's placeholders with their occurrence counts on the chosen slide.
- `workspace.spec.ts`: creating SQLite and DuckDB working databases in OPFS,
  opening databases created by the native CLI, reviewing and applying schemas,
  exporting actual database files, converting between both formats, reopening
  browser exports with the native engines, reporting unreadable files, and
  blocking incompatible schema changes before any write.
- `workspace-import.spec.ts`: preparing several workbooks together, reviewing
  table routes and bounded row previews, importing through both database
  engines, skipping a repeated capture, recording a separate delivery against
  reused captured rows, appending a changed submission, reopening saved import
  reviews after a worker restart without the Excel files, cancelling workbook
  preparation, resuming an interrupted SQLite apply after its transaction rolls
  back, and recovering a committed receipt after its worker reply is lost.
- `tools-navigation.spec.ts`: the `/tools` index, the sub-bar tabs, the
  tool-named "Try ... online" button each guide gains from the tool registry,
  and the single button a guide shared by two operations offers.

Every downloaded PDF is checked for the `%PDF-` header and every downloaded
workbook or presentation for the `PK` ZIP header (both `.xlsx` and `.pptx` are
ZIP packages), so a tool that "finishes" while producing empty or corrupt bytes
fails the suite. `readWorkbookDownload` goes further and opens a downloaded
workbook with jszip, resolving each worksheet through the workbook's own
relationships and its shared-string table, so a test can assert which
worksheets, which headers, and which rows reached the user. `readTextDownload`
does the same for the documents the pages build themselves, such as the
consolidate page's reviewed mapping draft.

## Selectors

Address the tool pages through the `data-testid` attributes the shared tool
shell renders, not through heading text. The stable identifiers are:

| Identifier                            | Element                                  |
| ------------------------------------- | ---------------------------------------- |
| `file-picker` / `file-input`          | the drop zone and its file input         |
| `source-summary`                      | the chosen single input's name and size  |
| `source-list` / `source-item`         | the ordered list of merge inputs         |
| `preview-section` / `preview-error`   | the plan preview and its failure text    |
| `planned-outputs`                     | the planned output names                 |
| `run-button` / `cancel-button`        | the run controls                         |
| `progress-report`                     | the progress bar and its labels          |
| `results-section`                     | the Results region                       |
| `artifact-list` / `artifact-item`     | the produced outputs                     |
| `artifact-name` / `artifact-download` | one output's name and Download button    |
| `archive-download`                    | "Download all (.zip)", multi-output only |
| `result-message` / `failure-message`  | the outcome text, by outcome             |

The Excel split page adds `column-select`, `column-input`, and one identifier
per advanced control (`prefix-input`, `sheet-input`, `table-input`,
`range-input`, `header-row-input`, `include-blank-checkbox`,
`include-hidden-checkbox`, `preserve-workbook-checkbox`, `strict-checkbox`,
`values-checkbox`).

The Excel merge page adds `output-name-input` and `values-checkbox`; the Excel
consolidate page adds `output-name-input`, `normalize-headers-checkbox`,
`source-columns-checkbox`, and `include-hidden-checkbox`. Both arrange their
inputs through the "Move X earlier", "Move X later", and "Remove X" buttons on
each `source-item`.

The consolidate page takes a second kind of file, so it renders two
`file-input`s: address them through `sectionFileInput(page, "source-section")`
and `sectionFileInput(page, "mapping-section")` rather than the bare helper. The
mapping section reports into `mapping-reading`, `mapping-summary`,
`mapping-columns`, `mapping-rejected`, `mapping-error` (the engine's refusal,
stable error reference included), and `mapping-remove`. Below them,
`suggest-button` drafts a mapping into `suggestion-list`, one `suggestion-group`
per proposal carrying `suggestion-spellings`, `suggestion-evidence`, and the
editable `suggestion-canonical`; `suggestion-download` hands back the reviewed
document and reports a review the engine refuses in `suggestion-error`,
`suggest-error` holds a failed drafting, and `suggestion-empty` stands in when
no headers need folding together.

Both the split and consolidate pages fold the shared `WorkbookInspector` into
`inspector-disclosure`, whose `summary` opens it; the consolidate page chooses
which workbook to describe through `inspect-select`. The report is mounted only
while the disclosure is open, so `inspection-section` and everything under it
exist only after that click.

The Excel inspect page has a single `source-section` (with `source-summary`,
`source-reading`, `source-rejected`, and `include-hidden-checkbox`) and reports
into `inspection-section`, the shared `WorkbookInspector`. That section renders
the metric tiles `inspection-worksheets`, `inspection-data-rows`,
`inspection-excel-tables`, and `inspection-named-ranges`, then
`hidden-worksheets-callout` when the description covers a hidden worksheet, then
`worksheet-list` with one `worksheet-item` per worksheet, each carrying a
`worksheet-name`, a `worksheet-visibility` badge when it is not visible, a
`worksheet-summary`, and a `column-list` of `column-item` entries holding a
`column-header` and its `sample-value` chips. A worksheet wider than the preview
limit renders only the first hundred columns, with `column-preview-note` naming
both counts and `column-toggle` revealing the rest and putting them away again.
`excel-table-list` and `named-range-list` follow, with `no-excel-tables` and
`no-named-ranges` in their place when the workbook declares none, and
`inspection-warnings` holds one `inspection-warning` per condition the operation
reported, or `inspection-error` when the workbook cannot be read. Like the
PowerPoint inspect page it has no Run button and no Results panel: the operation
creates nothing, so the report is the whole answer.

The PowerPoint populate page takes two files, so it wraps each picker in its own
section: `template-section` (with `template-summary`) and `records-section`
(with `records-summary` and the advanced controls `worksheet-input`,
`header-row-input`, `template-slide-input`, `output-name-input`). Because both
sections render a `file-input`, always scope the input to its section on that
page rather than using the bare `file-input` helper. The PowerPoint inspect page
has a single `source-section` (with `source-summary` and `template-slide-input`)
and reports into `inspection-section`, which renders `placeholder-list` with one
`placeholder-item` per placeholder, each carrying a `placeholder-name` and its
occurrence count, plus `inspection-warnings` holding one `inspection-warning`
per condition that would make a populate refuse the template, or
`inspection-error` when the template cannot be read. That page has no Run
button: choosing a template inspects it after the usual preview debounce.

Both PowerPoint pages reject a slide or row number that is not a whole number
counted from 1 rather than falling back to a default. The offending field
renders `<field>-error` (`template-slide-input-error`, `header-row-input-error`)
and the task is withdrawn: the populate page also lists the messages in
`preview-invalid-options` and disables `run-button`, and the inspect page shows
`inspection-invalid-slide` and clears the report.

Both pages also clear the chosen file and render `template-rejected` (or
`records-rejected`) when a picker is handed something it cannot read, rather
than keeping the previous document. Choosing a file clears the previous
selection immediately and shows `template-reading` / `records-reading` /
`source-reading` until the read finishes, so Run is never enabled against a
document that has already been replaced. And because a changed option applies to
Run at once, a preview or report is shown only while it still matches the page:
changing an input replaces it with `preview-pending` or `inspection-pending`
until the recomputed answer arrives. Both transient states last at least the 250
ms preview debounce, so they are safe to assert. A finished deck is withdrawn on
the same rule: changing any option removes `results-section` entirely, because a
worksheet change can produce a deck with the identical filename from different
rows.

The workspace page has its own persistent database controls. `workspace-start`
holds `workspace-new-format`, `workspace-new-name`, `workspace-new`,
`workspace-open`, and `workspace-open-input`. An open database renders
`workspace-summary`, `workspace-format`, `workspace-table-count`, and one
`workspace-table` per managed table. The summary states that the OPFS working
copy is separate from both the selected source and exported copies.

`workspace-schema` holds the JSON schema in `workspace-schema-input`, then uses
`workspace-schema-plan`, `workspace-schema-review`, and `workspace-schema-apply`
to keep conflicts in front of the write. Import uses `workspace-import-input`
with `multiple`, one `workspace-import-source` per workbook, and
`workspace-import-prepare`. Its review renders one `workspace-import-region` per
selected region with routing, column mapping, type choices, conflicts, and a
paged `workspace-import-preview-page`. `workspace-import-resolve` rebuilds the
stored plan and `workspace-import-apply` publishes only a ready revision. After
reopening a working database, `workspace-import-resume` restores a saved review
from browser storage without selecting the source workbook again.

Delivery details live under `workspace-delivery-context`. A duplicate capture
renders `workspace-import-duplicate`; `workspace-delivery-record-reuse` records
another touch point without copying rows. `workspace-deliveries-refresh` reads
the paged history into `workspace-delivery` entries. Export uses
`workspace-export-same` or `workspace-export-convert`. Long operations report
through `workspace-progress` and `workspace-cancel`; outcomes use
`workspace-notice` and `workspace-error`.

The preview and results panels also carry accessible names, so
`getByRole("region", { name: "Results" })` works where a role-based query reads
better.

## Fixtures

PDFs are generated in memory with pdf-lib, and workbooks and presentations are
assembled from minimal OOXML parts with jszip, all in `fixtures.ts`, and
uploaded as buffers. `createWorkbookUpload` takes one fixture per worksheet, and
a worksheet may declare a `state` (`hidden` or `veryHidden`) and an Excel
`table`; workbook-level `definedNames` are passed alongside the macro-enabled
option. Those three are what the inspection report is built to describe, so the
fixtures spell them out in the parts a package reader actually reads: a `state`
attribute on the sheet entry, a table part reached through the worksheet's own
relationships, and defined names in the workbook part.
`createPresentationUpload` takes one array of run strings per slide, so a
fixture spells out how a paragraph is split across text runs, the detail the
populate engine has to stitch back together before it can see a `{{field}}`.
`createMappingUpload` writes a column mapping document verbatim, so a test can
hand the consolidate page one the engine accepts or one it refuses. Nothing
binary is checked in and no temporary files are written.
