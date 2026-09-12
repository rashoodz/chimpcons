import { access, link, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { inspectDatabase } from "../src/database.js";
import { inspectImport } from "../src/import/inspection.js";
import type { ImportRecipe } from "../src/import/types.js";
import {
  createDatabase,
  createPreparedImport,
  exportDatabase,
  openDatabase,
  openPreparedImport,
  prepareImportFile,
} from "../src/node.js";
import { applySchema, planSchema } from "../src/records.js";
import type { DatabaseSchema } from "../src/schema.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function schema(...tables: readonly string[]): DatabaseSchema {
  return {
    version: 1,
    tables: tables.map((name) => ({
      name,
      recordId: { prefix: name.toLocaleUpperCase(), padding: 4 },
      columns: [{ name: "value", type: "text" }],
    })),
  };
}

const emptyRecipe: ImportRecipe = { version: 1, routes: [] };

test("refuses database replacement through a live path or hard-link alias", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cc-native-busy-"));
  directories.push(directory);
  const databasePath = path.join(directory, "shared.sqlite");
  const aliasPath = path.join(directory, "shared-alias.sqlite");
  let database = (
    await createDatabase({
      path: databasePath,
      format: "sqlite",
      schema: schema("first"),
    })
  ).database;
  try {
    await expect(
      createDatabase({
        path: databasePath,
        format: "sqlite",
        schema: schema("replacement"),
        overwrite: true,
      }),
    ).rejects.toMatchObject({ code: "DB_NATIVE_FILE_BUSY" });

    await link(databasePath, aliasPath);
    await expect(
      createDatabase({
        path: aliasPath,
        format: "sqlite",
        schema: schema("replacement"),
        overwrite: true,
      }),
    ).rejects.toMatchObject({ code: "DB_NATIVE_FILE_BUSY" });

    const plan = await planSchema({
      database,
      schema: schema("first", "still_writable"),
    });
    await applySchema({ database, plan });
    expect(
      (await inspectDatabase({ database })).tables.map((table) => table.name),
    ).toEqual(["first", "still_writable"]);

    await database.close();
    const opening = openDatabase({ path: databasePath });
    const racingReplacement = createDatabase({
      path: databasePath,
      format: "sqlite",
      schema: schema("replacement"),
      overwrite: true,
    });
    database = await opening;
    await expect(racingReplacement).rejects.toMatchObject({
      code: "DB_NATIVE_FILE_BUSY",
    });
    await database.close();

    const replacement = await createDatabase({
      path: databasePath,
      format: "sqlite",
      schema: schema("replacement"),
      overwrite: true,
    });
    database = replacement.database;
    expect(
      (await inspectDatabase({ database })).tables.map((table) => table.name),
    ).toEqual(["replacement"]);
  } finally {
    await database.close();
  }
});

test("uses filesystem case behavior instead of assuming macOS is insensitive", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cc-native-case-"));
  directories.push(directory);
  const databasePath = path.join(directory, "Case.sqlite");
  const caseVariantPath = path.join(directory, "case.sqlite");
  const { database } = await createDatabase({
    path: databasePath,
    format: "sqlite",
    schema: schema("original"),
  });
  try {
    let caseVariantExists = true;
    try {
      await access(caseVariantPath);
    } catch {
      caseVariantExists = false;
    }
    if (caseVariantExists) {
      await expect(
        createDatabase({
          path: caseVariantPath,
          format: "sqlite",
          schema: schema("replacement"),
          overwrite: true,
        }),
      ).rejects.toMatchObject({ code: "DB_NATIVE_FILE_BUSY" });
    } else {
      const distinct = await createDatabase({
        path: caseVariantPath,
        format: "sqlite",
        schema: schema("distinct"),
      });
      try {
        expect(
          (await inspectDatabase({ database: distinct.database })).tables.map(
            (table) => table.name,
          ),
        ).toEqual(["distinct"]);
      } finally {
        await distinct.database.close();
      }
    }
    expect(
      (await inspectDatabase({ database })).tables.map((table) => table.name),
    ).toEqual(["original"]);
  } finally {
    await database.close();
  }
});

test("recognizes a database opened through a symbolic-link alias", async () => {
  if (process.platform === "win32") return;
  const directory = await mkdtemp(path.join(tmpdir(), "cc-native-link-"));
  directories.push(directory);
  const databasePath = path.join(directory, "database.sqlite");
  const aliasPath = path.join(directory, "alias.sqlite");
  const created = await createDatabase({
    path: databasePath,
    format: "sqlite",
  });
  await created.database.close();
  await symlink(databasePath, aliasPath);
  const database = await openDatabase({ path: aliasPath });
  try {
    await expect(
      createDatabase({
        path: databasePath,
        format: "sqlite",
        overwrite: true,
      }),
    ).rejects.toMatchObject({ code: "DB_NATIVE_FILE_BUSY" });
  } finally {
    await database.close();
  }
});

test("refuses prepared-plan replacement while its handle is open", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cc-plan-busy-"));
  directories.push(directory);
  const databasePath = path.join(directory, "database.sqlite");
  const planPath = path.join(directory, "review.ccplan");
  const { database } = await createDatabase({
    path: databasePath,
    format: "sqlite",
  });
  let prepared = await createPreparedImport({
    path: planPath,
    database,
    recipe: emptyRecipe,
    baselineRevision: 0n,
  });
  const originalId = prepared.id;
  try {
    await expect(
      createPreparedImport({
        path: planPath,
        database,
        recipe: emptyRecipe,
        baselineRevision: 0n,
        overwrite: true,
      }),
    ).rejects.toMatchObject({ code: "DB_NATIVE_FILE_BUSY" });
    await expect(
      prepareImportFile({
        path: planPath,
        database,
        sources: [],
        recipe: emptyRecipe,
        baselineRevision: 0n,
        overwrite: true,
      }),
    ).rejects.toMatchObject({ code: "DB_NATIVE_FILE_BUSY" });
    expect(
      (await inspectImport({ prepared, page: { limit: 1 } })).capturedRows,
    ).toBe(0n);

    await prepared.close();
    const outcome = await prepareImportFile({
      path: planPath,
      database,
      sources: [],
      recipe: emptyRecipe,
      baselineRevision: 0n,
      overwrite: true,
    });
    prepared = await openPreparedImport({ path: planPath });
    expect(prepared.id).toBe(outcome.prepared.id);
    expect(prepared.id).not.toBe(originalId);
  } finally {
    await prepared.close();
    await database.close();
  }
});

test("refuses export over a database with a live handle", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cc-export-busy-"));
  directories.push(directory);
  const sourcePath = path.join(directory, "source.sqlite");
  const destinationPath = path.join(directory, "destination.sqlite");
  const { database: source } = await createDatabase({
    path: sourcePath,
    format: "sqlite",
    schema: schema("source"),
  });
  let destination = (
    await createDatabase({
      path: destinationPath,
      format: "sqlite",
      schema: schema("destination"),
    })
  ).database;
  try {
    await expect(
      exportDatabase({
        database: source,
        output: destinationPath,
        overwrite: true,
      }),
    ).rejects.toMatchObject({ code: "DB_NATIVE_FILE_BUSY" });
    expect(
      (await inspectDatabase({ database: destination })).tables.map(
        (table) => table.name,
      ),
    ).toEqual(["destination"]);

    await destination.close();
    await exportDatabase({
      database: source,
      output: destinationPath,
      overwrite: true,
    });
    destination = await openDatabase({ path: destinationPath });
    expect(destination.id).toBe(source.id);
    expect(
      (await inspectDatabase({ database: destination })).tables.map(
        (table) => table.name,
      ),
    ).toEqual(["source"]);
  } finally {
    await destination.close();
    await source.close();
  }
});
