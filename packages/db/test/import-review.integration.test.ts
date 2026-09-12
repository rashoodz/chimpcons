import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { engineOf, inspectDatabase } from "../src/database.js";
import { inspectImport } from "../src/import/inspection.js";
import {
  applyImport,
  prepareImport,
  resolveImport,
} from "../src/import/operations.js";
import { inspectAppliedImportPlan } from "../src/import/history.js";
import type {
  ImportCell,
  ImportRecipe,
  ImportSource,
} from "../src/import/types.js";
import {
  APPLICATION_TABLE,
  CAPTURE_ROW_TABLE,
  CAPTURE_TABLE,
  DELIVERY_MEMBERSHIP_TABLE,
} from "../src/metadata.js";
import {
  createDatabase,
  createPreparedImport,
  openPreparedImport,
} from "../src/node.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function source(
  selections: Readonly<
    Record<
      string,
      readonly Readonly<{
        sourceRow: number;
        cells: Record<string, ImportCell>;
      }>[]
    >
  >,
): ImportSource {
  const bytes = new TextEncoder().encode(JSON.stringify(selections));
  return {
    key: "submission",
    readerVersion: "synthetic-review-1",
    bytes: {
      name: "submission.xlsx",
      size: bytes.byteLength,
      async readAt(offset, length) {
        return bytes.slice(offset, offset + length);
      },
    },
    selections: Object.entries(selections).map(([key, rows]) => ({
      key,
      label: key,
      async open() {
        return {
          columns: [...new Set(rows.flatMap((row) => Object.keys(row.cells)))],
          async *batches() {
            yield rows;
          },
          async close() {},
        };
      },
    })),
  };
}

async function fixture(format: "sqlite" | "duckdb", recipe: ImportRecipe) {
  const directory = await mkdtemp(path.join(tmpdir(), "cc-import-review-"));
  directories.push(directory);
  const { database } = await createDatabase({
    path: path.join(directory, `workspace.${format}`),
    format,
  });
  const planPath = path.join(directory, "review.ccplan");
  const prepared = await createPreparedImport({
    path: planPath,
    database,
    recipe,
    baselineRevision: 0n,
  });
  return { database, prepared, planPath };
}

for (const format of ["sqlite", "duckdb"] as const) {
  for (const mode of ["inferred", "explicit"] as const) {
    test(`${format}: ${mode} dates retain source granularity through saved review and apply`, async () => {
      const columns = [
        { name: "DayOnly", type: "date" as const },
        { name: "CachedDay", type: "date" as const },
        { name: "Mixed", type: "timestamp" as const },
        { name: "Midnight", type: "timestamp" as const },
      ];
      const recipe: ImportRecipe = {
        version: 1,
        routes: [
          {
            source: "submission",
            selection: "Dates",
            destination:
              mode === "inferred"
                ? {
                    kind: "new-table-infer",
                    name: "Dates",
                    recordId: { prefix: "DAT", padding: 6 },
                  }
                : {
                    kind: "new-table",
                    schema: {
                      name: "Dates",
                      columns,
                      recordId: { prefix: "DAT", padding: 6 },
                    },
                  },
            columns:
              mode === "inferred"
                ? []
                : columns.map(({ name, type }) => ({
                    source: name,
                    target: name,
                    type,
                  })),
          },
        ],
      };
      const { database, prepared, planPath } = await fixture(format, recipe);
      const day: ImportCell = {
        kind: "date",
        raw: " 2024-01-02 ",
        iso: "2024-01-02T00:00:00.000Z",
      };
      const midnight: ImportCell = {
        kind: "date",
        raw: "2024-01-02T00:00:00Z",
        iso: "2024-01-02T00:00:00.000Z",
      };
      const submission = source({
        Dates: [
          {
            sourceRow: 2,
            cells: {
              DayOnly: day,
              CachedDay: { kind: "formula", formula: "TODAY()", cached: day },
              Mixed: { kind: "date", raw: "45293", iso: "2024-01-02" },
              Midnight: midnight,
            },
          },
          {
            sourceRow: 3,
            cells: {
              DayOnly: day,
              CachedDay: { kind: "formula", formula: "TODAY()", cached: day },
              Mixed: {
                kind: "date",
                raw: "2024-01-02T03:04:05Z",
                iso: "2024-01-02T03:04:05.000Z",
              },
              Midnight: midnight,
            },
          },
        ],
      });
      try {
        await prepareImport({
          database,
          prepared,
          recipe,
          sources: [submission],
        });
      } finally {
        await prepared.close();
      }
      const reopened = await openPreparedImport({ path: planPath });
      try {
        const approved = await resolveImport({
          database,
          prepared: reopened,
          decisions: [],
        });
        expect(approved.state).toBe("ready");
        if (approved.state !== "ready") throw new Error("Date plan not ready");
        await applyImport({
          database,
          prepared: reopened,
          approved,
          requestId: `${format}-${mode}-dates`,
        });
        const table = (await inspectDatabase({ database })).tables.find(
          ({ name }) => name === "Dates",
        );
        expect(
          table?.schema.columns.map(({ name, type }) => ({ name, type })),
        ).toEqual(columns);
        const values = await engineOf(database).query(
          'SELECT "DayOnly", "CachedDay", CAST("Mixed" AS VARCHAR) AS mixed, CAST("Midnight" AS VARCHAR) AS midnight FROM "Dates" ORDER BY record_id',
        );
        expect(values).toHaveLength(2);
        for (const row of values) {
          expect(row["DayOnly"]).toBe("2024-01-02");
          expect(row["CachedDay"]).toBe("2024-01-02");
          expect(String(row["midnight"]).replace(" ", "T")).toMatch(
            /^2024-01-02T00:00:00/u,
          );
        }
        expect(String(values[0]?.["mixed"]).replace(" ", "T")).toMatch(
          /^2024-01-02T00:00:00/u,
        );
        expect(String(values[1]?.["mixed"]).replace(" ", "T")).toMatch(
          /^2024-01-02T03:04:05/u,
        );
      } finally {
        await reopened.close();
        await database.close();
      }
    });
  }
  test(`${format}: existing table names use their registered spelling through apply and audit`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cc-import-case-"));
    directories.push(directory);
    const { database } = await createDatabase({
      path: path.join(directory, `workspace.${format}`),
      format,
      schema: {
        version: 1,
        tables: [
          {
            name: "Sales",
            columns: [{ name: "Value", type: "text", nullable: false }],
            recordId: { prefix: "SAL", padding: 6 },
          },
        ],
      },
    });
    const recipe: ImportRecipe = {
      version: 1,
      routes: [
        {
          source: "submission",
          selection: "Data",
          destination: { kind: "existing-table", table: "sales" },
          columns: [{ source: "Value", target: "Value", type: "text" }],
        },
      ],
    };
    const prepared = await createPreparedImport({
      path: path.join(directory, "review.ccplan"),
      database,
      recipe,
      baselineRevision: (await inspectDatabase({ database })).revision,
    });
    const submission = source({
      Data: [
        {
          sourceRow: 2,
          cells: { Value: { kind: "string", value: "North" } },
        },
      ],
    });
    try {
      const outcome = await prepareImport({
        database,
        prepared,
        recipe,
        sources: [submission],
      });
      expect(outcome.prepared.state).toBe("ready");
      await expect(
        resolveImport({
          database,
          prepared,
          decisions: [
            {
              kind: "exclude",
              source: "submission",
              selection: "Dtaa",
              reason: "Typo in the selection key",
            },
          ],
        }),
      ).rejects.toMatchObject({ code: "DB_IMPORT_DECISION_NOT_FOUND" });
      const resolved = await resolveImport({
        database,
        prepared,
        decisions: [
          {
            kind: "route",
            source: "submission",
            selection: "Data",
            destination: { kind: "existing-table", table: "sales" },
            columns: [{ source: "Value", target: "Value", type: "text" }],
          },
        ],
      });
      expect(resolved.state).toBe("ready");
      if (resolved.state !== "ready") throw new Error("Plan not ready");
      await applyImport({
        database,
        prepared,
        approved: resolved,
        requestId: `${format}-canonical-table`,
      });
      expect(
        await engineOf(database).query('SELECT count(*) AS count FROM "Sales"'),
      ).toEqual([{ count: 1n }]);
      const saved = await inspectAppliedImportPlan({
        database,
        planId: resolved.id,
        planRevision: resolved.planRevision,
      });
      expect(saved?.recipe.routes[0]?.destination).toEqual({
        kind: "existing-table",
        table: "Sales",
      });
      expect(saved?.decisions[0]).toMatchObject({
        kind: "route",
        destination: { kind: "existing-table", table: "sales" },
      });

      const replayRecipe: ImportRecipe = {
        version: 1,
        routes: [
          {
            source: "submission",
            selection: "Data",
            destination: {
              kind: "new-table",
              schema: {
                name: "sales",
                columns: [{ name: "Value", type: "text", nullable: false }],
                recordId: { prefix: "SAL", padding: 6 },
              },
            },
            columns: [{ source: "Value", target: "Value", type: "text" }],
          },
        ],
      };
      const replay = await createPreparedImport({
        path: path.join(directory, "replay.ccplan"),
        database,
        recipe: replayRecipe,
        baselineRevision: (await inspectDatabase({ database })).revision,
      });
      try {
        const replayed = await prepareImport({
          database,
          prepared: replay,
          recipe: replayRecipe,
          sources: [submission],
        });
        expect(replayed.prepared.state).toBe("ready");
        expect(replayed.result.metrics).toMatchObject({
          sourcesReused: 1,
          rowsCaptured: 0,
        });
        if (replayed.prepared.state !== "ready") {
          throw new Error("Replay plan not ready");
        }
        const replayResult = await applyImport({
          database,
          prepared: replay,
          approved: replayed.prepared,
          requestId: `${format}-canonical-table-replay`,
        });
        expect(replayResult.metrics).toMatchObject({
          rowsImported: 0,
          rowsReused: 1,
          tablesCreated: 0,
        });
        expect(await inspectDatabase({ database })).toMatchObject({
          completedImports: 1n,
          tables: [{ name: "Sales", rowCount: 1n }],
        });
        expect(
          (
            await inspectAppliedImportPlan({
              database,
              planId: replayed.prepared.id,
              planRevision: replayed.prepared.planRevision,
            })
          )?.recipe.routes[0]?.destination,
        ).toMatchObject({
          kind: "new-table",
          schema: { name: "Sales" },
        });
      } finally {
        await replay.close();
      }
    } finally {
      await prepared.close();
      await database.close();
    }
  });

  test(`${format}: a recipe route without a captured selection requires review`, async () => {
    const recipe: ImportRecipe = {
      version: 1,
      routes: [
        {
          source: "unknown-source",
          selection: "Unknown",
          destination: {
            kind: "new-table",
            schema: {
              name: "Unknown",
              columns: [{ name: "Value", type: "text" }],
              recordId: { prefix: "UNK", padding: 6 },
            },
          },
          columns: [{ source: "Value", target: "Value", type: "text" }],
        },
      ],
    };
    const { database, prepared, planPath } = await fixture(format, recipe);
    try {
      const outcome = await prepareImport({
        database,
        prepared,
        recipe,
        sources: [
          source({
            Data: [
              {
                sourceRow: 2,
                cells: { Value: { kind: "string", value: "North" } },
              },
            ],
          }),
        ],
      });
      expect(outcome.prepared.state).toBe("needs-review");
      expect(
        (await inspectImport({ prepared, page: { limit: 10 } })).conflicts,
      ).toContainEqual({
        kind: "source-selection-not-found",
        source: "unknown-source",
        selection: "Unknown",
      });
      expect(
        await resolveImport({ database, prepared, decisions: [] }),
      ).toMatchObject({ state: "needs-review" });
      expect(
        (await inspectImport({ prepared, page: { limit: 10 } })).conflicts,
      ).toEqual(
        expect.arrayContaining([
          {
            kind: "source-selection-not-found",
            source: "unknown-source",
            selection: "Unknown",
          },
          {
            kind: "missing-destination",
            source: "submission",
            selection: "Data",
          },
        ]),
      );
      const reopened = await openPreparedImport({ path: planPath });
      try {
        expect(
          (await inspectImport({ prepared: reopened, page: { limit: 10 } }))
            .conflicts,
        ).toContainEqual({
          kind: "source-selection-not-found",
          source: "unknown-source",
          selection: "Unknown",
        });
      } finally {
        await reopened.close();
      }
      await expect(
        resolveImport({
          database,
          prepared,
          decisions: [
            {
              kind: "exclude",
              source: "unknown-source",
              selection: "Unknown",
              reason: "The recipe entry does not belong to this source",
            },
            {
              kind: "exclude",
              source: "submission",
              selection: "Data",
              reason: "This captured selection is intentionally omitted",
            },
          ],
        }),
      ).resolves.toMatchObject({ state: "ready" });
      expect((await inspectDatabase({ database })).tables).toEqual([]);
    } finally {
      await prepared.close();
      await database.close();
    }
  });

  test(`${format}: exclusion skips table loading and retains delivery evidence`, async () => {
    const recipe: ImportRecipe = {
      version: 1,
      routes: [
        {
          source: "submission",
          selection: "Inventory",
          destination: {
            kind: "new-table",
            schema: {
              name: "Inventory",
              columns: [{ name: "Value", type: "text" }],
              recordId: { prefix: "INV", padding: 6 },
            },
          },
          columns: [{ source: "Value", target: "Value", type: "text" }],
        },
      ],
    };
    const { database, prepared } = await fixture(format, recipe);
    try {
      const preparedOutcome = await prepareImport({
        database,
        prepared,
        recipe,
        sources: [
          source({
            Inventory: [
              {
                sourceRow: 2,
                cells: { Value: { kind: "string", value: "North" } },
              },
            ],
          }),
        ],
      });
      expect(preparedOutcome.prepared.state).toBe("ready");
      const resolved = await resolveImport({
        database,
        prepared,
        decisions: [
          {
            kind: "exclude",
            source: "submission",
            selection: "Inventory",
            reason: "Keep as received evidence without loading a table",
          },
        ],
      });
      expect(resolved.state).toBe("ready");
      if (resolved.state !== "ready") throw new Error("Plan not ready");
      const applied = await applyImport({
        database,
        prepared,
        approved: resolved,
        requestId: `${format}-excluded-selection`,
        delivery: { label: "Inventory delivery", scope: { kind: "full" } },
      });
      expect(applied.metrics.rowsImported).toBe(0);
      expect(applied.importIds).toEqual([]);
      expect(applied.captureIds).toHaveLength(1);

      const engine = engineOf(database);
      await expect(
        engine.query(`SELECT count(*) AS count FROM ${APPLICATION_TABLE}`),
      ).resolves.toEqual([{ count: 0n }]);
      for (const table of [
        CAPTURE_TABLE,
        CAPTURE_ROW_TABLE,
        DELIVERY_MEMBERSHIP_TABLE,
      ]) {
        await expect(
          engine.query(`SELECT count(*) AS count FROM ${table}`),
        ).resolves.toEqual([{ count: 1n }]);
      }
      expect(await inspectDatabase({ database })).toMatchObject({
        tables: [],
        captures: 1n,
        completedImports: 0n,
        deliveries: 1n,
      });
      expect(
        await inspectAppliedImportPlan({
          database,
          planId: resolved.id,
          planRevision: resolved.planRevision,
        }),
      ).toMatchObject({
        recipe: { routes: [] },
        decisions: [
          {
            kind: "exclude",
            source: "submission",
            selection: "Inventory",
          },
        ],
        bindings: [{ captureId: applied.captureIds[0] }],
      });
    } finally {
      await prepared.close();
      await database.close();
    }
  });

  test(`${format}: mapping and value errors block readiness before apply`, async () => {
    const recipe: ImportRecipe = {
      version: 1,
      routes: [
        {
          source: "submission",
          selection: "Data",
          destination: {
            kind: "new-table",
            schema: {
              name: "Data",
              columns: [
                { name: "Amount", type: "integer", nullable: false },
                { name: "Required", type: "text", nullable: false },
                { name: "Extra", type: "text" },
              ],
              recordId: { prefix: "DAT", padding: 6 },
              foreignKeys: [],
            },
          },
          columns: [
            { source: "Amount", target: "Amount", type: "integer" },
            { source: "Missing", target: "Required", type: "text" },
            { source: "amount", target: "Extra", type: "text" },
          ],
        },
      ],
    };
    const { database, prepared } = await fixture(format, recipe);
    try {
      const outcome = await prepareImport({
        database,
        prepared,
        recipe,
        sources: [
          source({
            Data: [
              {
                sourceRow: 2,
                cells: {
                  Amount: { kind: "string", value: "not a number" },
                  Missing: { kind: "blank" },
                },
              },
            ],
          }),
        ],
      });
      expect(outcome.prepared.state).toBe("needs-review");
      expect(outcome.result.metrics.conflicts).toBe(3);
      const resolved = await resolveImport({
        database,
        prepared,
        decisions: [],
      });
      expect(resolved.state).toBe("needs-review");
    } finally {
      await prepared.close();
      await database.close();
    }
  });

  test(`${format}: related new tables apply in foreign-key order`, async () => {
    const parentSchema = {
      name: "Parents",
      columns: [{ name: "Name", type: "text", nullable: false }],
      recordId: { prefix: "PAR", padding: 6 },
      foreignKeys: [],
    } as const;
    const childSchema = {
      name: "Children",
      columns: [{ name: "ParentId", type: "text", nullable: false }],
      recordId: { prefix: "CHI", padding: 6 },
      foreignKeys: [{ column: "ParentId", referencesTable: "Parents" }],
    } as const;
    const recipe: ImportRecipe = {
      version: 1,
      routes: [
        {
          source: "submission",
          selection: "Children",
          destination: { kind: "new-table", schema: childSchema },
          columns: [{ source: "ParentId", target: "ParentId", type: "text" }],
        },
        {
          source: "submission",
          selection: "Parents",
          destination: { kind: "new-table", schema: parentSchema },
          columns: [{ source: "Name", target: "Name", type: "text" }],
        },
      ],
    };
    const { database, prepared } = await fixture(format, recipe);
    try {
      const outcome = await prepareImport({
        database,
        prepared,
        recipe,
        sources: [
          source({
            Children: [
              {
                sourceRow: 2,
                cells: { ParentId: { kind: "string", value: "PAR-000001" } },
              },
            ],
            Parents: [
              {
                sourceRow: 2,
                cells: { Name: { kind: "string", value: "Parent A" } },
              },
            ],
          }),
        ],
      });
      expect(outcome.prepared.state).toBe("ready");
      if (outcome.prepared.state !== "ready") throw new Error("Plan not ready");
      await applyImport({
        database,
        prepared,
        approved: outcome.prepared,
        requestId: `${format}-connected-tables`,
      });
      const inspection = await inspectDatabase({ database });
      expect(
        inspection.tables.map(({ name, rowCount }) => [name, rowCount]),
      ).toEqual([
        ["Children", 1n],
        ["Parents", 1n],
      ]);
      expect(inspection.appliedImportPlans).toBe(1n);
      const saved = await inspectAppliedImportPlan({
        database,
        planId: outcome.prepared.id,
        planRevision: outcome.prepared.planRevision,
      });
      expect(saved).toMatchObject({
        state: "applied",
        recipe,
        conflicts: [],
        bindings: [
          {
            source: "submission",
            displayName: "submission.xlsx",
            selection: "Children",
            label: "Children",
          },
          {
            source: "submission",
            displayName: "submission.xlsx",
            selection: "Parents",
            label: "Parents",
          },
        ],
      });
    } finally {
      await prepared.close();
      await database.close();
    }
  });

  test.each([
    { parentId: "PAR-000001", expectedState: "ready" },
    { parentId: "PAR-000002", expectedState: "needs-review" },
  ] as const)(
    `${format}: duplicate aliases reserve parent records once for $parentId`,
    async ({ parentId, expectedState }) => {
      const parentSchema = {
        name: "Parents",
        columns: [{ name: "Name", type: "text", nullable: false }],
        recordId: { prefix: "PAR", padding: 6 },
        foreignKeys: [],
      } as const;
      const childSchema = {
        name: "Children",
        columns: [{ name: "ParentId", type: "text", nullable: false }],
        recordId: { prefix: "CHI", padding: 6 },
        foreignKeys: [{ column: "ParentId", referencesTable: "Parents" }],
      } as const;
      const recipe: ImportRecipe = {
        version: 1,
        routes: [
          {
            source: "first-parent-alias",
            selection: "Parents",
            destination: { kind: "new-table", schema: parentSchema },
            columns: [{ source: "Name", target: "Name", type: "text" }],
          },
          {
            source: "second-parent-alias",
            selection: "Parents",
            destination: { kind: "existing-table", table: "Parents" },
            columns: [{ source: "Name", target: "Name", type: "text" }],
          },
          {
            source: "child",
            selection: "Children",
            destination: { kind: "new-table", schema: childSchema },
            columns: [{ source: "ParentId", target: "ParentId", type: "text" }],
          },
        ],
      };
      const { database, prepared } = await fixture(format, recipe);
      try {
        const parent = source({
          Parents: [
            {
              sourceRow: 2,
              cells: { Name: { kind: "string", value: "Parent A" } },
            },
          ],
        });
        const child = source({
          Children: [
            {
              sourceRow: 2,
              cells: { ParentId: { kind: "string", value: parentId } },
            },
          ],
        });
        const outcome = await prepareImport({
          database,
          prepared,
          recipe,
          sources: [
            { ...parent, key: "first-parent-alias" },
            { ...parent, key: "second-parent-alias" },
            { ...child, key: "child" },
          ],
        });

        expect(outcome.prepared.state).toBe(expectedState);
        if (expectedState === "needs-review") {
          expect(
            (await inspectImport({ prepared, page: { limit: 10 } })).conflicts,
          ).toContainEqual(
            expect.objectContaining({
              kind: "foreign-key-value-not-found",
              source: "child",
              sourceRow: 2,
              referencesTable: "Parents",
            }),
          );
          return;
        }
        if (outcome.prepared.state !== "ready")
          throw new Error("Plan not ready");
        const applied = await applyImport({
          database,
          prepared,
          approved: outcome.prepared,
          requestId: `${format}-duplicate-parent-aliases`,
        });
        expect(applied.metrics).toMatchObject({ rowsImported: 2 });
        expect(
          (await inspectDatabase({ database })).tables.map(
            ({ name, rowCount }) => [name, rowCount],
          ),
        ).toEqual([
          ["Children", 1n],
          ["Parents", 1n],
        ]);
      } finally {
        await prepared.close();
        await database.close();
      }
    },
  );

  test(`${format}: multiple sources can append to one table declared later`, async () => {
    const sharedSchema = {
      name: "Shared",
      columns: [{ name: "Value", type: "text", nullable: false }],
      recordId: { prefix: "SHA", padding: 6 },
      foreignKeys: [],
    } as const;
    const recipe: ImportRecipe = {
      version: 1,
      routes: [
        {
          source: "first",
          selection: "Data",
          destination: { kind: "existing-table", table: "shared" },
          columns: [{ source: "Value", target: "Value", type: "text" }],
        },
        {
          source: "second",
          selection: "Data",
          destination: { kind: "new-table", schema: sharedSchema },
          columns: [{ source: "Value", target: "Value", type: "text" }],
        },
      ],
    };
    const { database, prepared } = await fixture(format, recipe);
    try {
      const first = source({
        Data: [
          {
            sourceRow: 2,
            cells: { Value: { kind: "string", value: "A" } },
          },
        ],
      });
      const second = source({
        Data: [
          {
            sourceRow: 2,
            cells: { Value: { kind: "string", value: "B" } },
          },
        ],
      });
      const outcome = await prepareImport({
        database,
        prepared,
        recipe,
        sources: [
          { ...first, key: "first" },
          { ...second, key: "second" },
        ],
      });
      expect(outcome.prepared.state).toBe("ready");
      if (outcome.prepared.state !== "ready") throw new Error("Plan not ready");
      const result = await applyImport({
        database,
        prepared,
        approved: outcome.prepared,
        requestId: `${format}-shared-table`,
      });
      expect(result.metrics).toMatchObject({
        rowsImported: 2,
        tablesCreated: 1,
      });
      expect((await inspectDatabase({ database })).tables).toMatchObject([
        { name: "Shared", rowCount: 2n },
      ]);
      const saved = await inspectAppliedImportPlan({
        database,
        planId: outcome.prepared.id,
        planRevision: outcome.prepared.planRevision,
      });
      expect(saved?.recipe.routes[0]?.destination).toEqual({
        kind: "existing-table",
        table: "Shared",
      });
    } finally {
      await prepared.close();
      await database.close();
    }
  });

  test(`${format}: conflicting declarations for one new table require review`, async () => {
    const recipe: ImportRecipe = {
      version: 1,
      routes: [
        {
          source: "first",
          selection: "Data",
          destination: {
            kind: "new-table",
            schema: {
              name: "Shared",
              columns: [{ name: "Value", type: "text" }],
              recordId: { prefix: "SHA", padding: 6 },
            },
          },
          columns: [{ source: "Value", target: "Value", type: "text" }],
        },
        {
          source: "second",
          selection: "Data",
          destination: {
            kind: "new-table",
            schema: {
              name: "Shared",
              columns: [{ name: "Value", type: "integer" }],
              recordId: { prefix: "SHA", padding: 6 },
            },
          },
          columns: [{ source: "Value", target: "Value", type: "integer" }],
        },
      ],
    };
    const { database, prepared } = await fixture(format, recipe);
    try {
      const text = source({
        Data: [
          {
            sourceRow: 2,
            cells: { Value: { kind: "string", value: "A" } },
          },
        ],
      });
      const integer = source({
        Data: [
          {
            sourceRow: 2,
            cells: { Value: { kind: "number", raw: "1" } },
          },
        ],
      });
      const outcome = await prepareImport({
        database,
        prepared,
        recipe,
        sources: [
          { ...text, key: "first" },
          { ...integer, key: "second" },
        ],
      });
      expect(outcome.prepared.state).toBe("needs-review");
      expect(outcome.result.metrics.conflicts).toBeGreaterThan(0);
    } finally {
      await prepared.close();
      await database.close();
    }
  });

  test(`${format}: explicit re-review rebases a saved capture without reading its source again`, async () => {
    const firstRecipe: ImportRecipe = {
      version: 1,
      routes: [
        {
          source: "submission",
          selection: "First",
          destination: {
            kind: "new-table",
            schema: {
              name: "First",
              columns: [{ name: "Value", type: "text" }],
              recordId: { prefix: "FIR", padding: 6 },
            },
          },
          columns: [{ source: "Value", target: "Value", type: "text" }],
        },
      ],
    };
    const secondRecipe: ImportRecipe = {
      version: 1,
      routes: [
        {
          source: "submission",
          selection: "Second",
          destination: {
            kind: "new-table",
            schema: {
              name: "Second",
              columns: [{ name: "Value", type: "text" }],
              recordId: { prefix: "SEC", padding: 6 },
            },
          },
          columns: [{ source: "Value", target: "Value", type: "text" }],
        },
      ],
    };
    const directory = await mkdtemp(path.join(tmpdir(), "cc-import-rebase-"));
    directories.push(directory);
    const { database } = await createDatabase({
      path: path.join(directory, `workspace.${format}`),
      format,
    });
    const first = await createPreparedImport({
      path: path.join(directory, "first.ccplan"),
      database,
      recipe: firstRecipe,
      baselineRevision: 0n,
    });
    const second = await createPreparedImport({
      path: path.join(directory, "second.ccplan"),
      database,
      recipe: secondRecipe,
      baselineRevision: 0n,
    });
    try {
      const firstOutcome = await prepareImport({
        database,
        prepared: first,
        recipe: firstRecipe,
        sources: [
          source({
            First: [
              {
                sourceRow: 2,
                cells: { Value: { kind: "string", value: "A" } },
              },
            ],
          }),
        ],
      });
      const secondOutcome = await prepareImport({
        database,
        prepared: second,
        recipe: secondRecipe,
        sources: [
          source({
            Second: [
              {
                sourceRow: 2,
                cells: { Value: { kind: "string", value: "B" } },
              },
            ],
          }),
        ],
      });
      if (
        firstOutcome.prepared.state !== "ready" ||
        secondOutcome.prepared.state !== "ready"
      ) {
        throw new Error("Plans not ready");
      }
      await applyImport({
        database,
        prepared: first,
        approved: firstOutcome.prepared,
        requestId: `${format}-first-plan`,
      });
      await expect(
        applyImport({
          database,
          prepared: second,
          approved: secondOutcome.prepared,
          requestId: `${format}-stale-second-plan`,
        }),
      ).rejects.toMatchObject({ code: "DB_STALE_IMPORT_PLAN" });
      const rebased = await resolveImport({
        database,
        prepared: second,
        decisions: [],
        rebase: true,
      });
      expect(rebased).toMatchObject({
        state: "ready",
        baselineRevision: 1n,
      });
      expect(rebased.planRevision).toBeGreaterThan(
        secondOutcome.prepared.planRevision,
      );
      if (rebased.state !== "ready") throw new Error("Rebase failed review");
      await applyImport({
        database,
        prepared: second,
        approved: rebased,
        requestId: `${format}-second-plan`,
      });
      expect((await inspectDatabase({ database })).tables).toHaveLength(2);
    } finally {
      await Promise.all([first.close(), second.close()]);
      await database.close();
    }
  });
}
