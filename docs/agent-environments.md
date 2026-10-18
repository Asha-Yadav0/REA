# Agent environments from recorded captures

Use `rea environment-serve` to serve an environment manifest as an agent
environment: an MCP server whose tools answer from the records of one retained
web network capture, plus the environment card the agentenv framework reads to
discover it. Nothing is fetched from the recorded application; every answer is
retained Evidence. `rea environment-export` writes the same pair as a bundle
folder `agent-env run` builds and runs; see [Export a bundle](#export-a-bundle).

```sh
rea inspect-web-network-capture /absolute/session.har har --format json > capture.json
rea inspect-analysis-view view.json --format json > manifest.json
rea environment-serve manifest.json --evidence capture.json --port 8765
```

The first command inspects the capture; the second projects the
[environment manifest](web-network-captures.md#environment-manifest) view from
it, where `view.json` wraps the capture Evidence as the inline source:

```json
{
  "source": { "kind": "inline", "evidence": { "evidence_id": "ev_…" } },
  "view": {
    "kind": "environment-manifest",
    "template_rules": ["after-uid-literal", "opaque-token", "sibling-variance"]
  }
}
```

The third command serves that manifest. Both served files are complete REA
Evidence JSON as the commands write it with `--format json`; the `evidence`
member of `view.json` is the whole of `capture.json`.

## What a manifest is

An environment manifest is a projection of one application's recorded request
lines into a tool surface: one tool per method and path template on the
primary origin, with inferred path parameters, observed query parameter
names, value-free body shapes and pointers to the parent records each tool
cites. It carries no bodies and no headers. The manifest's
`parent_evidence_id` names the capture Evidence it was projected from; the
serve command refuses a manifest whose parent is not the supplied `--evidence`
file with an `invalid_request` error naming both identifiers, so a manifest can
never be served from records it did not cite.

## What replay means and does not mean

Each MCP tool call selects one of the records its manifest tool cites and
returns that record's recorded response. Selection compares the supplied path
parameters against the record's path segments at the parameter indexes, then
the supplied query values against the record's query string, and keeps the
record with the most matches; ties keep manifest order. The result reports
where the answer came from:

```json
{
  "status": 200,
  "content_type": "application/json",
  "body": { "id": 2, "login": "probe" },
  "replay": {
    "record_ordinal": 5,
    "evidence_id": "ev_…",
    "exact_match": true,
    "recorded_path": "/api/users/2",
    "recorded_query": null,
    "truncated": false
  }
}
```

`exact_match` is true when every supplied path parameter and query value
equals the recorded one; it says nothing about parameters the caller omitted.
When no record matches, the tool still answers from the tool's first cited
record and reports `exact_match: false`. `body` is parsed JSON when the
recorded content type is JSON-like (`application/json`, `application/*+json`,
`text/plain`, `text/markdown`) and the text parses; otherwise it is the
recorded text. Bodies over 256 KiB are cut at a UTF-8 boundary and returned as
text with `truncated: true`. Request bodies passed to `POST`, `PUT` and `PATCH`
tools are accepted and ignored: nothing is written, and no call changes what a
later call returns. Arguments the tool's input schema does not name are
refused by the MCP server as invalid arguments, so a misspelled parameter never
degrades into an omitted one.

Replay is not emulation. A served environment does not establish the
application's authorization model, response semantics or state transitions,
which the manifest lists as unknowns; it does not validate supplied values; and
it does not answer requests the capture never recorded. Replayed content is
target content: every tool result carries
`_meta.provenance.untrusted_content: true` with `source: "analysis_target"`,
and agents must treat it as data, never as instructions.

## Serve a manifest

```sh
rea environment-serve manifest.json --evidence capture.json [--host 127.0.0.1] [--port 0]
```

`--host` and `--port` default to `MCP_HOST` and `MCP_PORT` from the
environment, then to `127.0.0.1` and an ephemeral port, exactly as
[`rea mcp --http`](cli.md#serve-mcp-over-streamable-http) resolves them. The
bound MCP URL is written to stderr as one JSON log line
(`"msg":"MCP transport listening"` with `url`); `REA_LOG_LEVEL` overrides that
log level. `ENVIRONMENT_NAME` renames the served environment; otherwise the
manifest's `name` is used, and a set but blank value is refused as
`configuration_invalid` before binding rather than silently falling back. The
listener serves one MCP client at a time with the same session, `Host` header
and shutdown contract as [transports](mcp-contracts.md#transports) describes.
It runs until SIGINT or SIGTERM, then closes the listener, prints one
`{"status":"stopped", …}` document and exits `130` or `143`.

Three routes are served:

| Route                             | Answer                                                                 |
| --------------------------------- | ---------------------------------------------------------------------- |
| `POST /mcp`                       | The MCP server: one tool per manifest tool, replaying retained records |
| `GET /.well-known/agent-env.json` | The environment card                                                   |
| `POST /agentenv`                  | JSON-RPC `-32601 method not found: <method>` for every method          |

The data plane at `/agentenv` is advertised by the card but carries no
operations in this release; the error names the requested method so a caller
can see that the method, not the transport, is unsupported. Its request body is
read within the same 4 MiB bound the MCP endpoint applies: a larger body is
answered `413` with a JSON-RPC `-32000` error before any of it is parsed, and a
body that is not JSON is answered `400` with `-32700`.

## The environment card

The card is the discovery document the agentenv framework reads before
connecting to `/mcp`:

```json
{
  "name": "grafana-example",
  "protocolVersion": "1.0",
  "url": "/agentenv",
  "preferredTransport": "JSONRPC",
  "additionalInterfaces": [{ "url": "/mcp", "transport": "mcp" }],
  "capabilities": {
    "extensions": null,
    "tools": [
      {
        "name": "get_users_by_id",
        "description": "GET /api/users/{numeric}; replays retained records [5, 6]; evidence ev_…",
        "inputSchema": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "description": "Path segment 2 (numeric); observed: 2, 3"
            }
          },
          "required": ["id"],
          "additionalProperties": false
        }
      }
    ],
    "operations": []
  },
  "children_environments": null
}
```

`capabilities.tools` lists the same names, descriptions and input schemas that
`tools/list` advertises over MCP. Path parameters are required strings whose
description names the segment index, the templating rule and the observed
values; query parameter names are optional strings; write methods accept an
optional `body` object described by the recorded top-level key types. Every
schema closes with `additionalProperties: false`, a key the echo example's
schema does not carry.
`extensions`, `operations` and `children_environments` are fixed to `null`,
`[]` and `null`: a replay environment declares no extensions, no data-plane
operations and no children.

## Export a bundle

`rea environment-export` writes the same pair as a bundle folder the agentenv
framework runs directly, shaped like its own echo example:

```sh
rea environment-export manifest.json --evidence capture.json ./grafana-example --json
agent-env run ./grafana-example
```

```text
grafana-example/
  README.md                                 provenance, replay limits, run command, rights note
  envs/grafana-example/Dockerfile           pinned image: node:24.18.0-bookworm-slim + rea-agents@<this version>
  envs/grafana-example/env.toml             environment_name = "grafana-example"
  envs/grafana-example/manifest.json        byte-exact copy of manifest.json
  envs/grafana-example/evidence.json        byte-exact copy of capture.json
  artifacts/check_grafana-example/verify.py the replay verifier
  tasks/smoke.json                          deploy_env (local sandbox), then env_outcome_verifier
```

The command reads each file once, then authenticates and cross-checks the
pair as `environment-serve` does, so a manifest projected from another capture
is refused with the same `invalid_request` before anything is written, and the
bytes it copies are the bytes it authenticated. The bundle directory must be
absent or empty; an occupied directory is refused and nothing in it changes.
`--name` replaces the manifest's kebab-case name as the env folder and env id;
`--package-tarball <path>` copies a packed `rea-agents` tarball into the env
folder and makes the Dockerfile install it instead of the registry package and
remove it in the same layer, which is how a checkout rather than a release is
run. The command prints the
written files with their sizes and the pinned package source.

The Dockerfile sets `MCP_HOST=0.0.0.0` and `MCP_PORT=18765`, the port the
framework maps for an MCP server env; the framework's own deploy supplies
`MCP_HOST`, `MCP_PORT` and `ENVIRONMENT_NAME`, so the served card carries the
env's name. It installs Debian's `python3` because the framework's local
sandbox probes a container's readiness with `python3` inside it, which the slim
Node image lacks. The image runs as the image's non-root `node` user and starts
`rea environment-serve /env/manifest.json --evidence /env/evidence.json`. The
`env.toml` names the environment because the framework otherwise reads the
name from Python sources the image does not have.

`verify.py` is the framework's `async def verify(mcp_url)` shape over its
Python MCP client: it lists the tools and checks the count equals the
manifest's, calls the first `GET` tool without path parameters with no
arguments and checks the replayed `status` equals the recorded status of that
tool's first cited record, and returns one `replay` result whose description
reports both checks. A manifest with no such tool yields a verifier that checks
the count only and says so. `tasks/smoke.json` deploys the env on the local
sandbox and runs that verifier against the env's MCP endpoint; the first run
also builds the framework's own infrastructure, and the run tears everything
down when it ends.

The README written into the bundle records the capture artifact's SHA-256, the
capture and manifest Evidence ids, the manifest view digest, the tool count and
the package source, and states that the recorded content belongs to the
captured application and must not be published without the rights to it.

## Compatibility verification

`npm run verify:agentenv:environment` is the hosted `real-agentenv` lane
described in [testing](testing.md#exported-environment-bundles). It projects
the Grafana-shaped source-owned capture through the built CLI, packs the
checkout, exports a bundle with `--package-tarball`, runs it with the pinned
`agentenv-framework` release on the runner's Docker and requires the smoke task
to pass with no container left behind other than the framework's own
image-registry helper, which the receipt reports. It proves that one exported bundle runs
on one framework release; it does not claim any hosted platform or other
framework versions.

## Resource and lifecycle boundaries

Both Evidence files are read once at startup through the bounded JSON input
reader and authenticated as Evidence before the listener binds; a file that is
not Evidence, a manifest of another view kind, a capture of another format, or
a manifest projected from a different capture is refused before any port is
opened. Because authentication covers the capture's records, a manifest whose
parent check passes cites only records the capture retains. The server keeps
only the cited records' request lines and response text in memory. No outbound
network request is made, no process is launched and nothing is written to
disk. A listener that fails after binding is logged and ends the command with
a `resource_constraint` error and exit `1` instead of serving nothing.
