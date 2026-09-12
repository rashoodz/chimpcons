import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isBrowserTool, TOOLS } from "../apps/docs/src/lib/tools.ts";

// Registry <-> site conformance check, per ADR 0001 decision 5: every registry
// entry's documentation link must resolve to a real docs page (anchors
// included), every working browser surface must point at a real online-tool
// route, and the rendered site must derive its online-tool links from the
// registry rather than hardcoding them. The registry is imported directly so
// the check always sees the same entries the site renders from.

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const docsContentRoot = path.join(
  workspaceRoot,
  "apps",
  "docs",
  "content",
  "docs",
);
const docsSourceRoot = path.join(workspaceRoot, "apps", "docs", "src");
const appRouteRoot = path.join(docsSourceRoot, "app");
const registryLabel = "apps/docs/src/lib/tools.ts";

// Files under apps/docs/src that may legitimately contain a hardcoded
// /tools/<slug> literal. Every other source file must take online-tool links
// from the registry so the rendered surfaces cannot drift from it. Add a file
// here only with a comment justifying why it cannot derive the link.
const hardcodedToolLinkAllowlist: ReadonlySet<string> = new Set([
  // The registry itself is the one place browser tool routes are declared.
  registryLabel,
]);

// Matches an absolute online-tool route literal such as /tools/excel-merge.
// The lookbehind keeps documentation links under /docs/tools/ and relative
// links such as ./tools/spreadsheets out, and the required trailing segment
// keeps links to the bare /tools index page out.
const toolRoutePattern = /(?<![\w.])\/tools\/[a-z0-9-]+/g;

function toRepoLabel(absolutePath: string): string {
  return path.relative(workspaceRoot, absolutePath).split(path.sep).join("/");
}

function readTextFile(absolutePath: string): string {
  return readFileSync(absolutePath, "utf8").replace(/\r\n/g, "\n");
}

// Recursively lists files under a directory whose names end in one of the
// given extensions. Enumeration order does not matter: problems are reported
// per file and line, and the success line only counts files.
function listFilesWithExtensions(
  directory: string,
  extensions: readonly string[],
): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...listFilesWithExtensions(entryPath, extensions));
    } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
      found.push(entryPath);
    }
  }
  return found;
}

// Deliberately minimal reimplementation of github-slugger, which Fumadocs
// uses to derive heading ids: lowercase, drop everything but letters, digits,
// spaces, hyphens, and underscores, then turn spaces into hyphens. That is
// sufficient for the plain-English headings the docs use. If a future heading
// slugs differently in the real slugger (emoji, accented letters), give the
// heading an explicit id with the `## Heading [#custom-id]` syntax instead of
// widening this function.
function slugifyHeadingText(headingText: string): string {
  return headingText
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9 -]/g, "")
    .replace(/ /g, "-");
}

// Collects every anchor id the page's headings generate: the explicit
// `[#custom-id]` when present, otherwise the slug of the heading text, with
// repeated slugs suffixed -1, -2, ... the way github-slugger deduplicates.
// Headings inside fenced code blocks are ignored.
function collectHeadingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const usedSlugCounts = new Map<string, number>();
  let openFence: { marker: string; length: number } | null = null;

  for (const line of markdown.split("\n")) {
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence?.[1] !== undefined) {
      const marker = fence[1][0] as string;
      if (openFence === null) {
        openFence = { marker, length: fence[1].length };
      } else if (
        marker === openFence.marker &&
        fence[1].length >= openFence.length
      ) {
        openFence = null;
      }
      continue;
    }
    if (openFence !== null) {
      continue;
    }

    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading?.[1] === undefined) {
      continue;
    }

    const customId = /\s*\[#([^\]]+?)\]\s*$/.exec(heading[1]);
    if (customId?.[1] !== undefined) {
      anchors.add(customId[1]);
      continue;
    }

    const slug = slugifyHeadingText(heading[1]);
    const priorUses = usedSlugCounts.get(slug) ?? 0;
    usedSlugCounts.set(slug, priorUses + 1);
    anchors.add(priorUses === 0 ? slug : `${slug}-${priorUses}`);
  }

  return anchors;
}

const problems: string[] = [];
const headingAnchorsByFile = new Map<string, Set<string>>();

// Check 1 and 2: every entry's docHref resolves to a docs content file, and
// any #anchor resolves to a heading in that file. The URL-to-file mapping is
// the Fumadocs default with no slug rewriting: /docs/a/b maps to
// content/docs/a/b.mdx or content/docs/a/b/index.mdx.
for (const tool of TOOLS) {
  const [pagePath = "", ...fragmentParts] = tool.docHref.split("#");
  const fragment = fragmentParts.join("#");
  const segments =
    pagePath === "/docs" ? [] : pagePath.replace(/^\/docs\//, "").split("/");

  if (
    (pagePath !== "/docs" && !pagePath.startsWith("/docs/")) ||
    segments.some((segment) => segment === "")
  ) {
    problems.push(
      `entry "${tool.slug}" has docHref "${tool.docHref}", which is not a well-formed /docs page path`,
    );
    continue;
  }

  const candidateFiles =
    segments.length === 0
      ? [path.join(docsContentRoot, "index.mdx")]
      : [
          path.join(docsContentRoot, ...segments) + ".mdx",
          path.join(docsContentRoot, ...segments, "index.mdx"),
        ];
  const contentFile = candidateFiles.find((candidate) => existsSync(candidate));

  if (contentFile === undefined) {
    problems.push(
      `entry "${tool.slug}" links to "${pagePath}", but no docs page exists there (expected ${candidateFiles
        .map(toRepoLabel)
        .join(" or ")})`,
    );
    continue;
  }

  if (fragment === "") {
    continue;
  }

  let anchors = headingAnchorsByFile.get(contentFile);
  if (anchors === undefined) {
    anchors = collectHeadingAnchors(readTextFile(contentFile));
    headingAnchorsByFile.set(contentFile, anchors);
  }
  if (!anchors.has(fragment)) {
    problems.push(
      `entry "${tool.slug}" links to anchor "#${fragment}", but no heading in ${toRepoLabel(
        contentFile,
      )} generates that id; fix the heading text or give the intended heading an explicit [#${fragment}] id`,
    );
  }
}

// Check 3: every working browser surface points at an online-tool route that
// exists, no two entries claim the same route, and every online-tool route
// page belongs to a registry entry. An unregistered route cannot appear on
// the site's cards or tabs, which means it has drifted outside the registry.
const browserTools = TOOLS.filter(isBrowserTool);
const entriesByRouteHref = new Map<string, string[]>();

for (const tool of browserTools) {
  const routeHref = tool.surfaces.browser.href;
  entriesByRouteHref.set(routeHref, [
    ...(entriesByRouteHref.get(routeHref) ?? []),
    tool.slug,
  ]);

  // The persistent workspace has its own layout outside the stateless tools.
  if (routeHref !== "/workspace" && !/^\/tools\/[a-z0-9-]+$/.test(routeHref)) {
    problems.push(
      `entry "${tool.slug}" declares a working browser surface at "${routeHref}", which is not a /tools/<slug> route or /workspace`,
    );
    continue;
  }

  const routePageFile = path.join(
    appRouteRoot,
    ...routeHref.split("/").filter((segment) => segment !== ""),
    "page.tsx",
  );
  if (!existsSync(routePageFile)) {
    problems.push(
      `entry "${tool.slug}" declares a working browser surface at "${routeHref}", but no route page exists at ${toRepoLabel(
        routePageFile,
      )}`,
    );
  }
}

for (const [routeHref, slugs] of entriesByRouteHref) {
  if (slugs.length > 1) {
    problems.push(
      `entries ${slugs.map((slug) => `"${slug}"`).join(" and ")} both declare "${routeHref}" as their browser route; each online tool belongs to exactly one entry`,
    );
  }
}

const toolRoutesDirectory = path.join(appRouteRoot, "tools");
if (existsSync(toolRoutesDirectory)) {
  for (const entry of readdirSync(toolRoutesDirectory, {
    withFileTypes: true,
  })) {
    if (
      !entry.isDirectory() ||
      !existsSync(path.join(toolRoutesDirectory, entry.name, "page.tsx"))
    ) {
      continue;
    }
    const routeHref = `/tools/${entry.name}`;
    if (!entriesByRouteHref.has(routeHref)) {
      problems.push(
        `the online-tool route "${routeHref}" (${toRepoLabel(
          path.join(toolRoutesDirectory, entry.name, "page.tsx"),
        )}) is not the browser surface of any registry entry; register the operation in ${registryLabel} so the site can present it`,
      );
    }
  }
}

// Check 4a: no source file outside the allowlist hardcodes an online-tool
// route. Components must take these links from the registry so a card, tab,
// or button can never point at a tool the registry does not declare.
const sourceFiles = listFilesWithExtensions(docsSourceRoot, [".ts", ".tsx"]);
for (const sourceFile of sourceFiles) {
  const label = toRepoLabel(sourceFile);
  if (hardcodedToolLinkAllowlist.has(label)) {
    continue;
  }
  const lines = readTextFile(sourceFile).split("\n");
  lines.forEach((line, index) => {
    for (const match of line.match(toolRoutePattern) ?? []) {
      problems.push(
        `${label}:${index + 1} hardcodes the online-tool link "${match}"; take the link from the registry in ${registryLabel} instead`,
      );
    }
  });
}

// Check 4b: docs content cannot import the registry, so hardcoded
// online-tool links are allowed there, but each one must be the declared
// browser route of a registry entry whose browser surface works.
const contentFiles = listFilesWithExtensions(docsContentRoot, [".mdx", ".md"]);
for (const contentFile of contentFiles) {
  const label = toRepoLabel(contentFile);
  const lines = readTextFile(contentFile).split("\n");
  lines.forEach((line, index) => {
    for (const match of line.match(toolRoutePattern) ?? []) {
      if (!entriesByRouteHref.has(match)) {
        problems.push(
          `${label}:${index + 1} links to "${match}", which is not the working browser route of any registry entry; point the link at a route declared in ${registryLabel}, or update the entry's browser surface`,
        );
      }
    }
  });
}

if (problems.length > 0) {
  throw new Error(
    `The tool registry ${registryLabel} and the documentation site disagree:\n${problems
      .map((problem) => `- ${problem}`)
      .join(
        "\n",
      )}\nFix each item so the registry, the docs pages, and the online-tool routes stay in sync.`,
  );
}

process.stdout.write(
  `Verified ${TOOLS.length} registry entries against the docs pages, ${browserTools.length} browser tool routes, and ${sourceFiles.length + contentFiles.length} source and content files for hardcoded online-tool links.\n`,
);
