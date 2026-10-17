# Radare2 transport experiment

This is an isolated prototype for the [transport proposal](../../docs/radare2-proposal.md).
It is not imported by REA, registered in REA's agent catalog, included in the npm package or
an approved provider. It uses REA's existing process supervision and tagged
errors/Result; it does not implement production Evidence or session admission.

The [shared-provider scope and IDA-parity mapping](IDA-PARITY.md) identifies the
14 existing operations, ownership reuse from #3521 and remaining production
verification. Its small, explicitly launched compatibility check constructs
experimental Evidence with REA's existing contracts; it does not exercise
production admission or the Evidence ledger.

The separate [analyst capability prototype](CAPABILITIES.md) exposes CFG,
database layouts, native type synthesis, verified byte reads and value dependencies
through an explicitly launched experimental CLI/MCP server. It is usable for the documented
experiments; it is not enabled by running REA's normal MCP entrypoint.

Its [SQLite capability comparison](CAPABILITY-BENCHMARK.md) reports completed
CFG, type and buffer-flow investigations, including partial answers, a denied
import, corrective runs and all their model tokens and local resources.

The separate [task comparison](BENCHMARK.md) measures actual Codex investigations
and cold/warm MCP workloads through PR #3521, upstream r2mcp and Ghidra.
Its [proposed defaults](../../docs/radare2-proposal.md#proposed-defaults-informed-by-the-task-runs)
distinguish a bounded one-shot read from a continuing session. The probe applies
no implicit `aa`/`aaa`; choose the analysis needed for the question. Reuse a
caller-selected HTTP/iaito or MCP session rather than discarding its analysis.

Use the pinned Node/npm toolchain, install locked dependencies and build first:

```sh
npm ci
npm run build:cached
node experiments/radare2-transports/verify.mjs
```

The explicit verifier requires a C compiler, radare2 with r2ghidra and r2mcp on
`PATH`. `CC`, `REA_R2_COMMAND` and `REA_R2MCP_COMMAND` can select executables.
It compiles `fixture.c` into a private temporary directory without running it,
starts a loopback HTTP fixture and cleans up owned processes. Missing providers
fail the experiment; they are not silently skipped. These checks are separate
from the portable test suite.

For a known-address instruction question, replace the address below with the
selected target's address. No function inventory or decompilation is required:

```sh
node experiments/radare2-transports/probe.mjs '{"transport":"exec","path":"./program","commands":["pd 8 @ 0x1000"]}'
```

For function discovery followed by r2ghidra decompilation in one owned r2pipe2 batch:

```sh
node experiments/radare2-transports/probe.mjs '{"transport":"r2pipe","path":"./program","commands":["aa",{"cmd":"aflj","json":true},"pdg @ main"]}'
```

Other transports are `exec`, `r2mcp`, and `http`. For `http`, replace `path` with
the exact `endpoint`, for example `http://127.0.0.1:9090/cmd/`. For `exec`, each
command runs in a fresh process; include any necessary analysis in that command.
All carriers submit r2pipe2 requests. String commands request text; object
commands preserve explicit `json` and `trim` choices. Responses preserve raw
frames, parsed envelopes and process diagnostics separately. The 16 MiB frame
and transcript budgets follow REA's current reverse-command capture budget;
they do not establish production memory bounds or token savings.

Owned r2 processes start with `scr.color=0` and `scr.utf8=0`; the owned r2mcp
core receives the same settings. `R2_COLOR=0 R2_UTF8=0` also works for standalone
r2 commands. External HTTP cores keep the caller's settings; use an explicit
command or scoped `@e:scr.color=0,scr.utf8=0` when desired. No display filtering
is applied to captured results.

Local connection `settings` are applied before opening the target, for example
`"settings":{"bin.relocs.apply":true}`. Preserve this load-time distinction:
setting `bin.relocs.apply` after opening does not retroactively apply relocation
patches. HTTP connections have no startup settings field and preserve the
already running core's configuration.

`e cfg.json.num=string` is supported, including the r2pipe2 `value` field.
For individual JSON reads, `aflj @e:cfg.json.num=string` scopes the setting to
that command. Native strings retain their type; unsafe unquoted JSON numbers
are decoded as exact strings with separate `numeric_literals` metadata recording
their JSON Pointer, source type and literal. Safe numbers remain numbers.
The verifier also exercises this behavior without changing production REA.

The default deadline is 120 seconds for the whole batch. The programmatic `probe`
accepts a caller `signal`, `timeoutMs`, captured `environment`, and optional HTTP
`authorization`; authorization and ambient environment are not persisted. HTTP
submissions and MCP calls are never automatically replayed. `retryCleanup()`
retains and retries unresolved process owners within the experiment process.
External HTTP sessions remain unowned. Results explicitly leave target identity
unverified. Review the proposal's authority and verification gaps before running
arbitrary commands against a valuable external session.

Writes and frame reads share the batch cancellation signal. Interrupted reads
retain the unfinished frame within the existing capture bound, including base64
when its bytes are not valid UTF-8. Invalid UTF-8 JSON fails before interpretation
on every transport; the exec supervisor exposes its invalid-byte flag and text,
but does not retain base64. Cleanup settles before the analyst queue advances.

The analyst experiment applies one deadline from request submission through
queueing, before/after target digests, transport calls and independent byte
verification. Local hashing and byte verification share regular-file handle
ownership; FIFOs/devices are rejected with a nonblocking open. Cancellation is
checked between bounded reads. An OS filesystem call already in progress and
owned cleanup can extend beyond the deadline.

Completed transport replies, command status, stderr and cleanup remain in the
error's partial observation if final target hashing is cancelled or fails.
The initial digest remains available; `sha256_after` stays `null` until that
verification completes. Target mismatch and prelude failures use the same
observation shape, and interpretation cancellation also preserves captured facts.

Focused fault checks (C compiler required for the synthetic transport fixture):

```sh
node --test experiments/radare2-transports/probe.test.mjs
node --test experiments/radare2-transports/analysis-deadline.test.mjs
python3 experiments/radare2-transports/benchmark_test.py
```

The Python checks require `psutil` and the pinned `node` on `PATH`. They exercise
synthetic process trees, failed/partial manifest writes, failed diagnostic writes
and injected inspection failure, not engine behavior. Cleanup consumes the live
ownership record over stdin. If cleanup remains unverified, `CleanupIncomplete`
retains that record and the child handle even when neither output file was saved.
