import { ConsultChimpsError } from "@consultchimps/core";

import type {
  WorkspaceCommand,
  WorkspaceDatabaseFormat,
  WorkspaceDeliveryContext,
  WorkspaceDeliveryPage,
  WorkspaceEvent,
  WorkspaceImportFile,
  WorkspaceImportListing,
  WorkspaceImportResult,
  WorkspacePreparedImport,
  WorkspacePreviewPage,
  WorkspaceProgress,
  WorkspaceRouteDecision,
  WorkspaceSchemaDocument,
  WorkspaceSchemaPlan,
  WorkspaceSummary,
} from "./workspace-protocol";

export const WORKSPACE_WORKER_UNAVAILABLE = "WORKSPACE_WORKER_UNAVAILABLE";

type FinalWorkspaceEvent = Exclude<
  WorkspaceEvent,
  { readonly type: "progress" }
>;
type CommandWithoutId = {
  [Kind in WorkspaceCommand["type"]]: Omit<
    Extract<WorkspaceCommand, { readonly type: Kind }>,
    "id"
  >;
}[WorkspaceCommand["type"]];

interface PendingRequest {
  readonly resolve: (event: FinalWorkspaceEvent) => void;
  readonly reject: (error: Error) => void;
  readonly onProgress?: (progress: WorkspaceProgress) => void;
}

export interface WorkspaceRunOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: WorkspaceProgress) => void;
}

export interface WorkspaceOpenOptions {
  readonly name?: string;
  readonly overwrite?: boolean;
}

function unavailable(): ConsultChimpsError {
  return new ConsultChimpsError(
    WORKSPACE_WORKER_UNAVAILABLE,
    "The database worker is no longer available. Reopen the workspace page and try again.",
  );
}

function unexpected(operation: string): Error {
  return new Error(
    `The database worker returned an unexpected ${operation} response`,
  );
}

export class WorkspaceClient {
  #worker: Worker | null = null;
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #queue: Promise<void> = Promise.resolve();
  #terminated = false;

  #getWorker(): Worker {
    if (this.#terminated) {
      throw unavailable();
    }
    if (this.#worker === null) {
      const worker = new Worker(
        new URL("../workers/workspace.worker.ts", import.meta.url),
        { type: "module" },
      );
      this.#worker = worker;
      worker.addEventListener(
        "message",
        (message: MessageEvent<WorkspaceEvent>) => {
          if (this.#worker === worker) this.#receive(message.data);
        },
      );
      const failed = (): void => {
        if (this.#worker !== worker) return;
        worker.terminate();
        this.#worker = null;
        const error = unavailable();
        for (const pending of this.#pending.values()) pending.reject(error);
        this.#pending.clear();
      };
      worker.addEventListener("error", failed);
      worker.addEventListener("messageerror", failed);
    }
    return this.#worker;
  }

  #receive(event: WorkspaceEvent): void {
    const pending = this.#pending.get(event.id);
    if (pending === undefined) {
      return;
    }
    if (event.type === "progress") {
      pending.onProgress?.(event.progress);
      return;
    }
    this.#pending.delete(event.id);
    if (event.type === "error") {
      pending.reject(
        new ConsultChimpsError(
          event.code ?? "WORKSPACE_OPERATION_FAILED",
          event.message,
        ),
      );
      return;
    }
    pending.resolve(event);
  }

  #request(
    command: CommandWithoutId,
    options: WorkspaceRunOptions = {},
  ): Promise<FinalWorkspaceEvent> {
    const run = async (): Promise<FinalWorkspaceEvent> => {
      if (this.#terminated) {
        throw unavailable();
      }
      if (options.signal?.aborted === true) {
        throw new DOMException("The operation was cancelled", "AbortError");
      }
      const id = this.#nextId;
      this.#nextId += 1;
      return new Promise<FinalWorkspaceEvent>((resolve, reject) => {
        const abort = (): void => {
          this.#worker?.postMessage({
            type: "cancel",
            id: this.#nextId++,
            targetId: id,
          } satisfies WorkspaceCommand);
        };
        options.signal?.addEventListener("abort", abort, { once: true });
        this.#pending.set(id, {
          resolve: (event) => {
            options.signal?.removeEventListener("abort", abort);
            resolve(event);
          },
          reject: (error) => {
            options.signal?.removeEventListener("abort", abort);
            reject(error);
          },
          ...(options.onProgress === undefined
            ? {}
            : { onProgress: options.onProgress }),
        });
        this.#getWorker().postMessage({ ...command, id });
      });
    };

    const result = this.#queue.then(run, run);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async create(
    format: WorkspaceDatabaseFormat,
    name: string,
    options?: WorkspaceRunOptions,
  ): Promise<WorkspaceSummary> {
    const event = await this.#request(
      { type: "create", format, name },
      options,
    );
    if (event.type !== "ready") throw unexpected("create");
    return event.summary;
  }

  async open(
    file: File,
    openOptions: WorkspaceOpenOptions,
    runOptions?: WorkspaceRunOptions,
  ): Promise<WorkspaceSummary> {
    const event = await this.#request(
      {
        type: "open",
        file,
        ...(openOptions.name === undefined ? {} : { name: openOptions.name }),
        ...(openOptions.overwrite === undefined
          ? {}
          : { overwrite: openOptions.overwrite }),
      },
      runOptions,
    );
    if (event.type !== "ready") throw unexpected("open");
    return event.summary;
  }

  async reopen(
    name: string,
    options?: WorkspaceRunOptions,
  ): Promise<WorkspaceSummary> {
    const event = await this.#request({ type: "reopen", name }, options);
    if (event.type !== "ready") throw unexpected("open");
    return event.summary;
  }

  async planSchema(
    schema: WorkspaceSchemaDocument,
    options?: WorkspaceRunOptions,
  ): Promise<WorkspaceSchemaPlan> {
    const event = await this.#request({ type: "planSchema", schema }, options);
    if (event.type !== "schemaPlanned") throw unexpected("schema");
    return event.plan;
  }

  async applySchema(
    planId: string,
    options?: WorkspaceRunOptions,
  ): Promise<WorkspaceSummary> {
    const event = await this.#request({ type: "applySchema", planId }, options);
    if (event.type !== "schemaApplied") throw unexpected("schema");
    return event.summary;
  }

  async prepareImport(
    sources: readonly WorkspaceImportFile[],
    options?: WorkspaceRunOptions,
  ): Promise<WorkspacePreparedImport> {
    const event = await this.#request(
      { type: "prepareImport", sources },
      options,
    );
    if (event.type !== "importPrepared") throw unexpected("import");
    return event.plan;
  }

  async listImports(): Promise<WorkspaceImportListing> {
    const event = await this.#request({ type: "listImports" });
    if (event.type !== "importsListed") throw unexpected("import");
    return {
      plans: event.plans,
      ignoredPlanCount: event.ignoredPlanCount,
    };
  }

  async previewImport(
    planId: string,
    regionId: string,
    cursor: string | null,
  ): Promise<WorkspacePreviewPage> {
    const event = await this.#request({
      type: "previewImport",
      planId,
      regionId,
      cursor,
      limit: 25,
    });
    if (event.type !== "importPreview") throw unexpected("preview");
    return event.page;
  }

  async resolveImport(
    planId: string,
    decisions: readonly WorkspaceRouteDecision[],
  ): Promise<WorkspacePreparedImport> {
    const event = await this.#request({
      type: "resolveImport",
      planId,
      decisions,
    });
    if (event.type !== "importResolved") throw unexpected("import");
    return event.plan;
  }

  async applyImport(
    planId: string,
    delivery: WorkspaceDeliveryContext,
    options?: WorkspaceRunOptions,
  ): Promise<WorkspaceImportResult> {
    const event = await this.#request(
      { type: "applyImport", planId, delivery },
      options,
    );
    if (event.type !== "importApplied") throw unexpected("import");
    return event.result;
  }

  async recordDelivery(
    planId: string,
    delivery: WorkspaceDeliveryContext,
    options?: WorkspaceRunOptions,
  ): Promise<WorkspaceImportResult> {
    const event = await this.#request(
      { type: "recordDelivery", planId, delivery },
      options,
    );
    if (event.type !== "importApplied") throw unexpected("delivery");
    return event.result;
  }

  async listDeliveries(cursor: string | null): Promise<WorkspaceDeliveryPage> {
    const event = await this.#request({
      type: "listDeliveries",
      cursor,
      limit: 25,
    });
    if (event.type !== "deliveries") throw unexpected("delivery");
    return event.page;
  }

  async export(
    format: WorkspaceDatabaseFormat,
    options?: WorkspaceRunOptions,
  ): Promise<{
    readonly file: File;
    readonly name: string;
    readonly format: WorkspaceDatabaseFormat;
  }> {
    const event = await this.#request({ type: "export", format }, options);
    if (event.type !== "exported") throw unexpected("export");
    return { file: event.file, name: event.name, format: event.format };
  }

  async close(): Promise<void> {
    const event = await this.#request({ type: "close" });
    if (event.type !== "closed") throw unexpected("close");
  }

  terminate(): void {
    if (this.#terminated) return;
    this.#terminated = true;
    this.#worker?.terminate();
    this.#worker = null;
    const error = unavailable();
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}
