# AGENTS.md

<!--
This file gives coding agents repository-specific operating instructions.
It is intentionally more prescriptive than the README: the README teaches
people how to use ConsultChimps, while this file tells an agent how to change
the repository safely and consistently.
-->

## Scope and precedence

<!--
An AGENTS.md file governs its directory and every directory below it. Keeping
this file at the repository root gives the monorepo one shared baseline.
-->

- These instructions apply to the entire repository.
- `CLAUDE.md` is a symlink to this file so Claude Code and other coding agents
  read one shared instruction source; edit `AGENTS.md`, never replace the
  symlink with a separate copy.
- A more deeply nested `AGENTS.md`, if one is added later, may refine these
  rules for its subtree but must not silently weaken repository-wide safety,
  privacy, testing, or release requirements.
- Follow explicit user instructions first, then the nearest applicable
  `AGENTS.md`, then the repository documentation and established code patterns.
- If two instructions genuinely conflict, stop and explain the conflict before
  making a consequential or difficult-to-reverse change.

## Project mission

<!--
The mission is an architectural constraint. A convenient implementation is
still wrong if it makes a core operation nondeterministic, cloud-dependent, or
unsafe for confidential consulting data.
-->

ConsultChimps provides deterministic, local-first operations tools for
consultants. Core functionality must work without Codex, AI models, telemetry,
or hosted services.

Every change must preserve these principles:

- Deterministic behavior for identical inputs and options
- Local processing by default
- Immutable source files unless mutation is an explicit, documented operation
- Complete destination validation before writing any output
- Portable behavior across Windows, macOS, and Linux
- Structured results and stable, actionable errors
- Detailed, plain-language messages that explain outcomes and next steps to
  non-technical users
- Small composable operations instead of narrowly tailored one-off scripts
- No collection, transmission, or retention of client data

## Required toolchain

<!--
Pinned major versions reduce differences between local development, CI, and
published packages. Read package.json and the lockfile before changing them.
-->

- Develop on Node.js 24.x. Published packages declare `engines.node`
  `">=22.0.0"`; the workspace itself requires `">=22.13.0"` because the pinned
  pnpm does. CI validates the published contract with build-and-test legs on
  Node 22.16, the latest 22, and 26. Plan: drop Node 22 support around its April
  2027 end of life. Do not use APIs newer than Node 22 in package runtime code.
- Use pnpm 11.x through the repository's pinned `packageManager` declaration.
- TypeScript runs split-toolchain: each package's own `typescript` 7
  devDependency powers `tsc --noEmit` typechecks (native compiler), while the
  workspace root keeps TypeScript 6 for tools that need the JavaScript compiler
  API (tsup's declaration build, typescript-eslint, Next.js). Do not collapse
  the two until those tools support TypeScript 7.
- Run workspace commands from the repository root unless a command explicitly
  requires a package directory.
- Use the committed `pnpm-lock.yaml`; do not replace pnpm with npm or Yarn.
- Keep dependencies exact unless the repository deliberately uses a range.
- Do not change package-manager settings merely to work around a local machine.

Standard setup:

```bash
pnpm install
```

Common workspace commands:

```bash
pnpm build                                      # build all packages (tsup, ESM + d.ts)
pnpm typecheck                                  # tsc --noEmit across packages
pnpm --filter @consultchimps/xlsx typecheck     # one package
pnpm lint                                       # ESLint (flat config, TS-native)
pnpm format:check                               # Prettier check (pnpm format to write)
pnpm test:run                                   # vitest run (packages/**/*.test.ts)
pnpm test:run packages/xlsx/test/split.test.ts  # one test file
pnpm test:coverage                              # tests + coverage thresholds (used by check)
pnpm test                                       # build, then vitest
pnpm package:check                              # published dependency specifiers, package metadata, publishability
pnpm docs:check                                 # CLI reference covers the CLI; tool registry matches docs pages and online-tool routes (used by check)
pnpm check                                      # full verification sequence
pnpm consultchimps <args>                       # run the built CLI (packages/cli/dist)
pnpm docs:dev                                   # Fumadocs site (apps/docs)
```

Do not regenerate the lockfile without a dependency or package metadata change.
If the lockfile changes unexpectedly, investigate and revert only that
agent-created change before continuing.

## Repository map and ownership

<!--
Package boundaries are public architectural boundaries, not just folders.
Put behavior at the lowest reusable layer and keep the CLI as an adapter.
-->

| Path                | Responsibility                                                         |
| ------------------- | ---------------------------------------------------------------------- |
| `packages/core`     | Shared errors, artifacts, operation results, and contracts             |
| `packages/files`    | Input discovery and safe output-path handling                          |
| `packages/tabular`  | Runtime-neutral table models and table operations                      |
| `packages/theme`    | Runtime-neutral palette model and colour validation                    |
| `packages/db`       | Persistent SQLite/DuckDB files, schemas, imports, and delivery history |
| `packages/xlsx`     | Excel workbook reading, writing, consolidation, and splitting          |
| `packages/pptx`     | PowerPoint template inspection and population                          |
| `packages/pdf`      | PDF splitting and merging                                              |
| `packages/messages` | Plain-language rendering of operation results and errors               |
| `packages/cli`      | Command parsing, option mapping, and user-facing CLI output            |
| `apps/docs`         | Next.js and Fumadocs documentation site                                |
| `scripts`           | Repository-wide verification and packaging utilities                   |
| `.github`           | CI, security analysis, issue templates, and release automation         |
| `.changeset`        | Pending public package release notes and version intent                |

The xlsx package has a binding architecture document at
`packages/xlsx/ARCHITECTURE.md`. Read it before changing that package; it
defines the layer boundaries, the DataRegion model, the conformance contract,
and the contribution cookbook that changes there must follow.

When adding behavior:

1. Put shared contracts and stable error types in `packages/core`.
2. Put generic path discovery and destination safety in `packages/files`.
3. Put format-independent row and column logic in `packages/tabular`.
4. Put format-specific parsing and serialization in the relevant adapter.
5. Keep `packages/cli` thin: parse arguments, call a library operation, and
   render its structured result.
6. Create a new package only when the capability has a genuinely distinct
   runtime, dependency, or public API boundary.

Do not:

- Import CLI code from a library package.
- Duplicate file-safety logic inside format adapters.
- Add filesystem or process dependencies to `packages/tabular`.
- Couple core operations to Commander, Next.js, a desktop shell, or a hosted
  service.
- Bypass a package's public exports by importing another package's private
  source files.

## Before making changes

<!--
Early inspection prevents agents from overwriting collaborator work or solving
an already-fixed problem on an outdated branch.
-->

Before editing:

1. Read the root `README.md`, `CONTRIBUTING.md`, and every applicable
   `AGENTS.md`.
2. Check `git status --short --branch`.
3. Inspect relevant package manifests, source, tests, and public exports.
4. Search for existing implementations and terminology before introducing new
   abstractions.
5. Confirm whether the worktree contains unrelated user changes.
6. For branch-based work, update the intended base branch before creating the
   feature branch.

Preserve all changes you did not create. Never discard, overwrite, stage, or
reformat unrelated work.

## TypeScript and API conventions

<!--
The codebase publishes typed ESM packages. These rules protect consumers from
accidental runtime coupling and unreviewed public API expansion.
-->

- Write TypeScript using ECMAScript modules.
- Keep strict type safety; do not introduce `any` to bypass a design problem.
- Prefer explicit exported interfaces for stable public inputs and results.
- Keep internal helpers unexported unless consumers need them.
- Use `import type` for type-only imports when appropriate.
- Avoid default exports unless an existing framework convention requires one.
- Prefer small pure functions for transformation and validation logic.
- Make mutation obvious and locally contained.
- Do not read environment variables or global process state inside reusable
  operations unless that dependency is explicit in the API.
- Do not add module-level side effects to library packages.
- Preserve `sideEffects: false` semantics where declared.
- Do not change public names, option meanings, result shapes, or error codes
  without treating the change as a versioned public API change.

Match the repository's formatting:

- Double quotes
- Semicolons
- Trailing commas where supported
- Prettier-managed wrapping and whitespace
- Descriptive names over abbreviations
- Comments that explain intent, invariants, or non-obvious constraints, not a
  line-by-line restatement of the code

Run Prettier rather than manually fighting its output.

## Operation design

<!--
Operations may handle confidential and irreplaceable files. Planning writes
before execution prevents partially completed jobs and accidental overwrites.
-->

Every file-producing operation should follow this sequence:

1. Resolve and validate all inputs.
2. Parse options and validate cross-option constraints.
3. Determine every intended output path.
4. Detect collisions between inputs, outputs, and existing files.
5. Fail before writing if any destination is unsafe or ambiguous.
6. Perform the operation.
7. Return a structured `OperationResult` with metrics, artifacts, and warnings.

Additional requirements:

- Never modify an input file in place by default.
- Refuse to replace existing outputs unless the caller explicitly enables
  overwrite behavior.
- Make overwrite behavior consistent between the library and CLI.
- Use portable filenames and reject or sanitize invalid path components.
- Preserve stable input ordering when order affects output.
- Record source provenance where the operation supports it.
- Treat blank values, hidden sheets, formulas, and metadata deliberately; do not
  let library defaults decide important behavior accidentally.
- Avoid leaving partial artifacts after a predictable validation failure.
- Do not log document contents, row data, credentials, or full confidential
  paths unnecessarily.

## Errors and results

<!--
Stable error codes let the CLI, desktop apps, automation, and future adapters
respond consistently without parsing human-readable strings.
-->

- Throw `ConsultChimpsError` for expected operational failures.
- Give each expected failure a stable, namespaced error code.
- Write human-readable messages that tell the user what failed and how to fix
  it.
- Put machine-readable context in error details.
- Do not expose secrets or document contents in errors.
- Do not catch an error merely to throw a less-informative generic error.
- Let unexpected programming errors remain distinguishable from expected input
  or filesystem errors.
- Return `OperationResult` for successful operations.
- Keep metrics deterministic and define their meaning in tests.
- Report every created output as an artifact.
- Use warnings for recoverable conditions, not hidden failures.

## CLI requirements

<!--
The CLI is a public interface used directly by people and scripts. Help text,
exit status, stdout, and stderr are all part of that interface.
-->

- Use Commander only for command structure, parsing, validation adapters, and
  help rendering.
- Map CLI options explicitly to library options.
- Keep reusable business logic out of command actions.
- Provide both short and long flags for frequently used options when clear,
  especially `-o, --output`, `-c, --column`, and `-f, --force`.
- Include realistic examples in help for new commands or non-obvious options.
- Keep examples portable; quote glob patterns so shells do not expand them
  inconsistently.
- Send normal human-readable results to stdout.
- Send errors to stderr and set a nonzero exit code.
- Make normal output deliberately detailed and easy for a non-technical person
  to understand. Explain what happened, translate metrics into plain language,
  identify every created artifact, state whether warnings occurred, confirm
  source-file safety where known, and provide practical next steps.
- Do not expose raw internal metric names without a human-readable label.
- For recoverable errors, explain both the problem and the safest likely
  recovery action. Include a stable error reference for support.
- Prefer clarity and reassurance over terseness in interactive output. Do not
  assume the reader understands programming, shells, globs, file extensions, or
  internal operation names.
- Preserve `--json` as valid machine-readable JSON without surrounding prose.
- Never mix diagnostics into JSON stdout.
- Test the built CLI rather than importing its source entry point.
- CLI tests execute `packages/cli/dist/index.js`, so run `pnpm build` before
  running them; without it they exercise a stale build.

When changing a command, verify at least:

```bash
node packages/cli/dist/index.js --help
node packages/cli/dist/index.js <group> --help
node packages/cli/dist/index.js <group> <command> --help
```

## Testing requirements

<!--
Tests are executable promises about document safety and output behavior. Prefer
asserting observable results over implementation details.
-->

Add or update tests for every behavior change and bug fix.

Test placement:

- Core contract tests belong with `packages/core`.
- File discovery and collision tests belong with `packages/files`.
- Runtime-neutral data tests belong with `packages/tabular`.
- Excel behavior belongs with `packages/xlsx`.
- PowerPoint behavior belongs with `packages/pptx`.
- PDF behavior belongs with `packages/pdf`.
- Plain-language rendering belongs with `packages/messages`.
- Argument parsing, help, exit status, stdout, stderr, and packaged command
  behavior belong with `packages/cli`.

Fixture rules:

- Use generated fixtures when practical.
- Repository fixtures must be synthetic, minimal, and safe to publish.
- Never use client documents, production exports, emails, names, identifiers, or
  copied confidential data.
- Cover both successful output and expected failure paths.
- Verify that failure paths do not overwrite sources or unrelated outputs.
- For regressions, write a test that fails without the fix.

Use platform-neutral assertions:

- Build paths with `node:path`.
- Do not assume `/` or `\` in user-facing behavior.
- Do not assume case-sensitive filesystems.
- Do not depend on filesystem enumeration order.
- Avoid shell-specific test commands and expansion.

## Verification ladder

<!--
The ladder keeps iteration fast while still requiring proportional confidence.
Agents should start focused and expand verification before handoff.
-->

During implementation:

```bash
pnpm --filter <affected-package> typecheck
pnpm test:run <relevant-test-file>
```

Before handoff, run the narrowest sufficient set plus all applicable checks:

```bash
pnpm format:check
pnpm lint
pnpm build
pnpm typecheck
pnpm test:run
pnpm package:check
```

`pnpm check` runs the repository's complete verification sequence:

```bash
pnpm check
```

Expectations:

- Run focused tests for the changed behavior.
- Run type checking and linting for code changes.
- Run the build for changes affecting package output or CLI behavior.
- Run `pnpm package:check` for package metadata, exports, or publishability
  changes.
- Run the full `pnpm check` before a pull request when practical.
- If an unrelated existing failure prevents a clean run, report the exact
  command and failure. Do not claim the suite passed.
- Do not weaken, skip, delete, or rewrite a failing test merely to obtain green
  output.

Documentation-only changes do not require a full package build unless they alter
generated documentation, package metadata, examples that must execute, or
instructions tied to changed behavior. They still require formatting and link or
content review appropriate to the files changed.

## Documentation

<!--
Users should not have to inspect source code to discover public behavior.
Documentation and CLI help must evolve with the public interface.
-->

- Update the root README when installation, top-level commands, package
  responsibilities, or development workflows change.
- Update `apps/docs` for user-facing operations, options, recipes, and public
  library APIs.
- Update CLI help whenever command usage or options change.
- For every added, removed, or renamed user-facing operation, audit and update
  the homepage tool catalog, field-manual index, sidebar navigation, getting
  started guide, operation guide, CLI reference, library guide, package READMEs,
  and site metadata wherever they describe the affected capability.
- Search for stale tool counts and incomplete category descriptions after
  changing the catalog; a standalone guide is not sufficient discoverability.
- Render the documentation site, verify affected pages and navigation visually,
  and confirm that the production deployment serves the new content.
- Keep examples executable and consistent across README, docs, and CLI help.
- Explain defaults, overwrite behavior, output locations, and destructive
  implications.
- Do not document planned behavior as available.
- Use relative repository links where possible.
- Keep terminology consistent: use `ConsultChimps` for the project and
  `consultchimps` for the package and executable.
- No em or en dashes anywhere, in prose, comments, or UI strings; use commas,
  colons, parentheses, or separate sentences, and write a numeric range as "22
  to 26". `scripts/check-typography.ts` fails `pnpm docs:check` on a dash.
- Full stops: in repository prose (guides, README, comments), a fragment carries
  no full stop while real sentences keep theirs. On the documentation site's
  rendered interface (cards, headings, hero copy, picker descriptions, field
  hints, run summaries, empty states, field errors, notices), every string ends
  without a terminal full stop, even when it is a sentence; internal stops in
  multi-sentence strings stay. Exceptions: `metadata` descriptions (never
  rendered on the page) and sentence fragments spliced into
  `@consultchimps/messages` prose, which keep sentence punctuation.

### Claims vocabulary

<!--
Every false claim a documentation review has found here was an unconditional
word standing in for a rule nobody had written down. `pnpm docs:check` lints
the worst offenders through `scripts/check-claims.ts`.
-->

- Avoid unconditional words in user-facing copy (every, all, always, never,
  complete, exact, identical, byte-for-byte, fully preserved) unless a test or a
  declared contract holds the claim up. Otherwise state the actual rule.
- For preservation-heavy operations, describe Preserved / Changed or removed /
  Needs review rather than promising the whole document survives.
- Source-of-truth first: check `apps/docs/src/lib/tools.ts`,
  `packages/xlsx/src/contract.ts`, and the package's `engines` before writing a
  sentence about what a surface supports.

## Dependencies

<!--
Every dependency increases install size, supply-chain exposure, maintenance
work, and potential access to confidential files.
-->

Before adding a dependency:

1. Confirm the platform or standard library cannot reasonably solve the need.
2. Choose the narrowest package boundary that requires it.
3. Review maintenance status, license, release history, and transitive scope.
4. Pin it consistently with repository policy.
5. Commit the resulting lockfile change.
6. Add tests for the behavior the dependency enables.

Do not add:

- Analytics or telemetry SDKs
- Hosted-service clients for core operations
- Dependencies that upload or inspect user documents remotely
- A large framework for a small utility problem
- Duplicate libraries that solve an existing dependency's role

Published packages must declare only registry-installable dependencies. A
tarball URL, git remote, or local path in a publishable package's
`dependencies`, `peerDependencies`, or `optionalDependencies` makes every
consumer's `npm install` reach a host other than the npm registry, which fails
in registry-only, mirrored, and air-gapped environments. When a library is not
published to the registry, declare it as a devDependency and let the build
bundle it into `dist`, then record the attribution the bundled license requires.
`pnpm package:check` enforces this through
`scripts/check-package-dependencies.ts`.

Repository development still installs those devDependency tarballs from their
original host, so a contributor working in a registry-only environment may need
that host allowlisted to run `pnpm install` here even though consumers of the
published packages do not.

## Changesets and releases

<!--
Changesets separate implementation from release automation. A merged public
change declares version intent; the release workflow later updates versions and
changelogs.
-->

Add a Changeset when a pull request changes a published package's public
behavior, API, CLI, packaged files, or runtime behavior.

Use the smallest correct semantic-version bump:

- `patch`: backward-compatible fixes and small improvements
- `minor`: backward-compatible new capabilities
- `major`: breaking changes

Changeset requirements:

- Include every affected published package.
- Describe the user-visible impact, not the implementation mechanics.
- Do not manually edit generated release changelog entries in place of a
  Changeset.
- Do not add a Changeset for repository-only documentation, tests, CI
  maintenance, or internal refactoring with no published impact.

Never publish packages, create releases, modify npm authentication, or trigger
release workflows unless the user explicitly requests that external action.

## Git and pull requests

<!--
Small branches and focused commits make collaboration, review, rollback, and
automated releases safer.
-->

- Start branch work from the latest intended base branch.
- Use a focused, descriptive branch name.
- Keep each commit cohesive.
- Use concise imperative commit subjects.
- Do not mix unrelated cleanup into a feature or fix.
- Do not rewrite shared branch history unless explicitly authorized.
- Never use destructive Git commands to discard work without explicit user
  authorization.
- Never put personal email addresses or editors' legal/full names in Git author,
  committer, or `Co-authored-by` identities. Prefer the GitHub username with
  that account's private `users.noreply.github.com` address. Agent co-author
  trailers and GitHub private noreply addresses are fine; see the rewritten
  identity on
  [commit 4477ecb](https://github.com/consultchimps/consultchimps/commit/4477ecb6b6f0267291484ce22cfd4993906dd87f)
  (PR #34) as the expected pattern.
- Review `git diff --check` and `git status --short --branch` before committing.
- Stage only files belonging to the requested change.
- In the pull request, summarize behavior, list verification performed, and
  disclose any remaining failures or limitations.
- After merge, synchronize local `main` and verify it matches `origin/main`.

### Pull request CI gate

<!--
For this repository, CI starts when a pull request is opened or updated;
push-triggered checks apply only to the configured branches. Therefore, "wait
for CI before the pull request" is not the right sequence: open the pull request
first, then treat CI as a mandatory gate before merge.
-->

For every pull request, follow this sequence:

1. Push the complete, locally verified branch.
2. Open the pull request against the intended base branch.
3. Confirm that the expected CI and security checks were created for the pull
   request's latest head commit.
4. Wait while any required check is queued, pending, or in progress.
5. Refresh the pull request state after checks finish; do not rely on an earlier
   status snapshot.
6. If any required check fails, is cancelled, times out, or does not start,
   inspect the check output and diagnose the cause.
7. Fix failures on the same branch, rerun relevant local verification, push the
   fix, and restart the CI wait for the new head commit.
8. Merge only when all required checks for the latest head commit have completed
   successfully and GitHub reports the pull request as mergeable.
9. After merge, update local `main` and verify it matches `origin/main`.

Treat the CI gate strictly:

- Queued, pending, and in-progress checks are not passing checks.
- A missing expected check is not implicit success; investigate why it was not
  created.
- A successful check from an older commit does not satisfy the gate after a new
  push.
- A cancelled, timed-out, action-required, or startup-failure result does not
  satisfy the gate.
- A skipped or neutral result is acceptable only when the workflow and branch
  protection rules intentionally permit it.
- Do not merge merely because local tests pass; local verification complements
  CI but does not replace required repository checks.
- Do not use administrator privileges, force merge, temporarily weaken branch
  protection, disable a workflow, or rerun with reduced coverage to bypass the
  gate.
- Do not repeatedly rerun a failing check without investigating the failure.
- If CI is slow, continue monitoring it and keep the user informed rather than
  declaring the pull request complete.
- If GitHub reports conflicting status signals, inspect the required status
  checks, check runs, and latest head SHA before deciding the pull request is
  ready.
- Read pull request reviews and inline review threads separately from CI check
  results. Passing CI does not mean an automated code review has no findings.
- When a configured reviewer starts after a draft is marked ready, wait for its
  result before reporting review completion. Assess actionable findings, add
  regressions for accepted fixes, and verify them on the pull request branch.
- Recheck review activity after pushing fixes. Resolve a thread only after its
  finding is fixed and verified, or its rejection is supported by evidence.
- Merge with failing or incomplete required checks only under a documented
  exception permitted by repository policy and branch protection, after the user
  explicitly authorizes it with the exact non-green checks and rationale
  recorded in the pull request.

## Security and confidential data

<!--
Consulting tools routinely touch sensitive documents. Treat privacy rules as
hard requirements even when test data appears harmless.
-->

Never commit or expose:

- Client or confidential data
- Generated client outputs
- Credentials, tokens, passwords, cookies, or private keys
- `.env` files or machine-specific authentication configuration
- Real personal data used as a convenient test fixture
- Personal email addresses or editors' legal/full names in commit metadata,
  trailers, docs examples, or support text (use GitHub usernames and private
  noreply addresses instead)
- Browser profiles, session stores, or package-manager credentials
- `node_modules`, build caches, or local editor state

Additional safeguards:

- Treat conversations as private design input. Publish general requirements and
  explicitly synthetic examples, not a contributor's machine specifications,
  personal paths, engagement details, delivery schedules, or project counts.
- Apply this rule to plans, glossaries, benchmark reports, fixtures, and pull
  request descriptions. Do not label copied private facts as synthetic. Keep
  software versions and generated measurements when useful, but publish personal
  hardware or deployment details only with explicit authorization.
- Do not print secrets in commands, logs, test snapshots, errors, or pull
  request text.
- Use credential managers and CI secret stores rather than checked-in values.
- Minimize path and document metadata in logs.
- Prefer synthetic identifiers such as `Client A`, `North`, and `100`.
- Treat input files as untrusted.
- Keep CodeQL and dependency scanning enabled.
- Do not reduce security checks to make a pull request pass.

## Cross-platform behavior

<!--
The project explicitly supports Windows, macOS, and Linux. Code that works only
in the author's shell is incomplete.
-->

- Use Node APIs for path and filesystem behavior.
- Use `path.join`, `path.resolve`, `path.parse`, and `path.relative` as
  appropriate.
- Do not construct paths by concatenating separators.
- Do not assume a POSIX shell, GNU utility, drive letter, or case-sensitive
  filesystem.
- Quote glob examples so the application, not the shell, resolves them.
- Avoid filenames invalid on Windows.
- Account for reserved device names and trailing spaces or periods in generated
  filenames.
- Do not assume atomic filesystem operations behave identically across
  platforms.
- Make tests create and clean isolated temporary directories.
- Diagnose platform-specific failures rather than disabling the affected test.

## Generated files and cleanup

<!--
Generated artifacts can make reviews noisy and may accidentally contain input
data. Keep only artifacts that are intentional repository assets.
-->

- Do not commit `dist`, `node_modules`, coverage output, temporary workbooks,
  temporary PDFs, package tarballs, or local build caches unless the repository
  explicitly tracks a particular generated artifact.
- Write test outputs only to isolated temporary directories.
- Clean up artifacts created by tests and verification.
- Before recursive cleanup, resolve and verify the exact target directory.
- Never delete a repository root, workspace root, home directory, or broad
  computed path.

## Completion checklist

<!--
This is the final audit. An agent should be able to answer every applicable
item before claiming the task is complete.
-->

Before handing work back:

- [ ] The requested behavior is implemented and no unrelated behavior changed.
- [ ] Package boundaries and public exports remain intentional.
- [ ] Inputs remain immutable by default.
- [ ] Output paths and overwrite behavior are validated.
- [ ] Expected failures use stable structured errors.
- [ ] Tests cover the change and its important failure modes.
- [ ] Formatting, linting, type checking, build, and tests were run as
      applicable.
- [ ] Public documentation and CLI help match the implementation.
- [ ] A correct Changeset exists for every published-package change.
- [ ] Any tool-registry surface flipped to `works` meets
      `docs/agents/feature-completion.md`, demonstrated in the pull request
      description.
- [ ] No client data, credentials, generated outputs, or local configuration
      were added.
- [ ] `git diff --check` passes.
- [ ] `git status --short --branch` contains only intended changes.
- [ ] The final report states what changed, what was verified, and any known
      limitation or unrelated failure.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, operated through the `gh` CLI. See
`docs/agents/issue-tracker.md`.

### Feature completion

`docs/agents/feature-completion.md` defines per-surface completion checklists
for the tool registry. It is binding for any pull request that flips a surface's
status to `works`.

### Domain docs

Single-context: one `CONTEXT.md` and one `docs/adr/` directory at the repo root
cover every package. See `docs/agents/domain.md`.
