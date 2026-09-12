import { expect, test } from "vitest";

import { formatHumanError, formatHumanResult } from "../src/index.js";

test("a prepared import is described as private staging, not an applied import", () => {
  const text = formatHumanResult({
    operation: "db.prepare",
    artifacts: [
      {
        kind: "file",
        path: "review.ccplan",
        mediaType: "application/vnd.consultchimps.import-plan",
      },
    ],
    metrics: {
      rowsCaptured: 1250,
      conflicts: 1,
      sourcesRead: 1,
      sourcesReused: 1,
    },
    warnings: [],
  });
  expect(text).toContain("captured 1,250 source rows");
  expect(text).toContain("has not added these rows");
  expect(text).toContain("Private captured import plan");
  expect(text).toContain("Import conflicts requiring review: 1");
  expect(text).toContain("Source files with new captures: 1");
  expect(text).toContain("Source files with reused captures: 1");
  expect(text).not.toContain("rowsCaptured");
});

test("applied imports explain duplication and durable database changes", () => {
  const text = formatHumanResult({
    operation: "db.apply",
    artifacts: [],
    warnings: [],
    metrics: {
      rowsImported: 0,
      rowsReused: 300000,
      tablesCreated: 0,
      deliveriesRecorded: 1,
    },
  });
  expect(text).toContain("reused 300,000 previously imported observations");
  expect(text).toContain(
    "Committed changes are stored in the working database",
  );
  expect(text).toContain("original workbooks were not changed");
});

test.each(["application/vnd.sqlite3", "application/vnd.duckdb"])(
  "database output labels identify %s",
  (mediaType) => {
    const text = formatHumanResult({
      operation: "db.export",
      artifacts: [{ kind: "file", path: "copy.db", mediaType }],
      warnings: [],
      metrics: {
        tablesConverted: 2,
        rowsConverted: 1250,
        bytesWritten: 4096,
      },
    });
    expect(text).toContain(
      mediaType.endsWith("sqlite3") ? "SQLite database" : "DuckDB database",
    );
    expect(text).toContain("independent copy");
    expect(text).toContain("Database tables converted: 2");
    expect(text).toContain("Database rows converted: 1,250");
    expect(text).toContain("Bytes written to the exported database: 4,096");
    expect(text).not.toMatch(/tablesConverted|rowsConverted|bytesWritten/u);
  },
);

test("recorded deliveries use a plain-language capture metric", () => {
  const text = formatHumanResult({
    operation: "db.delivery.record",
    artifacts: [],
    warnings: [],
    metrics: { deliveriesRecorded: 1, deliveriesReused: 0, capturesLinked: 3 },
  });
  expect(text).toContain("Source captures linked to the delivery: 3");
  expect(text).not.toContain("capturesLinked");
});

test.each([
  "DB_STALE_IMPORT_PLAN",
  "DB_IMPORT_NEEDS_REVIEW",
  "DB_INVALID_SCHEMA",
])("database recovery keeps captured inputs for %s", (code) => {
  const text = formatHumanError("Review is required.", code);
  expect(text).toContain(code);
  expect(text).toMatch(/plan/i);
});
