import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  planFilePublication,
  publishStagedFile,
  type FilePublicationPlan,
} from "@consultchimps/files";

import { databaseError } from "./errors.js";

interface NativeFileIdentity {
  readonly pathKey: string;
  readonly device?: bigint | undefined;
  readonly inode?: bigint | undefined;
}

interface NativeFileHandle {
  readonly isOpen: boolean;
  close(): Promise<void>;
}

interface OpenNativeHandle {
  readonly identity: NativeFileIdentity;
  readonly reference: WeakRef<NativeFileHandle>;
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function nativeFileIdentity(
  filePath: string,
): Promise<NativeFileIdentity> {
  const resolved = path.resolve(filePath);
  try {
    const [canonical, status] = await Promise.all([
      realpath(resolved),
      stat(resolved, { bigint: true }),
    ]);
    return {
      pathKey: canonical,
      ...(status.ino === 0n ? {} : { device: status.dev, inode: status.ino }),
    };
  } catch (error) {
    if (!missing(error)) throw error;
    const canonicalParent = await realpath(path.dirname(resolved));
    return {
      pathKey: path.join(canonicalParent, path.basename(resolved)),
    };
  }
}

function sameNativeFile(
  left: NativeFileIdentity,
  right: NativeFileIdentity,
): boolean {
  if (
    left.inode !== undefined &&
    right.inode !== undefined &&
    left.inode === right.inode &&
    left.device === right.device
  ) {
    return true;
  }
  return left.pathKey === right.pathKey;
}

type NativeFileIdentityResolver = (
  filePath: string,
) => Promise<NativeFileIdentity>;

export class NativeFileRegistry {
  readonly #openHandles = new Set<OpenNativeHandle>();
  readonly #resolveIdentity: NativeFileIdentityResolver;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    resolveIdentity: NativeFileIdentityResolver = nativeFileIdentity,
  ) {
    this.#resolveIdentity = resolveIdentity;
  }

  async #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release: () => void = () => undefined;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  #liveHandles(): readonly OpenNativeHandle[] {
    const live: OpenNativeHandle[] = [];
    for (const entry of this.#openHandles) {
      const handle = entry.reference.deref();
      if (handle === undefined || !handle.isOpen) {
        this.#openHandles.delete(entry);
      } else {
        live.push(entry);
      }
    }
    return live;
  }

  async #assertNotOpen(filePath: string): Promise<void> {
    const identity = await this.#resolveIdentity(filePath);
    if (
      !this.#liveHandles().some((entry) =>
        sameNativeFile(entry.identity, identity),
      )
    ) {
      return;
    }
    throw databaseError(
      "DB_NATIVE_FILE_BUSY",
      "Close the open database or import plan before replacing this file.",
      { path: path.resolve(filePath) },
    );
  }

  async #register(filePath: string, handle: NativeFileHandle): Promise<void> {
    this.#openHandles.add({
      identity: await this.#resolveIdentity(filePath),
      reference: new WeakRef(handle),
    });
  }

  async inspect<T>(work: () => Promise<T>): Promise<T> {
    return this.#exclusive(work);
  }

  async open<T extends NativeFileHandle>(
    filePath: string,
    opener: () => Promise<T>,
  ): Promise<T> {
    return this.#exclusive(async () => {
      const handle = await opener();
      try {
        await this.#register(filePath, handle);
        return handle;
      } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
      }
    });
  }

  async planPublication(options: {
    readonly output: string;
    readonly inputs: readonly string[];
    readonly overwrite?: boolean | undefined;
  }): Promise<FilePublicationPlan> {
    return this.#exclusive(async () => {
      const publication = await planFilePublication(options);
      await this.#assertNotOpen(publication.output);
      return publication;
    });
  }

  async publish(options: {
    readonly temporary: string;
    readonly plan: FilePublicationPlan;
  }): Promise<void> {
    await this.#exclusive(async () => {
      await this.#assertNotOpen(options.plan.output);
      await publishStagedFile(options);
    });
  }

  async publishAndOpen<T extends NativeFileHandle>(options: {
    readonly temporary: string;
    readonly plan: FilePublicationPlan;
    open(): Promise<T>;
  }): Promise<T> {
    return this.#exclusive(async () => {
      await this.#assertNotOpen(options.plan.output);
      await publishStagedFile(options);
      const handle = await options.open();
      try {
        await this.#register(options.plan.output, handle);
        return handle;
      } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
      }
    });
  }
}
