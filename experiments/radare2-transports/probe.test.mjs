// Synthetic fault injection through the actual transports and process owner.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { runOwnedCommand } from "../../dist/process/OwnedCommand.js";
import { projectAnalysisError } from "../../dist/domain/analysisErrorProjection.js";
import { probe, retryCleanup } from "./probe.mjs";
import { createAnalysisExperiment } from "./analysis.mjs";
import { retryNativeByteCleanup } from "./native-bytes.mjs";

const root = await mkdtemp(join(tmpdir(), "rea-transport-faults-"));
const executable = join(root, "fault-provider");
before(async () => {
  await runOwnedCommand(
    {
      command: process.env.CC ?? "cc",
      arguments: [
        fileURLToPath(new URL("./transport-fault-fixture.c", import.meta.url)),
        "-o",
        executable,
      ],
      runId: randomUUID(),
    },
    { timeoutMs: 30_000, diagnosticBytes: 1024 * 1024 },
  );
});
after(async () => {
  assert.equal(await retryCleanup(), 0);
  await rm(root, { recursive: true, force: true });
});

function fixture(transport, mode) {
  const ready = join(root, randomUUID());
  return {
    ready,
    connection: { transport, path: executable, executable },
    options: {
      timeoutMs: 5_000,
      environment: {
        ...process.env,
        REA_FAULT_MODE: mode,
        REA_FAULT_TRANSPORT: transport,
        REA_FAULT_READY: ready,
      },
    },
  };
}
async function waitReady(path) {
  for (let attempt = 0; attempt < 500; attempt++) {
    try {
      const pid = Number(await readFile(path, "utf8"));
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch (cause) {
      if (cause.code !== "ENOENT") throw cause;
    }
    await delay(10);
  }
  throw new Error("Fault provider did not start");
}
function cleaned(result) {
  assert.equal(result.ok, false);
  assert.equal(result.error.partialObservation.cleanup_owners_retained, 0);
  const diagnostics = result.error.partialObservation.transcript.find(
    (entry) => entry.provider_diagnostics,
  );
  assert.ok(diagnostics);
  const { exitCode, signal } = diagnostics.provider_diagnostics;
  assert.ok(Number.isInteger(exitCode) || typeof signal === "string");
}

for (const transport of ["r2pipe", "r2mcp"]) {
  test(`${transport}: interrupted partial frame retains exact bytes and cleanup`, async () => {
    const { connection, options, ready } = fixture(transport, "partial");
    const controller = new AbortController();
    const pending = probe(
      { ...connection, commands: ["ij"] },
      { ...options, signal: controller.signal },
    );
    await waitReady(ready);
    await delay(100);
    controller.abort();
    const result = await pending;
    cleaned(result);
    const frame =
      result.error.partialObservation.provider_partial.unterminated_frame;
    assert.equal(frame.invalid_utf8, true);
    assert.deepEqual(
      Buffer.from(frame.base64, "base64"),
      Buffer.concat([Buffer.from('{"res":"partial-'), Buffer.from([255])]),
    );
    assert.equal(result.error.partialObservation.completion, "unknown");
  });
}

test("blocked pipe write cancels before releasing the analyst queue", async () => {
  const { connection, options, ready } = fixture("r2pipe", "blocked");
  const controller = new AbortController();
  const experiment = createAnalysisExperiment(connection, {
    ...options,
    prelude: ["x".repeat(2 * 1024 * 1024)],
  });
  const first = experiment.inspectType(
    { type: "T" },
    { signal: controller.signal },
  );
  const second = experiment.inspectType({ type: "invalid;command" });
  const pid = await waitReady(ready);
  await delay(100);
  controller.abort();
  assert.equal((await first).error._tag, "AnalysisCancelledError");
  assert.equal((await second).error._tag, "AnalysisInputError");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("blocked pipe write observes the batch deadline", async () => {
  const { connection, options } = fixture("r2pipe", "blocked");
  const began = performance.now();
  const result = await probe(
    { ...connection, commands: ["x".repeat(2 * 1024 * 1024)] },
    { ...options, timeoutMs: 1_000 },
  );
  cleaned(result);
  assert.ok(performance.now() - began < 5_000);
});

for (const mode of ["timeout", "missing"]) {
  test(`final hash ${mode} preserves completed replies and leaves verification unknown`, async () => {
    const { connection, options, ready } = fixture(
      "exec",
      `final-hash-${mode}`,
    );
    const path = join(root, randomUUID());
    const source = "selected target";
    await writeFile(path, source);
    const experiment = createAnalysisExperiment(
      { ...connection, path },
      {
        ...options,
        timeoutMs: mode === "timeout" ? 1_500 : 5_000,
        environment: { ...options.environment, REA_FAULT_TARGET: path },
      },
    );
    const result = await experiment.inspectType({ type: "T" });
    assert.equal(result.ok, false);
    assert.equal(
      result.error._tag,
      mode === "timeout" ? "AnalysisCancelledError" : "AnalysisOutputError",
    );
    if (mode === "timeout")
      assert.equal(result.error.cause.name, "TimeoutError");
    else assert.equal(result.error.cause.code, "ENOENT");
    // Exercise the same serializable error projection used by CLI and MCP.
    const projected = JSON.parse(
      JSON.stringify(projectAnalysisError(result.error)),
    );
    const partial = projected.details.partial_observation;
    assert.equal(partial.raw.cleanup, "complete");
    assert.equal(partial.replies[0].res, "completed-native-reply");
    assert.equal(partial.replies[0].command_outcome, "no_error_reported");
    assert.equal(partial.target.path, path);
    assert.equal(
      partial.target.sha256_before,
      createHash("sha256").update(source).digest("hex"),
    );
    assert.equal(partial.target.sha256_after, null);
    assert.match(
      JSON.stringify(partial.raw.transcript),
      /completed-native-stderr/u,
    );
    const pid = await waitReady(ready);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.equal(await retryNativeByteCleanup(), 0);
    assert.equal(
      (await experiment.inspectType({ type: "invalid;command" })).error._tag,
      "AnalysisInputError",
    );
  });
}

for (const transport of ["exec", "r2pipe", "r2mcp", "http"]) {
  test(`${transport}: invalid UTF-8 JSON cannot become normalized facts`, async () => {
    const { connection, options } = fixture(transport, "invalid");
    let server;
    let selected = connection;
    if (transport === "http") {
      server = createServer((_request, response) =>
        response.end(
          Buffer.concat([
            Buffer.from('{"error":false,"code":0,"res":"'),
            Buffer.from([255]),
            Buffer.from('"}'),
          ]),
        ),
      );
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      selected = {
        transport,
        endpoint: `http://127.0.0.1:${server.address().port}/cmd`,
      };
    }
    try {
      const result = await probe({ ...selected, commands: ["ij"] }, options);
      assert.equal(result.ok, false);
      assert.match(result.error.cause.message, /invalid UTF-8/u);
      assert.ok(
        result.error.partialObservation.transcript.every(
          (entry) => !entry.r2pipe2,
        ),
      );
      const raw = result.error.partialObservation.provider_partial.raw_reply;
      assert.equal(raw.invalid_utf8 ?? raw.invalidUtf8, true);
      if (transport !== "exec")
        assert.ok(Buffer.from(raw.base64, "base64").includes(255));
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
    }
  });
}
