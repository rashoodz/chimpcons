#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  isConsultChimpsError,
  type OperationResult,
} from "@consultchimps/core";
import { discoverFiles } from "@consultchimps/files";
import { mergePdfs, splitPdf } from "@consultchimps/pdf";
import {
  inspectPowerPointTemplate,
  populatePowerPointTemplate,
} from "@consultchimps/pptx";
import {
  consolidateWorkbooks,
  describeWorkbook,
  mergeWorkbooks,
  splitWorkbookByColumn,
  unprotectWorkbook,
} from "@consultchimps/xlsx";
import {
  CLI_VOCABULARY,
  formatHumanError,
  formatHumanResult,
} from "@consultchimps/messages";
import { Command, CommanderError } from "commander";

import { formatWorkbookDescription } from "./describe-report.js";
import { registerDbCommands } from "./commands/db.js";
import { createCliProgress, finishActiveProgress } from "./progress.js";
import {
  withoutTerminalControls,
  withoutTerminalControlsInProse,
} from "./text.js";

interface GlobalOptions {
  json?: boolean;
}

interface PackageMetadata {
  version: string;
}

interface ConsolidateOptions {
  force?: boolean;
  headerRow?: number;
  hidden?: boolean;
  map?: string;
  normalizeHeaders?: boolean;
  output: string;
  outputSheet?: string;
  sheet?: string[];
  source?: boolean;
  suggestMap?: string;
  values?: boolean;
}

interface SheetMergeOptions {
  force?: boolean;
  index: boolean;
  output: string;
  values?: boolean;
}

interface SheetInspectOptions {
  headerRow?: number;
  hidden?: boolean;
  samples?: number;
  sheet?: string[];
}

interface SheetSplitOptions {
  column: string;
  force?: boolean;
  headerRow?: number;
  hidden?: boolean;
  output?: string;
  outputDir?: string;
  prefix?: string;
  preserveWorkbook?: boolean;
  range?: string;
  sheet?: string;
  skipBlank?: boolean;
  strict?: boolean;
  table?: string;
  values?: boolean;
}

interface SplitOptions {
  force?: boolean;
  output?: string;
  prefix?: string;
}

interface MergeOptions {
  force?: boolean;
  output: string;
}

interface PptxPopulateOptions {
  data: string;
  force?: boolean;
  headerRow?: number;
  output: string;
  sheet?: string;
  template: string;
  templateSlide?: number;
}

interface PptxInspectOptions {
  templateSlide?: number;
}

function positiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("Expected a positive integer.");
  }
  return parsed;
}

// Reads a numeric option without judging it, for the options whose rule the
// library owns. `describeWorkbook` validates both its numbers before it reads
// anything and refuses a bad one with a stable code and a sentence naming the
// rule, so the parsing here only has to convert. Converting leniently, the way
// Number.parseInt does, would be worse than useless: it reads "1.5" as 1 and
// "3junk" as 3, and the inspection would then describe a row the reader never
// asked for. Number leaves those as NaN, which the library refuses like any
// other invalid value, so one mistake produces one refusal. Blank text is the
// one value Number reads as a number at all, and `--samples ""` meaning "no
// samples" is a coincidence rather than a request, so it joins them.
function numericOption(value: string): number {
  return value.trim() === "" ? Number.NaN : Number(value);
}

// Collects one worksheet name per occurrence of an option.
//
// The variadic form (`--sheet <names...>`) reads every following word as a
// name, including the positional workbook, so `--sheet North clients.xlsx`
// would take the workbook as a second worksheet name and then report the
// argument as missing. That is only safe where the positional is itself
// variadic and last, as it is for consolidate. Repeating the option instead
// binds exactly one name to each flag, so the workbook is always still there.
function collectName(value: string, previous: string[] | undefined): string[] {
  return previous ? [...previous, value] : [value];
}

// The --json envelope is a stable machine-readable contract: exactly one JSON
// object on a single line, so a consumer can parse stdout without first
// separating prose from data. "ok" discriminates the two shapes, which lets
// automation branch on success or failure without inspecting the exit code.
function jsonEnvelope(payload: unknown): string {
  return `${JSON.stringify(payload, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value))}\n`;
}

function printJsonResult(result: unknown): void {
  process.stdout.write(jsonEnvelope({ ok: true, result }));
}

function printJsonFailure(message: string, code: string | null): void {
  const envelope = jsonEnvelope({ ok: false, error: { message, code } });
  // stdout stays parseable on its own; stderr repeats the same object so the
  // CLI still reports failures on stderr as every other command does.
  process.stdout.write(envelope);
  process.stderr.write(envelope);
}

function printResult<TMetric extends string>(
  result: OperationResult<TMetric>,
  json: boolean,
): void {
  if (json) {
    printJsonResult(result);
    return;
  }

  // A warning quotes worksheet names and headers, and an artifact path quotes a
  // filename: all of them input, and all of them about to be written to a
  // terminal, where a control character is an instruction. The structured
  // result above is untouched, so --json still reports the original text.
  process.stdout.write(
    formatHumanResult(
      {
        ...result,
        artifacts: result.artifacts.map((artifact) => ({
          ...artifact,
          path: withoutTerminalControls(artifact.path),
        })),
        warnings: result.warnings.map(withoutTerminalControls),
      },
      { vocabulary: CLI_VOCABULARY },
    ),
  );
}

// Usage errors such as an unknown option carry no library error code, so they
// report one stable code of their own rather than null, which is reserved for
// genuinely unexpected failures.
const USAGE_ERROR_CODE = "CLI_USAGE";

// --json has to be read from argv rather than program.opts() because a usage
// error is thrown before Commander finishes populating the parsed options. A
// literal "--json" supplied as an option *value* would false-positive here,
// which is an acceptable trade for making parse failures machine-readable.
const jsonRequested = process.argv.includes("--json");

const program = new Command();

// Commander exits the process itself on a usage error, which would bypass the
// --json envelope and leave stdout empty. exitOverride makes it throw a
// CommanderError so every failure reaches the single handler at the end of this
// file. This and configureOutput must both be set before any .command() call,
// because subcommands copy the exit callback and output configuration from
// their parent at creation time.
program.exitOverride();

if (jsonRequested) {
  // Commander writes its usage prose to stderr before throwing. Silence it so
  // JSON mode emits nothing but the envelope. Help and version text goes
  // through writeOut and is deliberately left alone.
  program.configureOutput({ writeErr: () => {} });
} else {
  // That same prose quotes the argument it could not parse, and an argument is
  // untrusted text: a shell expanding a pattern can hand over a filename that
  // begins with a dash and carries a terminal escape, which Commander then
  // reports as an unknown option. It writes this before it throws, so the
  // handler at the end of this file never sees it. Its own line breaks survive;
  // everything else a terminal would read as an instruction does not.
  program.configureOutput({
    writeErr: (text) =>
      process.stderr.write(withoutTerminalControlsInProse(text)),
  });
}

// The standalone single-file bundle ships with no package.json beside it, so
// its build defines the version at compile time (tsup.bundle.config.ts); the
// packaged layout keeps reading the manifest that npm installs alongside.
declare const CONSULTCHIMPS_BUNDLED_VERSION: string;
const cliVersion =
  typeof CONSULTCHIMPS_BUNDLED_VERSION === "string"
    ? CONSULTCHIMPS_BUNDLED_VERSION
    : (
        JSON.parse(
          readFileSync(new URL("../package.json", import.meta.url), "utf8"),
        ) as PackageMetadata
      ).version;

program
  .name("consultchimps")
  .description(
    "Local-first tools for spreadsheets, persistent databases, presentations, and PDFs.",
  )
  .version(cliVersion)
  .option(
    "--json",
    "print one line of machine-readable JSON for automation instead of the detailed explanation",
  )
  .addHelpText(
    "after",
    `
Quick start:
  consultchimps db create -o inventory.duckdb
  consultchimps db plan inventory.duckdb --input inventory.xlsx -o review.ccplan
  consultchimps sheets inspect clients.xlsx
  consultchimps sheets consolidate "inputs/*.xlsx" -o combined.xlsx
  consultchimps sheets merge "inputs/*.xlsx" -o all-sheets.xlsx
  consultchimps sheets split clients.xlsx -c Region -o by-region
  consultchimps pptx populate --template profile.pptx --data clients.xlsx --sheet Clients --template-slide 1 -o profiles.pptx
  consultchimps pdf split report.pdf -o pages
  consultchimps pdf merge "inputs/*.pdf" -o combined.pdf

Automation with --json:
  Place --json before the command to replace the explanation with one line of
  JSON on stdout. Success prints {"ok":true,"result":...} and failure prints
  {"ok":false,"error":{"message":...,"code":...}} while keeping the nonzero
  exit code. Nothing else is written to stdout, so the output can be piped
  straight into a JSON parser.

  consultchimps --json pdf split report.pdf -o pages

Run consultchimps help <command> or append --help to a command for all options.
`,
  );

const sheets = program
  .command("sheets")
  .description(
    "inspect, combine, or divide Excel workbooks without changing the original files",
  )
  .addHelpText(
    "after",
    `
Examples:
  consultchimps sheets inspect clients.xlsx
  consultchimps sheets consolidate "inputs/*.xlsx" -o combined.xlsx
  consultchimps sheets merge "inputs/*.xlsx" -o all-sheets.xlsx
  consultchimps sheets split clients.xlsx -c Region -o by-region

Safety:
  Your original Excel workbooks are not changed. ConsultChimps creates new
  output files and refuses to replace existing outputs unless you use --force.

Run consultchimps sheets help <command> for all command options.
`,
  );

sheets
  .command("unprotect")
  .description("remove ordinary worksheet and workbook-structure protection")
  .argument("<input>", "the source .xlsx or .xlsm workbook")
  .requiredOption(
    "-o, --output <path>",
    "where to save the unprotected workbook",
  )
  .option("-f, --force", "replace the output file if it already exists")
  .addHelpText(
    "after",
    `\nExamples:\n  consultchimps sheets unprotect protected.xlsx -o unprotected.xlsx\n\nThis removes worksheet and workbook-structure protection without changing the source file. Office files encrypted to require a password to open are not supported.\n`,
  )
  .action(
    async (input: string, options: { output: string; force?: boolean }) => {
      const [inputPath] = await discoverFiles([input], {
        extensions: [".xlsx", ".xlsm"],
      });
      const result = await unprotectWorkbook({
        input: inputPath!,
        output: options.output,
        overwrite: options.force === true,
      });
      printResult(result, program.opts<GlobalOptions>().json === true);
    },
  );

sheets
  .command("merge")
  .description(
    "copy every worksheet from multiple Excel workbooks into one workbook, keeping each sheet separate",
  )
  .argument(
    "<inputs...>",
    'Excel files, folders, or quoted patterns such as "inputs/*.xlsx"',
  )
  .requiredOption("-o, --output <path>", "where to save the new workbook")
  .option("--no-index", "do not add the visible Sheet Index worksheet")
  .option(
    "--values",
    "replace formulas with their stored values while preserving formatting",
  )
  .option(
    "-f, --force",
    "replace the output file if it already exists; use with care",
  )
  .addHelpText(
    "after",
    `
Examples:
  consultchimps sheets merge "inputs/*.xlsx" --values -o all-sheets.xlsx
  consultchimps sheets merge north.xlsx south.xlsx --output all-sheets.xlsx

Every source worksheet remains a separate tab. Sheet Index records source names
and hidden/visible status. Duplicate tab names receive a suffix. --values
removes formulas but always retains cell and workbook formatting.

When you want one combined sheet instead of separate tabs:
  Use consultchimps sheets consolidate to stack the rows from every worksheet
  into a single sheet, matching columns by header.
`,
  )
  .action(async (inputs: string[], options: SheetMergeOptions) => {
    const inputPaths = await discoverFiles(inputs, { extensions: [".xlsx"] });
    const progress = createCliProgress(
      program.opts<GlobalOptions>().json === true,
    );
    const result = await mergeWorkbooks(inputPaths, options.output, {
      includeSheetIndex: options.index,
      onProgress: progress.report,
      overwrite: options.force === true,
      values: options.values === true,
    });
    progress.finish();
    printResult(result, program.opts<GlobalOptions>().json === true);
  });

sheets
  .command("consolidate")
  .description(
    "stack the rows from every worksheet into one combined sheet, matching columns by header",
  )
  .argument(
    "<inputs...>",
    'Excel files, folders, or quoted patterns such as "inputs/*.xlsx"',
  )
  .requiredOption(
    "-o, --output <path>",
    "where to save the new consolidated .xlsx workbook",
  )
  .option(
    "--sheet <names...>",
    "include only worksheets with these exact names",
  )
  .option(
    "--header-row <number>",
    "row containing column names, counted from 1",
    positiveInteger,
  )
  .option("--hidden", "include hidden worksheets as well as visible ones")
  .option(
    "--normalize-headers",
    'match columns whose headers differ only in case, spacing, or punctuation, such as "Failed Checks" and "Failed_Checks"',
  )
  .option(
    "--map <file>",
    "JSON column mapping that folds differently named columns into one column each",
  )
  .option(
    "--suggest-map <file>",
    "write a draft column mapping built from the headers found, for you to review",
  )
  .option(
    "--no-source",
    "leave out columns that identify each row's source file, worksheet, and row",
  )
  .option(
    "--output-sheet <name>",
    "name of the worksheet created in the new workbook",
    "Consolidated",
  )
  .option(
    "--values",
    "write stored values instead of formulas while preserving output formatting",
  )
  .option(
    "-f, --force",
    "replace the output file if it already exists; use with care",
  )
  .addHelpText(
    "after",
    `
Examples:
  consultchimps sheets consolidate "inputs/*.xlsx" -o combined.xlsx
  consultchimps sheets consolidate north.xlsx south.xlsx --output combined.xlsx

What happens:
  1. ConsultChimps finds the matching Excel files.
  2. It reads every selected, non-empty worksheet.
  3. It matches columns by header name and combines all data rows.
  4. It writes one new workbook and explains exactly what was created.

Your original workbooks are never changed.
Consolidation already writes stored values rather than copying formulas;
--values makes that requirement explicit.

Matching columns that are named differently:
  consultchimps sheets consolidate inputs/ --suggest-map draft.json -o combined.xlsx
  consultchimps sheets consolidate inputs/ --map mapping.json -o combined.xlsx

  --suggest-map writes a draft mapping grouping the headers that differ only in
  case, spacing, or punctuation, for you to read and edit; nothing is applied
  for you. --map then folds every listed spelling into the one column you named.
  A column no mapping entry covers keeps its own name and is reported as a
  warning. Two columns of one worksheet folding into one column stop the run
  rather than quietly losing a value. Use one option or the other, not both.

When you want each worksheet kept as its own tab instead:
  Use consultchimps sheets merge to copy every worksheet into one workbook
  without combining any rows.
`,
  )
  .action(async (inputs: string[], options: ConsolidateOptions) => {
    const inputPaths = await discoverFiles(inputs, { extensions: [".xlsx"] });
    const progress = createCliProgress(
      program.opts<GlobalOptions>().json === true,
    );
    const result = await consolidateWorkbooks({
      inputs: inputPaths,
      output: options.output,
      addSourceColumns: options.source !== false,
      headerRow: options.headerRow,
      includeHiddenSheets: options.hidden === true,
      mappingFile: options.map,
      normalizeHeaders: options.normalizeHeaders === true,
      onProgress: progress.report,
      outputSheetName: options.outputSheet,
      overwrite: options.force === true,
      sheets: options.sheet,
      suggestMappingOutput: options.suggestMap,
      values: options.values === true,
    });
    progress.finish();
    printResult(result, program.opts<GlobalOptions>().json === true);
  });

sheets
  .command("split")
  .description(
    "create one new Excel workbook for each distinct value in a selected column",
  )
  .argument("<input>", "the source .xlsx or .xlsm workbook to divide")
  .requiredOption(
    "-c, --column <name>",
    "column whose values decide which rows go into each new workbook",
  )
  .option(
    "-o, --output <directory>",
    "folder where the new workbooks will be saved",
  )
  .option(
    "--output-dir <directory>",
    "folder where the new workbooks will be saved (alias for --output)",
  )
  .option("--sheet <name>", "exact name of the worksheet to divide")
  .option(
    "--table <name>",
    "use this named Excel Table instead of the worksheet's full used range (preferred)",
  )
  .option(
    "--range <name>",
    "use this named range instead of the worksheet's full used range",
  )
  .option(
    "--header-row <number>",
    "row containing column names, counted from 1",
    positiveInteger,
  )
  .option("--hidden", "allow the selected worksheet to be hidden")
  .option(
    "--preserve-workbook",
    "keep the full workbook layout (default without a selector and for --table)",
  )
  .option(
    "--no-preserve-workbook",
    "write plain data-only workbooks using the single-source split mode",
  )
  .option(
    "--values",
    "replace formulas with their stored values while preserving formatting",
  )
  .option(
    "--strict",
    "match split values exactly, including case, whitespace, and value type",
  )
  .option(
    "--skip-blank",
    "do not create an output group for rows with a blank split-column value",
  )
  .option(
    "--prefix <name>",
    "text to place at the start of each output filename",
  )
  .option(
    "-f, --force",
    "replace matching output files that already exist; use with care",
  )
  .addHelpText(
    "after",
    `
Examples:
  consultchimps sheets split clients.xlsx -c Region --output-dir by-region
  consultchimps sheets split clients.xlsx --table ClientData --column Region --values
  consultchimps sheets split clients.xlsx --range ClientRange --column Region

What happens:
  1. By default, ConsultChimps finds --column in every worksheet.
  2. It collects distinct non-blank values across all matching worksheets.
  3. It copies the whole workbook once per value and removes other rows.
  4. Worksheets without --column are copied unchanged.
  5. Pivot tables and their caches are removed and reported as a warning: a
     cache holds a private copy of every source row, so it would carry other
     values into each file.

Matching trims surrounding whitespace, ignores case, and treats ordinary
numeric text like the equivalent number. Use --strict for exact matching.
Use --sheet, --table, or --range for the legacy single-source split mode.
Use --no-preserve-workbook only when a compact, data-only result is wanted.

--values removes formulas while retaining their stored results and all
formatting in a preserved workbook. A formula without a stored result becomes
a formatted blank cell and is reported as a warning.

Pro tip: before a table split, prepare the workbook exactly as you want to
deliver it - set each sheet's zoom, place the cursor on cell A1 so every
file opens consistently, add any cover sheet, and save.

Your original workbook is never changed.
`,
  )
  .action(async (input: string, options: SheetSplitOptions) => {
    if (options.output && options.outputDir) {
      throw new Error(
        "Choose either --output or --output-dir; they name the same destination option.",
      );
    }
    const inputPaths = await discoverFiles([input], {
      extensions: [".xlsx", ".xlsm"],
    });
    if (inputPaths.length !== 1) {
      throw new Error(
        `Expected exactly one input workbook; found ${inputPaths.length}.`,
      );
    }

    const inputPath = inputPaths[0];
    if (!inputPath) {
      throw new Error("No input workbook was found.");
    }

    const outputDirectory =
      options.outputDir ??
      options.output ??
      path.join(path.dirname(inputPath), `${path.parse(inputPath).name}-split`);
    const progress = createCliProgress(
      program.opts<GlobalOptions>().json === true,
    );
    const result = await splitWorkbookByColumn({
      input: inputPath,
      outputDirectory,
      column: options.column,
      filenamePrefix: options.prefix,
      headerRow: options.headerRow,
      includeBlank: options.skipBlank !== true,
      includeHiddenSheets: options.hidden === true,
      onProgress: progress.report,
      overwrite: options.force === true,
      preserveWorkbook: options.preserveWorkbook,
      range: options.range,
      sheet: options.sheet,
      table: options.table,
      strict: options.strict === true,
      values: options.values === true,
    });
    progress.finish();
    printResult(result, program.opts<GlobalOptions>().json === true);
  });

sheets
  .command("inspect")
  .description(
    "describe what is in an Excel workbook, creating and changing nothing",
  )
  .argument("<input>", "the .xlsx or .xlsm workbook to describe")
  .option(
    "--sheet <name>",
    "describe only the worksheet with this exact name; repeat for several",
    collectName,
  )
  .option(
    "--header-row <number>",
    "row containing column names, counted from 1",
    numericOption,
  )
  .option("--hidden", "describe hidden worksheets as well as visible ones")
  .option(
    "--samples <number>",
    "distinct sample values to report per column, from 0 to 5 (default: 5)",
    numericOption,
  )
  .addHelpText(
    "after",
    `
Examples:
  consultchimps sheets inspect clients.xlsx
  consultchimps sheets inspect clients.xlsx --hidden --samples 2
  consultchimps sheets inspect --sheet North --sheet South clients.xlsx

What you get:
  1. Each described worksheet, with its visibility, the size of its used range,
     and how many data rows sit below its header row.
  2. The header row an operation would actually use, and every column on it
     with a few of the values stored beneath it.
  3. The Excel Tables and named ranges the described worksheets contain.

Sample values are the first few distinct non-empty values a column stores, at
most five, reported exactly as the workbook holds them: text is quoted, so the
number 1 and the text "1" stay apart. Use --samples 0 for headers only.

No file is created and nothing in the workbook is changed. Run this before
consolidating, merging, or splitting to confirm the worksheet names, header
rows, and column spellings those commands will match on.
`,
  )
  .action(async (input: string, options: SheetInspectOptions) => {
    const inputPaths = await discoverFiles([input], {
      extensions: [".xlsx", ".xlsm"],
    });
    if (inputPaths.length !== 1) {
      throw new Error(
        `Expected exactly one input workbook; found ${inputPaths.length}.`,
      );
    }

    const inputPath = inputPaths[0];
    if (!inputPath) {
      throw new Error("No input workbook was found.");
    }

    const json = program.opts<GlobalOptions>().json === true;
    const progress = createCliProgress(json);
    const outcome = await describeWorkbook(inputPath, {
      headerRow: options.headerRow,
      includeHiddenSheets: options.hidden === true,
      onProgress: progress.report,
      sampleValues: options.samples,
      sheets: options.sheet,
    });
    progress.finish();

    if (json) {
      // The whole outcome, exactly as the library returns it: the counts alone
      // would drop the worksheet names, headers, and samples an inspection
      // exists to report.
      printJsonResult(outcome);
      return;
    }

    // The description first, then the explanation of the result that closes
    // every command's output with its warnings and next steps.
    process.stdout.write(`${formatWorkbookDescription(outcome.description)}\n`);
    printResult(outcome.result, false);
  });

const pptx = program
  .command("pptx")
  .description(
    "inspect or populate PowerPoint templates without changing the source files",
  )
  .addHelpText(
    "after",
    `
Examples:
  consultchimps pptx inspect-template profile.pptx
  consultchimps pptx populate --template profile.pptx --data clients.xlsx -o profiles.pptx

Safety:
  Your source PowerPoint template and Excel workbook are not changed.
  ConsultChimps creates one new presentation and refuses to replace an existing
  output unless you use --force.
`,
  );

pptx
  .command("inspect-template")
  .description(
    "list text placeholders on one PowerPoint template slide without creating a file",
  )
  .argument("<template>", "the source .pptx template to inspect")
  .option(
    "--template-slide <number>",
    "template slide number, counted from 1 (default: 1)",
    positiveInteger,
  )
  .addHelpText(
    "after",
    `
Example:
  consultchimps pptx inspect-template profile.pptx

The report identifies valid {{field_name}} placeholders, malformed placeholder
braces, and unsupported placeholder placements. Split-run placeholders are
supported.
`,
  )
  .action(async (template: string, options: PptxInspectOptions) => {
    const inspection = await inspectPowerPointTemplate(template, {
      templateSlide: options.templateSlide,
    });
    if (program.opts<GlobalOptions>().json === true) {
      printJsonResult(inspection);
      return;
    }

    const lines = [
      `PowerPoint template slide ${inspection.slideNumber}`,
      `Placeholder occurrences: ${inspection.placeholderOccurrences}`,
      "Placeholders:",
      ...(inspection.placeholders.length > 0
        ? inspection.placeholders.map(
            (placeholder) =>
              `  - ${placeholder.name}: ${placeholder.occurrences}`,
          )
        : ["  - None"]),
      `Malformed placeholder locations: ${inspection.malformedPlaceholderCount}`,
      `Unsupported split-run placeholders: ${
        inspection.unsupportedSplitRunPlaceholders.join(", ") || "None"
      }`,
      `Unsupported placeholder placements: ${
        inspection.unsupportedPlacementPlaceholders.join(", ") || "None"
      }`,
      "",
    ];
    process.stdout.write(lines.join("\n"));
  });

pptx
  .command("populate")
  .description(
    "create one populated PowerPoint slide for every nonempty Excel data row",
  )
  .requiredOption(
    "--template <path>",
    "source .pptx file containing {{field_name}} placeholders",
  )
  .requiredOption("--data <path>", "source .xlsx workbook containing the data")
  .option(
    "--sheet <name>",
    "exact worksheet name containing the data (default: first worksheet)",
  )
  .option(
    "--template-slide <number>",
    "template slide number, counted from 1 (default: 1)",
    positiveInteger,
  )
  .requiredOption(
    "-o, --output <path>",
    "where to save the new populated .pptx presentation",
  )
  .option(
    "--header-row <number>",
    "row containing field names, counted from 1",
    positiveInteger,
  )
  .option(
    "-f, --force",
    "replace the output presentation if it already exists; use with care",
  )
  .addHelpText(
    "after",
    `
Example:
  consultchimps pptx populate --template profile.pptx --data clients.xlsx --output profiles.pptx

Put placeholders such as {{client_name}} or Revenue: {{revenue}} in ordinary
text shapes on the template slide. Each nonempty row below the Excel header
creates one slide, in worksheet order. The first worksheet and first slide are
used unless you select them. Empty cells become empty text.

The output contains only the generated slides. Source files are never changed.
`,
  )
  .action(async (options: PptxPopulateOptions) => {
    const progress = createCliProgress(
      program.opts<GlobalOptions>().json === true,
    );
    const result = await populatePowerPointTemplate({
      headerRow: options.headerRow,
      onProgress: progress.report,
      outputPath: options.output,
      overwrite: options.force === true,
      templatePath: options.template,
      templateSlide: options.templateSlide,
      workbookPath: options.data,
      worksheet: options.sheet,
    });
    progress.finish();
    printResult(result, program.opts<GlobalOptions>().json === true);
  });

const pdf = program
  .command("pdf")
  .description("split or combine PDF documents without changing the originals")
  .addHelpText(
    "after",
    `
Examples:
  consultchimps pdf split report.pdf -o pages
  consultchimps pdf merge "inputs/*.pdf" -o combined.pdf

Safety:
  Your original PDF documents are not changed. ConsultChimps creates new output
  files and refuses to replace existing outputs unless you use --force.

Run consultchimps pdf help <command> for all command options.
`,
  );

pdf
  .command("split")
  .description("create one new PDF file for every page in a source PDF")
  .argument("<input>", "the source PDF document to divide")
  .option(
    "-o, --output <directory>",
    "folder where the separate page files will be saved",
  )
  .option(
    "--prefix <name>",
    "text to place at the start of each output filename",
  )
  .option(
    "-f, --force",
    "replace matching output files that already exist; use with care",
  )
  .addHelpText(
    "after",
    `
Example:
  consultchimps pdf split report.pdf -o pages

What happens:
  ConsultChimps creates one clearly numbered PDF for every page, lists every
  new file, and leaves the source PDF unchanged.
`,
  )
  .action(async (input: string, options: SplitOptions) => {
    const [inputPath] = await discoverFiles([input], { extensions: [".pdf"] });
    if (!inputPath) {
      throw new Error("No input PDF was found.");
    }
    const outputDirectory =
      options.output ??
      path.join(path.dirname(inputPath), `${path.parse(inputPath).name}-pages`);
    const progress = createCliProgress(
      program.opts<GlobalOptions>().json === true,
    );
    const result = await splitPdf({
      input: inputPath,
      outputDirectory,
      filenamePrefix: options.prefix,
      onProgress: progress.report,
      overwrite: options.force === true,
    });
    progress.finish();
    printResult(result, program.opts<GlobalOptions>().json === true);
  });

pdf
  .command("merge")
  .description("combine several PDF documents into one new PDF")
  .argument(
    "<inputs...>",
    'PDF files, folders, or quoted patterns such as "inputs/*.pdf"',
  )
  .requiredOption(
    "-o, --output <path>",
    "where to save the new combined PDF document",
  )
  .option(
    "-f, --force",
    "replace the output PDF if it already exists; use with care",
  )
  .addHelpText(
    "after",
    `
Examples:
  consultchimps pdf merge "inputs/*.pdf" -o combined.pdf
  consultchimps pdf merge first.pdf second.pdf --output combined.pdf

What happens:
  ConsultChimps reads the matching PDFs in their resolved order, copies every
  page into one new document, reports the final page count, and leaves every
  source PDF unchanged.
`,
  )
  .action(async (inputs: string[], options: MergeOptions) => {
    const inputPaths = await discoverFiles(inputs, { extensions: [".pdf"] });
    const progress = createCliProgress(
      program.opts<GlobalOptions>().json === true,
    );
    const result = await mergePdfs({
      inputs: inputPaths,
      onProgress: progress.report,
      output: options.output,
      overwrite: options.force === true,
    });
    progress.finish();
    printResult(result, program.opts<GlobalOptions>().json === true);
  });

registerDbCommands(program, {
  json: () => program.opts<GlobalOptions>().json === true,
  result: (result) =>
    printResult(result, program.opts<GlobalOptions>().json === true),
  data: (value, humanText) => {
    if (program.opts<GlobalOptions>().json === true) printJsonResult(value);
    else process.stdout.write(withoutTerminalControlsInProse(humanText));
  },
});

try {
  await program.parseAsync(process.argv);
} catch (error) {
  // A failed operation can leave a partially rendered TTY progress line; clear
  // it before any error output so the two never interleave.
  finishActiveProgress();
  if (error instanceof CommanderError) {
    // With exitOverride active Commander reports --help and --version as errors
    // too. Those are successful terminations whose output Commander has already
    // written, so there is nothing to add and nothing to fail.
    if (error.exitCode !== 0) {
      if (jsonRequested) {
        printJsonFailure(error.message, USAGE_ERROR_CODE);
      }
      // Without --json Commander has already written its own usage prose, so
      // only its exit status needs carrying over.
      process.exitCode = error.exitCode;
    }
  } else {
    const json = program.opts<GlobalOptions>().json === true;
    const expected = isConsultChimpsError(error);
    const message = expected
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
    // Only expected operational failures carry a published, stable error code.
    // Unexpected errors report null rather than inventing a code an automation
    // could come to depend on.
    const code = expected ? error.code : null;

    if (json) {
      printJsonFailure(message, code);
    } else {
      // An error message names the worksheet, column, or file it failed on, so
      // it carries input to a terminal exactly as a warning does. The JSON
      // envelope above keeps the original text.
      process.stderr.write(
        formatHumanError(
          withoutTerminalControls(message),
          expected ? error.code : undefined,
          { vocabulary: CLI_VOCABULARY },
        ),
      );
    }
    process.exitCode = 1;
  }
}
