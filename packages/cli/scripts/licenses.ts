import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function copyBundledLicenses(options: {
  readonly packageDirectory: string;
  readonly outputDirectory: string;
  readonly metafile: string;
}): Promise<void> {
  const metadata: unknown = JSON.parse(
    await readFile(options.metafile, "utf8"),
  );
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("inputs" in metadata) ||
    typeof metadata.inputs !== "object" ||
    metadata.inputs === null
  )
    throw new Error("The bundle is missing its dependency input metadata.");
  const packageRoots = new Set<string>();
  for (const input of Object.keys(metadata.inputs)) {
    const parts = path.resolve(options.packageDirectory, input).split(path.sep);
    const index = parts.lastIndexOf("node_modules");
    const packageName = parts[index + 1];
    if (index < 0 || packageName === undefined) continue;
    packageRoots.add(
      parts
        .slice(0, index + (packageName.startsWith("@") ? 3 : 2))
        .join(path.sep),
    );
  }
  for (const root of [...packageRoots].sort()) {
    const packageInfo: unknown = JSON.parse(
      await readFile(path.join(root, "package.json"), "utf8"),
    );
    if (
      typeof packageInfo !== "object" ||
      packageInfo === null ||
      !("name" in packageInfo) ||
      typeof packageInfo.name !== "string"
    )
      throw new Error("A bundled dependency has no package name.");
    const destination = path.join(
      options.outputDirectory,
      "LICENSES",
      encodeURIComponent(packageInfo.name),
    );
    await mkdir(destination, { recursive: true });
    const notices = (await readdir(root)).filter((name) =>
      /^(licen[cs]e|notice|copying)([.-]|$)/i.test(name),
    );
    if (notices.length === 0) {
      const readme = (await readdir(root)).find((name) =>
        /^readme(\.md)?$/i.test(name),
      );
      if (readme === undefined)
        throw new Error(
          `No license notice or README found for ${packageInfo.name}.`,
        );
      notices.push(readme);
    }
    for (const notice of notices)
      await writeFile(
        path.join(destination, notice),
        await readFile(path.join(root, notice)),
      );
  }
  await writeFile(
    path.join(options.outputDirectory, "THIRD-PARTY-LICENSES.md"),
    await readFile(
      path.join(
        options.packageDirectory,
        "..",
        "xlsx",
        "THIRD-PARTY-LICENSES.md",
      ),
    ),
  );
}
