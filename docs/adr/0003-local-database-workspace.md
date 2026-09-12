# Local database workspace

The storage and save model below is superseded by
[ADR 0005](0005-persistent-database-imports.md). Analytics UI work is paused
indefinitely. The remaining text records the spike's design history and does not
require preserving its APIs or in-memory lifecycle.

Status: Proposed (draft for agreement). The stack and framing decisions below
were each agreed on their own before being written here. Two decisions stay
deferred to the build item that needs them: the computed-column formula
language, and what the dashboard HTML export carries (static data or an inlined
query engine).

Every ConsultChimps tool so far is a stateless operation: immutable inputs in,
artifacts out, nothing kept between runs. This feature is different. It is a
stateful workspace that holds a small relational database for a project, edited
in place across sessions by a few people taking turns from a shared folder. The
registry (ADR 0001), the operations Web Worker, and the feature-completion
checklist all model stateless operations, so the first job is to say how a
stateful workspace lives beside them without bending what an operation means.

The database is SQLite, opened in the browser tab. There is no server and no
hosted service, and data never leaves the machine. Import reuses
`@consultchimps/xlsx` and `@consultchimps/tabular` (reading, inspection, column
mapping); the `Table` model is the exchange format in both directions, so the
database can also feed the existing PowerPoint populate and split operations.
The formula-preserving Excel export is a new L3 operation on the xlsx package's
OOXML model, per `packages/xlsx/ARCHITECTURE.md`. Every dependency adopted here
is Apache-2.0 compatible (HyperFormula and ExcelJS are excluded). A copyleft or
paid license was weighed only for the grid (Decision 4), where a GPL option was
genuinely considered and then rejected on merit, so no copyleft dependency
(elkjs among them) enters the project.

## Decision 1: save model

The file lives in a shared folder and one person edits at a time. The save model
has to make "open the shared file, edit, put it back" the natural path, not an
error-prone ritual.

Options considered: in-place through the File System Access API with a download
fallback; OPFS autosave plus an explicit download every session; File System
Access only with no fallback.

**Decision: in-place through the File System Access API, with an OPFS autosave
mirror and a download fallback.** On Chromium the workspace writes directly back
to the shared-folder file the user opened, holding the file handle for the
session. The OPFS copy autosaves for crash recovery and is a mirror, not a
source of truth, so nobody reconciles two locations. The mirror records which
shared file it belongs to and the base version of that file it was derived from
(a content hash), alongside the pending edits. On reopen, recovery is offered
whenever the mirror holds edits the shared file does not; if the shared file
still matches that recorded base, restoring is safe, and if the shared file has
changed since (another editor saved in the meantime), the workspace surfaces the
conflict and keeps the recovered copy under a new name rather than clobber the
other edits. Recovery is compared against the recorded base, never gated on a
plain newer-than check, which would suppress exactly the divergence case. The
mirror has a bounded lifecycle so no hidden second copy of client data lingers:
it is deleted on a successful save back to the shared file and on a clean close,
a crash-left mirror is offered once on the next open and then removed, and any
mirror past a bounded age is purged. Safari and Firefox, which lack the API,
fall back to download-and-replace. It serves the shared-folder, one-editor model
directly and degrades rather than blocking.

## Decision 2: SQLite engine

**Decision: sql.js (MIT, SQLite compiled to WebAssembly, in memory).** The
workspace loads the whole file into memory, edits it, and serializes it back to
bytes to save, which fits the load, edit, save-back shape of decision 1 exactly
and keeps the OPFS copy a genuine serialized mirror. An OPFS or File System
Access VFS engine (official sqlite-wasm, wa-sqlite) persists incrementally, but
it turns OPFS into a second live database and still needs an explicit serialize
to write back to the shared folder, so the extra machinery buys little for a
small database. Revisit if databases outgrow a comfortable in-memory size.

The sql.js WebAssembly binary is served from our own origin as a bundled static
asset, never a CDN: the browser worker points `locateFile` (or passes
`wasmBinary`) at that local asset. A CDN `locateFile` would break the offline,
local-first guarantee, so wave-2 work must not reach for one.

## Decision 3: how the workspace fits the registry

Options considered: a workspace page outside the operation registry with
stateless operations inside it; extending the registry with a new workspace
surface kind; folding the whole feature into one operation with sub-modes.

**Decision: a workspace page outside the registry, with stateless operations
inside it**, the way `/shortcuts` and the inspect chrome already sit beside the
operations. The registry keeps describing stateless operations, each still
obeying the browser-surface rules (bytes-level, no filesystem, run in the
worker). The editor is a new "workspace" category defined here: a stateful,
browser-only page that opens a file, mutates it in place, and saves it back, and
is exempt from the no-filesystem rule precisely because it is not an operation.
This keeps the rule that matters, that a card or button never offers a
capability that does not exist, and it avoids reworking ADR 0001 to model
statefulness the rest of the toolkit does not have. The File System Access API
of decision 1 lives only on this page, never in an operation.

The operations the feature contributes to the registry:

- **`db.import`**: Excel or CSV to a SQLite database (library, CLI, browser).
- **`db.export-excel`**: database to a formula-preserving workbook (library,
  CLI, browser).
- **`db.export-dashboard`**: a dashboard definition to a self-contained HTML
  file (library, CLI, browser).

The editor, relationship diagram, and dashboard builder are the workspace page
and are browser-only.

## Decision 4: editing grid

The grid has to feel as close to Excel as possible: rectangular and disjoint
range selection, a drag fill handle, and clipboard copy and paste of ranges as
TSV that round-trips with Excel. A headless table library (TanStack Table)
supplies none of that, so it would mean building a selection and clipboard
engine by hand, which is exactly the fiddly, error-prone work to avoid.

The license floor was deliberately widened to weigh this, first to MPL, then to
GPL, then to paid commercial. The finding: the batteries-rich grids
(Handsontable, AG Grid Enterprise, Kendo React, Bryntum) are pure commercial
with no usable GPL path; the only genuine dual GPL and commercial grids (DHTMLX,
Webix) are not materially better and fight a custom design system with their own
skins. So GPL earns nothing here.

**Decision: Tabulator (MIT), used through `tabulator-tables` directly.** Within
permissive licensing it is the most complete Excel range and clipboard package:
rectangular and disjoint (ctrl-click) range selection, keyboard range extension,
and Excel-compatible TSV clipboard, DOM-rendered so tool-kit CSS and light or
dark style the cells, and actively maintained. It satisfies the Excel-UX
requirement and the batteries-included goal with no license cost and no GPL
split on `apps/docs`, and the pieces it lacks are additive work we own rather
than a reason to change the choice.

A spike (2026-09-07, Tabulator 6.5.2, verified in a real browser) corrected one
assumption: Tabulator has no fill handle at all, not even copy, so the earlier
"verify series vs copy" note was wrong. Everything else the grid needs is
native: rectangular and disjoint range selection, shift-arrow extension, TSV
clipboard copy and paste that round-trips with Excel, tab and enter editing, and
a searchable `list` editor that serves the foreign-key picker (label shown,
Record ID stored). Three items are therefore ours to build on top of Tabulator's
public Range API (`getBounds`, `setBounds`, `getCells`, `cell.setValue`), no
fork required: the whole fill handle, including series inference (which none of
the permissive grids we evaluated provide, though some commercial grids such as
AG Grid Enterprise do) as well as plain copy; a custom `clipboardPasteParser`
that normalizes line endings, because the built-in `range` parser does not strip
`\r` and corrupts the last column of a multi-row paste on Windows; and a thin
layer that maps our CSS variables onto Tabulator's selectors, since it ships
hardcoded hex rather than variables. All three are moderate, additive work.

### Interactions

The grid's Excel-grade half is one rule with several faces: a gesture is one
movement, so it is one command. A range selection, a copy, a paste, and a drag
of the fill handle are each planned whole before anything is sent, written by a
single batched `updateCells` carrying the workspace generation, and reported to
the page's state model (Decision 9) as exactly one `editSent` and one
`editSettled`, however many cells they cover. Nothing is added to that model: a
paste and a fill are edits in flight, not an open editor, so the transition
table is unchanged.

Building it corrected the spike's picture twice, both times from the library's
source at 6.5.2 rather than from preference.

- Tabulator's built-in `range` paste action writes through `row.updateData`,
  which reaches cells by `setValueProcessData` and therefore never dispatches
  `cellEdited`. The grid's only path to the database is `cellEdited`, so that
  action would repaint the grid and save nothing. The paste action is ours; the
  parser is ours as already planned, because the built-in one splits on "\n" and
  leaves the "\r" of a Windows copy on the last field of every row.
- Tabulator's copy quotes nothing and emits a header row. A text column here may
  hold a tab or a newline, so such a cell would corrupt the clipboard on the way
  out exactly as the stray "\r" corrupts a paste on the way in. Copy is ours
  too, so one grammar is read in both directions.

**Selection.** Native: a rectangle by drag or shift-click, several by
ctrl-click, a column by its header, and keyboard extension by shift-arrow and
ctrl-shift-arrow. `editTriggerEvent` becomes `dblclick`, which is Tabulator's
own advice once a drag selects, and Enter opens the editor on the active cell.
Header sorting is off, because a header click now selects the column and one
click with two meanings loses the selection a visitor is building.
`selectableRangeRows` stays off: it would make the Record ID column Tabulator's
row header, which is excluded from every cell range, and the Record ID has to
stay selectable so it can be copied. `selectableRangeClearCells` stays off:
Delete would clear a range through one `setValue` per cell, which is one gesture
becoming one command per cell. Selection and copy stay available while the page
is busy, because neither writes; a paste or a fill made then is refused and says
so. The Record ID is selectable and never a write target.

**Clipboard.** Cells joined by tabs, every row terminated by CRLF, and no header
row. A field holding a tab, a newline, a carriage return, or a quote is wrapped
in double quotes with internal quotes doubled, which is what Excel reads and
writes. A cell contributes its stored value's text rather than its rendered
label, so a foreign-key cell copies the Record ID that pastes back and resolves.

What a line break means is one rule, stated once and read by both halves: it
ends the row before it rather than starting an empty one, which is the
convention Excel's own clipboard follows, since a single copied cell arrives
there as `A` and a break. So the encoder terminates the last row too. The
alternative cannot be read back: with no terminator, `A` and a break would have
to mean both a block of one row and a block whose second row is blank, and a
range ending in a blank row is an ordinary thing to copy. Terminating always
makes the round trip exact, and it is what a test now pins for every block,
blank rows, blank columns and blank blocks included. The parser accepts CRLF, a
bare CR, and a bare LF in any mix, keeps a last row the text did not terminate,
and reads the unwritten cases the way a spreadsheet does rather than refusing: a
quote inside an unquoted field is literal, text after a closing quote continues
the field, and an unterminated quote takes the rest of the text.

A paste of a single value fills the selection; a block whose height and width
both divide the selection tiles across it; anything else is written from the
anchor, overflowing the selection when larger. A paste that would run past the
last record or the last column is refused whole and says how many are missing,
because records are not added by a paste and a truncated block reads as one that
worked. A gesture is refused whole, too, when more than one rectangle is
selected, and when any target is the Record ID. Values are sent as text and the
library's one conversion point decides what each column will hold; a foreign key
that names no record is refused there like any other value.

**Fill handle.** A handle on the active range's bottom right corner, dragged
along one axis, the one the pointer moved furthest along, with a tie going to
the vertical. The source occupies indices 0 to n-1 along that axis and a target
is asked for by its own index, negative behind the source and n or greater ahead
of it, so one rule extends in both directions. The rules, each pinned by a table
of examples in `apps/docs/src/lib/workspace-series.test.ts`: a single number
copies; two or more with a constant difference extend, in exact scaled integer
arithmetic, so 0.1 and 0.2 give 0.3 and the decimals the source was written with
are the decimals the fill writes; a date series applies when every source value
shares the same time part, all-midnight import timestamps included, stepping by
a constant month difference when every date shares a day of the month of 28 or
lower and otherwise by a constant day difference, with a single date stepping by
one day, every produced value checked against the grammar the column keeps, and
the counting done in whole days by integer calendar arithmetic rather than
through a date constructor, which remaps a year below 100 into the twentieth
century and would answer 2000-01-01 for the day after 0099-12-31; text with a
trailing integer steps that integer, by one from a single value and by their
constant difference from several, keeping the padding; and everything else
copies the block cyclically, which covers mixed kinds, plain text, and booleans,
since a boolean has no series to infer and alternating one would invent data. A
foreign-key column copies only, and a sideways fill whose line crosses one
copies throughout, because a series read across columns that mean different
things is not a series anyone asked for. A fill never writes to the Record ID
column, never past the grid's edge, and never from a source cell that has a
refusal standing against it. The selection then follows what the gesture
covered, on the movement rather than on the reply: it is the shape the visitor
drew, and a gesture the worker refuses as a whole leaves every value untouched
and says so.

**Persistence.** One `updateCells` per gesture, one request per cell within it,
applied by `updateRecords` in `@consultchimps/db` inside a single transaction.
Partial application: the accepted writes commit together and a value the schema
refuses is reported against its own cell, which is both what a spreadsheet does
and what the grid's per-cell explanations already expect. All-or-nothing was the
alternative and was rejected: one bad value in a two hundred cell paste would
cost the visitor the other hundred and ninety nine with nothing to show for it.
A stale generation refuses the whole gesture before the transaction opens, and
so does a gesture above `WORKSPACE_MAX_GESTURE_CELLS`, which is 5000: far more
than a person produces by hand, and still a batch the in-browser engine applies
well inside a second. The grid checks that ceiling before sending so the refusal
costs no round trip, and the worker checks it again, because a limit the worker
does not enforce is a limit it cannot keep. Nothing is painted before the reply,
and a gesture the grid refuses before sending is not work in flight and reports
nothing to the state model. Its explanation stands against the gesture, keyed by
the cell it started from, and not against that cell's value, so it never stops
the next fill from that cell; it comes down when a gesture from there goes
ahead.

Undo is not in this item. After a paste that was partly refused, each refused
cell is explained against itself and still holds the value the workspace holds,
the accepted cells are ordinary edits, and the file on disk is unchanged until
Save.

### Theme

The third of those pieces is this subsection's subject, and it was built on a
spike of its own (2026-09-11, Tabulator 6.5.2, the installed stylesheet read
rather than remembered). Three findings shaped it.

Tabulator 6.5.2 exposes no CSS custom property at all: the stylesheet it ships
carries 155 hardcoded colour values and not one variable, so this is a selector
override layer and not a variable handoff. The site, for its part, has no
`data-theme` attribute and no `prefers-color-scheme` rule anywhere: fumadocs
mounts `next-themes` with `attribute: "class"` and a system default, so dark
mode is the `.dark` class on `<html>` and nothing else. And Tabulator renders
its popups (the foreign-key edit list, the header tooltip) into the document
body rather than into the table, because its own container clips them, so a
variable block on the grid element could never reach the picker.

**Decision: one document-level stylesheet,
`apps/docs/src/app/workspace-grid.css`, imported by `global.css`, which binds
every colour Tabulator can paint in this grid to a `--workspace-grid-*` role,
and gives each role a site design token or a `color-mix` of site tokens.** No
colour literal appears in it. The grid component imports it not at all and is
unchanged by it, which keeps the file's ownership clear of the interaction work
in the same component.

There is no light block and no dark block. A role declared on `:root` is
substituted on the element that declares it, which is the same element
`next-themes` marks, so a role aliasing `--color-fd-card` already resolves to
the light or the dark value on its own. The mode switch is therefore CSS alone,
with no re-render, which the end-to-end suite pins by marking the cell elements,
adding the class, and finding the same elements repainted.

Only colour longhands are overridden, never a shorthand, so Tabulator's widths,
arrow geometry, and right-to-left side flipping survive untouched. `box-shadow`
is the single exception, because CSS gives it no colour longhand.

Each override repeats the first class of Tabulator's own selector, which is
exactly source specificity plus one for every rule. That is load bearing rather
than defensive: in the static export the layer lands in the global stylesheet
and Tabulator's in a page chunk loaded after it, so on equal specificity the
hardcoded hex would win. Raising every reachable rule by the same amount also
preserves Tabulator's own cascade between its rules rather than flattening it.

What the grid cannot render is deliberately not bound, and is listed with the
option it waits on (no footer, no pagination, no grouping, no tree data, no
frozen or movable columns, no editable titles, no menus, no print view). A unit
test parses the installed stylesheet and fails unless every colour it declares
is either bound or on that list, so a Tabulator upgrade that adds a colour has
to be classified rather than quietly shipped.

The range, range-header, and range-handle colours are bound ahead of the
Excel-grade interaction work that turns them on, so that work inherits a themed
selection rather than a blue one.

Accessibility is measured in a browser rather than derived in a test, because a
`color-mix` over a token and an alpha border are only real once something paints
them. The end-to-end suite puts each state on screen in both modes, reads the
computed styles, composites every layer behind the text onto a pixel so an alpha
is resolved the way the compositor resolves it, and gates on `contrastRatio`
from `@consultchimps/theme`. Text answers to 4.5 to 1: cell text on the plain
surface, on the zebra stripe and on a hovered row, header text, the open
editor's own text, both kinds of picker option, the header tooltip, and the
empty-table placeholder. Indicators answer to 3 to 1: the open-editor border,
the chosen picker option against the surface it sits on, and the focus ring on
either kind of option, each against the fill it is drawn on, with Tabulator's
own outline answered where the popup does not clip it. What cannot be put on
screen at all falls into three groups. The range tints, the range borders and
the row header wait on the interaction work that draws them; the column-resize
guide waits on an option Tabulator leaves off by default; and the refused cell
waits on a Tabulator validator the library never lets run, because it turns a
bad value away first. Of those, the fill handle's colour is answered against
both of the surfaces it straddles, and the rest share the two tokens it is
answered on. A tint is also the one case where the 3 to 1 mark is the wrong
question, since a range is drawn inside a border in the indicator colour and a
tint strong enough to clear 3 to 1 against a plain cell would be a tint nobody
could read a number through. Cell gridlines are excluded on the same record: the
site's border token is a 15 to 18 percent alpha and reads at about 1.4 to 1, and
a table gridline is a decorative separator rather than a boundary that carries
state.

Two things the old stylesheet made unreadable are fixed by the same binding. The
empty-table placeholder sat near 1.6 to 1 on the light surface and vanished on
the dark one. And the header tooltip, which Tabulator gives a background but no
text colour, took the page's own ink onto that light panel, so in dark mode it
was near-white on near-white. The foreign-key picker, by contrast, was legible
throughout: Tabulator sets its option text explicitly, so it was a light island
rather than an unreadable one.

## Decision 5: theme package

Exports carry a client's brand colours, which is a real consulting need, but the
exports are library and CLI operations, so the theme model cannot live in
`apps/docs`.

**Decision: a new runtime-neutral package `@consultchimps/theme`.** It holds the
palette (categorical, sequential, and semantic colours), light and dark, and
validation (contrast and categorical distinctness, reusing the `dataviz` skill's
method), with zero dependencies. The dashboard HTML export consumes it now, and
the Excel export and the site can consume it later without a wrong dependency
direction. Neutral placeholder palettes only are committed; a client's colours
are supplied at runtime and never enter the repo, per the repository's
no-client-references rule.

The site's own chrome is not a consumer of this package, and the record grid is
the first place that distinction had to be made. The grid's surfaces, borders,
selection, and indicators are site design tokens (Decision 4's theme
subsection); the states that look semantic are either not drawn by the grid at
all (a refused edit, an unsaved workspace, and a locked page are the page's own
elements) or are a value rather than a status (a boolean column's tick and
cross, which take ink colours, because painting a false value critical red
asserts a judgement the data does not carry). Routing any of those through this
package would mean a client's brand recolouring the application's error notices,
and the neutral palette's semantic roles could not pass the grid's own contrast
gate anyway: they are mode invariant and deliberately not contrast gated,
because the data-viz method they come from pairs a status colour with an icon
and a label. What the package does supply the grid is `contrastRatio`, as the
authority the theme tests gate on.

The seam for later is the role names. When a data-bearing grid surface arrives
(conditional formatting, a dashboard preview), a palette may set the
`--workspace-grid-*` roles, and the rule is that it must pass `validatePalette`
for both modes first, and must set both modes at once so the switch stays free
of JavaScript.

## Decision 6: charts

The dominant constraint is the self-contained offline HTML export, which must
ship as a single file that renders without a network. The decision-maker ruled
out hand-rolled SVG (error-prone) and asked for a library, with
`@tanstack/charts` explicitly in scope despite its maturity.

Verified facts (September 2026): the mature, lower-risk choice is Recharts (MIT,
React, a documented static-SVG export path via `renderToStaticMarkup`).
`@tanstack/charts` is MIT and architecturally the best fit (framework-agnostic,
SVG server-side rendering as a headline feature, so the export generator emits
static SVG with no React runtime, and CSS-variable theming), but it is pre-1.0
(0.16, self-described as alpha) with structural breaking changes between minor
releases.

**Decision: `@tanstack/charts`, adopted now despite its pre-1.0 status, with the
risk contained.** Its architecture removes the React-in-the-generator cost that
every other library carries, and its SVG SSR produces the runtime-free offline
export this feature needs. To bound the alpha risk: pin the exact version
`0.16.0` (no caret or range, so a lockfile regeneration cannot pull a different
patch), and put all chart construction behind one thin adapter module so a
breaking minor bump touches a single file rather than every dashboard. Reassess
at 1.0. KPI stat tiles are plain JSX, not a chart type.

A spike (2026-09-07, verified in a real browser) confirmed the load-bearing bet
at 0.16.0: `createChartScene` then `renderChartSvg` render bar, line, and pie to
a DOM-free static SVG string in Node, which embeds into a self-contained HTML
that renders offline with no JavaScript, and colours emit as SVG presentation
attributes so `var(--chart-N)` and `currentColor` theme it through CSS with no
re-render (light and dark flip with scripting disabled). The same definitions
mount live in React. Build guidance from the spike: pass scale factories
uncalled (an invoked `scaleLinear()` silently breaks the domain), give a pie
placeholder reserved x and y scales, wrap the scale idiom and the three-part pie
composition in helpers, and keep a headless smoke test in CI so an alpha upgrade
that breaks the export is caught.

## Decision 7: relationship-diagram rendering

The diagram is an in-app view only, not an exported artifact, so there is no
offline or static-SVG constraint here, and per the no-hand-rolled-SVG preference
it is library-based.

**Decision: React Flow (`@xyflow/react`, MIT) for the node and edge rendering,
with `@dagrejs/dagre` (MIT) for layout.** React Flow gives a themeable,
pan-and-zoom diagram of tables and foreign-key edges; `@dagrejs/dagre` computes
a non-overlapping layout. `@dagrejs/dagre` is the maintained fork; the original
`dagre` has been unmaintained since 2019, so it is not used. Both are in-app
only and never enter an export. elkjs, the other common layout engine, is
dual-licensed EPL-2.0 or GPL-3.0, both copyleft, and therefore excluded.

## Decision 8: stable record identifiers

Relationships hang off record identity, so a record needs an identifier that is
human-readable (so it means something to a consultant and can be read in a
foreign-key cell), stable (so a relationship never breaks when other fields are
edited), and usable as a foreign-key target.

**Decision: a per-table prefixed sequential identifier, always generated, for
example `CUST-0001` or `INV-0042`.** The prefix and zero-padding are
configurable per table. The identifier is assigned once at record creation and
is immutable thereafter; foreign keys reference it, and in SQLite it is a
`UNIQUE` text column (a stable key beside the internal rowid), never an editable
display field. Single-writer editing means no counter contention, and gaps after
a delete are acceptable because the identifier is stable, not dense. Tables
always use the generated identifier; existing domain codes live in ordinary
columns and are not made the key, which keeps one identity mechanism to reason
about.

## Decision 9: the workspace page state model

The workspace page has four ways of losing work (New, Open, a link out of the
page, and the Back button), four reasons to hold on to it (unsaved changes, an
import in flight, a cell edit in flight, a cell open for editing), one worker
that runs one command at a time, and an inline confirmation standing in front of
all of it. Build items 4 and 5 grew those a piece at a time, and nearly every
review finding across them was the same shape: a guard keyed on one condition
when the invariant spanned several, or bookkeeping consumed on one path only.
Issue #174 is the first where no single piece was wrong on its own. A Back press
with a cell open for editing raised the confirmation, the confirmation locked
the grid, the lock cancelled the editor, the cancel released the hold, and the
rule that a question must not outlive its reason then dismissed the question the
navigation itself had raised. The draft went with no warning.

**Decision: one explicit state model for the page, as a pure reducer with a
total transition table, with every guard and every sentence derived from the
state and from nothing else.** It lives in
`apps/docs/src/lib/workspace-state.ts` and is the opener of the Excel-grade grid
work, which adds interactions to a page whose states must already be written
down.

### The state

The state is one record. Its tag is `activity`, which says which single command
is in flight: `ready`, `creating`, `opening`, `reading` (describing a chosen
import file), `importing`, or `saving` (carrying the mode the visitor asked
for). A seventh, `leaving`, is not a command but the page on its way out once
the visitor has answered for the workspace: the browser's own warning and the
Back guard's spare entry both stand down there, which is the whole of what that
answer does, so a reply landing during the navigation cannot put the warning
back or push an entry into a page that is already going. Such a reply is still
answered rather than dropped, and what the workspace holds is untouched, so the
reasons stay the one honest account of what is at stake. It is idle in every
other respect, and anything the visitor does ends it: a navigation the router
resolves back to this same route never unmounts the page, and a page left
disabled there would be a live workspace nobody could save. Nothing about the
workspace is rewritten on the way out either. What changes is that a page the
visitor has answered for holds nothing, so an unsaved workspace is still unsaved
if the page turns out to be staying or is handed back from the browser's cache,
rather than reading as saved when it is not.

The rest is data on the state: the held workspace (its summary, the file it came
from, and whether it has changes no file has) or null for closed; whether a cell
is open for editing; how many cell edits are in flight; the pending question;
how many spare history entries the Back guard is holding; and the one thing the
page has to say, as a notice or a failure.

Three of those placements were argued rather than assumed.

The pending confirmation is data, not an activity of its own, because it
composes with one: a link clicked while an import runs is held, and the import
goes on running underneath the question until it lands, which the page's own
tests pin. It carries the intent that raised it and the reasons that were at
stake when it was raised.

The spare history entries are state rather than a derived answer, because what
the page believes about history has to come from what happened to history. A
save clears the hold and cannot remove an entry the browser already holds, so
the count outlives its reason and moves only on a real history event.

The File System Access handle stays outside the state, as a ref. It is an opaque
browser object, no answer is derived from it, and where a save actually landed
is reported back as an event.

### The transition

`workspaceStep(state, event)` returns the next state and, where the page must go
and do something, one described effect: create, run the open picker, save, leave
(retiring the spare entries), push a spare history entry, or take over a click.
Describing the effects rather than performing them is what keeps the model pure
and puts the navigation guards in the table where a test can read them.

The table is total. Every event is answered in every activity, and where an
event cannot arrive (a worker reply for a command that is not running) or is
deliberately refused (a stale click on a disabled button, a second command while
one is in flight), the state is returned unchanged and by identity. There is no
fall-through and no implicit case: the review findings this model replaces all
lived in the gaps of a table nobody had written down, so the table being total
is the deliverable, and a unit test crosses every activity with every event to
keep it that way.

### The derived answers

Whether editing is locked, whether the page is holding and for which reasons,
whether the browser's own unload warning is installed, whether a spare history
entry should be armed, which buttons are live, which one shows a spinner, what
the confirmation says, and the busy value the import section reads are all
functions of the state. No component may compute any of them from anything else:
a condition worked out in a component is a second reading of a state that
already has one, and two readings drift. The reasons and their wording stay in
`workspace-hold.ts`, which the model projects the state into.

### The rule from #174

A pending confirmation is answered by the visitor, or by an event that removes
all of its reasons from outside the navigation. It is never answered by a side
effect of the navigation that raised it. Two halves make that true.

Structurally, editing is locked by the activity alone. A standing question does
not lock the grid, so the model never commands an editor closed while a question
is up, and an editor that closes then can only be the visitor's own doing. That
removes the cause rather than special-casing the Back button.

Explicitly, a question is dismissed only by the event that took its last live
reason away, and only when that event was not a teardown. A teardown is the grid
unmounting, which is now its own reported event rather than the zeroed counts it
used to report; an editor the grid closed on its way out, which it reports as
such because Tabulator cannot tell a destroyed instance from a visitor's Escape
and only the grid knows which happened; or an editor closing while editing was
locked, which is a close the model asked for. Once a teardown has taken the
reasons, no later event can take a last one away either, so only the visitor can
answer. What the question says then falls back to the reasons captured when it
was raised, because a teardown takes the bookkeeping away without making the
work safe.

The dismissal reads the live reasons rather than the captured ones. A link held
while an import runs, where the import then lands, has a captured set that is
empty and a workspace that is now unsaved: dismissing there would leave the
visitor on the page with work at stake and a click that silently did nothing.
The case that must still dismiss, an import that fails under a question raised
by a held link, does, because a worker reply is an answer from outside.

### Consequences

- Editing is not locked while a confirmation stands, so an open editor survives
  the question. That is the #174 fix.
- Confirming a leave releases every reason to hold, not the unsaved flag alone,
  so the browser's own warning does not ask a second time, in its own words, for
  the navigation the visitor has just approved. Released where the guards are
  asked, not by rewriting what the workspace holds, so the facts stay true
  underneath.
- A Back press that finds a spare entry with nothing at stake retires what is
  left and lets the navigation through, rather than being spent on nothing. A
  press that appears to do nothing is the dead press the link guard already
  refuses to leave behind.
- The page has one announcement slot rather than a notice and a failure that
  each cleared the other.
- Save as spins its own button rather than the one beside it, because the saving
  activity carries the mode it was asked for and the spinner is derived from the
  whole of it.
- Later build items add states and events to this table rather than flags beside
  it. The OPFS autosave mirror of decision 1 brings its own (mirroring, a
  recovery offered, a conflict) and is designed with the item that builds it.

## Deferred decisions

Settled when the build item that needs them is designed, so each can be
discussed with its real constraints in front of us:

- **Computed-column formula language** (build item 7): a small language that
  compiles to both a SQLite expression and an Excel formula, and its initial
  function set.
- **Dashboard export payload** (build item 10): whether the self-contained HTML
  ships static rendered data or an inlined sql.js engine for in-page filtering.
- **Glossary verbs for `CONTEXT.md`** (build item 1): the package names are
  `@consultchimps/db` and `@consultchimps/theme`; the workspace and
  record-editing verbs are still to agree.

## Build list

Each item is independently designable and buildable, in order. The decision it
carries, if any, is noted.

1. **Package scaffolds and glossary.** Create `@consultchimps/db` (schema model
   types, the sql.js wrapper, the `Table` bridge to `@consultchimps/tabular`)
   and `@consultchimps/theme` (palette model and validation, neutral placeholder
   palettes). Add the workspace and record-editing terms to `CONTEXT.md`.
2. **Schema and relationships model.** Tables, columns, types, foreign keys, and
   the per-table prefixed stable identifier (Decision 8), persisted in the
   database file, in the library. Comes before import so that imported tables
   are created through this model and receive generated identifiers from the
   start.
3. **Import operation.** `db.import`: Excel or CSV to SQLite, reusing xlsx,
   tabular, and column mapping, and creating tables through the schema model
   from item 2 so every imported table gets generated stable identifiers. On
   library, CLI, and browser. Registry entry.
4. **Workspace shell.** The browser page that opens or creates a database
   through the File System Access API, autosaves to OPFS, and falls back to
   download, outside the registry. Adds the workspace completion checklist.
5. **Record grid.** Excel-like editing on Tabulator (`tabulator-tables`
   directly; the React wrapper is not needed): native range and disjoint
   selection, clipboard, and the `list` editor for foreign-key pickers, plus the
   three custom pieces from Decision 4 (a fill-handle module with series
   inference, a line-ending-normalizing paste parser, and a CSS-variable
   override layer), with validation and undo.
6. **Relationship diagram.** A pan-and-zoom view of tables and foreign keys, on
   React Flow and dagre.
7. **Computed columns.** The formula language that compiles to a SQLite
   expression and an Excel formula. (Deferred decision.)
8. **Formula-preserving Excel export.** `db.export-excel`, a new xlsx L3
   operation that emits live formulas with no hardcoded results, on library,
   CLI, and browser.
9. **Dashboards.** A KPI, bar, line, and pie builder in the workspace, on
   `@tanstack/charts` behind a thin adapter, themed from `@consultchimps/theme`.
10. **Dashboard HTML export.** `db.export-dashboard`, a self-contained HTML file
    per dashboard, with the charts as static SVG, on library, CLI, and browser.
    The file carries no JavaScript runtime when the payload is static data; if
    the deferred payload decision instead inlines a sql.js engine for in-page
    filtering, the file necessarily carries that runtime. The charts are static
    SVG either way. (Deferred decision on the payload.)
11. **Bridge to existing operations.** A database table through `Table` into
    PowerPoint populate and split, so the workspace feeds the tools that already
    exist.

## Consequences

- ADR 0001 and its drift checks are unchanged. The registry gains three
  operations; the workspace is a new category this ADR defines, not a registry
  entry.
- The browser-surface rules keep their meaning: operations stay bytes-level and
  filesystem-free; only the workspace page uses the File System Access API, and
  it is not an operation.
- New dependencies, all Apache-2.0 compatible: sql.js (MIT); `tabulator-tables`
  (MIT) for the grid, used directly; `@tanstack/charts` (MIT, pre-1.0 at 0.16
  and self-described as alpha, pinned to an exact version and isolated behind
  one adapter, reassessed at 1.0); `@xyflow/react` and `@dagrejs/dagre` (MIT)
  for the diagram, in-app only. A new first-party package `@consultchimps/theme`
  (zero dependency). The grid license floor was widened to MPL, GPL, and
  commercial and the permissive choice still won, so nothing on `apps/docs`
  relicenses; copyleft grids and elkjs (dual EPL-2.0 or GPL-3.0) are excluded.
- Because `@tanstack/charts` is framework-agnostic with SVG server-side
  rendering, the dashboard-export generator produces static SVG without bundling
  React into the exported file, so the charts add no JavaScript runtime. Whether
  the whole file is runtime-free depends on the deferred payload decision:
  static data keeps it runtime-free; an inlined sql.js engine for in-page
  filtering adds its own runtime. Visx is the documented fallback for the charts
  if `@tanstack/charts` has to be dropped before it reaches a stable 1.0.
- Theming ships neutral placeholder palettes only; client colours are runtime
  input and never committed.
- The feature-completion checklist applies to the three operations as written.
  The workspace page needs its own short checklist, added when build item 4
  lands, covering save, autosave, and the download fallback rather than
  artifacts.
- Editing is single-writer by design. The workspace does not attempt concurrent
  multi-user editing; the shared-folder, one-editor-at-a-time model is a stated
  constraint, not a limitation to remove later.
