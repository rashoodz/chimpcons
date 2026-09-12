import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, expect, test } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import * as XLSX from "xlsx";
import Sqlite from "better-sqlite3";
import JSZip from "jszip";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const directories: string[] = [];

async function directory(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), "cc-db-cli-test-"));
  directories.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((value) => rm(value, { recursive: true, force: true })),
  );
});

async function run(
  args: string[],
  cwd?: string,
): Promise<Record<string, unknown>> {
  const result = await execute(
    process.execPath,
    [cli, "--json", "db", ...args],
    { encoding: "utf8", cwd },
  );
  expect(result.stderr).toBe("");
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  const envelope: unknown = JSON.parse(result.stdout);
  expect(envelope).toMatchObject({ ok: true });
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    !("result" in envelope) ||
    envelope.result === null ||
    typeof envelope.result !== "object"
  )
    throw new Error("Missing command result.");
  return envelope.result as Record<string, unknown>;
}

async function runHuman(args: string[]): Promise<string> {
  const result = await execute(process.execPath, [cli, "db", ...args], {
    encoding: "utf8",
  });
  expect(result.stderr).toBe("");
  expect(result.stdout.trim()).not.toMatch(/^\{/u);
  return result.stdout;
}

async function runFailure(args: string[]): Promise<{
  readonly stdout: string;
  readonly stderr: string;
}> {
  try {
    await execute(process.execPath, [cli, ...args], { encoding: "utf8" });
  } catch (error) {
    if (
      error instanceof Error &&
      "stdout" in error &&
      typeof error.stdout === "string" &&
      "stderr" in error &&
      typeof error.stderr === "string"
    ) {
      return { stdout: error.stdout, stderr: error.stderr };
    }
    throw error;
  }
  throw new Error("The command unexpectedly succeeded.");
}

test.each([
  {
    option: "schema",
    args: (root: string, missing: string) => [
      "db",
      "create",
      "-o",
      path.join(root, "database.sqlite"),
      "--schema",
      missing,
    ],
  },
  {
    option: "recipe",
    args: (root: string, missing: string) => [
      "db",
      "resolve",
      path.join(root, "database.sqlite"),
      "--plan",
      path.join(root, "review.ccplan"),
      "--recipe",
      missing,
    ],
  },
  {
    option: "context",
    args: (root: string, missing: string) => [
      "db",
      "apply",
      path.join(root, "database.sqlite"),
      "--plan",
      path.join(root, "review.ccplan"),
      "--context",
      missing,
    ],
  },
])("missing $option documents have a stable JSON error", async ({ args }) => {
  const root = await directory();
  const missing = path.join(root, "private-configuration.json");
  const failure = await runFailure(["--json", ...args(root, missing)]);

  const expected = {
    ok: false,
    error: {
      code: "DB_DOCUMENT_UNREADABLE",
      message:
        "The JSON configuration file could not be opened. Check that it exists and that you can read it.",
    },
  };
  expect(JSON.parse(failure.stdout)).toEqual(expected);
  expect(JSON.parse(failure.stderr)).toEqual(expected);
  expect(failure.stdout).not.toContain("private-configuration.json");
  expect(failure.stderr).not.toContain("private-configuration.json");
  await expect(
    readFile(path.join(root, "database.sqlite")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("a missing database document has an actionable human error", async () => {
  const root = await directory();
  const missing = path.join(root, "private-configuration.json");
  const output = path.join(root, "database.sqlite");
  await writeFile(output, "existing output");
  const failure = await runFailure([
    "db",
    "create",
    "-o",
    output,
    "--schema",
    missing,
    "--force",
  ]);

  expect(failure.stdout).toBe("");
  expect(failure.stderr).toContain(
    "The JSON configuration file could not be opened. Check that it exists and that you can read it.",
  );
  expect(failure.stderr).toContain("DB_DOCUMENT_UNREADABLE");
  expect(failure.stderr).not.toContain("private-configuration.json");
  expect(await readFile(output, "utf8")).toBe("existing output");
});

test("an existing workbook path containing an equals sign remains a plain path", async () => {
  const root = await directory();
  const database = path.join(root, "inventory.sqlite");
  const source = "current=final.xlsx";
  await writeFile(path.join(root, source), workbook([["Name"], ["North"]]));
  await run(["create", "-o", database]);

  const imported = await run(["import", database, "--input", source], root);

  expect(imported["metrics"]).toMatchObject({ rowsImported: 1 });
  expect((await run(["inspect", database]))["tables"]).toEqual([
    expect.objectContaining({ name: "current_final", rowCount: "1" }),
  ]);
});

function workbook(
  rows: readonly (readonly (string | number | boolean)[])[],
): Uint8Array {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet(rows.map((row) => [...row])),
    "Inventory",
  );
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Uint8Array;
}

async function workbookWithInvalidNumericCell(): Promise<Uint8Array> {
  const archive = await JSZip.loadAsync(workbook([["Name"], ["North"]]));
  const worksheet = archive.file("xl/worksheets/sheet1.xml");
  if (!worksheet) throw new Error("The generated workbook has no worksheet.");
  const xml = await worksheet.async("string");
  const invalid = xml.replace(
    '<c r="A2" t="str"><v>North</v></c>',
    '<c r="A2"><v>not-a-number</v></c>',
  );
  if (invalid === xml)
    throw new Error("The generated workbook cell was not found.");
  archive.file("xl/worksheets/sheet1.xml", invalid);
  return archive.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

async function addUnsupportedObject(
  file: string,
  format: "sqlite" | "duckdb",
): Promise<void> {
  if (format === "sqlite") {
    const database = new Sqlite(file);
    try {
      database.exec("CREATE VIEW unsupported_view AS SELECT 1 AS value");
    } finally {
      database.close();
    }
    return;
  }

  const instance = await DuckDBInstance.create(file);
  const connection = await instance.connect();
  try {
    await connection.run("CREATE MACRO unsupported_macro(value) AS value + 1");
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

test("inspects an ordinary SQLite database without adopting or changing it", async () => {
  const root = await directory();
  const file = path.join(root, "external.sqlite");
  const external = new Sqlite(file);
  external.exec(
    "CREATE TABLE existing (name TEXT NOT NULL, count INTEGER); INSERT INTO existing VALUES ('Synthetic', 2)",
  );
  external.close();
  const before = await readFile(file);
  expect(await run(["inspect", file])).toMatchObject({
    kind: "unmanaged-database",
    format: "sqlite",
    tables: [
      {
        name: "existing",
        columns: [
          { name: "name", storageType: "TEXT", nullable: false },
          { name: "count", storageType: "INTEGER", nullable: true },
        ],
      },
    ],
  });
  expect(await readFile(file)).toEqual(before);
});

test("inspects a read-only saved plan without changing its journal mode or files", async () => {
  const root = await directory();
  const database = path.join(root, "inventory.sqlite");
  const source = path.join(root, "inventory.xlsx");
  const plan = path.join(root, "review.ccplan");
  await writeFile(source, workbook([["Name"], ["Synthetic"]]));
  await run(["create", "-o", database]);
  await run(["plan", database, "--input", source, "-o", plan]);
  const connection = new Sqlite(plan);
  try {
    connection.pragma("journal_mode = DELETE");
  } finally {
    connection.close();
  }
  const before = await readFile(plan);
  const files = (await readdir(root)).sort();
  await chmod(plan, 0o444);
  try {
    expect((await run(["inspect", plan]))["capturedRows"]).toBe("1");
    expect(await readFile(plan)).toEqual(before);
    expect((await readdir(root)).sort()).toEqual(files);
  } finally {
    await chmod(plan, 0o644);
  }
});

test("renders database review commands as labeled prose while JSON stays structured", async () => {
  const root = await directory();
  const database = path.join(root, "inventory.sqlite");
  const source = path.join(root, "inventory.xlsx");
  const plan = path.join(root, "review.ccplan");
  const context = path.join(root, "delivery.json");
  const schema = path.join(root, "schema.json");
  await writeFile(
    source,
    workbook([
      ["Name"],
      ...Array.from({ length: 25 }, (_, index) => [`Region ${index + 1}`]),
    ]),
  );
  await writeFile(
    context,
    JSON.stringify({ label: "Synthetic delivery", scope: { kind: "full" } }),
  );
  await run(["create", "-o", database]);
  await run(["plan", database, "--input", `inventory=${source}`, "-o", plan]);

  const planInspection = await runHuman(["inspect", plan, "--limit", "25"]);
  expect(planInspection).toContain("Saved import plan inspection");
  expect(planInspection).toContain("Rows newly captured in this plan: 25");
  expect(planInspection).toContain("Bounded row preview:");
  expect(planInspection).toContain('Name="Region 1"');
  expect(planInspection).toContain("source row 26");
  expect(planInspection).toContain("Selection key:");
  expect(planInspection).toContain("Capture ID:");
  expect(planInspection).toContain("captured in this plan");
  expect(planInspection).toContain("Column mappings: Name -> Name (text)");
  expect(planInspection).toContain(
    'Confirm the inferred schema for new table "inventory"',
  );
  expect(planInspection).not.toContain("inferred-schema");
  expect(planInspection).toContain(
    "Safety: This inspection did not change captured rows, routes, or decisions.",
  );
  expect(planInspection).not.toContain('"capturedRows"');

  const firstPreview = await run(["inspect", plan, "--limit", "20"]);
  const nextCursor = firstPreview["nextCursor"];
  if (typeof nextCursor !== "string") {
    throw new Error("The first preview page did not return a cursor.");
  }
  const firstPreviewText = await runHuman(["inspect", plan, "--limit", "20"]);
  expect(firstPreviewText).toContain("More preview rows are available.");
  const secondPreviewText = await runHuman([
    "inspect",
    plan,
    "--limit",
    "20",
    "--cursor",
    nextCursor,
  ]);
  expect(secondPreviewText).toContain("source row 26");
  expect(secondPreviewText).not.toContain("source row 2:");

  const resolution = await runHuman(["resolve", database, "--plan", plan]);
  expect(resolution).toContain("Saved import plan resolution");
  expect(resolution).toContain("Status: Ready");
  expect(resolution).toContain("No accepted database rows were changed.");
  expect(resolution).not.toContain('"planRevision"');

  const applied = await run([
    "apply",
    database,
    "--plan",
    plan,
    "--context",
    context,
    "--request-id",
    "synthetic-delivery",
  ]);
  const captureIds = applied["captureIds"];
  if (!Array.isArray(captureIds) || typeof captureIds[0] !== "string") {
    throw new Error("The import did not report its capture ID.");
  }
  const deliveryConnection = new Sqlite(database);
  try {
    const insertDelivery = deliveryConnection.prepare(
      "INSERT INTO _consultchimps_delivery_events VALUES (?, ?, ?)",
    );
    const insertMembership = deliveryConnection.prepare(
      "INSERT INTO _consultchimps_delivery_memberships VALUES (?, ?)",
    );
    for (let index = 2; index <= 25; index += 1) {
      const id = `DEL-${index.toString().padStart(6, "0")}`;
      const deliveryContext =
        index === 2
          ? {
              label: "Selected region delivery",
              scope: { kind: "partial", description: "Selected regions" },
            }
          : index === 3
            ? {
                label: "Changed records delivery",
                effectiveDate: "2026-09-01",
                receivedDate: "2026-09-02",
                scope: { kind: "changes", baseline: "August delivery" },
                attributes: { reportedRows: 25 },
              }
            : { label: `Synthetic delivery ${index}`, scope: { kind: "full" } };
      insertDelivery.run(
        id,
        `synthetic-delivery-${index}`,
        JSON.stringify(deliveryContext),
      );
      insertMembership.run(id, captureIds[0]);
    }
  } finally {
    deliveryConnection.close();
  }
  const databaseInspection = await runHuman(["inspect", database]);
  expect(databaseInspection).toContain("Database inspection");
  expect(databaseInspection).toContain("Recorded deliveries: 25");
  expect(databaseInspection).toContain(
    "Safety: This inspection did not change database tables or stored data.",
  );
  expect(databaseInspection).not.toContain('"completedImports"');

  const deliveries = await runHuman(["deliveries", database, "--limit", "25"]);
  expect(deliveries).toContain("Delivery history");
  expect(deliveries).toContain("Synthetic delivery");
  expect(deliveries).toContain("DEL-000025");
  expect(deliveries).toContain("Scope: Partial, Selected regions");
  expect(deliveries).toContain("Scope: Changes since August delivery");
  expect(deliveries).toContain("Effective date: 2026-09-01");
  expect(deliveries).toContain("Received date: 2026-09-02");
  expect(deliveries).toContain("Reported attributes: reportedRows=25");
  expect(deliveries).toContain(`Capture IDs: ${captureIds[0]}`);
  expect(deliveries).not.toContain('"captureIds"');

  await writeFile(
    schema,
    JSON.stringify({
      version: 1,
      tables: [
        {
          name: "inventory",
          recordId: { prefix: "I", padding: 6 },
          columns: [{ name: "Name", type: "integer" }],
        },
        {
          name: "reviews",
          recordId: { prefix: "RVW", separator: ":", padding: 4 },
          columns: [
            { name: "inventory_id", type: "text", nullable: false },
            { name: "score", type: "integer" },
          ],
          foreignKeys: [
            { column: "inventory_id", referencesTable: "inventory" },
          ],
        },
      ],
    }),
  );

  const schemaReview = await runHuman([
    "schema",
    "apply",
    database,
    "--file",
    schema,
    "--dry-run",
  ]);
  expect(schemaReview).toContain("Database schema review");
  expect(schemaReview).toContain(
    'Column "Name" in table "inventory" is text, but the proposed schema declares integer.',
  );
  expect(schemaReview).toContain('Create table "reviews"');
  expect(schemaReview).toContain(
    'Record IDs: prefix "RVW", separator ":", padding 4',
  );
  expect(schemaReview).toContain("inventory_id text required");
  expect(schemaReview).toContain("score integer optional");
  expect(schemaReview).toContain("inventory_id -> inventory.record_id");
  expect(schemaReview).not.toContain("column-type");
  expect(schemaReview).toContain("Safety: This dry run did not change");
  expect(schemaReview).not.toContain('"schemaFingerprint"');

  const exportReview = await runHuman([
    "export",
    database,
    "-o",
    path.join(root, "converted.duckdb"),
    "--format",
    "duckdb",
    "--dry-run",
  ]);
  expect(exportReview).toContain("Database export review");
  expect(exportReview).toContain("Source format: SQLite");
  expect(exportReview).toContain(
    "Safety: This dry run did not create or replace an output file.",
  );
  expect(exportReview).not.toContain('"sourceFormat"');

  const jsonInspection = await run(["inspect", plan]);
  expect(jsonInspection).toMatchObject({
    capturedRows: "25",
    prepared: { state: "ready" },
  });
});

for (const format of ["sqlite", "duckdb"] as const) {
  test(`${format}: applies ready plans read-only and reopens unresolved plans for resolution`, async () => {
    const root = await directory();
    const database = path.join(root, `inventory.${format}`);
    const readySource = path.join(root, "ready.xlsx");
    const readyRecipe = path.join(root, "ready.json");
    const readyPlan = path.join(root, "ready.ccplan");
    await writeFile(readySource, workbook([["Name"], ["North"]]));
    await writeFile(
      readyRecipe,
      JSON.stringify({
        version: 1,
        routes: [
          {
            source: "ready",
            selection: JSON.stringify({
              sheet: "Inventory",
              headerRow: 1,
            }),
            destination: {
              kind: "new-table",
              schema: {
                name: "ready",
                recordId: { prefix: "RDY", padding: 4 },
                columns: [{ name: "name", type: "text" }],
              },
            },
            columns: [{ source: "Name", target: "name", type: "text" }],
          },
        ],
      }),
    );
    await run(["create", "-o", database, "--format", format]);
    await run([
      "plan",
      database,
      "--input",
      `ready=${readySource}`,
      "--recipe",
      readyRecipe,
      "-o",
      readyPlan,
    ]);
    expect(await run(["inspect", readyPlan])).toMatchObject({
      prepared: { state: "ready" },
    });

    const readyConnection = new Sqlite(readyPlan);
    try {
      readyConnection.pragma("journal_mode = DELETE");
    } finally {
      readyConnection.close();
    }
    const planBefore = await readFile(readyPlan);
    const filesBefore = (await readdir(root)).sort();
    await chmod(readyPlan, 0o444);
    try {
      const applied = await run(["apply", database, "--plan", readyPlan]);
      expect(applied["metrics"]).toMatchObject({ rowsImported: 1 });
      expect(await readFile(readyPlan)).toEqual(planBefore);
      expect((await readdir(root)).sort()).toEqual(filesBefore);
    } finally {
      await chmod(readyPlan, 0o644);
    }

    const unresolvedSource = path.join(root, "unresolved.xlsx");
    const unresolvedPlan = path.join(root, "unresolved.ccplan");
    await writeFile(unresolvedSource, workbook([["Name"], ["South"]]));
    await run([
      "plan",
      database,
      "--input",
      `unresolved=${unresolvedSource}`,
      "-o",
      unresolvedPlan,
    ]);
    expect(await run(["inspect", unresolvedPlan])).toMatchObject({
      prepared: { state: "needs-review" },
    });

    const resolved = await run(["apply", database, "--plan", unresolvedPlan]);
    expect(resolved["metrics"]).toMatchObject({ rowsImported: 1 });
    expect(await run(["inspect", unresolvedPlan])).toMatchObject({
      prepared: { state: "ready" },
    });
    expect((await run(["inspect", database]))["tables"]).toEqual([
      expect.objectContaining({ name: "ready", rowCount: "1" }),
      expect.objectContaining({ name: "unresolved", rowCount: "1" }),
    ]);
  });

  test(`${format}: dry-run reviews conversion without reserving or changing output files`, async () => {
    const root = await directory();
    const source = path.join(root, `source.${format}`);
    const targetFormat = format === "sqlite" ? "duckdb" : "sqlite";
    const output = path.join(root, `existing.${targetFormat}`);
    const sentinel = Buffer.from("existing destination");
    await run(["create", "-o", source, "--format", format]);
    if (format === "sqlite") {
      const database = new Sqlite(source);
      try {
        database.pragma("journal_mode = DELETE");
      } finally {
        database.close();
      }
    }

    const sourceBeforeAliasReview = await readFile(source);
    const filesBeforeAliasReview = (await readdir(root)).sort();
    const aliasPlan = await run([
      "export",
      source,
      "-o",
      source,
      "--format",
      format,
      "--dry-run",
    ]);
    expect(aliasPlan).toMatchObject({
      sourceFormat: format,
      targetFormat: format,
      state: "ready",
    });
    expect(await readFile(source)).toEqual(sourceBeforeAliasReview);
    expect((await readdir(root)).sort()).toEqual(filesBeforeAliasReview);

    await writeFile(output, sentinel);
    const sourceBeforeConversionReview = await readFile(source);
    const filesBeforeConversionReview = (await readdir(root)).sort();
    const conversionPlan = await run([
      "export",
      source,
      "-o",
      output,
      "--format",
      targetFormat,
      "--dry-run",
    ]);
    expect(conversionPlan).toMatchObject({
      sourceFormat: format,
      targetFormat,
      state: "ready",
      issues: [],
    });
    expect(await readFile(source)).toEqual(sourceBeforeConversionReview);
    expect(await readFile(output)).toEqual(sentinel);
    expect((await readdir(root)).sort()).toEqual(filesBeforeConversionReview);

    const publicationFailure = await runFailure([
      "--json",
      "db",
      "export",
      source,
      "-o",
      output,
      "--format",
      targetFormat,
    ]);
    expect(publicationFailure.stdout).toContain("OUTPUT_EXISTS");
    expect(await readFile(source)).toEqual(sourceBeforeConversionReview);
    expect(await readFile(output)).toEqual(sentinel);
    expect((await readdir(root)).sort()).toEqual(filesBeforeConversionReview);

    const conflict = await runFailure([
      "--json",
      "db",
      "export",
      source,
      "-o",
      output,
      "--format",
      format,
      "--dry-run",
    ]);
    expect(conflict.stdout).toContain("DB_FORMAT_CONFLICT");
    expect(await readFile(source)).toEqual(sourceBeforeConversionReview);
    expect(await readFile(output)).toEqual(sentinel);
    expect((await readdir(root)).sort()).toEqual(filesBeforeConversionReview);

    await addUnsupportedObject(source, format);
    const sourceBeforeUnsupportedReview = await readFile(source);
    const filesBeforeUnsupportedReview = (await readdir(root)).sort();
    const unsupportedPlan = await run([
      "export",
      source,
      "-o",
      output,
      "--format",
      targetFormat,
      "--dry-run",
    ]);
    expect(unsupportedPlan).toMatchObject({
      sourceFormat: format,
      targetFormat,
      state: "unsupported",
      issues: [
        expect.objectContaining({
          kind: "unsupported-object",
          name: format === "sqlite" ? "unsupported_view" : "unsupported_macro",
        }),
      ],
    });
    expect(await readFile(source)).toEqual(sourceBeforeUnsupportedReview);
    expect(await readFile(output)).toEqual(sentinel);
    expect((await readdir(root)).sort()).toEqual(filesBeforeUnsupportedReview);
  });

  test(`${format}: previews reused captures from the target database without Excel`, async () => {
    const root = await directory();
    const database = path.join(root, `inventory.${format}`);
    const source = path.join(root, "inventory.xlsx");
    const plan = path.join(root, "duplicate.ccplan");
    await writeFile(source, workbook([["Name"], ["North"], ["South"]]));
    await run(["create", "-o", database]);
    await run(["import", database, "--input", source]);
    await run(["plan", database, "--input", source, "-o", plan]);
    await rm(source);

    const offline = await run(["inspect", plan]);
    expect(offline["previewWarnings"]).toEqual([
      expect.objectContaining({ code: "DB_PREVIEW_DATABASE_REQUIRED" }),
    ]);
    const preview = await run(["inspect", plan, "--database", database]);
    expect(preview["examples"]).toEqual([
      expect.objectContaining({
        sourceRow: 2,
        values: { Name: { kind: "string", value: "North" } },
      }),
      expect.objectContaining({
        sourceRow: 3,
        values: { Name: { kind: "string", value: "South" } },
      }),
    ]);
    expect(preview["previewWarnings"]).toEqual([]);
  });

  test(`${format}: re-reviews a stale saved plan without returning to Excel`, async () => {
    const root = await directory();
    const database = path.join(root, `inventory.${format}`);
    const source = path.join(root, "inventory.xlsx");
    const firstPlan = path.join(root, "first.ccplan");
    const secondPlan = path.join(root, "second.ccplan");
    await run(["create", "-o", database]);
    await writeFile(source, workbook([["Name"], ["North"]]));
    await run([
      "plan",
      database,
      "--input",
      `first=${source}`,
      "-o",
      firstPlan,
    ]);
    await writeFile(source, workbook([["Name"], ["South"]]));
    await run([
      "plan",
      database,
      "--input",
      `second=${source}`,
      "-o",
      secondPlan,
    ]);
    await rm(source);
    await run(["apply", database, "--plan", firstPlan]);
    await expect(
      execute(process.execPath, [
        cli,
        "--json",
        "db",
        "apply",
        database,
        "--plan",
        secondPlan,
      ]),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining("DB_STALE_IMPORT_PLAN"),
    });
    await run(["resolve", database, "--plan", secondPlan]);
    const applied = await run(["apply", database, "--plan", secondPlan]);
    expect(applied["metrics"]).toMatchObject({ rowsImported: 1 });
    expect((await run(["inspect", database]))["tables"]).toEqual([
      expect.objectContaining({ name: "first", rowCount: "1" }),
      expect.objectContaining({ name: "second", rowCount: "1" }),
    ]);
    const retried = await run(["apply", database, "--plan", secondPlan]);
    expect(retried["captureIds"]).toEqual(applied["captureIds"]);
    expect(retried["metrics"]).toMatchObject({
      rowsImported: 0,
      rowsReused: 1,
    });
  });

  test(`${format}: create, prepare, remove Excel, apply, and reopen through built CLI`, async () => {
    const root = await directory();
    const database = path.join(root, `inventory.${format}`);
    const source = path.join(root, "inventory.xlsx");
    const prepared = path.join(root, "review.ccplan");
    await writeFile(
      source,
      workbook([
        ["Dataset", "Attributes", "CDE"],
        ["North", 12, true],
        ["South", 9, false],
      ]),
    );
    await run(["create", "-o", database, "--format", format]);
    const plan = await run([
      "plan",
      database,
      "--input",
      `inventory=${source}`,
      "-o",
      prepared,
    ]);
    expect(plan["metrics"]).toMatchObject({ rowsCaptured: 2 });
    const preview = await run(["inspect", prepared]);
    expect(preview["capturedRows"]).toBe("2");
    const renamedPlan = path.join(root, "renamed-plan.sqlite");
    await copyFile(prepared, renamedPlan);
    expect((await run(["inspect", renamedPlan]))["capturedRows"]).toBe("2");
    await rm(source);
    const applied = await run(["apply", database, "--plan", prepared]);
    expect(applied["metrics"]).toMatchObject({ rowsImported: 2 });
    const inspected = await run(["inspect", database]);
    expect(inspected["format"]).toBe(format);
    expect(inspected["tables"]).toEqual([
      expect.objectContaining({ rowCount: "2" }),
    ]);
    const retried = await run(["apply", database, "--plan", prepared]);
    expect(retried["metrics"]).toMatchObject({ rowsImported: 0 });
  });

  test(`${format}: identical renamed workbook adds no observations`, async () => {
    const root = await directory();
    const database = path.join(root, `inventory.${format}`);
    const source = path.join(root, "first.xlsx");
    const renamed = path.join(root, "renamed.xlsx");
    await writeFile(source, workbook([["Name"], ["Synthetic dataset"]]));
    await copyFile(source, renamed);
    const original = await readFile(source);
    await run(["create", "-o", database]);
    await run(["import", database, "--input", `inventory=${source}`]);
    const repeated = await run([
      "import",
      database,
      "--input",
      `inventory=${renamed}`,
    ]);
    expect(repeated["metrics"]).toMatchObject({ rowsImported: 0 });
    const inspected = await run(["inspect", database]);
    expect(inspected["tables"]).toEqual([
      expect.objectContaining({ rowCount: "1" }),
    ]);
    expect(await readFile(source)).toEqual(original);
    expect(await readFile(renamed)).toEqual(original);
  });

  test(`${format}: changed submissions append, delivery retries are distinct from content, and conversion retains history`, async () => {
    const root = await directory();
    const database = path.join(root, `inventory.${format}`);
    const targetFormat = format === "sqlite" ? "duckdb" : "sqlite";
    const converted = path.join(root, `converted.${targetFormat}`);
    const source = path.join(root, "submission.xlsx");
    const recipe = path.join(root, "recipe.json");
    const context = path.join(root, "delivery.json");
    const schema = path.join(root, "schema.json");
    await writeFile(
      schema,
      JSON.stringify({
        version: 1,
        tables: [
          {
            name: "datasets",
            recordId: { prefix: "DS", padding: 4 },
            columns: [{ name: "name", type: "text" }],
          },
        ],
      }),
    );
    await writeFile(
      recipe,
      JSON.stringify({
        version: 1,
        routes: [
          {
            source: "inventory",
            selection: JSON.stringify({ sheet: "Inventory", headerRow: 1 }),
            destination: { kind: "existing-table", table: "datasets" },
            columns: [{ source: "Name", target: "name", type: "text" }],
          },
        ],
      }),
    );
    await writeFile(
      context,
      JSON.stringify({
        label: "Synthetic partial submission",
        scope: { kind: "partial", description: "Selected records" },
        attributes: { reportedCount: 9 },
      }),
    );
    await writeFile(source, workbook([["Name"], ["North"]]));
    await run(["create", "-o", database, "--schema", schema]);
    const first = await run([
      "import",
      database,
      "--input",
      `inventory=${source}`,
      "--recipe",
      recipe,
      "--context",
      context,
      "--request-id",
      "submission-a",
    ]);
    await writeFile(source, workbook([["Name"], ["North revised"], ["South"]]));
    const second = await run([
      "import",
      database,
      "--input",
      `inventory=${source}`,
      "--recipe",
      recipe,
      "--context",
      context,
      "--request-id",
      "submission-b",
    ]);
    expect(first["metrics"]).toMatchObject({ rowsImported: 1 });
    expect(second["metrics"]).toMatchObject({ rowsImported: 2 });
    const captures = second["captureIds"];
    if (!Array.isArray(captures) || typeof captures[0] !== "string")
      throw new Error("Import did not report its capture.");
    const deliveryArguments = [
      "delivery",
      "record",
      database,
      "--capture",
      captures[0],
      "--context",
      context,
      "--request-id",
      "submission-c",
    ];
    const delivered = await run(deliveryArguments);
    expect(delivered["metrics"]).toMatchObject({ deliveriesRecorded: 1 });
    const retried = await run(deliveryArguments);
    expect(retried["metrics"]).toMatchObject({ deliveriesRecorded: 0 });
    const before = await run(["inspect", database]);
    expect(before["tables"]).toEqual([
      expect.objectContaining({ name: "datasets", rowCount: "3" }),
    ]);
    expect(before["deliveries"]).toBe("3");
    await run(["export", database, "-o", converted]);
    const after = await run(["inspect", converted]);
    expect(after["format"]).toBe(targetFormat);
    expect(after["tables"]).toEqual(before["tables"]);
    expect(after["captures"]).toBe(before["captures"]);
    expect(await run(["deliveries", converted])).toEqual(
      await run(["deliveries", database]),
    );
  });
}

test("db help describes source-safe persistence and format choices", async () => {
  for (const args of [
    ["--help"],
    ["db", "--help"],
    ["db", "create", "--help"],
    ["db", "plan", "--help"],
  ]) {
    const result = await execute(process.execPath, [cli, ...args], {
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("consultchimps");
    if (args[1] === "plan")
      expect(result.stdout).toMatch(/existing paths are used as\s+written/u);
  }
});

test("a create format mismatch fails before producing a database", async () => {
  const root = await directory();
  const output = path.join(root, "inventory.sqlite");
  await expect(
    execute(process.execPath, [
      cli,
      "--json",
      "db",
      "create",
      "-o",
      output,
      "--format",
      "duckdb",
    ]),
  ).rejects.toMatchObject({
    code: 1,
    stdout: expect.stringContaining("DB_FORMAT_CONFLICT"),
  });
  await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
});

test("one recipe can select several distinct regions in the same workbook", async () => {
  const root = await directory();
  const database = path.join(root, "inventory.duckdb");
  const source = path.join(root, "inventory.xlsx");
  const recipe = path.join(root, "recipe.json");
  const plan = path.join(root, "regions.ccplan");
  await writeFile(
    source,
    workbook([
      ["Left", "Right"],
      ["North", "South"],
    ]),
  );
  await writeFile(
    recipe,
    JSON.stringify({
      version: 1,
      routes: [
        {
          source: "inventory",
          selection: JSON.stringify({ range: "Inventory!A1:A2" }),
          destination: {
            kind: "new-table-infer",
            name: "left_side",
            recordId: { prefix: "L", padding: 4 },
          },
          columns: [],
        },
        {
          source: "inventory",
          selection: JSON.stringify({ range: "Inventory!B1:B2" }),
          destination: {
            kind: "new-table-infer",
            name: "right_side",
            recordId: { prefix: "R", padding: 4 },
          },
          columns: [],
        },
      ],
    }),
  );
  await run(["create", "-o", database]);
  await run([
    "plan",
    database,
    "--input",
    `inventory=${source}`,
    "--recipe",
    recipe,
    "-o",
    plan,
  ]);
  await rm(source);
  await run(["apply", database, "--plan", plan]);
  expect((await run(["inspect", database]))["tables"]).toEqual([
    expect.objectContaining({ name: "left_side", rowCount: "1" }),
    expect.objectContaining({ name: "right_side", rowCount: "1" }),
  ]);
});

test("a replacement recipe excludes routes it omits", async () => {
  const root = await directory();
  const database = path.join(root, "routes.sqlite");
  const source = path.join(root, "routes.xlsx");
  const initialRecipe = path.join(root, "initial.json");
  const replacementRecipe = path.join(root, "replacement.json");
  const plan = path.join(root, "routes.ccplan");
  const selection = (column: string) =>
    JSON.stringify({ range: `Inventory!${column}1:${column}2` });
  const route = (column: "A" | "B", table: string) => ({
    source: "inventory",
    selection: selection(column),
    destination: {
      kind: "new-table",
      schema: {
        name: table,
        recordId: { prefix: column, padding: 4 },
        columns: [{ name: "value", type: "text" }],
      },
    },
    columns: [
      {
        source: column === "A" ? "Left" : "Right",
        target: "value",
        type: "text",
      },
    ],
  });
  const left = route("A", "left_side");
  const right = route("B", "right_side");
  const unavailable = {
    ...route("B", "unavailable"),
    source: "missing",
  };
  await writeFile(
    source,
    workbook([
      ["Left", "Right"],
      ["North", "South"],
    ]),
  );
  await writeFile(
    initialRecipe,
    JSON.stringify({ version: 1, routes: [left, right, unavailable] }),
  );
  await writeFile(
    replacementRecipe,
    JSON.stringify({ version: 1, routes: [left] }),
  );
  await run(["create", "-o", database]);
  await run([
    "plan",
    database,
    "--input",
    `inventory=${source}`,
    "--recipe",
    initialRecipe,
    "-o",
    plan,
  ]);
  const resolved = await run([
    "resolve",
    database,
    "--plan",
    plan,
    "--recipe",
    replacementRecipe,
  ]);
  expect(resolved).toMatchObject({ state: "ready" });
  await rm(source);
  const applied = await run(["apply", database, "--plan", plan]);
  expect(applied["metrics"]).toMatchObject({ rowsImported: 1 });
  expect((await run(["inspect", database]))["tables"]).toEqual([
    expect.objectContaining({ name: "left_side", rowCount: "1" }),
  ]);
});

test("an empty replacement recipe excludes every captured route", async () => {
  const root = await directory();
  const database = path.join(root, "empty.sqlite");
  const source = path.join(root, "empty.xlsx");
  const initialRecipe = path.join(root, "initial.json");
  const replacementRecipe = path.join(root, "empty.json");
  const plan = path.join(root, "empty.ccplan");
  await writeFile(source, workbook([["Name"], ["North"]]));
  const selection = JSON.stringify({ sheet: "Inventory", headerRow: 1 });
  const destination = (name: string) => ({
    kind: "new-table-infer",
    name,
    recordId: { prefix: name.slice(0, 3).toUpperCase(), padding: 4 },
  });
  await writeFile(
    initialRecipe,
    JSON.stringify({
      version: 1,
      routes: [
        {
          source: "inventory",
          selection,
          destination: destination("inventory"),
          columns: [],
        },
        {
          source: "missing",
          selection: "Unavailable",
          destination: destination("unavailable"),
          columns: [],
        },
      ],
    }),
  );
  await writeFile(
    replacementRecipe,
    JSON.stringify({ version: 1, routes: [] }),
  );
  await run(["create", "-o", database]);
  await run([
    "plan",
    database,
    "--input",
    `inventory=${source}`,
    "--recipe",
    initialRecipe,
    "-o",
    plan,
  ]);
  const resolved = await run([
    "resolve",
    database,
    "--plan",
    plan,
    "--recipe",
    replacementRecipe,
  ]);
  expect(resolved).toMatchObject({ state: "ready" });
  const applied = await run(["apply", database, "--plan", plan]);
  expect(applied["metrics"]).toMatchObject({ rowsImported: 0 });
  expect((await run(["inspect", database]))["tables"]).toEqual([]);
});

test("forced plan replacement preserves the old plan until capture succeeds", async () => {
  const root = await directory();
  const database = path.join(root, "safe.sqlite");
  const source = path.join(root, "safe.xlsx");
  const plan = path.join(root, "safe.ccplan");
  await writeFile(source, workbook([["Name"], ["North"]]));
  await run(["create", "-o", database]);
  await run(["plan", database, "--input", `inventory=${source}`, "-o", plan]);
  const originalPlan = await readFile(plan);
  await writeFile(source, await workbookWithInvalidNumericCell());
  await expect(
    execute(process.execPath, [
      cli,
      "--json",
      "db",
      "plan",
      database,
      "--input",
      `inventory=${source}`,
      "-o",
      plan,
      "-f",
    ]),
  ).rejects.toMatchObject({
    code: 1,
    stdout: expect.stringContaining("XLSX_READ_FAILED"),
  });
  expect(await readFile(plan)).toEqual(originalPlan);
  expect((await run(["inspect", plan]))["capturedRows"]).toBe("1");
  expect(
    (await readdir(root)).filter((name) =>
      name.startsWith(`.${path.basename(plan)}.`),
    ),
  ).toEqual([]);

  const originalSource = await readFile(source);
  await expect(
    execute(process.execPath, [
      cli,
      "--json",
      "db",
      "plan",
      database,
      "--input",
      `inventory=${source}`,
      "-o",
      source,
      "-f",
    ]),
  ).rejects.toMatchObject({
    code: 1,
    stdout: expect.stringContaining("FILES_INPUT_OVERWRITE"),
  });
  expect(await readFile(source)).toEqual(originalSource);

  await writeFile(source, workbook([["Name"], ["North"], ["South"]]));
  await run([
    "plan",
    database,
    "--input",
    `inventory=${source}`,
    "-o",
    plan,
    "-f",
  ]);
  expect((await run(["inspect", plan]))["capturedRows"]).toBe("2");
});

test("a recipe naming an unavailable source fails instead of accepting an empty import", async () => {
  const root = await directory();
  const database = path.join(root, "inventory.sqlite");
  const source = path.join(root, "inventory.xlsx");
  const recipe = path.join(root, "recipe.json");
  await writeFile(source, workbook([["Name"], ["North"]]));
  await writeFile(
    recipe,
    JSON.stringify({
      version: 1,
      routes: [
        {
          source: "missing",
          selection: JSON.stringify({ sheet: "Inventory", headerRow: 1 }),
          destination: {
            kind: "new-table-infer",
            name: "datasets",
            recordId: { prefix: "DS", padding: 4 },
          },
          columns: [],
        },
      ],
    }),
  );
  await run(["create", "-o", database]);
  await expect(
    execute(process.execPath, [
      cli,
      "--json",
      "db",
      "import",
      database,
      "--input",
      `inventory=${source}`,
      "--recipe",
      recipe,
    ]),
  ).rejects.toMatchObject({
    code: 1,
    stdout: expect.stringContaining('"ok":false'),
  });
  expect((await run(["inspect", database]))["tables"]).toEqual([]);
});
