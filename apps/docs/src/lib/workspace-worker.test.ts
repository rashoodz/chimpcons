import { isConsultChimpsError } from "@consultchimps/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  WorkspaceCommand,
  WorkspaceEvent,
  WorkspaceSummary,
} from "./workspace-protocol";
import {
  WORKSPACE_WORKER_UNAVAILABLE,
  WorkspaceClient,
} from "./workspace-worker";

const EMPTY_SUMMARY: WorkspaceSummary = {
  databaseId: "DB-test",
  format: "sqlite",
  formatVersion: 1,
  workingCopyName: "test.sqlite",
  tables: [],
  importCount: 0,
  deliveryCount: 0,
};

type ReplyWithoutId = {
  [Kind in WorkspaceEvent["type"]]: Omit<
    Extract<WorkspaceEvent, { readonly type: Kind }>,
    "id"
  >;
}[WorkspaceEvent["type"]];

class ScriptedWorker {
  static latest: ScriptedWorker | null = null;
  readonly posted: WorkspaceCommand[] = [];
  terminated = false;
  #listeners = new Map<
    string,
    Array<(event: MessageEvent<WorkspaceEvent>) => void>
  >();

  constructor() {
    ScriptedWorker.latest = this;
  }

  addEventListener(
    type: string,
    listener: (event: MessageEvent<WorkspaceEvent>) => void,
  ): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  postMessage(command: WorkspaceCommand): void {
    this.posted.push(command);
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(index: number, reply: ReplyWithoutId): void {
    const command = this.posted[index];
    if (command === undefined) throw new Error("No command to answer");
    const event: WorkspaceEvent = { ...reply, id: command.id };
    for (const listener of this.#listeners.get("message") ?? []) {
      listener({ data: event } as MessageEvent<WorkspaceEvent>);
    }
  }

  fail(type: "error" | "messageerror"): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener({} as MessageEvent<WorkspaceEvent>);
    }
  }
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("WorkspaceClient", () => {
  beforeEach(() => {
    ScriptedWorker.latest = null;
    vi.stubGlobal("Worker", ScriptedWorker);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("serializes database commands", async () => {
    const client = new WorkspaceClient();
    const create = client.create("sqlite", "one.sqlite");
    const close = client.close();
    await settle();
    const worker = ScriptedWorker.latest;
    expect(worker?.posted.map((command) => command.type)).toEqual(["create"]);
    worker?.reply(0, { type: "ready", summary: EMPTY_SUMMARY });
    await create;
    await settle();
    expect(worker?.posted.map((command) => command.type)).toEqual([
      "create",
      "close",
    ]);
    worker?.reply(1, { type: "closed" });
    await close;
  });

  it("sends the selected working-copy name and replacement choice", async () => {
    const client = new WorkspaceClient();
    const file = new File(["database"], "report.sqlite");
    const opened = client.open(file, {
      name: "reviewed-copy.sqlite",
      overwrite: true,
    });
    await settle();

    expect(ScriptedWorker.latest?.posted[0]).toMatchObject({
      type: "open",
      file,
      name: "reviewed-copy.sqlite",
      overwrite: true,
    });
    ScriptedWorker.latest?.reply(0, {
      type: "ready",
      summary: EMPTY_SUMMARY,
    });
    await expect(opened).resolves.toEqual(EMPTY_SUMMARY);
  });

  it("sends cancellation beside the active command", async () => {
    const controller = new AbortController();
    const client = new WorkspaceClient();
    const create = client.create("sqlite", "one.sqlite", {
      signal: controller.signal,
    });
    await settle();
    controller.abort();
    const worker = ScriptedWorker.latest;
    expect(worker?.posted.map((command) => command.type)).toEqual([
      "create",
      "cancel",
    ]);
    worker?.reply(0, {
      type: "error",
      code: "OPERATION_CANCELLED",
      message: "The operation was cancelled",
    });
    await expect(create).rejects.toMatchObject({ code: "OPERATION_CANCELLED" });
  });

  it.each(["plan", "apply"] as const)(
    "forwards cancellation while schema %s is active",
    async (operation) => {
      const controller = new AbortController();
      const client = new WorkspaceClient();
      const pending =
        operation === "plan"
          ? client.planSchema(
              { version: 1, tables: [] },
              { signal: controller.signal },
            )
          : client.applySchema("schema-plan", { signal: controller.signal });
      await settle();
      controller.abort();

      const worker = ScriptedWorker.latest;
      expect(worker?.posted.map((command) => command.type)).toEqual([
        operation === "plan" ? "planSchema" : "applySchema",
        "cancel",
      ]);
      worker?.reply(0, {
        type: "error",
        code: "OPERATION_ABORTED",
        message: "The operation was cancelled",
      });
      await expect(pending).rejects.toMatchObject({
        code: "OPERATION_ABORTED",
      });
    },
  );

  it("rejects pending work when terminated", async () => {
    const client = new WorkspaceClient();
    const create = client.create("sqlite", "one.sqlite");
    await settle();
    client.terminate();
    let code = "";
    try {
      await create;
    } catch (error) {
      code = isConsultChimpsError(error) ? error.code : "unknown";
    }
    expect(code).toBe(WORKSPACE_WORKER_UNAVAILABLE);
    expect(ScriptedWorker.latest?.terminated).toBe(true);
  });

  it.each(["error", "messageerror"] as const)(
    "rejects pending work on worker %s and recovers with a new worker",
    async (failureType) => {
      const client = new WorkspaceClient();
      const failed = client.create("sqlite", "one.sqlite");
      await settle();
      const firstWorker = ScriptedWorker.latest;
      firstWorker?.fail(failureType);
      await expect(failed).rejects.toMatchObject({
        code: WORKSPACE_WORKER_UNAVAILABLE,
      });

      const recovered = client.create("sqlite", "two.sqlite");
      await settle();
      const secondWorker = ScriptedWorker.latest;
      expect(secondWorker).not.toBe(firstWorker);
      secondWorker?.reply(0, { type: "ready", summary: EMPTY_SUMMARY });
      await expect(recovered).resolves.toEqual(EMPTY_SUMMARY);
    },
  );
});
