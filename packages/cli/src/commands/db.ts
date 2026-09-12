import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ConsultChimpsError,
  type OperationControlOptions,
  type OperationResult,
} from "@consultchimps/core";
import {
  applyImport,
  applySchema,
  draftImportRecipe,
  inspectDatabase,
  inspectImport,
  listDeliveries,
  parseDatabaseSchema,
  parseDeliveryContext,
  parseImportRecipe,
  planSchema,
  planConversion,
  prepareImport,
  recordDelivery,
  replaceImportRecipe,
  resolveImport,
  type DatabaseFormat,
  type PreparedImportRef,
  type ReadyImportRef,
} from "@consultchimps/db";
import {
  createDatabase,
  createPreparedImport,
  exportDatabase,
  inspectFileKind,
  openDatabase,
  openPreparedImport,
  prepareImportFile,
} from "@consultchimps/db/node";
import { planFilePublication } from "@consultchimps/files";
import { Option, type Command } from "commander";

import {
  openDbInputs,
  readDbDocument,
  type DbInputOptions,
} from "../db-inputs.js";
import {
  formatConversionPlan,
  formatDatabaseInspection,
  formatDeliveryPage,
  formatImportInspection,
  formatImportResolution,
  formatSchemaPlan,
} from "../db-report.js";
import { createCliProgress } from "../progress.js";
import { withoutTerminalControlsInProse } from "../text.js";

export interface DbCommandOutput {
  json(): boolean;
  result(value: OperationResult): void;
  data(value: unknown, humanText: string): void;
}

interface ImportOptions extends DbInputOptions {
  output?: string;
  recipe?: string;
  into?: string;
  force?: boolean;
  context?: string;
  requestId?: string;
}

function requireReady(
  prepared: PreparedImportRef | ReadyImportRef,
): ReadyImportRef {
  if (prepared.state !== "ready") {
    throw new ConsultChimpsError(
      "DB_IMPORT_NEEDS_REVIEW",
      "The import has unresolved table or column conflicts. Use db plan to save the captured data, db inspect to review it, and db resolve with a corrected recipe before applying.",
    );
  }
  return prepared;
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function chooseFormat(
  output: string,
  format?: string,
  fallback?: DatabaseFormat,
): DatabaseFormat {
  const extension = path.extname(output).toLowerCase();
  const inferred =
    extension === ".duckdb"
      ? "duckdb"
      : extension === ".sqlite" || extension === ".sqlite3"
        ? "sqlite"
        : undefined;
  if (format !== undefined && format !== "sqlite" && format !== "duckdb") {
    throw new ConsultChimpsError(
      "DB_INVALID_FORMAT",
      "Choose sqlite or duckdb as the database format.",
    );
  }
  if (format && inferred && inferred !== format) {
    throw new ConsultChimpsError(
      "DB_FORMAT_CONFLICT",
      "The filename extension and chosen database format disagree. Change one before retrying.",
    );
  }
  const selected = format ?? inferred ?? fallback;
  if (!selected)
    throw new ConsultChimpsError(
      "DB_FORMAT_REQUIRED",
      "Specify --format sqlite or --format duckdb when the filename does not identify its format.",
    );
  return selected;
}

async function withControls<T>(
  output: DbCommandOutput,
  work: (controls: OperationControlOptions) => Promise<T>,
): Promise<T> {
  const progress = createCliProgress(output.json());
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  process.once("SIGINT", cancel);
  try {
    return await work({
      signal: controller.signal,
      onProgress: progress.report,
    });
  } finally {
    process.removeListener("SIGINT", cancel);
    progress.finish();
  }
}

function sources(command: Command): Command {
  return command
    .requiredOption(
      "--input <source>",
      "workbook path or alias=path; existing paths are used as written",
      collect,
    )
    .option(
      "--recipe <file>",
      "versioned JSON table routing and column mapping",
    )
    .option("--sheet <name>", "select one worksheet from one workbook")
    .option("--table <name>", "select one named Excel Table")
    .option(
      "--range <reference>",
      "select one named range or worksheet A1 rectangle",
    )
    .option(
      "--header-row <number>",
      "worksheet header row, starting at 1",
      Number,
      1,
    )
    .option("--hidden", "include hidden worksheets in default sheet selection")
    .option("--into <table>", "destination name for one selected region");
}

async function prepare(
  databasePath: string,
  options: ImportOptions,
  output: DbCommandOutput,
  apply: boolean,
): Promise<void> {
  await withControls(output, async (controls) => {
    const delivery = options.context
      ? parseDeliveryContext(await readDbDocument(options.context))
      : undefined;
    const database = await openDatabase({ path: databasePath });
    let temporary: string | undefined;
    try {
      const suppliedRecipe = options.recipe
        ? parseImportRecipe(await readDbDocument(options.recipe))
        : undefined;
      const inputs = await openDbInputs(options, controls, suppliedRecipe);
      try {
        const sourceList = inputs.workbooks.map((workbook) => workbook.source);
        const recipe =
          suppliedRecipe ??
          (await draftImportRecipe({
            sources: sourceList,
            into: options.into,
          }));
        const inspected = await inspectDatabase({ database });
        if (!options.output)
          temporary = await mkdtemp(path.join(tmpdir(), "cc-import-plan-"));
        const planPath =
          options.output ?? path.join(temporary ?? "", "review.ccplan");
        const protectedInputPaths = [
          ...inputs.paths,
          ...(options.recipe ? [options.recipe] : []),
          ...(options.context ? [options.context] : []),
        ];
        if (!apply) {
          const outcome = await prepareImportFile({
            path: planPath,
            database,
            sources: sourceList,
            recipe,
            baselineRevision: inspected.revision,
            overwrite: options.force,
            protectedInputPaths,
            ...controls,
          });
          output.result(outcome.result);
          if (!output.json())
            process.stdout.write(
              "Review this plan with db inspect, then apply it with db apply. The captured plan can contain source values; keep it private.\n",
            );
          return;
        }
        const prepared = await createPreparedImport({
          path: planPath,
          database,
          recipe,
          baselineRevision: inspected.revision,
          overwrite: options.force,
          protectedInputPaths,
        });
        try {
          const outcome = await prepareImport({
            database,
            prepared,
            sources: sourceList,
            recipe,
            ...controls,
          });
          const approved = requireReady(
            outcome.prepared.state === "ready"
              ? outcome.prepared
              : await resolveImport({ database, prepared, decisions: [] }),
          );
          output.result(
            await applyImport({
              database,
              prepared,
              approved,
              requestId: options.requestId ?? prepared.id,
              delivery,
              ...controls,
            }),
          );
        } finally {
          await prepared.close();
        }
      } finally {
        await inputs.close();
      }
    } finally {
      await database.close();
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
  });
}

export function registerDbCommands(
  program: Command,
  output: DbCommandOutput,
): void {
  const db = program
    .command("db")
    .description(
      "Create persistent local databases, manage schemas, and import workbook submissions",
    )
    .addHelpText(
      "after",
      "\nStart with: consultchimps db create -o inventory.duckdb\nThen: consultchimps db plan inventory.duckdb --input inventory.xlsx -o review.ccplan\nReview: consultchimps db inspect review.ccplan\nApply: consultchimps db apply inventory.duckdb --plan review.ccplan\n",
    );

  db.command("create")
    .description("Create a persistent SQLite or DuckDB file")
    .requiredOption("-o, --output <file>", "new database file")
    .addOption(
      new Option("--format <format>", "database storage format").choices([
        "sqlite",
        "duckdb",
      ]),
    )
    .option("--schema <file>", "versioned JSON table definitions")
    .option("-f, --force", "allow replacement of an existing output")
    .addHelpText(
      "after",
      "\nExample: consultchimps db create -o inventory.sqlite --schema schema.json\n",
    )
    .action(
      async (options: {
        output: string;
        format?: string;
        schema?: string;
        force?: boolean;
      }) => {
        const schema = options.schema
          ? parseDatabaseSchema(await readDbDocument(options.schema))
          : undefined;
        await planFilePublication({
          output: options.output,
          inputs: options.schema ? [options.schema] : [],
          overwrite: options.force,
        });
        const created = await createDatabase({
          path: options.output,
          format: chooseFormat(options.output, options.format),
          schema,
          overwrite: options.force,
        });
        try {
          output.result(created.result);
        } finally {
          await created.database.close();
        }
      },
    );

  db.command("inspect")
    .description(
      "Inspect a database or saved import plan without reading Excel",
    )
    .argument("<file>", "database or .ccplan file")
    .option("--limit <number>", "maximum preview rows", Number, 20)
    .option(
      "--cursor <cursor>",
      "preview cursor returned by a prior saved-plan inspection",
    )
    .option(
      "--database <file>",
      "target database containing reused rows for a saved-plan preview",
    )
    .action(
      async (
        file: string,
        options: { limit: number; cursor?: string; database?: string },
      ) => {
        const kind = await inspectFileKind({ path: file });
        if (kind.kind === "unmanaged-database") {
          if (output.json()) output.data(kind, "");
          else {
            process.stdout.write(
              `${kind.format === "duckdb" ? "DuckDB" : "SQLite"} database, read-only inspection\nThis file has no ConsultChimps import history. No tables or metadata were added.\n`,
            );
            for (const table of kind.tables)
              process.stdout.write(
                `${withoutTerminalControlsInProse(table.name)}: ${table.columns.length} columns\n`,
              );
            process.stdout.write(
              "Create a separate ConsultChimps database for managed imports.\n",
            );
          }
        } else if (kind.kind === "prepared-import") {
          const prepared = await openPreparedImport({
            path: file,
            readonly: true,
          });
          try {
            const database =
              options.database === undefined
                ? undefined
                : await openDatabase({
                    path: options.database,
                    readonly: true,
                  });
            try {
              const inspection = await inspectImport({
                database,
                prepared,
                page: { limit: options.limit, cursor: options.cursor },
              });
              output.data(inspection, formatImportInspection(inspection));
            } finally {
              await database?.close();
            }
          } finally {
            await prepared.close();
          }
        } else {
          const database = await openDatabase({ path: file, readonly: true });
          try {
            const inspection = await inspectDatabase({ database });
            output.data(inspection, formatDatabaseInspection(inspection));
          } finally {
            await database.close();
          }
        }
      },
    );

  db.command("schema")
    .description("Manage database table definitions")
    .command("apply")
    .description("Review or apply additive schema changes")
    .argument("<database>")
    .requiredOption("--file <schema>", "versioned JSON schema")
    .option("--dry-run", "report proposed changes without applying them")
    .action(
      async (
        databasePath: string,
        options: { file: string; dryRun?: boolean },
      ) => {
        const schema = parseDatabaseSchema(await readDbDocument(options.file));
        const database = await openDatabase({
          path: databasePath,
          readonly: options.dryRun === true,
        });
        try {
          const plan = await planSchema({ database, schema });
          if (options.dryRun) output.data(plan, formatSchemaPlan(plan));
          else output.result(await applySchema({ database, plan }));
        } finally {
          await database.close();
        }
      },
    );

  sources(
    db
      .command("plan")
      .description(
        "Capture workbook data into a durable, reviewable import plan",
      )
      .argument("<database>"),
  )
    .requiredOption("-o, --output <file>", "private .ccplan staging artifact")
    .option("-f, --force", "allow replacing an existing plan output")
    .action((database: string, options: ImportOptions) =>
      prepare(database, options, output, false),
    );

  sources(
    db
      .command("import")
      .description("Prepare and apply an explicit import recipe")
      .argument("<database>"),
  )
    .option(
      "--context <file>",
      "delivery label, scope, and reported attributes as JSON",
    )
    .option("--request-id <id>", "retry key for this application")
    .action((database: string, options: ImportOptions) =>
      prepare(database, options, output, true),
    );

  db.command("apply")
    .description("Approve and apply a reviewed saved import plan")
    .argument("<database>")
    .requiredOption("--plan <file>", "saved .ccplan artifact")
    .option("--context <file>", "delivery context JSON")
    .option("--request-id <id>", "retry key for this application")
    .action(
      async (
        databasePath: string,
        options: { plan: string; context?: string; requestId?: string },
      ) => {
        await withControls(output, async (controls) => {
          const delivery = options.context
            ? parseDeliveryContext(await readDbDocument(options.context))
            : undefined;
          const database = await openDatabase({ path: databasePath });
          try {
            let prepared = await openPreparedImport({
              path: options.plan,
              readonly: true,
            });
            try {
              let review = await inspectImport({
                database,
                prepared,
                page: { limit: 1 },
              });
              if (review.prepared.state !== "ready") {
                await prepared.close();
                prepared = await openPreparedImport({ path: options.plan });
                review = await inspectImport({
                  database,
                  prepared,
                  page: { limit: 1 },
                });
              }
              const approved = requireReady(
                review.prepared.state === "ready"
                  ? review.prepared
                  : await resolveImport({
                      database,
                      prepared,
                      decisions: [],
                    }),
              );
              output.result(
                await applyImport({
                  database,
                  prepared,
                  approved,
                  delivery,
                  requestId: options.requestId ?? prepared.id,
                  ...controls,
                }),
              );
            } finally {
              await prepared.close();
            }
          } finally {
            await database.close();
          }
        });
      },
    );

  db.command("resolve")
    .description("Update a saved plan's table routing and column mapping")
    .argument("<database>")
    .requiredOption("--plan <file>", "saved .ccplan artifact")
    .option(
      "--recipe <file>",
      "replacement import recipe; omitted routes stop table loading; omit this option to re-review captured data",
    )
    .action(
      async (
        databasePath: string,
        options: { plan: string; recipe?: string },
      ) => {
        const recipe = options.recipe
          ? parseImportRecipe(await readDbDocument(options.recipe))
          : undefined;
        const database = await openDatabase({ path: databasePath });
        try {
          const prepared = await openPreparedImport({ path: options.plan });
          try {
            const resolved =
              recipe === undefined
                ? await resolveImport({
                    database,
                    prepared,
                    decisions: [],
                    rebase: true,
                  })
                : await replaceImportRecipe({
                    database,
                    prepared,
                    recipe,
                    rebase: true,
                  });
            output.data(resolved, formatImportResolution(resolved));
          } finally {
            await prepared.close();
          }
        } finally {
          await database.close();
        }
      },
    );

  db.command("deliveries")
    .description("List recorded deliveries and their source captures")
    .argument("<database>")
    .option("--limit <number>", "maximum deliveries", Number, 50)
    .option("--cursor <cursor>", "pagination cursor from a prior response")
    .action(
      async (
        databasePath: string,
        options: { limit: number; cursor?: string },
      ) => {
        const database = await openDatabase({
          path: databasePath,
          readonly: true,
        });
        try {
          const deliveries = await listDeliveries({ database, ...options });
          output.data(deliveries, formatDeliveryPage(deliveries));
        } finally {
          await database.close();
        }
      },
    );

  db.command("delivery")
    .description("Record a delivery without importing row values again")
    .command("record")
    .description("Associate an intentional new delivery with existing captures")
    .argument("<database>")
    .requiredOption(
      "--capture <id>",
      "capture ID, repeat for additional captures",
      collect,
    )
    .requiredOption("--context <file>", "delivery context JSON")
    .requiredOption(
      "--request-id <id>",
      "stable key used to retry this delivery safely",
    )
    .action(
      async (
        databasePath: string,
        options: { capture: string[]; context: string; requestId: string },
      ) => {
        const context = parseDeliveryContext(
          await readDbDocument(options.context),
        );
        const database = await openDatabase({ path: databasePath });
        try {
          output.result(
            await recordDelivery({
              database,
              captureIds: options.capture,
              context,
              requestId: options.requestId,
            }),
          );
        } finally {
          await database.close();
        }
      },
    );

  db.command("export")
    .description(
      "Create a validated database copy or convert its storage format",
    )
    .argument("<database>")
    .requiredOption("-o, --output <file>", "independent database output file")
    .addOption(
      new Option("--format <format>", "output storage format").choices([
        "sqlite",
        "duckdb",
      ]),
    )
    .option(
      "--dry-run",
      "review format changes and unsupported objects without writing",
    )
    .option("-f, --force", "allow replacing an existing output")
    .addHelpText(
      "after",
      "\nExample: consultchimps db export inventory.sqlite -o inventory.duckdb\nReview first: consultchimps db export inventory.sqlite -o inventory.duckdb --dry-run\n",
    )
    .action(
      async (
        databasePath: string,
        options: {
          output: string;
          format?: string;
          dryRun?: boolean;
          force?: boolean;
        },
      ) => {
        if (options.dryRun !== true) {
          await planFilePublication({
            output: options.output,
            inputs: [databasePath],
            overwrite: options.force,
          });
        }
        await withControls(output, async (controls) => {
          const database = await openDatabase({
            path: databasePath,
            readonly: options.dryRun === true,
          });
          try {
            const format = chooseFormat(
              options.output,
              options.format,
              database.format,
            );
            if (options.dryRun) {
              const plan = await planConversion({ database, format });
              output.data(plan, formatConversionPlan(plan));
            } else
              output.result(
                await exportDatabase({
                  database,
                  output: options.output,
                  format,
                  overwrite: options.force,
                  ...controls,
                }),
              );
          } finally {
            await database.close();
          }
        });
      },
    );
}
