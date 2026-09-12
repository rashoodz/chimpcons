# Feature completion

This document defines what "complete" means for an operation surface in the tool
registry (`apps/docs/src/lib/tools.ts`, per
[ADR 0001](../adr/0001-feature-registry-and-drift-checks.md)).

**Binding rule:** a pull request that flips any surface's status to `works` must
include the applicable checklists below in its description, with evidence per
item: the test file, docs page, or command that demonstrates it. A flip without
the demonstrated checklist is not mergeable.

## Every surface

- [ ] Deterministic output for identical inputs and options, covered by a test.
- [ ] Success returns a structured `OperationResult`; expected failures throw
      `ConsultChimpsError` with stable, namespaced codes. Both paths are tested.
- [ ] Operations that can run long on realistic inputs support `onProgress` and
      `signal` (cancellation).
- [ ] A Changeset exists for every published-package change.
- [ ] The registry entry's status matches reality and `pnpm check` passes,
      including both drift checks.

## CLI surface (`cli: "works"`)

- [ ] Command wired with explicit option mapping, short and long flags where
      conventional, realistic help examples, and a result-shape description.
- [ ] Human-readable results on stdout, progress and diagnostics on stderr,
      `--json` envelope kept clean.
- [ ] The CLI reference page documents the command (verified by
      `scripts/check-cli-reference.ts`).
- [ ] CLI tests execute the built `dist` entry point.

## Library surface (`library: "works"`)

- [ ] Public API exported with explicit typed options and result interfaces; no
      internal types leak into the published `.d.ts`.
- [ ] The libraries guide documents the API with an executable example.

## Browser surface (`browser: { status: "works", href }`)

- [ ] Stateless document operations run client-side on a bytes-level API.
      Persistent database operations follow the additional checklist below.
      Neither sends input data to a service; heavy work runs in a Web Worker.
- [ ] The tool page exists at the registry `href`; cards, sub-bar tab, and the
      guide's "Try … online" button light up from the registry entry alone
      (verified by `scripts/check-registry-site.ts`).
- [ ] Playwright e2e coverage: the navigation spec lists the tool, and a
      functional spec exercises the page's happy path.
- [ ] Multi-file downloads offer the bundled zip alongside individual files.
- [ ] The operation's guide page has a section for the online tool.

## Persistent database browser operations

[ADR 0005](../adr/0005-persistent-database-imports.md) defines this storage
contract. These checks supplement the browser checklist and do not require an
analytics UI.

- [ ] The page identifies the working database format and location, including
      whether the working file differs from the selected or exported file
- [ ] Creation, opening, incremental commits, close, and reopen are verified
      against each advertised engine
- [ ] Source reading, import staging, previews, and export avoid complete
      workbook and database buffers
- [ ] Cancellation and interrupted writes do not expose partially accepted
      observations; a retry produces the tested idempotent result
- [ ] Storage quota, permission, unsupported browser, and conflicting-writer
      failures have actionable errors
- [ ] Duplicate imports and intentional repeat deliveries have separate tests
- [ ] Exported files reopen in an independent native engine; conversion checks
      its declared type and constraint rules
- [ ] Browser storage and engine assets are local; offline behavior and any
      initial asset-loading requirements are documented
- [ ] Tests cover disposal and cleanup without deleting saved databases or
      selected source files
