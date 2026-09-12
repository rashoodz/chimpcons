import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Typography check: no em dash (U+2014) and no en dash (U+2013) anywhere in the
// repository's tracked text. The repository writes short sentences that carry
// one idea each, and a dash is the punctuation that quietly defeats that: it
// glues two thoughts together, so the sentence keeps growing and the reader has
// to hold the first half open while the second arrives. Every occurrence this
// check found had a plainer reading waiting for it. A parenthetical becomes a
// comma pair, parentheses, or two sentences; a dash standing in for a colon
// becomes a colon; a dash joining a label to its explanation becomes a colon;
// a numeric range becomes "22 to 26".
//
// The point is the rewrite, not the substitution. Replacing an em dash with
// " - " or "--" keeps the sentence that needed splitting and adds an ASCII
// artefact to it, so neither is an accepted fix and neither is what this check
// is asking for.
//
// Scope is every tracked text file, which is wider than scripts/check-claims.ts
// deliberately: a claim is only wrong where a user reads it, while a dash is a
// house-style violation wherever it is written, and a CHANGELOG entry is
// rendered on the releases page, a code comment is read by the next
// contributor, and a workflow comment by whoever debugs the release. Only
// bytes are out of scope, and only by being named as such: a tracked file that
// no list below classifies stops the check rather than being skipped quietly,
// so an extensionless text file such as LICENSE cannot slip out of the rule.
//
// This is a character scan and it is meant to stay one. It does not judge
// prose, count sentence length, or police any other punctuation, because a rule
// that cannot be checked by looking at one character is a rule a reviewer
// should be applying instead. Widening it into a general prose linter would
// trade a check that is always right for one that is usually annoying.
//
// A genuine exception goes in the allowlist below with the reason it is
// deliberate, keyed on the file, the line, and the character. There are none
// today: every dash in the repository's history was a sentence that read better
// without it.

/** A dash this check bans, and the plainer punctuation that replaces it. */
interface BannedDash {
  /** The character itself, so a message can name it exactly. */
  readonly character: string;
  /** How the character is spelled in a failure message. */
  readonly name: string;
  /** What to write instead. */
  readonly advice: string;
}

interface AllowlistEntry {
  /** Repository-relative path, forward slashes. */
  readonly file: string;
  /**
   * One-based line the dash sits on. Together with the character and the
   * declared count it identifies one line's worth of deliberate dashes, so an
   * exemption can never widen into a blanket pardon: a second dash further
   * down the same file is still reported. A line number moves, but moving it
   * can only make the dash reappear as a failure and the entry report itself
   * stale, never let an unexamined dash pass quietly.
   */
  readonly line: number;
  /** The banned character being excused, as the character itself. */
  readonly character: string;
  /**
   * How many of that character the line is expected to carry. The default is
   * one, and the count is checked rather than assumed: an entry excusing one
   * deliberate dash cannot quietly cover a second one that appears beside it
   * later, because the line would then carry two and the check says so.
   */
  readonly occurrences?: number;
  readonly reason: string;
}

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

// The characters are written as escapes so this file, which the check scans
// like any other, does not report itself.
const BANNED_DASHES: readonly BannedDash[] = [
  {
    advice:
      'rewrite the sentence: a parenthetical takes a comma pair, parentheses, or a full stop; a dash standing in for a colon takes a colon; a label and its explanation take a colon. Never substitute " - " or "--" in prose',
    character: "\u2014",
    name: "em dash (U+2014)",
  },
  {
    advice:
      'rewrite the sentence, or write a numeric range as "22 to 26"; a code-like range takes a plain hyphen',
    character: "\u2013",
    name: "en dash (U+2013)",
  },
];

// Deliberate occurrences, each with the reason it is not a style violation.
// Keep this list short: needing many entries means the house style has changed,
// not that a file deserves an exemption.
const ALLOWLIST: readonly AllowlistEntry[] = [];

// Text this repository writes. Anything else tracked in git is data or an
// image, where a dash is not the repository's prose to fix.
const TEXT_EXTENSIONS: readonly string[] = [
  ".css",
  ".json",
  ".md",
  ".mdx",
  ".mjs",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
];

// Tracked text whose name carries no extension to match on, so it is named
// here instead: the licence, and the dotfiles that configure the toolchain.
// A leading dot is not an extension, which is why `.npmrc` belongs on this
// list rather than the one above.
const TEXT_FILENAMES: readonly string[] = [
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  ".npmrc",
  ".prettierignore",
  "LICENSE",
];

// Extensions whose files are bytes rather than prose. This list exists so an
// extensionless file the repository adds later cannot be skipped in silence:
// anything matching none of the three lists stops the check and has to be
// classified, the same way the xlsx contract makes the build demand a decision
// rather than leaving one to a reviewer.
const BINARY_EXTENSIONS: readonly string[] = [".png", ".xlsx"];

/**
 * Every tracked file, from git rather than a directory walk: git already knows
 * what is ignored, generated, or vendored, so the check cannot drift out of
 * step with .gitignore, and a file the repository does not track is not the
 * repository's prose. Names are NUL-separated so a path with a space or a
 * non-ASCII character survives.
 */
function listTrackedFiles(): string[] {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return output
    .split("\0")
    .filter((label) => label !== "")
    .filter((label) => existsSync(path.join(workspaceRoot, label)))
    .sort();
}

function hasExtension(label: string, extensions: readonly string[]): boolean {
  return extensions.some((extension) => label.endsWith(extension));
}

function isNamed(label: string, names: readonly string[]): boolean {
  const basename = label.slice(label.lastIndexOf("/") + 1);
  return names.includes(basename);
}

/** Enough of the offending line to see the sentence the dash sits in. */
function excerpt(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
}

const problems: string[] = [];
const usedAllowlistEntries = new Set<string>();
// An exemption names one line: this character, on this line of this file, as
// many times as the entry declares. Another dash elsewhere in the file is a
// separate violation and is still reported, and so is an extra one that appears
// on the excused line later, because the declared count no longer matches.
const allowlistKey = (file: string, line: number, character: string): string =>
  `${file}::${line}::${character}`;
const allowedEntries = new Map(
  ALLOWLIST.map((entry) => [
    allowlistKey(entry.file, entry.line, entry.character),
    entry,
  ]),
);

const scannedFiles: string[] = [];

for (const label of listTrackedFiles()) {
  if (hasExtension(label, BINARY_EXTENSIONS)) {
    continue;
  }
  if (
    !hasExtension(label, TEXT_EXTENSIONS) &&
    !isNamed(label, TEXT_FILENAMES)
  ) {
    problems.push(
      `${label} is tracked but neither the text nor the binary lists in scripts/check-typography.ts name it, so nothing decided whether its prose is checked\n    add its extension or its filename to one of those lists`,
    );
    continue;
  }
  scannedFiles.push(label);

  const absolutePath = path.join(workspaceRoot, ...label.split("/"));
  const text = readFileSync(absolutePath, "utf8");
  if (!BANNED_DASHES.some((dash) => text.includes(dash.character))) {
    continue;
  }

  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (const [index, line] of lines.entries()) {
    for (const dash of BANNED_DASHES) {
      const columns: number[] = [];
      for (
        let at = line.indexOf(dash.character);
        at !== -1;
        at = line.indexOf(dash.character, at + 1)
      ) {
        columns.push(at + 1);
      }
      if (columns.length === 0) {
        continue;
      }
      const lineNumber = index + 1;
      const key = allowlistKey(label, lineNumber, dash.character);
      const entry = allowedEntries.get(key);
      if (entry !== undefined) {
        usedAllowlistEntries.add(key);
        const expected = entry.occurrences ?? 1;
        if (columns.length !== expected) {
          problems.push(
            `${label}:${lineNumber} carries ${columns.length} ${dash.name} characters, but its allowlist entry excuses ${expected}\n    ${excerpt(line)}\n    rewrite the ones the entry does not cover, or raise its occurrences after checking each of them\n    recorded reason: ${entry.reason}`,
          );
        }
        continue;
      }
      for (const column of columns) {
        problems.push(
          `${label}:${lineNumber}:${column} contains an ${dash.name}\n    ${excerpt(line)}\n    ${dash.advice}`,
        );
      }
    }
  }
}

for (const entry of ALLOWLIST) {
  const key = allowlistKey(entry.file, entry.line, entry.character);
  if (!usedAllowlistEntries.has(key)) {
    problems.push(
      `the typography allowlist entry at ${entry.file}:${entry.line} matches no dash any more; move it to the line the dash is on now, or delete it\n    recorded reason: ${entry.reason}`,
    );
  }
}

if (problems.length > 0) {
  throw new Error(
    `The typography check found problems in the repository's tracked text:\n${problems
      .map((problem) => `- ${problem}`)
      .join(
        "\n",
      )}\nRewrite each sentence so it reads plainly without the dash, or add an allowlist entry in scripts/check-typography.ts with the reason the character is deliberate.`,
  );
}

process.stdout.write(
  `Checked ${scannedFiles.length} tracked text files for em and en dashes, with ${ALLOWLIST.length} allowlisted occurrences.\n`,
);
