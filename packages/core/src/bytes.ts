/** A source whose individual reads do not require materializing the whole file. */
export interface RandomAccessSource {
  readonly name: string;
  readonly size: number;
  readAt(
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
}

/** Caller-owned temporary storage. Closing releases resources, not source data. */
export interface RandomAccessFile extends RandomAccessSource {
  writeAt(offset: number, bytes: Uint8Array): Promise<void>;
  truncate(size: number): Promise<void>;
  close(): Promise<void>;
}
