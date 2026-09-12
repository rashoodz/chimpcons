import * as duckdb from "@duckdb/duckdb-wasm";

const worker = new globalThis.Worker("/dist/duckdb-browser-eh.worker.js");
const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
await db.instantiate("/dist/duckdb-eh.wasm");
const root = await globalThis.navigator.storage.getDirectory();
for (const name of ["observations.duckdb", "observations.duckdb.wal"]) {
  const handle = await root.getFileHandle(name, { create: true });
  await db.registerFileHandle(
    name,
    handle,
    duckdb.DuckDBDataProtocol.BROWSER_FSACCESS,
    true,
  );
}
await db.open({
  path: "observations.duckdb",
  accessMode: duckdb.DuckDBAccessMode.READ_WRITE,
  useDirectIO: true,
});
const connection = await db.connect();
await connection.query("SET memory_limit='1GB'");

globalThis.experiment = {
  async query(sql) {
    const start = globalThis.performance.now();
    const table = await connection.query(sql);
    return {
      milliseconds: Math.round(globalThis.performance.now() - start),
      rows: JSON.parse(
        JSON.stringify(table.toArray(), (_, value) =>
          typeof value === "bigint" ? value.toString() : value,
        ),
      ),
    };
  },
  async registerWorkbook() {
    const file = globalThis.document.querySelector("input").files[0];
    await db.registerFileHandle(
      "source.xlsx",
      file,
      duckdb.DuckDBDataProtocol.BROWSER_FILEREADER,
      true,
    );
    return file.size;
  },
  async close() {
    await connection.query("CHECKPOINT");
    await connection.close();
    await db.reset();
    await db.dropFiles();
    await db.terminate();
  },
  async export() {
    const handle = await root.getFileHandle("observations.duckdb");
    const file = await handle.getFile();
    const response = await globalThis.fetch("/export", {
      method: "POST",
      body: file,
    });
    if (!response.ok) throw new Error("Export failed");
    return file.size;
  },
};
