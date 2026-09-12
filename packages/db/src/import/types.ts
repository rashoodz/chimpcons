import type {
  OperationControlOptions,
  OperationResult,
  RandomAccessSource,
} from "@consultchimps/core";

import type { Database, DatabaseId } from "../database.js";
import type { PreparedImport } from "../prepared.js";
import type { ColumnDefinition, TableSchema } from "../schema.js";

declare const preparedImportIdBrand: unique symbol;
export type PreparedImportId = string & {
  readonly [preparedImportIdBrand]: true;
};

export type ImportCell =
  | { readonly kind: "blank" }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly raw: string }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "date"; readonly raw: string; readonly iso: string }
  | { readonly kind: "error"; readonly error: string }
  | {
      readonly kind: "formula";
      readonly formula?: string | undefined;
      readonly cached:
        | Exclude<ImportCell, { readonly kind: "formula" }>
        | { readonly kind: "missing" };
    };

export interface ImportRow {
  readonly sourceRow: number;
  readonly cells: Readonly<Record<string, ImportCell>>;
}

export interface ImportRegionReader {
  readonly columns: readonly string[];
  batches(options: {
    readonly batchSize: number;
    readonly signal?: AbortSignal | undefined;
    readonly onProgress?: OperationControlOptions["onProgress"];
  }): AsyncIterable<readonly ImportRow[]>;
  close(): Promise<void>;
}

export interface ImportSelectionSource {
  readonly key: string;
  readonly label: string;
  readonly open: (
    options: OperationControlOptions,
  ) => Promise<ImportRegionReader>;
}

export interface ImportSource {
  readonly key: string;
  readonly bytes: RandomAccessSource;
  readonly readerVersion: string;
  readonly selections: readonly ImportSelectionSource[];
  readonly verifyUnchanged?: (() => Promise<void>) | undefined;
}

export interface ColumnRoute {
  readonly source: string;
  readonly target: string;
  readonly type: ColumnDefinition["type"];
}

export type ImportDestination =
  | { readonly kind: "new-table"; readonly schema: TableSchema }
  | {
      readonly kind: "new-table-infer";
      readonly name: string;
      readonly recordId: TableSchema["recordId"];
    }
  | { readonly kind: "existing-table"; readonly table: string };

export interface ImportRoute {
  readonly source: string;
  readonly selection: string;
  readonly destination: ImportDestination;
  readonly columns: readonly ColumnRoute[];
}

export interface ImportRecipe {
  readonly version: 1;
  readonly routes: readonly ImportRoute[];
}

export type ImportConflict =
  | {
      readonly kind: "missing-destination";
      readonly source: string;
      readonly selection: string;
    }
  | {
      readonly kind: "source-selection-not-found";
      readonly source: string;
      readonly selection: string;
    }
  | {
      readonly kind: "missing-column";
      readonly source: string;
      readonly selection: string;
      readonly column: string;
    }
  | {
      readonly kind: "source-column-not-found";
      readonly source: string;
      readonly selection: string;
      readonly column: string;
    }
  | {
      readonly kind: "required-column-unmapped";
      readonly source: string;
      readonly selection: string;
      readonly target: string;
    }
  | {
      readonly kind: "required-value";
      readonly source: string;
      readonly selection: string;
      readonly target: string;
      readonly sourceRow: number;
    }
  | {
      readonly kind: "invalid-value";
      readonly source: string;
      readonly selection: string;
      readonly column: string;
      readonly target: string;
      readonly sourceRow: number;
      readonly expected: ColumnDefinition["type"];
    }
  | {
      readonly kind: "foreign-key-value-not-found";
      readonly source: string;
      readonly selection: string;
      readonly column: string;
      readonly target: string;
      readonly sourceRow: number;
      readonly referencesTable: string;
    }
  | {
      readonly kind: "incompatible-column";
      readonly source: string;
      readonly selection: string;
      readonly column: string;
      readonly target: string;
      readonly expected: ColumnDefinition["type"];
    }
  | {
      readonly kind: "decimal-capacity";
      readonly source: string;
      readonly selection: string;
      readonly column: string;
      readonly target: string;
      readonly requiredPrecision: number;
      readonly requiredScale: number;
      readonly targetPrecision: number;
      readonly targetScale: number;
    }
  | {
      readonly kind: "inferred-schema";
      readonly source: string;
      readonly selection: string;
      readonly schema: TableSchema;
    }
  | { readonly kind: "table-exists"; readonly table: string }
  | { readonly kind: "table-not-found"; readonly table: string };

export interface PreparedImportRef {
  readonly id: PreparedImportId;
  readonly databaseId: DatabaseId;
  readonly planRevision: bigint;
  readonly baselineRevision: bigint;
  readonly baselineSchemaFingerprint: string;
  readonly state: "needs-review";
}

export interface ReadyImportRef {
  readonly id: PreparedImportId;
  readonly databaseId: DatabaseId;
  readonly planRevision: bigint;
  readonly baselineRevision: bigint;
  readonly baselineSchemaFingerprint: string;
  readonly state: "ready";
}

export type ImportDecision =
  | {
      readonly kind: "route";
      readonly source: string;
      readonly selection: string;
      readonly destination: ImportDestination;
      readonly columns: readonly ColumnRoute[];
    }
  | {
      readonly kind: "exclude";
      readonly source: string;
      readonly selection: string;
      readonly reason: string;
    };

export interface PreparedImportPage {
  readonly limit: number;
  readonly cursor?: string | undefined;
  readonly source?: string | undefined;
  readonly selection?: string | undefined;
}

export interface ImportExample {
  readonly source: string;
  readonly selection: string;
  readonly sourceRow: number;
  readonly values: Readonly<Record<string, ImportCell>>;
}

export interface ImportInspection {
  readonly prepared: PreparedImportRef | ReadyImportRef;
  readonly conflicts: readonly ImportConflict[];
  readonly capturedRows: bigint;
  readonly routes: readonly ImportRouteInspection[];
  readonly examples: readonly ImportExample[];
  readonly previewWarnings: readonly {
    readonly code: "DB_PREVIEW_DATABASE_REQUIRED";
    readonly source: string;
    readonly selection: string;
    readonly message: string;
  }[];
  readonly nextCursor?: string | undefined;
}

export interface AppliedImportPlanBinding {
  readonly source: string;
  readonly displayName: string;
  readonly selection: string;
  readonly label: string;
  readonly captureId: string;
}

export interface AppliedImportPlan {
  readonly id: PreparedImportId;
  readonly planRevision: bigint;
  readonly baselineRevision: bigint;
  readonly state: "applied";
  readonly recipe: ImportRecipe;
  readonly conflicts: readonly ImportConflict[];
  readonly decisions: readonly ImportDecision[];
  readonly bindings: readonly AppliedImportPlanBinding[];
}

export interface ImportRouteInspection {
  readonly source: string;
  readonly selection: string;
  readonly label: string;
  readonly captureId: string;
  readonly reused: boolean;
  readonly rowCount: bigint;
  readonly destination: ImportDestination | null;
  readonly columns: readonly ColumnRoute[];
  readonly inferredColumns: readonly ColumnDefinition[];
}

export interface DeliveryContext {
  readonly label: string;
  readonly effectiveDate?: string | undefined;
  readonly receivedDate?: string | undefined;
  readonly scope:
    | { readonly kind: "full" }
    | { readonly kind: "partial"; readonly description: string }
    | { readonly kind: "changes"; readonly baseline: string }
    | { readonly kind: "unknown" };
  readonly attributes?: Readonly<
    Record<string, string | number | boolean | null>
  >;
}

export interface DeliveryRecord {
  readonly id: string;
  readonly requestId: string;
  readonly context: DeliveryContext;
  readonly captureIds: readonly string[];
  readonly reusedCaptureIds: readonly string[];
}

export interface DeliveryPage {
  readonly deliveries: readonly DeliveryRecord[];
  readonly nextCursor?: string | undefined;
}

export interface PrepareImportOptions extends OperationControlOptions {
  readonly database: Database;
  readonly prepared: PreparedImport;
  readonly sources: readonly ImportSource[];
  readonly recipe: ImportRecipe;
}

export interface PrepareImportOutcome {
  readonly prepared: PreparedImportRef | ReadyImportRef;
  readonly result: OperationResult<
    "sourcesRead" | "sourcesReused" | "rowsCaptured" | "conflicts"
  >;
}

export interface ApplyImportOptions extends OperationControlOptions {
  readonly database: Database;
  readonly prepared: PreparedImport;
  readonly approved: ReadyImportRef;
  readonly requestId: string;
  readonly delivery?: DeliveryContext | undefined;
}

export interface ImportResult extends OperationResult<
  "rowsImported" | "rowsReused" | "tablesCreated" | "deliveriesRecorded"
> {
  readonly importIds: readonly string[];
  readonly captureIds: readonly string[];
  readonly deliveryId?: string | undefined;
}

export interface DeliveryResult extends OperationResult<
  "deliveriesRecorded" | "capturesLinked"
> {
  readonly delivery: DeliveryRecord;
}
