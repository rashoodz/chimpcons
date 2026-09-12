import type { DatabaseFormat } from "../schema.js";

export type EngineValue =
  null | string | number | bigint | boolean | Uint8Array;
export type EngineRow = Readonly<Record<string, EngineValue>>;

export interface EngineTransaction {
  execute(sql: string, values?: readonly EngineValue[]): Promise<void>;
  query(
    sql: string,
    values?: readonly EngineValue[],
  ): Promise<readonly EngineRow[]>;
  bulkInsert(options: {
    readonly table: string;
    readonly columns: readonly string[];
    readonly rows: readonly (readonly EngineValue[])[];
    readonly signal?: AbortSignal | undefined;
  }): Promise<void>;
}

export interface DatabaseEngine extends EngineTransaction {
  readonly format: DatabaseFormat;
  readonly interruptible: boolean;
  transaction<T>(
    work: (transaction: EngineTransaction) => Promise<T>,
  ): Promise<T>;
  readTransaction<T>(
    work: (transaction: EngineTransaction) => Promise<T>,
  ): Promise<T>;
  checkpoint(): Promise<void>;
  interrupt(): void;
  close(): Promise<void>;
}
