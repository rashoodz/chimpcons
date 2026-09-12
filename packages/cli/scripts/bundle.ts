import { execFileSync } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";
import { copyBundledLicenses } from "./licenses.ts";

const packageDirectory = path.resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);
const directory = path.join(packageDirectory, "dist-bundle");
const releaseDirectory = path.join(packageDirectory, "dist-archives");
const metafile = path.join(directory, "metafile-esm.json");
await copyBundledLicenses({
  packageDirectory,
  outputDirectory: directory,
  metafile,
});
await rm(metafile);
const metadata: unknown = JSON.parse(
  await readFile(path.join(packageDirectory, "package.json"), "utf8"),
);
if (
  metadata === null ||
  typeof metadata !== "object" ||
  !("version" in metadata) ||
  typeof metadata.version !== "string" ||
  !("dependencies" in metadata) ||
  metadata.dependencies === null ||
  typeof metadata.dependencies !== "object"
)
  throw new Error("CLI package metadata is invalid.");

const dependencies: Record<string, string> = {};
for (const name of ["@duckdb/node-api", "better-sqlite3"]) {
  const value = Reflect.get(metadata.dependencies, name);
  if (typeof value !== "string")
    throw new Error(`Missing native dependency ${name}.`);
  dependencies[name] = value;
}
await writeFile(
  path.join(directory, "package.json"),
  JSON.stringify(
    {
      name: "consultchimps-portable",
      private: true,
      type: "module",
      version: metadata.version,
      dependencies,
    },
    null,
    2,
  ) + "\n",
);

const npm = process.platform === "win32" ? process.execPath : "npm";
const prefix =
  process.platform === "win32"
    ? [
        path.join(
          path.dirname(process.execPath),
          "node_modules",
          "npm",
          "bin",
          "npm-cli.js",
        ),
      ]
    : [];
execFileSync(
  npm,
  [
    ...prefix,
    "install",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
  ],
  {
    cwd: directory,
    stdio: "inherit",
  },
);
const nodeMajor = process.versions.node.split(".")[0];
const target = `${process.platform}-${process.arch}-node${nodeMajor}`;
await writeFile(
  path.join(directory, "README.txt"),
  `ConsultChimps ${metadata.version}\n\nThis archive targets ${process.platform} ${process.arch} and Node.js ${nodeMajor}.\nExtract the whole archive, keep node_modules beside consultchimps.mjs, and run:\n\n  node consultchimps.mjs --help\n\nNo npm installation is needed on the destination machine.\nUse the npm distribution for other supported Node.js versions and platforms.\nNative dependency licenses are included inside node_modules.\n`,
);
await writeFile(
  path.join(directory, "LICENSE"),
  await readFile(path.join(packageDirectory, "..", "..", "LICENSE")),
);

const zip = new JSZip();
async function addDirectory(current: string, relative = ""): Promise<void> {
  const entries = (await readdir(current, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name, "en"),
  );
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const archivePath = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await addDirectory(absolute, archivePath);
    else if (entry.isFile()) zip.file(archivePath, createReadStream(absolute));
  }
}
await addDirectory(directory);
await mkdir(releaseDirectory, { recursive: true });
const output = path.join(releaseDirectory, `consultchimps-${target}.zip`);
await pipeline(
  zip.generateNodeStream({ streamFiles: true, compression: "DEFLATE" }),
  createWriteStream(output),
);
const smokeDirectory = await mkdtemp(path.join(tmpdir(), "cc-portable-check-"));
try {
  const archive = await JSZip.loadAsync(await readFile(output));
  for (const entry of Object.values(archive.files)) {
    const destination = path.resolve(smokeDirectory, entry.name);
    if (!destination.startsWith(smokeDirectory + path.sep))
      throw new Error("The portable archive contains an unsafe filename.");
    if (entry.dir) await mkdir(destination, { recursive: true });
    else {
      await mkdir(path.dirname(destination), { recursive: true });
      await pipeline(entry.nodeStream(), createWriteStream(destination));
    }
  }
  const executable = path.join(smokeDirectory, "consultchimps.mjs");
  execFileSync(process.execPath, [executable, "--version"], {
    cwd: smokeDirectory,
    stdio: "inherit",
  });
  for (const format of ["sqlite", "duckdb"]) {
    const database = path.join(smokeDirectory, `database.${format}`);
    execFileSync(
      process.execPath,
      [executable, "db", "create", "--format", format, "--output", database],
      { cwd: smokeDirectory, stdio: "inherit" },
    );
    execFileSync(
      process.execPath,
      [executable, "db", "inspect", database, "--json"],
      { cwd: smokeDirectory, stdio: "inherit" },
    );
  }
} finally {
  await rm(smokeDirectory, { recursive: true, force: true });
}
process.stdout.write(`Created ${path.basename(output)}\n`);
