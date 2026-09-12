import {
  Database,
  FileSearch,
  FileStack,
  GitMerge,
  Presentation,
  ScanLine,
  ScanSearch,
  SplitSquareVertical,
  TableProperties,
  ShieldOff,
  type LucideIcon,
} from "lucide-react";

/**
 * Single source of truth for every operation the toolkit ships, per ADR 0001
 * (docs/adr/0001-feature-registry-and-drift-checks.md): one entry per
 * operation, each declaring the status of its CLI, library, and browser
 * surfaces. Landing cards, online-tool tabs, and guide-page "Try … online"
 * buttons all derive from these statuses; `planned` and `none` render
 * nothing user-visible, so a page can never offer a capability that does
 * not exist.
 */

export type SurfaceStatus = "works" | "planned" | "none";

export type ToolCategory = "Excel" | "PDF" | "PowerPoint" | "Database";

/**
 * The browser surface carries its route only when it works, so a card, tab,
 * or button can never link to a browser page that does not exist.
 */
export type BrowserSurface =
  | { readonly status: "works"; readonly href: string }
  | { readonly status: "planned" | "none" };

export interface ToolSurfaces {
  readonly cli: SurfaceStatus;
  readonly library: SurfaceStatus;
  readonly browser: BrowserSurface;
}

export interface ConsultTool {
  readonly slug: string;
  readonly category: ToolCategory;
  readonly title: string;
  /** Short name shown in the online-tools sub-bar and "Try … online" buttons. */
  readonly tabLabel: string;
  readonly description: string;
  readonly docHref: string;
  readonly surfaces: ToolSurfaces;
  readonly icon: LucideIcon;
}

/** A tool whose browser surface works: the only kind that renders browser UI. */
export interface BrowserTool extends ConsultTool {
  readonly surfaces: ToolSurfaces & {
    readonly browser: Extract<BrowserSurface, { status: "works" }>;
  };
}

export function isBrowserTool(tool: ConsultTool): tool is BrowserTool {
  return tool.surfaces.browser.status === "works";
}

export const TOOLS: readonly ConsultTool[] = [
  {
    slug: "spreadsheet-consolidate",
    category: "Excel",
    title: "Consolidate spreadsheets",
    tabLabel: "Consolidate",
    description:
      "Stack rows from every visible worksheet that holds data into one auditable table, even when columns arrive in different orders",
    docHref: "/docs/tools/spreadsheet-consolidate",
    surfaces: {
      cli: "works",
      library: "works",
      browser: { status: "works", href: "/tools/excel-consolidate" },
    },
    icon: TableProperties,
  },
  {
    slug: "workbook-merge",
    category: "Excel",
    title: "Merge workbook tabs",
    tabLabel: "Merge tabs",
    description:
      "Copy every source worksheet into one workbook as its own separate tab, never stacking rows into one sheet",
    docHref: "/docs/tools/workbook-merge",
    surfaces: {
      cli: "works",
      library: "works",
      browser: { status: "works", href: "/tools/excel-merge" },
    },
    icon: FileStack,
  },
  {
    slug: "spreadsheet-split",
    category: "Excel",
    title: "Split spreadsheets",
    tabLabel: "Split Excel",
    description:
      "Create one Excel workbook per distinct value, each keeping the source workbook's sheets, formatting, and supported workbook structure, while leaving source workbooks unchanged",
    docHref: "/docs/tools/spreadsheet-split",
    surfaces: {
      cli: "works",
      library: "works",
      browser: { status: "works", href: "/tools/excel-split" },
    },
    icon: SplitSquareVertical,
  },
  {
    slug: "powerpoint-populate",
    category: "PowerPoint",
    title: "Populate PowerPoint templates",
    tabLabel: "PowerPoint",
    description:
      "Turn a designed template slide and Excel records into a review-ready presentation, entirely locally",
    docHref: "/docs/tools/powerpoint-populate",
    surfaces: {
      cli: "works",
      library: "works",
      browser: { status: "works", href: "/tools/pptx-populate" },
    },
    icon: Presentation,
  },
  {
    slug: "pdf-split",
    category: "PDF",
    title: "Split PDF pages",
    tabLabel: "Split PDF",
    description:
      "Turn a long PDF into predictable, zero-padded page files without sending the document anywhere",
    docHref: "/docs/tools/pdf-split",
    surfaces: {
      cli: "works",
      library: "works",
      browser: { status: "works", href: "/tools/pdf-split" },
    },
    icon: ScanLine,
  },
  {
    slug: "pdf-merge",
    category: "PDF",
    title: "Merge PDF packs",
    tabLabel: "Merge PDFs",
    description:
      "Assemble source PDFs in resolved order and preserve every page in one clean deliverable",
    docHref: "/docs/tools/pdf-merge",
    surfaces: {
      cli: "works",
      library: "works",
      browser: { status: "works", href: "/tools/pdf-merge" },
    },
    icon: GitMerge,
  },
  {
    slug: "powerpoint-inspect-template",
    category: "PowerPoint",
    title: "Inspect PowerPoint templates",
    tabLabel: "Inspect template",
    description:
      "Report every placeholder a template slide expects, with occurrence counts and malformed braces, before you populate it",
    docHref: "/docs/tools/powerpoint-populate#inspect-the-template",
    surfaces: {
      cli: "works",
      library: "works",
      browser: { status: "works", href: "/tools/pptx-inspect" },
    },
    icon: FileSearch,
  },
  {
    slug: "workbook-inspect",
    category: "Excel",
    title: "Inspect workbooks",
    tabLabel: "Inspect workbook",
    description:
      "Report a workbook's worksheets, hidden tabs, header rows, Excel Tables, named ranges, and sample column values before you operate on it",
    docHref: "/docs/tools/workbook-inspect",
    surfaces: {
      cli: "works",
      library: "works",
      browser: { status: "works", href: "/tools/excel-inspect" },
    },
    icon: ScanSearch,
  },
  {
    slug: "excel-unprotect",
    category: "Excel",
    title: "Unprotect Excel workbooks",
    tabLabel: "Unprotect Excel",
    description:
      "Remove ordinary worksheet and workbook-structure protection locally, without uploading or changing the original file",
    docHref: "/docs/tools/excel-unprotect",
    surfaces: {
      cli: "works",
      library: "works",
      browser: { status: "works", href: "/tools/excel-unprotect" },
    },
    icon: ShieldOff,
  },
  {
    slug: "data-workspace",
    category: "Database",
    title: "Import workbooks into a database",
    tabLabel: "Database",
    description:
      "Create persistent SQLite or DuckDB files, review Excel imports, and retain source captures and delivery history locally",
    docHref: "/docs/tools/data-workspace",
    surfaces: {
      cli: "works",
      library: "works",
      browser: { status: "works", href: "/workspace" },
    },
    icon: Database,
  },
] as const;

export const BROWSER_TOOLS: readonly BrowserTool[] =
  TOOLS.filter(isBrowserTool);

export interface BrowserToolGroup {
  readonly category: ToolCategory;
  readonly tools: readonly BrowserTool[];
}

const TOOL_CATEGORY_ORDER: readonly ToolCategory[] = [
  "Excel",
  "PDF",
  "PowerPoint",
  "Database",
];

/**
 * Groups the working browser surfaces without maintaining a second list of
 * tools. The explicit order keeps the catalog predictable as registry entries
 * are added in release order.
 */
export const BROWSER_TOOL_GROUPS: readonly BrowserToolGroup[] =
  TOOL_CATEGORY_ORDER.map((category) => ({
    category,
    tools: BROWSER_TOOLS.filter((tool) => tool.category === category),
  })).filter(({ tools }) => tools.length > 0);

/**
 * Find the tool whose working browser surface a docs page should offer.
 * Keyed off browser status, not entry order, so a page whose operations do
 * not run in the browser offers nothing. Fragments are stripped, so an
 * anchored docHref still resolves to its page.
 *
 * When several operations share one guide page (populate and template
 * inspection both live on the PowerPoint guide), the page gets exactly one
 * button, belonging to the first registered operation that runs in the
 * browser. That is deliberate: a guide header with two competing "Try …
 * online" buttons reads as a choice the reader has to make before they have
 * read anything. The other operations stay one click away in the online-tools
 * sub-bar and on the /tools index, both of which list every browser tool.
 */
export function findToolByDocUrl(url: string): BrowserTool | undefined {
  return BROWSER_TOOLS.find((tool) => tool.docHref.split("#")[0] === url);
}
