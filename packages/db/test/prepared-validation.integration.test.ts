import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { inspectDatabase } from "../src/database.js";
import { NodeSqliteEngine } from "../src/engines/sqlite/node.js";
import {
  createDatabase,
  createPreparedImport,
  openPreparedImport,
} from "../src/node.js";
import {
  PREPARED_BINDING_TABLE,
  PREPARED_CAPTURE_TABLE,
  PREPARED_METADATA_TABLE,
  PREPARED_ROW_TABLE,
  preparedRef,
} from "../src/prepared.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const damageCases = [
  {
    label: "metadata table",
    sql: `DROP TABLE ${PREPARED_METADATA_TABLE}`,
  },
  {
    label: "capture table",
    sql: `DROP TABLE ${PREPARED_CAPTURE_TABLE}`,
  },
  {
    label: "binding table",
    sql: `DROP TABLE ${PREPARED_BINDING_TABLE}`,
  },
  {
    label: "row table",
    sql: `DROP TABLE ${PREPARED_ROW_TABLE}`,
  },
  {
    label: "metadata column",
    sql: `ALTER TABLE ${PREPARED_METADATA_TABLE} DROP COLUMN decisions_json`,
  },
  {
    label: "capture column",
    sql: `ALTER TABLE ${PREPARED_CAPTURE_TABLE} DROP COLUMN columns_json`,
  },
  {
    label: "binding column",
    sql: `ALTER TABLE ${PREPARED_BINDING_TABLE} DROP COLUMN display_name`,
  },
  {
    label: "row column",
    sql: `ALTER TABLE ${PREPARED_ROW_TABLE} DROP COLUMN values_json`,
  },
] as const;

test.each([false, true])(
  "rejects incomplete prepared plans opened with readonly=%s without changing their files",
  async (readonly) => {
    const directory = await mkdtemp(path.join(tmpdir(), "cc-plan-schema-"));
    directories.push(directory);
    const databasePath = path.join(directory, "workspace.sqlite");
    const { database } = await createDatabase({
      path: databasePath,
      format: "sqlite",
    });
    try {
      const baselineRevision = (await inspectDatabase({ database })).revision;
      for (const damage of damageCases) {
        const planPath = path.join(
          directory,
          `${damage.label.replaceAll(" ", "-")}-${String(readonly)}.ccplan`,
        );
        const created = await createPreparedImport({
          path: planPath,
          database,
          recipe: { version: 1, routes: [] },
          baselineRevision,
        });
        await created.close();
        const corrupt = NodeSqliteEngine.open(planPath);
        await corrupt.execute(damage.sql);
        await corrupt.close();
        const before = await readFile(planPath);

        await expect(
          openPreparedImport({ path: planPath, readonly }),
          damage.label,
        ).rejects.toMatchObject({ code: "DB_INVALID_PREPARED_IMPORT" });
        expect(await readFile(planPath)).toEqual(before);

        const replacement = await createPreparedImport({
          path: planPath,
          database,
          recipe: { version: 1, routes: [] },
          baselineRevision,
          overwrite: true,
        });
        await replacement.close();
        const reopened = await openPreparedImport({ path: planPath, readonly });
        await reopened.close();
      }
    } finally {
      await database.close();
    }
  },
);

test.each([false, true])(
  "opens complete prepared plans with readonly=%s",
  async (readonly) => {
    const directory = await mkdtemp(path.join(tmpdir(), "cc-plan-valid-"));
    directories.push(directory);
    const databasePath = path.join(directory, "workspace.sqlite");
    const planPath = path.join(directory, "review.ccplan");
    const { database } = await createDatabase({
      path: databasePath,
      format: "sqlite",
    });
    try {
      const baselineRevision = (await inspectDatabase({ database })).revision;
      const created = await createPreparedImport({
        path: planPath,
        database,
        recipe: { version: 1, routes: [] },
        baselineRevision,
      });
      const id = created.id;
      await created.close();
      const before = await readFile(planPath);

      const opened = await openPreparedImport({ path: planPath, readonly });
      expect(await preparedRef(opened)).toMatchObject({
        id,
        databaseId: database.id,
        state: "needs-review",
      });
      await opened.close();
      expect(await readFile(planPath)).toEqual(before);
    } finally {
      await database.close();
    }
  },
);

test("reports an unsupported future version before validating its changed layout", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cc-plan-future-"));
  directories.push(directory);
  const databasePath = path.join(directory, "workspace.sqlite");
  const planPath = path.join(directory, "future.ccplan");
  const { database } = await createDatabase({
    path: databasePath,
    format: "sqlite",
  });
  try {
    const created = await createPreparedImport({
      path: planPath,
      database,
      recipe: { version: 1, routes: [] },
      baselineRevision: (await inspectDatabase({ database })).revision,
    });
    await created.close();
    const future = NodeSqliteEngine.open(planPath);
    await future.execute(
      `UPDATE ${PREPARED_METADATA_TABLE} SET format_version = 2`,
    );
    await future.execute(`DROP TABLE ${PREPARED_CAPTURE_TABLE}`);
    await future.close();
    const before = await readFile(planPath);

    await expect(
      openPreparedImport({ path: planPath, readonly: true }),
    ).rejects.toMatchObject({
      code: "DB_UNSUPPORTED_PREPARED_IMPORT_VERSION",
      details: { fileVersion: "2", supportedVersion: 1 },
    });
    expect(await readFile(planPath)).toEqual(before);
  } finally {
    await database.close();
  }
});
