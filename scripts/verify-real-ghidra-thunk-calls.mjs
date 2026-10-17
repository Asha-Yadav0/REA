import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parseEvidence } from "../dist/domain/evidence.js";
import { requireMcpOperationResult } from "./lib/mcp-verifier-results.mjs";
import { completeVerifierRun, createVerifierRun } from "./lib/verifier-run.mjs";

// Calls between exported functions of an ELF -fPIC shared library reach their
// target through a PLT thunk. Mach-O dylibs bind those calls directly, so this
// lane needs a Linux ELF toolchain.
if (
  process.env.GHIDRA_INSTALL_DIR === undefined ||
  process.platform !== "linux"
)
  throw new Error(
    "The thunk call lane requires BYO Ghidra and a C compiler on Linux.",
  );
const execute = promisify(execFile);
const run = createVerifierRun();
const workspace = await mkdtemp(join(tmpdir(), "rea-ghidra-thunk-calls-"));
const runtime = join(workspace, "runtime");
await mkdir(runtime);
const env = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  TMPDIR: runtime,
  REA_LOG_LEVEL: "silent",
  REA_ANALYSIS_PROVIDER: "ghidra",
  REA_PROCESS_RUN_ID: run.run_id,
  GHIDRA_INSTALL_DIR: process.env.GHIDRA_INSTALL_DIR,
  ...(process.env.JAVA_HOME === undefined
    ? {}
    : { JAVA_HOME: process.env.JAVA_HOME }),
};
const source = fileURLToPath(
  new URL("../tests/conformance/ghidra/shared-thunks.c", import.meta.url),
);
const targetPath = join(workspace, "librea-ghidra-shared.so");
let report;
let failure;
try {
  await execute(process.env.REA_CC ?? "cc", [
    "-shared",
    "-fPIC",
    "-O0",
    "-fno-inline",
    source,
    "-o",
    targetPath,
  ]);
  const original = await readFile(targetPath);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["scripts/rea.mjs", "mcp"],
    cwd: process.cwd(),
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "rea-ghidra-thunk-calls", version: "1" });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-262144);
  });
  let calls = 0;
  const call = async (name, args = {}) => {
    const response = await client.callTool(
      { name, arguments: args },
      { timeout: 180000 },
    );
    await writeFile(
      join(workspace, `${++calls}-${name}.json`),
      JSON.stringify(response, null, 2),
    );
    return requireMcpOperationResult(response, name);
  };
  try {
    await client.connect(transport);
    await call("open_binary", { path: targetPath, provider_id: "ghidra" });
    const procedures = await call("list_procedures");
    const named = (name) => procedures.filter(({ value }) => value === name);
    const leaf = named("rea_ghidra_shared_leaf").find(
      ({ procedure }) => !procedure.thunk && !procedure.external,
    );
    const thunk = named("rea_ghidra_shared_leaf").find(
      ({ procedure }) =>
        procedure.thunk && procedure.thunk_target === leaf?.address,
    );
    const entry = named("rea_ghidra_shared_entry").find(
      ({ procedure }) => !procedure.thunk && !procedure.external,
    );
    assert.ok(
      leaf && thunk && entry,
      `The fixture has no PLT thunk for its leaf; the compiler may have bound the call directly: ${JSON.stringify(named("rea_ghidra_shared_leaf"))}`,
    );
    const callers = await call("procedure_callers", {
      procedure: leaf.address,
    });
    assert.ok(callers.includes(entry.address), JSON.stringify(callers));
    assert.ok(!callers.includes(thunk.address), JSON.stringify(callers));
    const thunkCallees = await call("procedure_callees", {
      procedure: thunk.address,
    });
    assert.ok(
      thunkCallees.includes(leaf.address),
      JSON.stringify(thunkCallees),
    );
    const dossier = await call("analyze_function", { procedure: leaf.address });
    const dossierCallers = dossier.callers.map(({ address }) => address);
    assert.ok(
      dossierCallers.includes(entry.address),
      JSON.stringify(dossierCallers),
    );
    await call("close_binary");
    const cli = await execute(
      process.execPath,
      [
        "scripts/rea.mjs",
        "function",
        targetPath,
        leaf.address,
        "--provider",
        "ghidra",
        "--format",
        "json",
      ],
      { env, timeout: 180000, maxBuffer: 32 * 1024 * 1024 },
    );
    assert.deepEqual(
      parseEvidence(JSON.parse(cli.stdout)).normalized_result.callers.map(
        ({ address }) => address,
      ),
      dossierCallers,
    );
    assert.deepEqual(await readFile(targetPath), original);
    report = {
      status: "passed",
      entry: entry.address,
      leaf: leaf.address,
      thunk: thunk.address,
      callers,
      thunk_callees: thunkCallees,
      dossier_callers: dossierCallers,
      cli_mcp_parity: true,
      source_unchanged: true,
      scope:
        "Real Ghidra analysis of a source-owned ELF -fPIC shared library through MCP and the CLI. No target execution; Mach-O and PE thunks are not exercised.",
    };
  } finally {
    await client.close();
    await transport.close();
    await writeFile(join(workspace, "server.stderr"), stderr);
  }
} catch (cause) {
  failure = cause;
}
const completed = await completeVerifierRun(run);
if (
  completed.process_lineage.status !== "verified" ||
  completed.process_lineage.descendants.length !== 0
)
  throw new Error(`Cleanup unverified; retained workspace: ${workspace}`, {
    cause: failure,
  });
if (failure !== undefined)
  throw new Error(
    `Thunk call verification failed; retained workspace: ${workspace}`,
    { cause: failure },
  );
await rm(workspace, { recursive: true, force: true });
console.log(JSON.stringify({ ...completed, report }, null, 2));
