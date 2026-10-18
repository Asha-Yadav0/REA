import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROCESS_OUTPUT_MARKER_CONTEXT_BYTES,
  ProcessOutputMarkerScanner,
} from "./ProcessOutputMarkerScanner.js";
import { ProviderProcessSupervisor } from "./ProviderProcess.js";

const MARKER = "java.lang.OutOfMemoryError";
const OOME_LINE =
  "ERROR Abort due to Headless analyzer error: Java heap space (HeadlessAnalyzer) java.lang.OutOfMemoryError: Java heap space";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const supervised = (maxDiagnosticBytes = 64) => {
  const producer = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: () => false,
  });
  const supervisor = new ProviderProcessSupervisor(
    { process: producer, ownsProcessLifetime: false },
    { maxDiagnosticBytes, outputMarker: MARKER },
  );
  cleanups.push(() => {
    supervisor.dispose();
    producer.stdout.destroy();
    producer.stderr.destroy();
  });
  return { producer, supervisor };
};

describe("ProviderProcessSupervisor output marker", () => {
  it("observes a marker printed after the retention budget is exhausted", () => {
    const { producer, supervisor } = supervised();
    const checkpoint = supervisor.checkpointOutput();
    producer.stdout.write("x".repeat(200));
    producer.stderr.write(`${OOME_LINE}\n\tat frame\n`);
    const scoped = supervisor.snapshotOutputSince(checkpoint);
    expect(scoped.complete).toBe(false);
    expect(scoped.snapshot.stderr.text).toBe("");
    expect(scoped.markers).toEqual([
      {
        stream: "stderr",
        offset: OOME_LINE.indexOf(MARKER),
        line: OOME_LINE,
        truncated: false,
      },
    ]);
  });

  it("detects a marker and its line split across chunks", () => {
    const { producer, supervisor } = supervised(0);
    const checkpoint = supervisor.checkpointOutput();
    producer.stdout.write("progress\n");
    const text = `${OOME_LINE}\nnext\n`;
    const split = text.indexOf(MARKER) + 7;
    producer.stdout.write(text.slice(0, 20));
    producer.stdout.write(text.slice(20, split));
    producer.stdout.write(text.slice(split, split + 10));
    producer.stdout.write(text.slice(split + 10));
    expect(supervisor.snapshotOutputSince(checkpoint).markers).toEqual([
      {
        stream: "stdout",
        offset: "progress\n".length + OOME_LINE.indexOf(MARKER),
        line: OOME_LINE,
        truncated: false,
      },
    ]);
  });

  it("does not attribute a marker from before the checkpoint", () => {
    const { producer, supervisor } = supervised(0);
    producer.stderr.write(`${OOME_LINE}\n`);
    const checkpoint = supervisor.checkpointOutput();
    producer.stderr.write("later unrelated failure\n");
    expect(supervisor.snapshotOutputSince(checkpoint).markers).toBeUndefined();
  });

  it("forgets markers on reset and for checkpoints from another epoch", () => {
    const { producer, supervisor } = supervised(0);
    const stale = supervisor.checkpointOutput();
    producer.stderr.write(`${OOME_LINE}\n`);
    supervisor.resetOutput();
    expect(supervisor.snapshotOutputSince(stale).markers).toBeUndefined();
    const current = supervisor.checkpointOutput();
    producer.stderr.write("after reset\n");
    expect(supervisor.snapshotOutputSince(current).markers).toBeUndefined();
  });

  it("does not scan when no marker is configured", () => {
    const producer = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      kill: () => false,
    });
    const supervisor = new ProviderProcessSupervisor({
      process: producer,
      ownsProcessLifetime: false,
    });
    cleanups.push(() => supervisor.dispose());
    const checkpoint = supervisor.checkpointOutput();
    producer.stderr.write(`${OOME_LINE}\n`);
    expect(supervisor.snapshotOutputSince(checkpoint).markers).toBeUndefined();
  });
});

describe("ProcessOutputMarkerScanner", () => {
  it("bounds the retained line and omits a prefix it could not keep whole", () => {
    const scanner = new ProcessOutputMarkerScanner(MARKER);
    const prefix = "p".repeat(PROCESS_OUTPUT_MARKER_CONTEXT_BYTES * 3);
    const suffix = `: ${"s".repeat(PROCESS_OUTPUT_MARKER_CONTEXT_BYTES * 3)}`;
    scanner.scan(Buffer.from(prefix.slice(0, 1000)), 0);
    scanner.scan(Buffer.from(prefix.slice(1000)), 1000);
    scanner.scan(Buffer.from(`${MARKER}${suffix.slice(0, 50)}`), prefix.length);
    scanner.scan(
      Buffer.from(`${suffix.slice(50)}\n`),
      prefix.length + MARKER.length + 50,
    );
    const observed = scanner.latestWithin(0, Number.MAX_SAFE_INTEGER);
    expect(observed).toEqual({
      offset: prefix.length,
      line: `${MARKER}${suffix.slice(0, PROCESS_OUTPUT_MARKER_CONTEXT_BYTES)}`,
      truncated: true,
    });
  });

  it("keeps the latest of several markers", () => {
    const scanner = new ProcessOutputMarkerScanner(MARKER);
    const text = `first ${MARKER}\nsecond ${MARKER}: Metaspace\n`;
    scanner.scan(Buffer.from(text), 0);
    expect(scanner.latestWithin(0, text.length)).toEqual({
      offset: text.lastIndexOf(MARKER),
      line: `second ${MARKER}: Metaspace`,
      truncated: false,
    });
  });

  it("does not re-record a marker carried in the line tail", () => {
    const scanner = new ProcessOutputMarkerScanner(MARKER);
    scanner.scan(Buffer.from(`detail ${MARKER}`), 0);
    scanner.scan(Buffer.from(": Java heap space"), `detail ${MARKER}`.length);
    scanner.scan(Buffer.from("\n"), `detail ${MARKER}: Java heap space`.length);
    expect(scanner.latestWithin(0, 100)).toEqual({
      offset: "detail ".length,
      line: `detail ${MARKER}: Java heap space`,
      truncated: false,
    });
  });
});
