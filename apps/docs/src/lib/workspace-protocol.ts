import type { DatabaseFormat } from "@consultchimps/db";

export type WorkspaceDatabaseFormat = DatabaseFormat;

export interface WorkspaceColumnSummary {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
}

export interface WorkspaceTableSummary {
  readonly id: string;
  readonly name: string;
  readonly rowCount: number;
  readonly columns: readonly WorkspaceColumnSummary[];
}

export interface WorkspaceSummary {
  readonly databaseId: string;
  readonly format: WorkspaceDatabaseFormat;
  readonly formatVersion: number;
  readonly workingCopyName: string;
  readonly tables: readonly WorkspaceTableSummary[];
  readonly importCount: number;
  readonly deliveryCount: number;
}

export interface WorkspaceSchemaColumn {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly precision?: number;
  readonly scale?: number;
}

export interface WorkspaceSchemaTableDefinition {
  readonly name: string;
  readonly recordId: {
    readonly prefix: string;
    readonly separator: string;
    readonly padding: number;
  };
  readonly columns: readonly WorkspaceSchemaColumn[];
  readonly foreignKeys: readonly {
    readonly column: string;
    readonly referencesTable: string;
  }[];
}

export type WorkspaceSchemaDocument = unknown;

export type WorkspaceSchemaChange =
  | {
      readonly kind: "create-table";
      readonly table: WorkspaceSchemaTableDefinition;
    }
  | {
      readonly kind: "add-column";
      readonly table: string;
      readonly column: WorkspaceSchemaColumn;
    };

export interface WorkspaceSchemaConflict {
  readonly table: string;
  readonly column: string | null;
  readonly message: string;
}

export interface WorkspaceSchemaPlan {
  readonly id: string;
  readonly changes: readonly WorkspaceSchemaChange[];
  readonly conflicts: readonly WorkspaceSchemaConflict[];
  readonly ready: boolean;
}

export interface WorkspaceDeliveryContext {
  readonly requestId: string;
  readonly vendor: string;
  readonly entity: string;
  readonly phase: string;
  readonly coverage: "full" | "partial" | "unknown";
  readonly effectiveDate: string | null;
  readonly receivedDate: string | null;
  readonly note: string;
}

export interface WorkspaceImportFile {
  readonly id: string;
  readonly file: File;
  readonly role: string;
  readonly revision: string;
}

export interface WorkspaceImportColumn {
  readonly source: string;
  readonly destination: string | null;
  readonly inferredType: string;
  readonly destinationType: string | null;
  readonly compatible: boolean;
  readonly message: string | null;
}

export type WorkspaceImportRoute =
  | { readonly kind: "create"; readonly table: string }
  | { readonly kind: "append"; readonly table: string }
  | { readonly kind: "unresolved"; readonly suggestedTable: string };

export interface WorkspaceImportRegion {
  readonly id: string;
  readonly sourceId: string;
  readonly fileName: string;
  readonly label: string;
  readonly rowCount: number;
  readonly columns: readonly WorkspaceImportColumn[];
  readonly route: WorkspaceImportRoute;
  readonly conflicts: readonly string[];
}

export interface WorkspacePreparedImport {
  readonly id: string;
  readonly state: "needs-review" | "ready";
  readonly application: "applied" | "pending";
  readonly duplicateOf: string | null;
  readonly captureIds: readonly string[];
  readonly regions: readonly WorkspaceImportRegion[];
  readonly totalRows: number;
  readonly warningCount: number;
}

export interface WorkspaceImportListing {
  readonly plans: readonly WorkspacePreparedImport[];
  readonly ignoredPlanCount: number;
}

export interface WorkspacePreviewPage {
  readonly planId: string;
  readonly regionId: string;
  readonly columns: readonly string[];
  readonly rows: ReadonlyArray<readonly (boolean | null | number | string)[]>;
  readonly cursor: string | null;
  readonly nextCursor: string | null;
}

export interface WorkspaceRouteDecision {
  readonly regionId: string;
  readonly route:
    | { readonly kind: "create"; readonly table: string }
    | { readonly kind: "append"; readonly table: string };
  readonly columns: ReadonlyArray<{
    readonly source: string;
    readonly destination: string | null;
    readonly type: string;
  }>;
}

export interface WorkspaceImportResult {
  readonly importId: string;
  readonly receiptId: string;
  readonly outcome: "applied" | "duplicate";
  readonly appendedRows: number;
  readonly skippedRows: number;
  readonly unresolvedRows: number;
  readonly schemaChanges: number;
  readonly deliveriesRecorded: number;
  readonly captureIds: readonly string[];
  readonly summary: WorkspaceSummary;
}

export interface WorkspaceDeliverySummary {
  readonly id: string;
  readonly requestId: string;
  readonly label: string;
  readonly vendor: string;
  readonly entity: string;
  readonly phase: string;
  readonly scope:
    | { readonly kind: "full" }
    | { readonly kind: "partial"; readonly description: string }
    | { readonly kind: "changes"; readonly baseline: string }
    | { readonly kind: "unknown" };
  readonly effectiveDate: string | null;
  readonly receivedDate: string | null;
  readonly captureIds: readonly string[];
  readonly reusedCapture: boolean;
}

export interface WorkspaceDeliveryPage {
  readonly deliveries: readonly WorkspaceDeliverySummary[];
  readonly nextCursor: string | null;
}

export interface WorkspaceProgress {
  readonly phase: string;
  readonly completed: number;
  readonly total: number | null;
  readonly message: string;
}

interface WorkspaceCommandBase {
  readonly id: number;
}

export type WorkspaceCommand =
  | (WorkspaceCommandBase & {
      readonly type: "create";
      readonly format: WorkspaceDatabaseFormat;
      readonly name: string;
      readonly schema?: WorkspaceSchemaDocument;
      readonly overwrite?: boolean;
    })
  | (WorkspaceCommandBase & {
      readonly type: "open";
      readonly file: File;
      readonly name?: string;
      readonly overwrite?: boolean;
    })
  | (WorkspaceCommandBase & {
      readonly type: "reopen";
      readonly name: string;
      readonly readonly?: boolean;
    })
  | (WorkspaceCommandBase & {
      readonly type: "planSchema";
      readonly schema: WorkspaceSchemaDocument;
    })
  | (WorkspaceCommandBase & {
      readonly type: "applySchema";
      readonly planId: string;
    })
  | (WorkspaceCommandBase & {
      readonly type: "prepareImport";
      readonly sources: readonly WorkspaceImportFile[];
    })
  | (WorkspaceCommandBase & { readonly type: "listImports" })
  | (WorkspaceCommandBase & {
      readonly type: "previewImport";
      readonly planId: string;
      readonly regionId: string;
      readonly cursor: string | null;
      readonly limit: number;
    })
  | (WorkspaceCommandBase & {
      readonly type: "resolveImport";
      readonly planId: string;
      readonly decisions: readonly WorkspaceRouteDecision[];
    })
  | (WorkspaceCommandBase & {
      readonly type: "applyImport";
      readonly planId: string;
      readonly delivery: WorkspaceDeliveryContext;
    })
  | (WorkspaceCommandBase & {
      readonly type: "recordDelivery";
      readonly planId: string;
      readonly delivery: WorkspaceDeliveryContext;
    })
  | (WorkspaceCommandBase & {
      readonly type: "listDeliveries";
      readonly cursor: string | null;
      readonly limit: number;
    })
  | (WorkspaceCommandBase & {
      readonly type: "export";
      readonly format: WorkspaceDatabaseFormat;
    })
  | (WorkspaceCommandBase & { readonly type: "close" })
  | (WorkspaceCommandBase & {
      readonly type: "cancel";
      readonly targetId: number;
    });

interface WorkspaceEventBase {
  readonly id: number;
}

export type WorkspaceEvent =
  | (WorkspaceEventBase & {
      readonly type: "ready";
      readonly summary: WorkspaceSummary;
    })
  | (WorkspaceEventBase & {
      readonly type: "schemaPlanned";
      readonly plan: WorkspaceSchemaPlan;
    })
  | (WorkspaceEventBase & {
      readonly type: "schemaApplied";
      readonly summary: WorkspaceSummary;
    })
  | (WorkspaceEventBase & {
      readonly type: "importPrepared";
      readonly plan: WorkspacePreparedImport;
    })
  | (WorkspaceEventBase & {
      readonly type: "importsListed";
      readonly plans: readonly WorkspacePreparedImport[];
      readonly ignoredPlanCount: number;
    })
  | (WorkspaceEventBase & {
      readonly type: "importPreview";
      readonly page: WorkspacePreviewPage;
    })
  | (WorkspaceEventBase & {
      readonly type: "importResolved";
      readonly plan: WorkspacePreparedImport;
    })
  | (WorkspaceEventBase & {
      readonly type: "importApplied";
      readonly result: WorkspaceImportResult;
    })
  | (WorkspaceEventBase & {
      readonly type: "deliveries";
      readonly page: WorkspaceDeliveryPage;
    })
  | (WorkspaceEventBase & {
      readonly type: "exported";
      readonly file: File;
      readonly name: string;
      readonly format: WorkspaceDatabaseFormat;
    })
  | (WorkspaceEventBase & { readonly type: "closed" })
  | (WorkspaceEventBase & {
      readonly type: "progress";
      readonly progress: WorkspaceProgress;
    })
  | (WorkspaceEventBase & {
      readonly type: "error";
      readonly message: string;
      readonly code?: string;
    });
