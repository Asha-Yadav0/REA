// Exploratory only: not imported by REA or included in its npm package.
import { isUtf8 } from "node:buffer";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isSafeNumber,
  LosslessNumber,
  parse as parseLossless,
} from "lossless-json";
import { z } from "zod";
import {
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisProtocolError,
  AnalysisResourceConstraintError,
} from "../../dist/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../dist/domain/analysisErrorProjection.js";
import { err, ok } from "../../dist/domain/result.js";
import {
  jsonValueValidationIssue,
  MAX_JSON_DEPTH,
} from "../../dist/domain/jsonValue.js";
import { runOwnedCommand } from "../../dist/process/OwnedCommand.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../../dist/process/ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "../../dist/process/ProcessOwnership.js";

// Match the existing reverse-command capture budget; this is not a token budget.
const MAX_BYTES = 16 * 1024 * 1024;
const command = z
  .string()
  .min(1)
  .regex(/^[^\r\n\u0000]+$/u);
const requestSchema = z.strictObject({
  cmd: command,
  json: z.boolean().optional(),
  trim: z.boolean().optional(),
});
const batch = { commands: z.array(z.union([command, requestSchema])).min(1) };
const local = {
  path: z.string().min(1),
  executable: z.string().min(1).optional(),
  settings: z
    .record(
      z.string().regex(/^[a-z][a-z0-9_.]*$/u),
      z.union([
        z.boolean(),
        z.number().finite(),
        z.string().regex(/^[a-zA-Z0-9_.:/ +-]*$/u),
      ]),
    )
    .optional(),
};
export const connectionSchema = z.discriminatedUnion("transport", [
  z.strictObject({ transport: z.literal("exec"), ...local }),
  z.strictObject({ transport: z.literal("r2pipe"), ...local }),
  z.strictObject({ transport: z.literal("r2mcp"), ...local }),
  z.strictObject({
    transport: z.literal("http"),
    endpoint: z.string().url(),
  }),
]);
const inputSchema = z.discriminatedUnion(
  "transport",
  connectionSchema.options.map((schema) => schema.extend(batch)),
);
const retainedOwners = new Set();

/** Settle observed output before stop() releases the supervisor's event listeners. */
export async function stopAndDrain(owner) {
  const cleanup = await owner.launch.cleanup();
  if (!cleanup.cleaned) return { status: "incomplete", reason: cleanup.reason };
  if (!(await owner.waitForExit(1_000)))
    return { status: "incomplete", reason: "Provider exit remains unobserved" };
  if (!(await owner.waitForOutputClose(1_000)))
    return {
      status: "incomplete",
      reason: "Provider output remains unsettled",
    };
  return owner.stop({ cleanupResult: cleanup });
}

/** Retry rather than discard an owner whose cleanup could not be verified. */
export async function retryCleanup() {
  for (const owner of retainedOwners) {
    const stopped = await stopAndDrain(owner);
    if (stopped.status !== "incomplete") {
      retainedOwners.delete(owner);
    }
  }
  return retainedOwners.size;
}

function decoded(bytes) {
  const invalid_utf8 = !isUtf8(bytes);
  return {
    text: bytes.toString("utf8"),
    bytes: bytes.length,
    invalid_utf8,
    ...(invalid_utf8 ? { base64: bytes.toString("base64") } : {}),
  };
}

function protocolText(output) {
  if (output.invalid_utf8 || output.invalidUtf8)
    throw new AnalysisProtocolError("Protocol JSON contains invalid UTF-8", {
      partialObservation: { raw_reply: output },
    });
  return output.text;
}

// One owner decodes r2pipe2 for every carrier; logs are distinct from process stderr.
const replySchema = z
  .object({
    error: z.boolean(),
    code: z.number().finite(),
    value: z
      .union([
        z.number().finite(),
        z.string().regex(/^(?:-?\d+|0x[\da-f]+)$/iu),
      ])
      .optional(),
    res: z.unknown().optional(),
    logs: z
      .array(
        z
          .object({
            type: z.string(),
            message: z.string(),
            origin: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

// Preserve native strings. Unsafe JSON numbers become exact strings with their
// original type and spelling identified by JSON Pointer, outside the envelope.
function losslessJson(text) {
  const root = { value: parseLossless(text) };
  const numeric_literals = [];
  const pending = [{ owner: root, key: "value", pointer: "", depth: 0 }];
  while (pending.length) {
    const { owner, key, pointer, depth } = pending.pop();
    if (depth > MAX_JSON_DEPTH)
      throw new Error(`JSON exceeds ${MAX_JSON_DEPTH} levels`);
    const value = owner[key];
    if (value instanceof LosslessNumber) {
      if (isSafeNumber(value.value)) owner[key] = Number(value.value);
      else {
        owner[key] = value.value;
        numeric_literals.push({
          pointer,
          producer_type: "json-number",
          literal: value.value,
        });
      }
    } else if (value !== null && typeof value === "object") {
      for (const child of Object.keys(value)) {
        const escaped = child.replaceAll("~", "~0").replaceAll("/", "~1");
        pending.push({
          owner: value,
          key: child,
          pointer: `${pointer}/${escaped}`,
          depth: depth + 1,
        });
      }
    }
  }
  return { value: root.value, numeric_literals };
}

function r2pipe2Reply(output) {
  const text = protocolText(output);
  let reply;
  let numeric_literals;
  try {
    ({ value: reply, numeric_literals } = losslessJson(text));
  } catch (cause) {
    throw new AnalysisProtocolError(
      "Malformed r2pipe2 JSON; command was not retried",
      {
        cause,
        partialObservation: { raw_reply: text },
      },
    );
  }
  const issue = jsonValueValidationIssue(reply);
  if (issue !== undefined || !replySchema.safeParse(reply).success)
    throw new AnalysisProtocolError("Invalid r2pipe2 envelope", {
      partialObservation: { raw_reply: text },
    });
  const r2pipe2 = {
    ...reply,
    command_outcome:
      reply.error ||
      reply.code !== 0 ||
      reply.logs?.some((log) => ["ERROR", "FATAL"].includes(log.type))
        ? "reported_error"
        : "no_error_reported",
  };
  return {
    r2pipe2,
    ...(numeric_literals.length ? { numeric_literals } : {}),
  };
}

const encode = (command) =>
  JSON.stringify(
    typeof command === "string"
      ? { cmd: command, json: false, trim: false }
      : command,
  );

/** Continuously drain the protocol stream, including after a decoder rejects a frame. */
function frames(stream, separator) {
  let parts = [];
  let size = 0;
  let queuedBytes = 0;
  const queue = [];
  let waiting;
  let failure;
  const partial = () => ({
    unterminated_frame: decoded(Buffer.concat(parts, size)),
  });
  const fail = (cause) => {
    failure ??= cause;
    waiting?.reject(failure);
    waiting = undefined;
  };
  stream.on("data", (chunk) => {
    if (failure) return;
    let offset = 0;
    while (offset < chunk.length) {
      const end = chunk.indexOf(separator, offset);
      const part = chunk.subarray(offset, end < 0 ? chunk.length : end);
      if (size + part.length + queuedBytes > MAX_BYTES || queue.length >= 16) {
        fail(
          new AnalysisResourceConstraintError(
            "radare2_probe",
            "transport",
            "Provider frame queue exceeds capture budget",
            { max_bytes: MAX_BYTES, max_pending_frames: 16 },
          ),
        );
        return;
      }
      parts.push(part);
      size += part.length;
      if (end < 0) break;
      const bytes = Buffer.concat(parts, size);
      if (waiting) {
        waiting.accept(bytes);
        waiting = undefined;
      } else {
        queue.push(bytes);
        queuedBytes += size;
      }
      parts = [];
      size = 0;
      offset = end + 1;
    }
  });
  stream.on("error", fail);
  stream.once("end", () =>
    fail(
      new AnalysisProtocolError("Provider exited before the next frame", {
        partialObservation: partial(),
      }),
    ),
  );
  return {
    next: (signal) => {
      const interrupted = () =>
        new AnalysisOutputError(
          "radare2_probe",
          "Provider frame read interrupted",
          {
            cause: signal.reason,
            partialObservation: partial(),
          },
        );
      if (signal.aborted) return Promise.reject(interrupted());
      const bytes = queue.shift();
      if (bytes !== undefined) {
        queuedBytes -= bytes.length;
        return Promise.resolve(bytes);
      }
      if (failure) return Promise.reject(failure);
      return new Promise((accept, reject) => {
        const abort = () => fail(interrupted());
        const settle = (callback) => (value) => {
          signal.removeEventListener("abort", abort);
          callback(value);
        };
        waiting = { accept: settle(accept), reject: settle(reject) };
        signal.addEventListener("abort", abort, { once: true });
      });
    },
  };
}

function send(stream, value, signal) {
  signal.throwIfAborted();
  return new Promise((accept, reject) => {
    const finish = (error) => {
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else accept();
    };
    const abort = () => finish(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    try {
      stream.write(value + "\n", finish);
    } catch (cause) {
      finish(cause);
    }
  });
}

async function withOwned(
  executable,
  args,
  environment,
  signal,
  record,
  operation,
) {
  const launched = await spawnOwnedProviderProcess({
    command: executable,
    arguments: args,
    runId: randomUUID(),
    env: environment,
    stdin: "pipe",
    signal,
  });
  const owner = new ProviderProcessSupervisor(
    {
      ...launched,
      ownsProcessLifetime: true,
      cleanup:
        launched.cleanup ??
        (() => cleanupOwnedProcessGroup(launched.ownership)),
    },
    { captureStdout: false, maxDiagnosticBytes: MAX_BYTES },
  );
  // Write callbacks report their errors; also consume the stream's error event.
  launched.process.stdin.on("error", () => {});
  let result;
  let failure;
  try {
    result = await operation(launched.process);
  } catch (cause) {
    failure = cause;
  }
  launched.process.stdin.end();
  await owner.waitForExit(1_000);
  const stopped = await stopAndDrain(owner);
  if (stopped.status === "incomplete") {
    retainedOwners.add(owner);
    owner.unref();
    throw new AnalysisOutputError(
      "radare2_probe",
      "Owned provider cleanup remains incomplete",
      {
        cause: failure,
        partialObservation: {
          cleanup: stopped,
          diagnostics: owner.snapshot(),
          primary_failure: failure?.message ?? null,
          primary_partial: failure?.partialObservation ?? null,
        },
      },
    );
  }
  record({ provider_diagnostics: owner.snapshot() });
  if (failure !== undefined) throw failure;
  return result;
}

function httpEndpoint(source) {
  const url = new URL(source);
  if (
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.hash ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new AnalysisInputError("radare2_probe");
  // Pin localhost to loopback while retaining the caller's original URL below.
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url;
}

async function httpCommand(endpoint, command, signal, authorization) {
  return new Promise((accept, reject) => {
    // r2 6.2.5 emits LF-only headers. Use Node's format-aware compatibility parser.
    // This is restricted to an explicit loopback peer and never follows redirects.
    const request = httpRequest(
      endpoint,
      {
        method: "POST",
        signal,
        insecureHTTPParser: true,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Length": Buffer.byteLength(command),
          ...(authorization === undefined
            ? {}
            : { Authorization: authorization }),
        },
      },
      (response) => {
        const parts = [];
        let size = 0;
        response.on("data", (bytes) => {
          if (size + bytes.length > MAX_BYTES) {
            response.destroy(
              new AnalysisResourceConstraintError(
                "radare2_probe",
                "transport",
                "HTTP response exceeds 16 MiB",
                { max_bytes: MAX_BYTES },
              ),
            );
            return;
          }
          parts.push(bytes);
          size += bytes.length;
        });
        response.once("error", (cause) =>
          reject(
            new AnalysisOutputError(
              "radare2_probe",
              "HTTP command completion is unknown; do not retry automatically",
              {
                cause,
                partialObservation: {
                  status: response.statusCode,
                  output: decoded(Buffer.concat(parts, size)),
                },
              },
            ),
          ),
        );
        response.once("end", () =>
          accept({
            status: response.statusCode,
            headers: response.rawHeaders,
            output: decoded(Buffer.concat(parts, size)),
          }),
        );
      },
    );
    request.once("error", reject);
    request.end(command);
  });
}

/** Observe a sequential batch. Results are protocol observations, not REA Evidence. */
export async function probe(input, options = {}) {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return err(new AnalysisInputError("radare2_probe"));
  const selected = parsed.data;
  const environment = { ...(options.environment ?? process.env) };
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? 120_000),
    ...(options.signal === undefined ? [] : [options.signal]),
  ]);
  const transcript = [];
  const priorOwners = new Set(retainedOwners);
  let observedBytes = 0;
  const record = (value) => {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (observedBytes + bytes > MAX_BYTES)
      throw new AnalysisResourceConstraintError(
        "radare2_probe",
        "transport",
        "Batch transcript exceeds 16 MiB",
        { max_bytes: MAX_BYTES },
      );
    observedBytes += bytes;
    transcript.push(value);
  };
  try {
    signal.throwIfAborted();
    if (selected.transport === "http") {
      const endpoint = httpEndpoint(selected.endpoint);
      for (const command of selected.commands) {
        const reply = await httpCommand(
          endpoint,
          encode(command),
          signal,
          options.authorization,
        );
        record({ command, ...reply });
        if (reply.status < 200 || reply.status >= 300)
          throw new AnalysisProtocolError(
            "HTTP command returned an unsuccessful status",
          );
        record({ command, ...r2pipe2Reply(reply.output) });
      }
    } else {
      const path = resolve(selected.path);
      const executable =
        selected.executable ??
        (selected.transport === "r2mcp"
          ? (environment.REA_R2MCP_COMMAND ?? "r2mcp")
          : (environment.REA_R2_COMMAND ?? "r2"));
      const flags = ["-N", "-q", "-e", "scr.color=0", "-e", "scr.utf8=0"];
      const settings = Object.entries(selected.settings ?? {});
      for (const [key, value] of settings) flags.push("-e", `${key}=${value}`);
      if (selected.transport === "exec") {
        for (const command of selected.commands) {
          const output = await runOwnedCommand(
            {
              command: executable,
              arguments: [...flags, "-c", encode(command), path],
              runId: randomUUID(),
              env: environment,
            },
            {
              timeoutMs: options.timeoutMs ?? 120_000,
              diagnosticBytes: MAX_BYTES,
            },
            {
              signal,
              retainCleanup: (owner) => {
                retainedOwners.add(owner);
              },
            },
          );
          record({ command, output });
          record({ command, ...r2pipe2Reply(output.stdout) });
        }
      } else {
        const args =
          selected.transport === "r2pipe"
            ? [...flags, "-0", path]
            : [
                "-r",
                "-N",
                "-c",
                [
                  "e scr.color=0",
                  "e scr.utf8=0",
                  ...settings.map(([key, value]) => `e ${key}=${value}`),
                ].join(";"),
              ];
        await withOwned(
          executable,
          args,
          environment,
          signal,
          record,
          async (child) => {
            const iterator = frames(
              child.stdout,
              selected.transport === "r2pipe" ? 0 : 10,
            );
            const write = (value) => send(child.stdin, value, signal);
            if (selected.transport === "r2pipe") {
              const startup = await iterator.next(signal);
              if (startup.length) record({ startup: decoded(startup) });
              for (const command of selected.commands) {
                await write(encode(command));
                const output = decoded(await iterator.next(signal));
                record({ command, output });
                record({ command, ...r2pipe2Reply(output) });
              }
            } else {
              let id = 0;
              const rpc = async (method, params) => {
                const requestId = ++id;
                await write(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: requestId,
                    method,
                    params,
                  }),
                );
                for (;;) {
                  const raw = decoded(await iterator.next(signal));
                  const text = protocolText(raw);
                  let reply;
                  try {
                    const decoded = losslessJson(text);
                    reply = decoded.value;
                    if (decoded.numeric_literals.length)
                      record({
                        request_id: requestId,
                        mcp_numeric_literals: decoded.numeric_literals,
                      });
                  } catch (cause) {
                    throw new AnalysisProtocolError("Malformed MCP JSON", {
                      cause,
                      partialObservation: { raw_reply: raw },
                    });
                  }
                  if (!reply || reply.jsonrpc !== "2.0")
                    throw new AnalysisProtocolError("Malformed MCP reply");
                  if (
                    reply.id === undefined &&
                    typeof reply.method === "string"
                  )
                    continue;
                  if (reply.id !== requestId)
                    throw new AnalysisProtocolError(
                      "MCP response identity mismatch",
                    );
                  if (reply.error)
                    throw new AnalysisProtocolError("MCP request failed", {
                      partialObservation: reply,
                    });
                  if (!Object.hasOwn(reply, "result"))
                    throw new AnalysisProtocolError("MCP result missing");
                  return reply.result;
                }
              };
              await rpc("initialize", {
                protocolVersion: "2024-11-05",
                capabilities: {},
                clientInfo: {
                  name: "rea-radare2-transport-probe",
                  version: "0",
                },
              });
              await write(
                JSON.stringify({
                  jsonrpc: "2.0",
                  method: "notifications/initialized",
                }),
              );
              const catalog = await rpc("tools/list", {});
              for (const name of ["open_file", "run_command"])
                if (!catalog.tools?.some((tool) => tool.name === name))
                  throw new AnalysisProtocolError(
                    `Required named r2mcp tool unavailable: ${name}`,
                  );
              const call = async (name, arguments_) => {
                const reply = await rpc("tools/call", {
                  name,
                  arguments: arguments_,
                });
                record({ tool: name, arguments: arguments_, reply });
                if (reply.isError === true)
                  throw new AnalysisProtocolError("r2mcp tool failed");
                return reply;
              };
              await call("open_file", { file_path: path });
              const properties = catalog.tools.find(
                (tool) => tool.name === "run_command",
              ).inputSchema?.properties;
              for (const command of selected.commands) {
                const reply = await call("run_command", {
                  command: encode(command),
                  ...(properties?.page_size ? { page_size: 10_000 } : {}),
                });
                const text = reply.content?.filter(
                  (block) => block.type === "text",
                );
                if (text?.length !== 1 || typeof text[0].text !== "string")
                  throw new AnalysisProtocolError(
                    "r2mcp did not return one text block; raw result retained",
                  );
                record({ command, ...r2pipe2Reply({ text: text[0].text }) });
              }
            }
          },
        );
      }
    }
    if ([...retainedOwners].some((owner) => !priorOwners.has(owner)))
      throw new AnalysisOutputError(
        "radare2_probe",
        "Cleanup owner retained for retry",
      );
    return ok({
      transport: selected.transport,
      input: selected,
      transcript,
      target_identity: "unverified",
      completion: "responses_received",
      cleanup:
        selected.transport === "http" ? "external_session_unowned" : "complete",
    });
  } catch (cause) {
    if (cause?.cleanupOwner) retainedOwners.add(cause.cleanupOwner);
    return err(
      new AnalysisOutputError(
        "radare2_probe",
        "Transport probe failed; command effects may be incomplete",
        {
          cause,
          partialObservation: {
            transport: selected.transport,
            transcript,
            provider_partial:
              cause?.partialObservation ?? cause?.snapshot ?? null,
            failure: {
              tag: cause?._tag ?? cause?.name ?? "unknown",
              message: cause?.message ?? "unknown",
            },
            cleanup_owners_retained: retainedOwners.size,
            completion: "unknown",
          },
        },
      ),
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input;
  try {
    input = JSON.parse(process.argv[2] ?? "null");
  } catch {
    input = null;
  }
  const result = await probe(input);
  console.log(
    JSON.stringify(
      result.ok
        ? result
        : { ok: false, error: projectAnalysisError(result.error) },
    ),
  );
  if (!result.ok) process.exitCode = 1;
}
