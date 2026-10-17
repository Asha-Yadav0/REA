# Local radare2 / Ghidra task comparison

This experiment compares complete static investigations and a separate fixed
query workload. It does not register a provider or approve integration. The REA
radare2 lanes use [PR #3521](https://github.com/morluto/rea/pull/3521) at
`16b98bd1f1205564b66f942b9f21e11e925282e8`; they are complementary to this draft.
Direct r2mcp results are upstream baselines, not an implemented REA r2mcp adapter.

## Completed problem results

One Codex trial per problem/lane; seconds include reasoning, tools and cleanup. All answers were checked afterward against the finite oracles below.

| Lane         | Branch s | SQLite s | Discovery s | Solved |
| ------------ | -------- | -------- | ----------- | ------ |
| REA r2pipe2  | 30.52    | 31.08    | 44.51       | 3/3    |
| REA one-shot | 29.48    | 25.87    | 34.16       | 3/3    |
| r2mcp raw    | 23.18    | 19.33    | 45.54       | 3/3    |
| r2mcp typed  | 24.98    | 40.19    | 40.81       | 3/3    |
| REA Ghidra   | 39.32    | 90.51    | 55.39       | 3/3    |

## Model tokens per run

Actual Codex usage, with full conversation/schema costs. Cached input is a subset of input; uncached input = input − cached input; reasoning is a subset of output. Total = input + output. These are token counts, not cost estimates.

| Problem / lane           | Input   | Cached input | Uncached input | Output | Reasoning | Total   |
| ------------------------ | ------- | ------------ | -------------- | ------ | --------- | ------- |
| Branch / REA r2pipe2     | 109,724 | 73,344       | 36,380         | 817    | 0         | 110,541 |
| Branch / REA one-shot    | 84,961  | 66,816       | 18,145         | 758    | 17        | 85,719  |
| Branch / r2mcp raw       | 54,272  | 48,256       | 6,016          | 671    | 0         | 54,943  |
| Branch / r2mcp typed     | 96,713  | 75,136       | 21,577         | 736    | 39        | 97,449  |
| Branch / REA Ghidra      | 149,629 | 120,448      | 29,181         | 784    | 12        | 150,413 |
| SQLite / REA r2pipe2     | 132,581 | 115,840      | 16,741         | 705    | 0         | 133,286 |
| SQLite / REA one-shot    | 80,407  | 56,320       | 24,087         | 599    | 0         | 81,006  |
| SQLite / r2mcp raw       | 75,041  | 62,592       | 12,449         | 484    | 0         | 75,525  |
| SQLite / r2mcp typed     | 127,036 | 100,096      | 26,940         | 637    | 53        | 127,673 |
| SQLite / REA Ghidra      | 211,983 | 188,288      | 23,695         | 768    | 18        | 212,751 |
| Discovery / REA r2pipe2  | 248,371 | 189,824      | 58,547         | 1,398  | 11        | 249,769 |
| Discovery / REA one-shot | 149,883 | 120,448      | 29,435         | 1,125  | 13        | 151,008 |
| Discovery / r2mcp raw    | 216,507 | 192,000      | 24,507         | 1,265  | 64        | 217,772 |
| Discovery / r2mcp typed  | 188,506 | 165,760      | 22,746         | 1,324  | 29        | 189,830 |
| Discovery / REA Ghidra   | 318,001 | 278,528      | 39,473         | 1,459  | 13        | 319,460 |

## Local resources per agent run

CPU = local child-family user + system seconds. RSS is a sampled estimate in MiB; remote model resources are excluded. Calls include setup, follow-ups and close. Exact tool/argument repetitions remain in the data; they can refer to different lifecycle states.

| Problem / lane           | CPU s | Peak RSS MiB | MCP calls | Denied samples |
| ------------------------ | ----- | ------------ | --------- | -------------- |
| Branch / REA r2pipe2     | 4.00  | 887          | 4         | 0              |
| Branch / REA one-shot    | 5.29  | 890          | 2         | 9              |
| Branch / r2mcp raw       | 1.20  | 299          | 4         | 0              |
| Branch / r2mcp typed     | 1.32  | 324          | 8         | 0              |
| Branch / REA Ghidra      | 18.66 | 1465         | 6         | 1              |
| SQLite / REA r2pipe2     | 3.88  | 894          | 4         | 0              |
| SQLite / REA one-shot    | 5.72  | 899          | 2         | 6              |
| SQLite / r2mcp raw       | 1.11  | 285          | 4         | 0              |
| SQLite / r2mcp typed     | 14.47 | 393          | 9         | 0              |
| SQLite / REA Ghidra      | 95.99 | 2343         | 5         | 0              |
| Discovery / REA r2pipe2  | 4.43  | 896          | 8         | 0              |
| Discovery / REA one-shot | 6.13  | 898          | 3         | 9              |
| Discovery / r2mcp raw    | 1.60  | 366          | 8         | 0              |
| Discovery / r2mcp typed  | 1.61  | 362          | 20        | 0              |
| Discovery / REA Ghidra   | 18.94 | 1501         | 10        | 1              |

## Fixed MCP retrieval workload

Three fresh sessions per lane/target; median and min–max. Warm cells cover nine repeats. This table measures requested retrieval, not semantic problem completion. The six SQLite REA r2pipe2/one-shot runs did not inline the version string and need a follow-up dereference; their literal check failed. All 30 runs completed their requested calls without tool errors or observed leftover children.

| Target / lane         | First retrieval s      | Warm retrieval ms               | CPU s / full run | Max sampled RSS MiB |
| --------------------- | ---------------------- | ------------------------------- | ---------------- | ------------------- |
| Branch / REA r2pipe2  | 4.524 [4.261–5.627]    | 18.339 [16.654–23.405]          | 5.71             | 1260                |
| Branch / REA one-shot | 4.867 [4.633–6.413]    | 729.276 [707.071–1300.398]      | 8.93             | 1271                |
| Branch / r2mcp raw    | 0.317 [0.317–0.404]    | 15.587 [15.281–19.920]          | 0.53             | 151                 |
| Branch / r2mcp typed  | 0.374 [0.314–0.404]    | 17.391 [15.503–22.184]          | 0.55             | 151                 |
| Branch / REA Ghidra   | 10.008 [9.848–12.921]  | 10.299 [9.063–12.351]           | 16.67            | 1696                |
| SQLite / REA r2pipe2  | 17.802 [14.124–17.909] | 15.803 [13.493–17.728]          | 19.38            | 1135                |
| SQLite / REA one-shot | 16.315 [14.742–18.810] | 13452.965 [10562.408–14003.141] | 58.61            | 1131                |
| SQLite / r2mcp raw    | 10.383 [10.214–13.109] | 11.847 [11.337–15.263]          | 10.63            | 213                 |
| SQLite / r2mcp typed  | 10.353 [10.253–13.166] | 13.387 [12.039–16.682]          | 10.62            | 214                 |
| SQLite / REA Ghidra   | 49.703 [48.161–57.630] | 6.823 [5.877–9.641]             | 75.84            | 2715                |

SDK CPU/RSS covers startup, first query, three repeats and cleanup. Byte counts, complete per-run resource records, model answers, call arguments, Evidence IDs, target hashes and the selected configuration are in [the results JSON](benchmark-2026-10-15.json). Raw transcripts and failed/configuration pilot runs remain under `/tmp/rea-r2-ghidra-benchmark-20261015`; they are excluded from these tables.

## What these runs show

The fastest task lane changes with the question. Direct r2mcp raw completed the
branch and SQLite tasks fastest in this cohort, while REA one-shot completed
discovery fastest and used fewer total tokens than the retained REA session on
all three tasks. Extra agent calls can outweigh process reuse on small targets.
The fixed repeated queries separately demonstrate the value of retained analysis:
the SQLite one-shot median is 13.45 seconds per repeat versus 15.80 milliseconds
through the retained REA session. That comparison covers retrieval, including
the explicitly incomplete version-string coverage above.

Analysis scope matters more than startup alone. The raw-command agents read the
known SQLite instructions and literal without `aa`; the typed r2mcp agent chose
whole-symbol analysis and found 2,765 functions. Its anchored string search
missed an adjacent packed literal; it closed, reopened and broadened the search.
All those calls are included. Expose analysis scope and filtered, address-bearing
facts in a future adapter rather than silently running stronger analysis.

Correctness required reading assembly in addition to pseudocode. Ghidra rendered
the stripped branch wrapper as `void`; both decompiler pipelines produced a
`void` callback wrapper/indirect-flow warning. The agents recovered return
propagation from the tail-transfer instructions. The r2 typed branch run also
rejected an inferred `callee(0x0)` annotation contradicted by the registers.
These finite successes do not establish general decompiler accuracy.

The r2mcp typed discovery run completed without raw fallback, using 20 calls
versus 8 for direct raw r2mcp, but fewer total model tokens (189,830 versus
217,772). Typed inputs alone do not establish smaller context. String tools
return text without addresses, and the basic-analysis string xref lookups were
empty; successful discovery used function inventories and instruction reads.
Ghidra's richer function dossiers preserve more typed Evidence, with higher
observed context/resource costs here. Direct r2mcp does not supply REA Evidence
IDs; REA raw-command Evidence reports artifact identity unavailable. The local
before/after hashes do not upgrade those identity claims.

All 15 agent runs exited successfully, retained the same target digests, closed
their sessions, and left no observed child processes. No rejected MCP calls or
reported native command errors were observed. Empty searches and decompiler
warnings remain in the recorded observations. Two identical Ghidra branch
dossier calls were repeated; their time and tokens remain included. Color-free
output was checked, but no before/after token-saving percentage was measured.

The proposal turns these observations into [explicit routing and analysis
recommendations](../../docs/radare2-proposal.md#proposed-defaults-informed-by-the-task-runs):
focused reads without blanket analysis, one-shot batches for bounded questions,
retained cores for continuing work, and reuse of existing Evidence and selected
connections. These are proposed policies; this report does not measure their
combined improvement or enable a new runtime default.

Token comparisons need both totals and cache breakdowns. For SQLite, retained
REA used 133,286 total tokens versus one-shot's 81,006, but less uncached input
(16,741 versus 24,087). Ghidra's uncached input was 23,695 despite its larger
212,751 total. The recorded counts establish context usage; no billing-cost
ranking was measured. A future A/B should control task scope and capture
equivalent Evidence before attributing an improvement to a transport or backend.

## Workloads and independent answers

The targets are an optimized, stripped ARM64 Mach-O built from
[`inventory.c`](../../tests/conformance/ghidra/inventory.c), and an installed
SQLite 3.54.0 ARM64 dylib. No target was executed. The fixture was built with
`cc -O2 -g -fno-inline`, copied, then stripped with `/usr/bin/strip`.

1. **Branch recovery:** supplied two addresses; explain signed conditional
   negation, a tail call, the callee's marker, and returns for 7 and 15 when the
   global is 7. The source oracle is `value > 10 ? leaf(value) : leaf(-value)`,
   with `leaf(v) = v + global`; answers are 0 and 22 and the marker is
   `REA_GHIDRA_LEAF_VALUE`.
2. **String-led discovery:** supplied only `REA_GHIDRA_INVENTORY_ENTRY`;
   discover its referencing function and follow the three computed terms.
   They are `branch(35) = 42`, `indirect(leaf, 0) = 7`, and
   `dense_switch(100, 0) = -1`; the function adds 1 and returns 49. The callback
   target and out-of-range switch result must be established, not guessed.
3. **SQLite inspection:** supplied the addresses of `sqlite3_libversion` and
   `sqlite3_threadsafe`; recover `"3.54.0"` and integer 1 and distinguish a
   build-time mutex setting from live connection/thread behavior. Independent
   Apple `otool` disassembly shows a pointer to `0xf61f9` and `mov w0, #1; ret`;
   the literal bytes at that pointer are `33 2e 35 34 2e 30 00`.

The parent agent reviewed answers against those finite oracles and actual tool
observations; this is not an independent human evaluation.
Literal-presence SDK checks alone do not establish semantic correctness. A
missing, incorrect or ungrounded requested result is not counted as a solved
problem. Addresses and target digests are recorded with each run.

## Scope and measurement

The host is macOS 27.0.1 ARM64, with 10 logical CPUs and 32 GiB RAM. The client
is Codex CLI 0.162.1, requested model `gpt-6.1-sol`, reasoning `medium`, using
Node 24.18.0 and MCP client 2.3.1. Model service revision, prompt caching and
network latency are not controlled; reported usage includes the Codex base
instructions and tool schemas, not just target output.
The pinned PR used the benchmark checkout's dependency installation through a
symlink. Common locked package versions agree; the benchmark lock additionally
contains unused `openpgp` 6.3.2. Both lock hashes are retained in provenance.

Ghidra's official [12.1.4 release](https://github.com/NationalSecurityAgency/ghidra/releases/tag/Ghidra_12.1.4_build)
was downloaded and its SHA-256 checked:
`ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db`.
The archive lacks a macOS native decompiler, so its included source was built
inside the temporary extraction with
`make -j4 ghidra_opt ARCH_TYPE='-arch arm64' OSDIR=mac_arm_64`, then copied to
`Ghidra/Features/Decompiler/os/mac_arm_64/decompile`. Existing ARM64 JDK 27 was
selected. Downloads, builds and doctor checks precede measurement; no unrelated
software or global client configuration was installed or upgraded.

The r2 checkout is `bf69061a9948d7fcf8d08a51a7afa412d9d7c3df`; the installed
development binary still reports the earlier `679075d13e` build banner, so
executable/library hashes identify the actual producers. The r2mcp binary is
built from `64051cb7978f5226e60e04781a0582ab3a753068`, including the independently
merged signed-number correction. r2ghidra is pinned by installed plugin hash;
its nearby source checkout alone does not establish binary source identity.
Neither REA lane depends on the TypeScript/Python r2pipe libraries: these use
REA's native r2pipe2 process adapter. A release of `r2pipe-ts` does not change
these measurements.

All five lanes use the same targets and question text. The model trials expose
only the selected static-analysis MCP tools: no shell, web search, source reads,
target execution or other agents. Each trial starts an ephemeral Codex session
with explicit per-invocation settings and uses the existing CLI login; global
Codex configuration and credentials are neither changed nor copied.

- **REA r2pipe2:** `start_radare2_session`, `radare2_command`, close.
- **REA one-shot:** `execute_radare2_command`; new r2 process for each call.
- **r2mcp raw:** owned stdio server with `-r`, using JSON r2pipe2 requests through
  `run_command`.
- **r2mcp typed:** named analysis, decompilation, assembly, string/function
  inventory, address calculation and incoming-reference tools; no raw fallback.
- **REA Ghidra:** shared native operations, including function dossiers and
  string/reference discovery, with Ghidra 12.1.4.

For task trials, the agent chooses calls, analysis scope, batching and follow-up
reads. Elapsed time covers Codex startup, MCP connection/discovery, reasoning,
all tool calls, failures/retries, final answer generation and session cleanup.
Correctness review is performed afterward; its human/parent-agent time is not
included. These are unattended completed-task timings, not interactive latency.

The separate SDK workload fixes basic `aa` analysis for r2, then asks for two
decompilations and the first function's assembly. Raw lanes batch that query in
one call; typed/Ghidra lanes use three named calls. Its first-query timer starts
before MCP connection/catalog discovery and ends after all requested output.
It excludes initial SDK imports and final cleanup, which remain included in the
whole-run resource measurement. Each fresh session repeats the query three
times. Ghidra may reuse its analyzed/decompiled results; the one-shot lane must
reload and reanalyze. Warm numbers are complete API response times, not isolated
decompiler times. “Cold” means a fresh engine/session with normal OS caches;
filesystem caches are not flushed.

Processes run serially. The Python monitor tracks PID plus creation time and
waits 50 ms between family inspections. Actual intervals include inspection work.
Peak memory is the maximum sum of observed live
RSS, so shared pages may be counted more than once and short-lived peaks may
be missed. CPU is local reaped child-family user + system time; sampled family
CPU is retained as a cross-check. Remote model inference CPU/memory, energy,
network traffic, billing and monitor overhead are not measured. Sampling adds
some wall-time overhead. A 600-second / sampled 6-GiB per-run bound is enforced;
any bound or unresolved observed process is reported, not scored as success.
This is a shared interactive host; thermal/power state and other applications
are not controlled. Permission-denied process observations are counted, and RSS
estimates can omit those samples. Reported ranges matter, especially during
sustained library analysis.

`R2_COLOR=0` and `R2_UTF8=0` are explicit. Embedded r2mcp also receives
`e asm.dwarf=false;e scr.utf8=0`; fixed r2 queries use the same settings. The
stripped task target has no source-line shortcut. Earlier source-backed and
configuration smoke runs are excluded from the final comparisons. No claim
about token savings follows from output byte counts: model usage is recorded
from Codex's actual `turn.completed` event, including cached input separately.

## Reproduction and limits

`benchmark.mjs` runs the fixed MCP workload. `benchmark.py` runs either that
workload or real Codex tasks and records local resources. They are explicit
experiments, not package entrypoints. Use the pinned Node/npm toolchain, locked
REA dependencies and a built checkout of the pinned PR. Supply installed r2,
r2ghidra, r2mcp, Codex, Java and Ghidra paths in a JSON configuration; Python
requires `psutil`. REA setup does not install these engines.

The review cleanup fix gives each trial a run token and retains `ownership.json`
beside its output. `benchmark-ownership.mjs` reuses REA's process identity and
cleanup primitives to stop and verify owned groups, including detached children,
after limits, normal exit or measurement failure. The live in-memory ownership
record is passed over stdin; cleanup does not depend on saving or rereading the
manifest. Unverified cleanup attempts to write its reason to `resources.json`
and raises `CleanupIncomplete`, stopping subsequent trials. That error retains
`ownership` and `child` even when manifest or diagnostic writes fail. Python
callers can retry `ownership_command(node, "cleanup", error.ownership)`, then
reap `error.child` after verified cleanup. A successfully saved manifest also
supports an explicit retry with
`node experiments/radare2-transports/benchmark-ownership.mjs cleanup /absolute/path/ownership.json`;
inspect the returned `cleaned` status before continuing. PID reuse or unreadable
identity does not authorize signaling. Prompts use retained file-backed stdin
so a child that does not read cannot block the limit monitor.

New `elapsed_seconds` and child CPU totals include the cleanup helper;
`cleanup_seconds` reports its wall time separately. Ownership preparation runs
before those measurements. Sampled task-family CPU/RSS still cover the workload,
not the separate preparation/cleanup helpers. The historical tables above retain
their original measurements and have not been rerun with this instrumentation.

A macOS arm64 harness comparison on 2026-10-16 used the same Python task
(allocate 8 MiB, sleep 250 ms) before/after this cleanup fix. Each measurement
starts fresh workload/helper processes. “Repeat” reuses host filesystem/compiler
caches; neither a flushed-cache cold run nor a persistent-helper warm run was
measured. Totals include preparation, cleanup and the external 10 ms sampler:

| Revision | Run    | Elapsed (s) | CPU (s) | Sampled family peak RSS (MiB) | Agent tokens |
| -------- | ------ | ----------: | ------: | ----------------------------: | -----------: |
| Before   | First  |       0.405 |   0.354 |                          46.0 |            0 |
| After    | First  |       2.633 |   4.359 |                        ≥276.8 |            0 |
| Before   | Repeat |       0.350 |   0.309 |                          47.0 |            0 |
| After    | Repeat |       2.798 |   4.549 |                        ≥279.9 |            0 |

The new ownership checks cost time and compiler/helper memory. Both after runs
had nine denied RSS observations, so their peaks are lower bounds. All four
tasks completed successfully; the after runs verified cleanup. These two trials
measure harness overhead, not engine or agent performance. Raw measurements are
retained locally at `/private/tmp/rea-pr4148-review/comparison-v2.json`; the first
attempt in `comparison.json` had an interrupted RSS sampler and is not used here.

The 2026-10-17 follow-up measured the same 8 MiB/250 ms task against `561466bd5`
and the in-memory ownership fix on macOS arm64, Node 24.18.0. Total elapsed/CPU
includes ownership preparation, cleanup and the 10 ms RSS sampler:

| Revision | Run    | Elapsed (s) | CPU (s) | Sampled family peak RSS (MiB) | Agent tokens |
| -------- | ------ | ----------: | ------: | ----------------------------: | -----------: |
| Before   | First  |       2.567 |   4.246 |                        ≥279.6 |            0 |
| After    | First  |       2.609 |   4.368 |                        ≥277.6 |            0 |
| Before   | Repeat |       2.570 |   4.215 |                        ≥283.5 |            0 |
| After    | Repeat |       2.568 |   4.215 |                        ≥276.5 |            0 |

All four tasks completed with verified cleanup. RSS is a lower bound because
9–11 observations per run were denied. Every run starts fresh processes; host
caches were not flushed, so these are first/repeat observations, not controlled
cold/warm measurements. Two trials do not establish a performance difference.
Raw measurements are retained at
`/private/tmp/rea-pr4148-followup-b_2e63g3/comparison.json`. No new engine/agent
investigation benchmark or error-response token measurement was performed.

The configuration keys are `node`, `sdk_driver`, `rea3521`, `r2`, `r2mcp`,
`ghidra`, `java`, `codex`, `model`, `reasoning`, `output`, `warm_repeats`, `lanes`
and `targets`. Each target has `id`, `path`, `addresses`, literal SDK `checks`
and an agent `prompt`. Re-resolve addresses for newly compiled binaries.
Retain exact configurations, executable/target hashes and raw outputs privately;
the published data contains selected measurements, answers and provenance.

The final color/UTF-8 prototype update also passed the nine real transport
verification checks, `npm run check:fast`, `npm run docs:check` (including five
README tests), syntax checks and result-integrity checks. The first verifier
attempt was blocked by the sandbox's Swift module-cache restriction; the
authorized unsandboxed rerun passed. These checks do not establish production
provider registration, CLI/MCP parity or untested-platform behavior.

```sh
python3 experiments/radare2-transports/benchmark.py /absolute/path/configuration.json sdk \
  --targets stripped sqlite --trials 3 --label final-sdk
python3 experiments/radare2-transports/benchmark.py /absolute/path/configuration.json agent \
  --targets stripped sqlite discovery --trials 1 --label final-agent
```

These are narrow ARM64 macOS workloads. Direct r2mcp bypasses REA's Evidence,
session and catalog work. Ghidra and r2ghidra use different analysis pipelines
and separately built native decompilers; they do not isolate transport overhead.
The experiment does not compare IDA, Hopper, HTTP/iaito, debugger workflows,
decai/pdc quality, other architectures or whole-program reversing accuracy.
It cannot establish a universal engine ranking or production transport default.
The agent cohort uses one trial per lane/problem and common compact instructions,
not installed provider-specific skills or carefully optimized per-engine prompts.
Selected tool whitelists, repeated calls and agent choices are part of these
observations. They are not optimal lower bounds or statistically stable rankings.
