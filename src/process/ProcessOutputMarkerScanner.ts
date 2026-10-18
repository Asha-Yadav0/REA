/** One retained observation of a caller-selected literal in raw provider output. */
export interface ProviderProcessOutputMarker {
  /** Raw byte offset of the marker in its stream since construction or reset. */
  readonly offset: number;
  /**
   * Bounded copy of the marker's line. Starts at the marker when the line's
   * beginning was beyond the context bound, so no partial prefix is retained.
   */
  readonly line: string;
  /** True when line bytes beyond the context bound were omitted. */
  readonly truncated: boolean;
}

/** Bytes retained on each side of a marker; Java OOME lines fit comfortably. */
export const PROCESS_OUTPUT_MARKER_CONTEXT_BYTES = 1024;

const NEWLINE = 0x0a;

/**
 * Scan every drained chunk for one literal before diagnostic retention applies.
 *
 * Retains only the latest match and the bounded unterminated line tail needed
 * to detect a marker split across chunks and to recover its line prefix.
 */
export class ProcessOutputMarkerScanner {
  readonly #marker: Buffer;
  /** Bytes after the last newline, bounded to the marker context. */
  #lineTail: Buffer = Buffer.alloc(0);
  /** True when #lineTail does not start at a line boundary. */
  #lineTailCut = false;
  #latest:
    | {
        offset: number;
        prefix: Buffer;
        prefixCut: boolean;
        suffix: Buffer;
        open: boolean;
        suffixCut: boolean;
      }
    | undefined;

  constructor(marker: string) {
    if (marker.length === 0 || marker.includes("\n"))
      throw new RangeError("Output marker must be non-empty single-line text");
    this.#marker = Buffer.from(marker, "utf8");
  }

  /** Observe one drained chunk; `start` is its raw byte offset in the stream. */
  scan(chunk: Buffer, start: number): void {
    this.#extendOpenLine(chunk);
    const carried = this.#lineTail.byteLength;
    const searched =
      carried === 0 ? chunk : Buffer.concat([this.#lineTail, chunk]);
    const index = searched.lastIndexOf(this.#marker);
    // A match wholly inside the carried tail was recorded by an earlier scan.
    if (index >= 0 && index + this.#marker.byteLength > carried)
      this.#record(searched, index, start - carried);
    this.#retainLineTail(searched);
  }

  /** Latest marker whose offset lies in [start, end), if any. */
  latestWithin(
    start: number,
    end: number,
  ): ProviderProcessOutputMarker | undefined {
    const latest = this.#latest;
    if (latest === undefined || latest.offset < start || latest.offset >= end)
      return undefined;
    return {
      offset: latest.offset,
      line: Buffer.concat([latest.prefix, latest.suffix]).toString("utf8"),
      truncated: latest.prefixCut || latest.suffixCut,
    };
  }

  #record(searched: Buffer, index: number, searchedStart: number): void {
    const lineStart =
      index === 0 ? 0 : searched.lastIndexOf(NEWLINE, index - 1) + 1;
    const prefixFits =
      index - lineStart <= PROCESS_OUTPUT_MARKER_CONTEXT_BYTES &&
      (lineStart > 0 || !this.#lineTailCut);
    const lineEnd = searched.indexOf(NEWLINE, index);
    const available = lineEnd < 0 ? searched.byteLength : lineEnd;
    const suffixEnd = Math.min(
      available,
      index + this.#marker.byteLength + PROCESS_OUTPUT_MARKER_CONTEXT_BYTES,
    );
    this.#latest = {
      offset: searchedStart + index,
      prefix: prefixFits
        ? Buffer.from(searched.subarray(lineStart, index))
        : Buffer.alloc(0),
      prefixCut: !prefixFits,
      suffix: Buffer.from(searched.subarray(index, suffixEnd)),
      open: lineEnd < 0 && suffixEnd === available,
      suffixCut: suffixEnd < available,
    };
  }

  #extendOpenLine(chunk: Buffer): void {
    const latest = this.#latest;
    if (latest?.open !== true) return;
    const lineEnd = chunk.indexOf(NEWLINE);
    const available = lineEnd < 0 ? chunk.byteLength : lineEnd;
    const room =
      this.#marker.byteLength +
      PROCESS_OUTPUT_MARKER_CONTEXT_BYTES -
      latest.suffix.byteLength;
    const taken = Math.min(available, Math.max(0, room));
    if (taken > 0)
      latest.suffix = Buffer.concat([latest.suffix, chunk.subarray(0, taken)]);
    latest.suffixCut = taken < available;
    latest.open = lineEnd < 0 && taken === available;
  }

  #retainLineTail(searched: Buffer): void {
    const lineStart = searched.lastIndexOf(NEWLINE) + 1;
    const limit =
      PROCESS_OUTPUT_MARKER_CONTEXT_BYTES + this.#marker.byteLength - 1;
    const tailLength = searched.byteLength - lineStart;
    this.#lineTailCut =
      tailLength > limit || (lineStart === 0 && this.#lineTailCut);
    this.#lineTail = Buffer.from(
      searched.subarray(Math.max(lineStart, searched.byteLength - limit)),
    );
  }
}
