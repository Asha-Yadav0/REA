#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PrivateRuntimeRoot } from "../dist/process/PrivateRuntimeRoot.js";
import { runOwnedCommand } from "../dist/process/OwnedCommand.js";
import { createVerifierRun, completeVerifierRun } from "./lib/verifier-run.mjs";

const AGENTENV_PIN = "agentenv-framework 0.9.1334";
const TEMPLATE_RULES = [
  "after-uid-literal",
  "opaque-token",
  "sibling-variance",
];
const execFileAsync = promisify(execFile);

// Both tools are caller-supplied absolute paths, as every real-* lane names its upstream.
for (const key of ["REA_AGENT_ENV_COMMAND", "REA_DOCKER_COMMAND"])
  if (!isAbsolute(process.env[key] ?? ""))
    throw new Error(
      `verify:agentenv:environment requires absolute ${key}; see docs/testing.md. No dependencies are installed by this verifier.`,
    );
const agentEnv = process.env.REA_AGENT_ENV_COMMAND;
const docker = process.env.REA_DOCKER_COMMAND;
await Promise.all([access(agentEnv), access(docker)]);
const entrypoint =
  process.argv[2] ?? fileURLToPath(new URL("./rea.mjs", import.meta.url));
const checkout = resolve(dirname(entrypoint), "..");
const run = createVerifierRun();
const runtime = await PrivateRuntimeRoot.create({
  prefix: "rea-agentenv-verifier-",
});
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === "string"),
);
const failures = [];
let cases = 0;
const receipt = {};
try {
  const containersBefore = await containers();
  const knownContainers = new Set(containersBefore.map((entry) => entry.id));
  receipt.docker_before = {
    containers: containersBefore.length,
    images: (await imageIds()).length,
  };
  // Source-owned capture: the Grafana-shaped HAR builder the view tests use.
  const { environmentManifestHar } = await import(
    new URL("../tests/fixtures/historicalHar.ts", import.meta.url).href
  );
  const harPath = join(runtime.path, "capture.har");
  await writeFile(harPath, JSON.stringify(environmentManifestHar()));
  const capture = await cli(
    "inspect-web-network-capture",
    harPath,
    "har",
    "--format",
    "json",
  );
  assert.equal(capture.operation, "inspect_web_network_capture");
  assert.equal(capture.normalized_result.total_records, 28);
  cases++;
  const viewPath = join(runtime.path, "view.json");
  await writeFile(
    viewPath,
    JSON.stringify({
      source: { kind: "inline", evidence: capture },
      view: { kind: "environment-manifest", template_rules: TEMPLATE_RULES },
    }),
  );
  const manifest = await cli(
    "inspect-analysis-view",
    viewPath,
    "--format",
    "json",
  );
  assert.equal(manifest.normalized_result.kind, "environment-manifest");
  assert.equal(
    manifest.normalized_result.parent_evidence_id,
    capture.evidence_id,
  );
  assert.equal(manifest.normalized_result.name, "grafana-example");
  const toolCount = manifest.normalized_result.tools.length;
  assert.ok(toolCount > 0);
  cases++;
  const capturePath = join(runtime.path, "capture.json");
  const manifestPath = join(runtime.path, "manifest.json");
  await writeFile(capturePath, JSON.stringify(capture));
  await writeFile(manifestPath, JSON.stringify(manifest));
  // The lane proves this checkout, not the registry package: pack it and install the tarball in the image.
  const { stdout: packed } = await execFileAsync(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", runtime.path],
    { cwd: checkout, env: environment, maxBuffer: 16 * 1024 * 1024 },
  );
  const tarball = join(runtime.path, packedFilename(JSON.parse(packed)));
  await access(tarball);
  const bundle = join(runtime.path, "grafana-example");
  const exported = await cli(
    "environment-export",
    manifestPath,
    "--evidence",
    capturePath,
    bundle,
    "--package-tarball",
    tarball,
  );
  assert.equal(exported.status, "exported");
  assert.equal(exported.name, "grafana-example");
  assert.equal(exported.tool_count, toolCount);
  assert.equal(exported.package_source.kind, "tarball");
  assert.deepEqual(exported.files.map((file) => file.path).sort(), [
    "README.md",
    "artifacts/check_grafana-example/verify.py",
    "envs/grafana-example/Dockerfile",
    "envs/grafana-example/env.toml",
    "envs/grafana-example/evidence.json",
    "envs/grafana-example/manifest.json",
    "envs/grafana-example/rea-agents.tgz",
    "tasks/smoke.json",
  ]);
  assert.equal(
    await readFile(join(bundle, "envs/grafana-example/manifest.json"), "utf8"),
    await readFile(manifestPath, "utf8"),
  );
  const dockerfile = await readFile(
    join(bundle, "envs/grafana-example/Dockerfile"),
    "utf8",
  );
  assert.ok(dockerfile.includes("COPY rea-agents.tgz /tmp/"));
  assert.ok(dockerfile.includes("/tmp/rea-agents.tgz"));
  cases++;
  // The agentenv runner builds the image, deploys it on the local sandbox and runs the verifier.
  // Bounded well under the 30-minute job so a hung run ends with this receipt, not the runner's kill.
  const started = Date.now();
  const snapshot = await runOwnedCommand(
    {
      command: agentEnv,
      arguments: ["run", bundle, "--sandbox", "local"],
      cwd: runtime.path,
      runId: `rea-agentenv-run-${randomUUID()}`,
      hostEnvironment: environment,
    },
    { timeoutMs: 15 * 60_000, diagnosticBytes: 4 * 1024 * 1024 },
  );
  receipt.agent_env_run = {
    exit_code: snapshot.exitCode,
    seconds: Math.round((Date.now() - started) / 1000),
    stdout_tail: snapshot.stdout.text.trim().split("\n").slice(-6),
  };
  assert.equal(snapshot.exitCode, 0);
  assert.match(snapshot.stdout.text, /tasks\/smoke\.json v\d+: passed/u);
  assert.match(
    snapshot.stdout.text,
    new RegExp(
      `replay: listed ${String(toolCount)} tools, expected ${String(toolCount)};`,
      "u",
    ),
  );
  cases++;
  const containersAfter = await containers();
  const added = containersAfter.filter(
    (entry) => !knownContainers.has(entry.id),
  );
  const helpers = added.filter((entry) => IMAGE_STORE_HELPER.test(entry.name));
  const leaked = added.filter((entry) => !IMAGE_STORE_HELPER.test(entry.name));
  receipt.docker_after = {
    containers: containersAfter.length,
    images: (await imageIds()).length,
    image_store_helpers: helpers.map((entry) => entry.name),
    new_containers: leaked.map((entry) => `${entry.id} ${entry.name}`),
  };
  assert.deepEqual(leaked, []);
  cases++;
} catch (cause) {
  failures.push(cause);
} finally {
  try {
    await runtime.close();
  } catch (cause) {
    failures.push(cause);
  }
}
const verifier = await completeVerifierRun(run);
try {
  assert.equal(verifier.process_lineage.status, "verified");
  assert.deepEqual(verifier.process_lineage.descendants, []);
} catch (cause) {
  failures.push(cause);
}
if (failures.length > 0) {
  console.error(
    JSON.stringify(
      { status: "failed", public_cases: cases, ...receipt, verifier },
      null,
      2,
    ),
  );
  throw new AggregateError(
    failures,
    "Environment bundle verification failed; export, run and cleanup failures are retained.",
  );
}
console.log(
  JSON.stringify(
    {
      status: "passed",
      public_cases: cases,
      upstream: AGENTENV_PIN,
      runner: `${process.platform} ${process.arch}; host Docker`,
      offline: false,
      ...receipt,
      verifier,
    },
    null,
    2,
  ),
);

async function cli(...args) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [entrypoint, ...args, "--json"],
    { env: environment, cwd: runtime.path, maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

// npm 11 prints `npm pack --json` as a one-element array; npm 12 keys the same record by package name.
function packedFilename(report) {
  const record = Array.isArray(report) ? report[0] : Object.values(report)[0];
  assert.equal(typeof record?.filename, "string");
  return record.filename;
}

// Containers are not verifier descendants, so leaks are checked by id against the pre-run set.
// The framework's local image store keeps its registry:2 helper running across runs; a first
// run on a fresh host creates it, so it is reported separately rather than counted as a leak.
const IMAGE_STORE_HELPER = /^agentenv-registry(?:-\d+)?$/u;

async function containers() {
  const { stdout } = await execFileAsync(
    docker,
    ["ps", "-a", "--format", "{{.ID}}\t{{.Names}}"],
    { env: environment },
  );
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [id, name = ""] = line.split("\t");
      return { id, name };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

async function imageIds() {
  const { stdout } = await execFileAsync(docker, ["images", "-q"], {
    env: environment,
  });
  return [...new Set(stdout.split("\n").filter((line) => line.length > 0))];
}
