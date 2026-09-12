import type { Artifact, OperationResult } from "@consultchimps/core";

/**
 * Interface-specific wording used by the shared explanations.
 *
 * The guidance in this package is identical for every interface, but the way a
 * recovery step is expressed is not: a terminal user reruns a command with
 * `--force`, while a browser user turns on an overwrite control. Each entry is
 * a complete, plain-language sentence (or, for `actionNoun` and
 * `artifactListReference`, a fragment) so that an interface can supply wording
 * that matches how its users actually work.
 */
export interface MessageVocabulary {
  /**
   * Word for a single unit of work the user asked for: "command" in a terminal,
   * "task" in a graphical interface.
   */
  readonly actionNoun: string;
  /**
   * Fragment that points at the list of created files, such as "listed below"
   * in a scrolling transcript or "shown in the list of created files" in an
   * interface that renders the files somewhere else.
   */
  readonly artifactListReference: string;
  /** Where to find worked examples for the attempted work. */
  readonly examplesReference: string;
  /** How to include hidden worksheets in a spreadsheet operation. */
  readonly hiddenWorksheetOption: string;
  /** Where to find the expected input format. */
  readonly inputFormatReference: string;
  /** How to review a PowerPoint template's placeholders before populating it. */
  readonly inspectTemplateFirst: string;
  /** Caution to confirm before replacing an existing output. */
  readonly overwriteCaution: string;
  /** How to make a file pattern such as `*.xlsx` be interpreted literally. */
  readonly patternQuoting: string;
  /** Where to find the available PDF options and examples. */
  readonly pdfOptionsReference: string;
  /** Where to find a complete PowerPoint population example. */
  readonly powerPointExampleReference: string;
  /** How to try again after choosing a different output location. */
  readonly retryAfterChoosingDifferentOutput: string;
  /** How to try the same work again once the user is ready. */
  readonly retryWhenReady: string;
  /** How to try again with overwriting deliberately enabled. */
  readonly retryWithOverwrite: string;
  /** Where to find the available spreadsheet options and examples. */
  readonly spreadsheetOptionsReference: string;
}

/** Options shared by the human-readable formatters. */
export interface MessageFormatOptions {
  /** Interface wording to use. Defaults to {@link GENERIC_VOCABULARY}. */
  readonly vocabulary?: MessageVocabulary;
}

/**
 * Interface-neutral wording. It never names a flag, an executable, or a
 * terminal, so any interface can render these explanations unchanged.
 */
export const GENERIC_VOCABULARY: MessageVocabulary = {
  actionNoun: "task",
  artifactListReference: "shown in the list of created files",
  examplesReference: "Review the reference for this task if you need examples.",
  hiddenWorksheetOption:
    "If the data is on a hidden worksheet, turn on the option that includes hidden worksheets.",
  inputFormatReference:
    "Review the reference for this task if you want to check the expected input format.",
  inspectTemplateFirst:
    "Inspect the PowerPoint template to review its placeholders before populating the presentation.",
  overwriteCaution:
    "Allow the existing output to be replaced only after confirming that it is safe to replace.",
  patternQuoting:
    "If you used a pattern such as *.xlsx or *.pdf, check that it is written exactly as you intended and try again.",
  pdfOptionsReference:
    "Review the reference for this task to see the available PDF options and examples.",
  powerPointExampleReference:
    "Review the reference for populating a presentation to see a complete example.",
  retryAfterChoosingDifferentOutput:
    "Choose a different output filename or output folder and start the task again.",
  retryWhenReady: "Start the task again when you are ready to complete it.",
  retryWithOverwrite:
    "If you intentionally want to replace the existing output, allow the existing output to be replaced and try again.",
  spreadsheetOptionsReference:
    "Review the reference for this task to see the available spreadsheet options and examples.",
};

/**
 * Wording for the `consultchimps` command-line interface. These values are the
 * exact sentences the CLI has always printed.
 */
export const CLI_VOCABULARY: MessageVocabulary = {
  actionNoun: "command",
  artifactListReference: "listed below",
  examplesReference: "Run the command again with --help if you need examples.",
  hiddenWorksheetOption:
    "If the data is on a hidden worksheet, review the --hidden option in the command help.",
  inputFormatReference:
    "Run the command with --help if you want to review the expected input format.",
  inspectTemplateFirst:
    "Run consultchimps pptx inspect-template to review placeholders before populating the presentation.",
  overwriteCaution:
    "Use --force only after confirming that the existing output is safe to replace.",
  patternQuoting:
    "If you used a pattern such as *.xlsx or *.pdf, place it in quotation marks and try again.",
  pdfOptionsReference:
    "Run the command with --help to review the available PDF options and examples.",
  powerPointExampleReference:
    "Run consultchimps pptx populate --help for a complete example.",
  retryAfterChoosingDifferentOutput:
    "Choose a different output filename or output folder and run the command again.",
  retryWhenReady:
    "Run the command again when you are ready to complete the task.",
  retryWithOverwrite:
    "If you intentionally want to replace the existing output, rerun the command with --force.",
  spreadsheetOptionsReference:
    "Run the command with --help to review the available spreadsheet options and examples.",
};

interface OperationExplanation {
  readonly nextSteps: (
    vocabulary: MessageVocabulary,
    result: OperationResult,
  ) => readonly string[];
  readonly summary: (result: OperationResult) => readonly string[];
  readonly title: string;
}

const numberFormatter = new Intl.NumberFormat("en-US");

/**
 * The media type a written column mapping carries. It is the only JSON
 * document any operation produces, so it names both the artifact's type and
 * the presence of a drafted mapping in a consolidation's explanation.
 */
const MAPPING_MEDIA_TYPE = "application/json";

function metric(result: OperationResult, name: string): number {
  return result.metrics[name] ?? 0;
}

function formatNumber(value: number): string {
  return numberFormatter.format(value);
}

function workbookSplitSummary(result: OperationResult):
  | {
      column: string;
      copiedUnchangedSheets: string[];
      filteredSheets: string[];
      input: string;
      outputDirectory: string;
      valuesOnly: boolean;
    }
  | undefined {
  const summary = (result as OperationResult & { summary?: unknown }).summary;
  if (
    !summary ||
    typeof summary !== "object" ||
    !("column" in summary) ||
    typeof summary.column !== "string" ||
    !("input" in summary) ||
    typeof summary.input !== "string" ||
    !("outputDirectory" in summary) ||
    typeof summary.outputDirectory !== "string" ||
    !("filteredSheets" in summary) ||
    !Array.isArray(summary.filteredSheets) ||
    !("copiedUnchangedSheets" in summary) ||
    !Array.isArray(summary.copiedUnchangedSheets) ||
    !("valuesOnly" in summary) ||
    typeof summary.valuesOnly !== "boolean"
  ) {
    return undefined;
  }
  return summary as {
    column: string;
    copiedUnchangedSheets: string[];
    filteredSheets: string[];
    input: string;
    outputDirectory: string;
    valuesOnly: boolean;
  };
}

function quantity(
  value: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${formatNumber(value)} ${value === 1 ? singular : plural}`;
}

/**
 * Whether this result wrote a drafted column mapping. The artifact answers
 * that; the proposed-column count does not, because a run over headers that
 * already agree writes a real file proposing nothing.
 */
function hasMappingDraft(result: OperationResult): boolean {
  return result.artifacts.some(
    (artifact) => artifact.mediaType === MAPPING_MEDIA_TYPE,
  );
}

const operationExplanations: Readonly<Record<string, OperationExplanation>> = {
  "db.create": {
    title: "Your persistent database was created.",
    summary: (result) => [
      `The database contains ${quantity(metric(result, "tablesCreated"), "declared table")}. Subsequent database operations can reopen this file.`,
    ],
    nextSteps: () => [
      "Inspect the database or prepare a workbook import before adding observations.",
    ],
  },
  "db.prepare": {
    title: "Your workbook import is captured for review.",
    summary: (result) => [
      `ConsultChimps captured ${quantity(metric(result, "rowsCaptured"), "source row")} in private staging storage.`,
      "The import has not added these rows to accepted database tables. The original workbooks were not changed.",
    ],
    nextSteps: () => [
      "Review the proposed tables, types, mappings, and conflicts before applying the plan.",
      "The saved plan can contain source values. Keep it with your confidential working files.",
    ],
  },
  "db.apply": {
    title: "Your database import was applied.",
    summary: (result) => [
      `ConsultChimps added ${quantity(metric(result, "rowsImported"), "observation")} and reused ${quantity(metric(result, "rowsReused"), "previously imported observation")}.`,
      "Committed changes are stored in the working database. The original workbooks were not changed.",
    ],
    nextSteps: () => [
      "Inspect the database and delivery history. You can reopen the database without importing the Excel files again.",
    ],
  },
  "db.schema.apply": {
    title: "Your database schema changes were applied.",
    summary: () => [
      "The approved table definitions were applied to the working database.",
    ],
    nextSteps: () => [
      "Inspect the schema before preparing imports into its tables.",
    ],
  },
  "db.delivery.record": {
    title: "Your delivery was recorded.",
    summary: () => [
      "The delivery references existing source captures without adding their row values again.",
    ],
    nextSteps: () => [
      "Review delivery history to see the submission context and referenced captures.",
    ],
  },
  "db.export": {
    title: "Your database copy was exported.",
    summary: () => [
      "The exported file is an independent copy. Later changes to the working database do not update it.",
    ],
    nextSteps: () => [
      "Open the exported file with a tool that supports its format and verify the tables you need.",
    ],
  },
  "sheets.merge": {
    title: "Your Excel workbook merge is complete.",
    summary: (result) => [
      `ConsultChimps copied ${quantity(metric(result, "outputSheets"), "worksheet")} from ${quantity(metric(result, "inputFiles"), "Excel file")} into one workbook.`,
      `${quantity(metric(result, "hiddenSheets"), "source worksheet")} ${metric(result, "hiddenSheets") === 1 ? "was" : "were"} hidden.`,
      "Your original Excel files were not changed.",
    ],
    nextSteps: (vocabulary) => [
      `Open the new Excel workbook ${vocabulary.artifactListReference} and review the copied worksheets.`,
      "Keep the original workbooks until you have confirmed the merged workbook is complete.",
    ],
  },
  "sheets.consolidate": {
    title: "Your Excel consolidation is complete.",
    summary: (result) => {
      const lines = [
        `ConsultChimps read ${quantity(metric(result, "inputFiles"), "Excel file")} and combined ${quantity(metric(result, "inputTables"), "visible worksheet")}.`,
        `The finished workbook contains ${quantity(metric(result, "outputRows"), "data row")} arranged across ${quantity(metric(result, "outputColumns"), "column")}.`,
      ];
      // A column mapping folds source headers into canonical columns, so the
      // sentence below is reported only when one did; a plain consolidation
      // says nothing about it.
      if (metric(result, "unmappedColumns") > 0) {
        lines.push(
          `${quantity(metric(result, "unmappedColumns"), "column")} did not match the column mapping and ${metric(result, "unmappedColumns") === 1 ? "kept its own name" : "kept their own names"}; the warnings name ${metric(result, "unmappedColumns") === 1 ? "it" : "them"}.`,
        );
      }
      // Whether a draft was written is answered by the artifact, not by the
      // count: a run over headers that already agree drafts an empty mapping,
      // and a reader handed that file still needs to be told what it is and
      // that nothing was applied.
      if (hasMappingDraft(result)) {
        lines.push(
          metric(result, "suggestedColumns") === 0
            ? "It also drafted a column mapping. Every header was already spelled the same way, so the draft proposes no canonical columns."
            : `It also drafted a column mapping proposing ${quantity(metric(result, "suggestedColumns"), "canonical column")}, and applied none of them.`,
        );
      }
      lines.push("Your original Excel files were not changed.");
      return lines;
    },
    nextSteps: (vocabulary, result) => {
      const steps = [
        `Open the new Excel workbook ${vocabulary.artifactListReference} and review the consolidated worksheet.`,
        "Keep the source columns in the workbook if you need to trace a row back to its original file and worksheet.",
      ];
      if (hasMappingDraft(result)) {
        steps.push(
          `Review and edit the drafted column mapping ${vocabulary.artifactListReference} before you use it: a draft groups headers that are spelled differently, which is evidence rather than a decision, and nothing was applied for you.`,
        );
      }
      return steps;
    },
  },
  "sheets.split-by-column": {
    title: "Your Excel workbook split is complete.",
    summary: (result) => {
      const splitSummary = workbookSplitSummary(result);
      const lines = [
        `ConsultChimps read ${quantity(metric(result, "inputRows"), "data row")} from the source workbook.`,
        `It found ${quantity(metric(result, "groups"), "distinct group")} and created ${quantity(metric(result, "outputFiles"), "separate Excel workbook")}.`,
        `${quantity(metric(result, "outputRows"), "data row")} ${metric(result, "outputRows") === 1 ? "was" : "were"} retained across the new workbooks, and ${quantity(metric(result, "skippedRows"), "row")} ${metric(result, "skippedRows") === 1 ? "was" : "were"} skipped.`,
      ];
      if (Object.hasOwn(result.metrics, "sheetsFiltered")) {
        lines.push(
          `${quantity(metric(result, "sheetsFiltered"), "worksheet")} contained the split column and ${metric(result, "sheetsFiltered") === 1 ? "was" : "were"} filtered.`,
          `${quantity(metric(result, "sheetsCopiedUnchanged"), "worksheet")} did not contain the split column and ${metric(result, "sheetsCopiedUnchanged") === 1 ? "was" : "were"} copied unchanged.`,
          `Values-only mode was ${metric(result, "valuesOnly") === 1 ? "enabled" : "disabled"}.`,
        );
      }
      if (splitSummary) {
        lines.push(
          `Input workbook: ${splitSummary.input}`,
          `Split column: ${splitSummary.column}`,
          `Worksheets filtered: ${splitSummary.filteredSheets.join(", ")}`,
          `Worksheets copied unchanged: ${splitSummary.copiedUnchangedSheets.join(", ") || "None"}`,
          `Output directory: ${splitSummary.outputDirectory}`,
        );
      }
      lines.push("Your original Excel workbook was not changed.");
      return lines;
    },
    nextSteps: (vocabulary) => [
      `Open the new workbooks ${vocabulary.artifactListReference} and confirm that each file contains the expected group.`,
      "If rows were skipped, review the warning section to understand why.",
    ],
  },
  "pdf.split": {
    title: "Your PDF split is complete.",
    summary: (result) => [
      `ConsultChimps read ${quantity(metric(result, "pages"), "page")} from the source PDF.`,
      `It created ${quantity(metric(result, "outputFiles"), "separate PDF file")}, with one source page in each new file.`,
      "Your original PDF was not changed.",
    ],
    nextSteps: (vocabulary) => [
      `Open the new PDF files ${vocabulary.artifactListReference} and confirm that the pages are in the expected order.`,
      "The page number in each filename identifies its position in the original PDF.",
    ],
  },
  "pdf.merge": {
    title: "Your PDF merge is complete.",
    summary: (result) => [
      `ConsultChimps combined ${quantity(metric(result, "inputFiles"), "PDF file")} in the resolved input order.`,
      `The new PDF contains ${quantity(metric(result, "pages"), "page")}.`,
      "Your original PDF files were not changed.",
    ],
    nextSteps: (vocabulary) => [
      `Open the new PDF ${vocabulary.artifactListReference} and check that the documents appear in the intended order.`,
      "Keep the original PDFs until you have confirmed the merged file is complete.",
    ],
  },
  "pptx.populate": {
    title: "Your PowerPoint presentation is complete.",
    summary: (result) => [
      `ConsultChimps read ${quantity(metric(result, "inputRows"), "nonempty Excel record")} and created ${quantity(metric(result, "generatedSlides"), "populated slide")} in worksheet order.`,
      `It replaced ${quantity(metric(result, "replacements"), "placeholder occurrence")} across the generated slides.`,
      "Your source PowerPoint template and Excel workbook were not changed.",
    ],
    nextSteps: (vocabulary) => [
      `Open the new PowerPoint presentation ${vocabulary.artifactListReference} and review every generated slide.`,
      "Check longer replacement values for fit because this version does not shrink or truncate text automatically.",
    ],
  },
  // An inspection reads one slide and creates nothing, so its wording never
  // points at output files. Its warnings are the useful part: each one is a
  // reason a population would refuse the same template.
  "pptx.inspect-template": {
    title: "Your PowerPoint template inspection is complete.",
    summary: (result) => [
      `ConsultChimps found ${quantity(
        metric(result, "placeholderFields"),
        "distinct placeholder field",
      )} on the inspected template slide, used ${quantity(
        metric(result, "placeholderOccurrences"),
        "time",
      )} in total.`,
      "Nothing was created or changed. An inspection only reads the template.",
    ],
    // The counts are all this result carries: the placeholder names travel
    // beside it, in the inspection report itself. Saying "listed above" would
    // point at information this text does not contain, exactly when the reader
    // needs the exact spellings.
    nextSteps: (vocabulary) => [
      "Read the placeholder names from the inspection report that accompanies this result, and give the Excel workbook one column header for each, spelled exactly the same way.",
      "Review any warnings above before populating: each one is a reason the population would refuse this template.",
      vocabulary.powerPointExampleReference,
    ],
  },
  // A workbook inspection reads the file and creates nothing, so its wording
  // never points at output files. The counts are all this result carries: the
  // sheet names, headers, and sample values travel beside it in the
  // description, so the next steps send the reader there rather than "above".
  "sheets.inspect": {
    title: "Your Excel workbook inspection is complete.",
    summary: (result) => [
      `ConsultChimps described ${quantity(
        metric(result, "worksheets"),
        "worksheet",
      )}, holding ${quantity(
        metric(result, "headerColumns"),
        "column",
      )} and ${quantity(metric(result, "dataRows"), "data row")} in total.`,
      `It also found ${quantity(
        metric(result, "excelTables"),
        "Excel Table",
      )} and ${quantity(metric(result, "namedRanges"), "named range")}.`,
      "Nothing was created or changed. An inspection only reads the workbook.",
    ],
    nextSteps: (vocabulary) => [
      "Read the worksheet names, column headers, and sample values from the description that accompanies this result, and confirm they are the ones you expected before consolidating, merging, or splitting the workbook.",
      "Check the header row of every worksheet: a report title sitting above the real headers becomes the header row unless you name the correct one.",
      vocabulary.spreadsheetOptionsReference,
    ],
  },
  // Unprotect rewrites a copy of the workbook with the protection removed and
  // changes nothing else. Its two metrics carry the whole story, including the
  // case where there was nothing to remove: the workbook was already open.
  "sheets.unprotect": {
    title: "Your Excel workbook is unprotected.",
    summary: (result) => {
      const sheets = metric(result, "sheetProtectionsRemoved");
      const workbook = metric(result, "workbookProtectionsRemoved");
      const lines: string[] = [];
      if (sheets === 0 && workbook === 0) {
        lines.push(
          "ConsultChimps found no worksheet or workbook-structure protection to remove, so the new workbook is a copy of your file with nothing to unlock.",
        );
      } else {
        lines.push(
          `ConsultChimps removed protection from ${quantity(sheets, "worksheet")} and ${quantity(workbook, "workbook-structure lock")}.`,
        );
      }
      lines.push(
        "Formulas, formatting, hidden worksheets, and any macros were carried across unchanged.",
        "Your original Excel workbook was not changed.",
      );
      return lines;
    },
    nextSteps: (vocabulary) => [
      `Open the new Excel workbook ${vocabulary.artifactListReference} and confirm that you can edit the worksheets and workbook structure.`,
      "This removes ordinary worksheet and workbook-structure protection only; a workbook encrypted to require a password to open is not affected.",
    ],
  },
};

const metricLabels: Readonly<Record<string, string>> = {
  sourcesRead: "Source files with new captures",
  sourcesReused: "Source files with reused captures",
  rowsCaptured: "Source rows captured for review",
  conflicts: "Import conflicts requiring review",
  rowsImported: "Observations added to the database",
  rowsReused: "Observations reused without duplication",
  tablesCreated: "Database tables created",
  columnsAdded: "Database columns added",
  deliveriesRecorded: "Deliveries recorded",
  deliveriesReused: "Previously recorded deliveries reused",
  tablesConverted: "Database tables converted",
  rowsConverted: "Database rows converted",
  bytesWritten: "Bytes written to the exported database",
  capturesLinked: "Source captures linked to the delivery",
  dataRows: "Data rows described",
  excelTables: "Excel Tables found",
  generatedSlides: "PowerPoint slides generated",
  groups: "Distinct groups found",
  headerColumns: "Columns described across worksheets",
  hiddenSheets: "Hidden source worksheets copied",
  hiddenWorksheets: "Hidden worksheets described",
  inputFiles: "Input files read",
  namedRanges: "Named ranges found",
  inputRows: "Source data rows read",
  inputTables: "Visible worksheets combined",
  malformedPlaceholderLocations: "Locations with malformed placeholder braces",
  outputColumns: "Columns in the finished spreadsheet",
  outputFiles: "New files created",
  outputRows: "Data rows written",
  outputSheets: "Source worksheets copied",
  pages: "PDF pages processed",
  placeholderFields: "Distinct placeholder fields",
  placeholderOccurrences: "Placeholder occurrences per template slide",
  replacements: "Placeholder replacements made",
  skippedRows: "Rows skipped",
  rowsDeleted: "Rows deleted across output workbooks",
  sheetProtectionsRemoved: "Worksheet protections removed",
  sheetsCopiedUnchanged: "Worksheets copied without filtering",
  sheetsFiltered: "Worksheets filtered",
  suggestedColumns: "Canonical columns proposed in the drafted mapping",
  unmappedColumns: "Columns that did not match the column mapping",
  unsupportedPlacementPlaceholders:
    "Placeholders outside a supported text shape",
  unsupportedSplitRunPlaceholders: "Placeholders split across text runs",
  formulaCellsConverted: "Formula cells converted to cached values",
  formulaCellsWithoutCachedValues: "Formula cells missing cached values",
  valuesOnly: "Values-only mode (1 enabled, 0 disabled)",
  warnings: "Warnings reported",
  workbookProtectionsRemoved: "Workbook-structure protections removed",
  worksheets: "Worksheets described",
};

function artifactType(artifact: Artifact): string {
  if (artifact.mediaType === "application/vnd.sqlite3")
    return "SQLite database";
  if (artifact.mediaType === "application/vnd.duckdb") return "DuckDB database";
  if (artifact.mediaType === "application/vnd.consultchimps.import-plan")
    return "Private captured import plan";
  if (artifact.kind === "directory") {
    return "Folder";
  }
  if (
    artifact.mediaType ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    // A macro-enabled .xlsm output, which the unprotect and merge operations
    // can produce, is still an Excel workbook to a reader.
    artifact.mediaType === "application/vnd.ms-excel.sheet.macroEnabled.12"
  ) {
    return "Excel workbook";
  }
  if (artifact.mediaType === "application/pdf") {
    return "PDF document";
  }
  // The drafted column mapping is the only JSON document any operation
  // produces, so the label names it rather than saying "JSON file", which
  // would tell a non-technical reader nothing. Revisit when a second one
  // appears.
  if (artifact.mediaType === MAPPING_MEDIA_TYPE) {
    return "Column mapping file";
  }
  if (
    artifact.mediaType ===
    "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  ) {
    return "PowerPoint presentation";
  }
  return "File";
}

function genericExplanation(
  result: OperationResult,
  vocabulary: MessageVocabulary,
): OperationExplanation {
  return {
    title: "Your task is complete.",
    summary: () => [
      `ConsultChimps completed the "${result.operation}" operation successfully.`,
      `Review the detailed results and the files ${vocabulary.artifactListReference}.`,
    ],
    nextSteps: () => [
      `Open the files ${vocabulary.artifactListReference} and confirm that they contain the expected results.`,
    ],
  };
}

export function formatHumanResult<TMetric extends string>(
  result: OperationResult<TMetric>,
  options?: MessageFormatOptions,
): string {
  return renderResult(
    {
      ...result,
      metrics: result.metrics as Record<string, number>,
    },
    options?.vocabulary ?? GENERIC_VOCABULARY,
  );
}

function renderResult(
  result: OperationResult,
  vocabulary: MessageVocabulary,
): string {
  const explanation =
    operationExplanations[result.operation] ??
    genericExplanation(result, vocabulary);
  const lines = [
    "SUCCESS: ConsultChimps finished your task.",
    "",
    explanation.title,
    "",
    "What ConsultChimps did:",
    ...explanation.summary(result).map((line) => `  - ${line}`),
    "",
    "Detailed results:",
    ...Object.entries(result.metrics).map(
      ([name, value]) =>
        `  - ${metricLabels[name] ?? name}: ${formatNumber(value)}`,
    ),
    "",
    "Files created:",
  ];

  if (result.artifacts.length === 0) {
    lines.push(
      "  - No files were created. Review the result details above for more information.",
    );
  } else {
    result.artifacts.forEach((artifact, index) => {
      lines.push(
        `  ${index + 1}. ${artifact.path}`,
        `     Type: ${artifactType(artifact)}`,
      );
    });
  }

  lines.push("", "Warnings:");
  if (result.warnings.length === 0) {
    lines.push(
      "  - None. ConsultChimps did not detect any recoverable problems during this task.",
    );
  } else {
    lines.push(
      ...result.warnings.map((warning, index) => `  ${index + 1}. ${warning}`),
    );
  }

  lines.push(
    "",
    "What you can do next:",
    ...explanation.nextSteps(vocabulary, result).map((step) => `  - ${step}`),
    "",
  );

  return lines.join("\n");
}

function recoverySteps(
  code: string | undefined,
  vocabulary: MessageVocabulary,
): readonly string[] {
  if (code === "OPERATION_ABORTED") {
    return [
      "The task was cancelled before it finished; no source file was changed.",
      "Output files completed before the cancellation may remain. Review and remove them if they are not wanted.",
      vocabulary.retryWhenReady,
    ];
  }
  if (code === "DB_IMPORT_NEEDS_REVIEW" || code === "DB_STALE_IMPORT_PLAN") {
    return [
      "Inspect the saved import plan and its target database.",
      "Resolve the reported conflicts or refresh the plan against the current database before applying it.",
      "Keep the captured plan until the import has completed; it can contain data needed for review.",
    ];
  }
  if (code?.startsWith("DB_")) {
    return [
      "Check the database format, schema, and import options named in the message.",
      "Keep your source files and saved plan while correcting the problem.",
      vocabulary.examplesReference,
    ];
  }
  if (code === "FILES_NOT_FOUND") {
    return [
      "Check that every file or folder path is spelled correctly and still exists.",
      vocabulary.patternQuoting,
      vocabulary.inputFormatReference,
    ];
  }
  if (code === "FILES_OUTPUT_EXISTS") {
    return [
      vocabulary.retryAfterChoosingDifferentOutput,
      vocabulary.retryWithOverwrite,
      vocabulary.overwriteCaution,
    ];
  }
  if (code === "FILES_INPUT_OVERWRITE") {
    return [
      "Choose an output path that is different from every source file.",
      "ConsultChimps protects source files and will not replace an input file.",
    ];
  }
  if (code === "XLSX_NO_TABLES") {
    return [
      "Open the source workbooks and confirm that they contain at least one visible worksheet with data.",
      vocabulary.hiddenWorksheetOption,
    ];
  }
  // A mapping is checked and applied before anything is written, so every one
  // of these failures leaves the destination untouched. Saying so is the most
  // useful first sentence: it tells the reader nothing needs cleaning up
  // before they correct the mapping and try again.
  if (code?.startsWith("TABLE_MAPPING_") || code?.startsWith("XLSX_MAPPING_")) {
    return [
      "Nothing was created or changed: a column mapping is checked and applied before any output is written.",
      "Open the column mapping and check the canonical column names, the aliases listed under them, any declared coercions, and the column named in the message above.",
      vocabulary.spreadsheetOptionsReference,
    ];
  }
  if (code?.startsWith("XLSX_")) {
    return [
      `Check the workbook, worksheet, table, column name, and ${vocabulary.actionNoun} options mentioned in the message above.`,
      vocabulary.spreadsheetOptionsReference,
    ];
  }
  if (code?.startsWith("PDF_")) {
    return [
      "Confirm that every source file is a readable PDF and that the output location is available.",
      vocabulary.pdfOptionsReference,
    ];
  }
  if (code?.startsWith("PPTX_")) {
    return [
      "Check the PowerPoint template slide, placeholder spelling, Excel headers, and output path mentioned above.",
      vocabulary.inspectTemplateFirst,
      vocabulary.powerPointExampleReference,
    ];
  }
  return [
    `Read the message above and check the supplied files, folders, and ${vocabulary.actionNoun} options.`,
    vocabulary.examplesReference,
    "If the problem continues, keep the error reference below when asking for support.",
  ];
}

export function formatHumanError(
  message: string,
  code?: string,
  options?: MessageFormatOptions,
): string {
  const vocabulary = options?.vocabulary ?? GENERIC_VOCABULARY;
  return [
    "ERROR: ConsultChimps could not finish your task.",
    "",
    "What went wrong:",
    `  ${message}`,
    "",
    "What you can do:",
    ...recoverySteps(code, vocabulary).map((step) => `  - ${step}`),
    ...(code
      ? [
          "",
          "Error reference:",
          `  ${code}`,
          "  This reference can help a developer or support person identify the exact type of problem.",
        ]
      : []),
    "",
  ].join("\n");
}
