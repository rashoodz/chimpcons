import { link, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { planFilePublication, publishStagedFile } from "../src/index.js";

const directories: string[] = [];
async function fixture(): Promise<{
  directory: string;
  source: string;
  output: string;
  temporary: string;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "cc-publication-test-"));
  directories.push(directory);
  const source = path.join(directory, "source.sqlite");
  const output = path.join(directory, "output.sqlite");
  const temporary = path.join(directory, "staged.sqlite");
  await writeFile(source, "source");
  await writeFile(temporary, "new database");
  return { directory, source, output, temporary };
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("publishes a staged file without replacing a source", async () => {
  const { source, output, temporary } = await fixture();
  const plan = await planFilePublication({ output, inputs: [source] });
  await publishStagedFile({ temporary, plan });
  expect(await readFile(output, "utf8")).toBe("new database");
  expect(await readFile(source, "utf8")).toBe("source");
});

test("refuses source hard-link aliases even with overwrite enabled", async () => {
  const { source, output } = await fixture();
  await link(source, output);
  await expect(
    planFilePublication({ output, inputs: [source], overwrite: true }),
  ).rejects.toMatchObject({ code: "FILES_INPUT_OVERWRITE" });
  expect(await readFile(source, "utf8")).toBe("source");
});

test("a file created after planning is preserved", async () => {
  const { source, output, temporary } = await fixture();
  const plan = await planFilePublication({ output, inputs: [source] });
  await writeFile(output, "another writer");
  await expect(publishStagedFile({ temporary, plan })).rejects.toMatchObject({
    code: "FILES_DESTINATION_CHANGED",
  });
  expect(await readFile(output, "utf8")).toBe("another writer");
  expect(await readFile(temporary, "utf8")).toBe("new database");
});

test("explicit replacement checks that the prior file did not change", async () => {
  const { source, output, temporary } = await fixture();
  await writeFile(output, "old");
  const plan = await planFilePublication({
    output,
    inputs: [source],
    overwrite: true,
  });
  await writeFile(output, "changed meanwhile");
  await expect(publishStagedFile({ temporary, plan })).rejects.toMatchObject({
    code: "FILES_DESTINATION_CHANGED",
  });
  const updatedPlan = await planFilePublication({
    output,
    inputs: [source],
    overwrite: true,
  });
  await publishStagedFile({ temporary, plan: updatedPlan });
  expect(await readFile(output, "utf8")).toBe("new database");
});
