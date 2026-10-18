import { describe, expect, it } from "vitest";

import {
  analysisViewCaptureEvidence,
  environmentManifestCaptureFixture,
} from "../../../tests/fixtures/analysisView.js";
import {
  environmentServeFixture,
  environmentServeSource,
} from "../../../tests/fixtures/environmentServe.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { inspectAnalysisView } from "../analysisView/AnalysisViewService.js";
import {
  REPLAY_BODY_LIMIT_BYTES,
  replayEnvironmentTool,
  selectReplayExchange,
} from "./environmentReplay.js";
import type {
  EnvironmentSource,
  RecordedExchange,
} from "./environmentSource.js";

const source = environmentServeSource();

const tool = (name: string) => {
  const found = source.manifest.tools.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`Fixture manifest lacks ${name}`);
  return found;
};

const replay = (
  name: string,
  args: Readonly<Record<string, unknown>>,
  from: EnvironmentSource = source,
) => {
  const result = replayEnvironmentTool(from, tool(name), args);
  if (!result.ok) throw result.error;
  return result.value;
};

/** A source whose only exchange carries the given body and content type. */
const singleExchangeSource = (
  bodyText: string | null,
  contentType: string | null,
): EnvironmentSource => {
  const users = tool("get_users_by_id");
  const ordinal = users.record_ordinals[0] ?? 0;
  const exchange: RecordedExchange = {
    ordinal,
    path: "/api/users/2",
    query: null,
    status: 200,
    contentType,
    bodyText,
  };
  return { ...source, exchanges: new Map([[ordinal, exchange]]) };
};

describe("replayEnvironmentTool selection", () => {
  it("replays the record whose path segments equal the supplied parameters as an exact match", () => {
    const result = replay("get_users_by_id", { id: "2" });
    expect(result).toMatchObject({
      status: 200,
      content_type: "application/json",
      body: { id: 2, login: "probe" },
      replay: {
        evidence_id: source.evidenceId,
        exact_match: true,
        recorded_path: "/api/users/2",
        recorded_query: null,
        truncated: false,
      },
    });
    expect(replay("get_users_by_id", { id: "3" })).toMatchObject({
      body: { login: "viewer" },
      replay: { exact_match: true, recorded_path: "/api/users/3" },
    });
    expect(
      replay("get_folders_by_uid", { uid: "general" }).replay,
    ).toMatchObject({
      exact_match: true,
      recorded_path: "/api/folders/general",
    });
  });

  it("falls back to the tool's first record, flagged inexact, when no record matches", () => {
    const users = tool("get_users_by_id");
    const result = replay("get_users_by_id", { id: "999" });
    expect(result.replay).toMatchObject({
      record_ordinal: users.record_ordinals[0],
      exact_match: false,
      recorded_path: "/api/users/2",
    });
    expect(result.body).toMatchObject({ login: "probe" });
    // Omitted parameters cannot mismatch: a call without arguments is exact on the first record.
    expect(replay("get_users_by_id", {}).replay.exact_match).toBe(true);
  });

  it("matches query values after path segments and reports the recorded query", () => {
    const both = replay("get_search", { query: "probe", type: "dash-db" });
    expect(both.replay).toMatchObject({
      exact_match: true,
      recorded_path: "/api/search",
      recorded_query: "?query=probe&type=dash-db",
    });
    expect(Array.isArray(both.body)).toBe(true);
    expect(both.body).toMatchObject([{ title: "probe dashboard" }]);
    const folder = replay("get_search", { type: "dash-folder" });
    expect(folder.replay).toMatchObject({
      exact_match: true,
      recorded_query: "?query=&type=dash-folder",
    });
    const unmatched = replay("get_search", { type: "dash-nothing" });
    expect(unmatched.replay.exact_match).toBe(false);
    expect(unmatched.replay.recorded_query).toBe("?query=probe&type=dash-db");
  });

  it("prefers path matches over query matches and keeps manifest order on ties", () => {
    const search = tool("get_search");
    const [first, second] = search.record_ordinals;
    if (first === undefined || second === undefined)
      throw new Error("Fixture search tool must cite two records");
    const exchanges = new Map<number, RecordedExchange>([
      [
        first,
        {
          ordinal: first,
          path: "/api/search",
          query: "?type=a",
          status: 200,
          contentType: null,
          bodyText: null,
        },
      ],
      [
        second,
        {
          ordinal: second,
          path: "/api/search",
          query: "?type=a",
          status: 200,
          contentType: null,
          bodyText: null,
        },
      ],
    ]);
    expect(
      selectReplayExchange(search, exchanges, { type: "a" }),
    ).toMatchObject({ exchange: { ordinal: first }, exact: true });
    expect(
      selectReplayExchange(search, new Map(), { type: "a" }),
    ).toBeUndefined();
    const refused = replayEnvironmentTool(
      { ...source, exchanges: new Map() },
      search,
      {},
    );
    if (refused.ok) throw new Error("Expected a refusal without records");
    expect(projectAnalysisError(refused.error)).toMatchObject({
      code: "invalid_request",
      details: { issues: [{ path: ["tool"], expected: "get_search" }] },
    });
  });
});

describe("replayEnvironmentTool bodies", () => {
  it("returns text for non-JSON content types and for JSON-like content that does not parse", () => {
    expect(
      replay(
        "get_users_by_id",
        { id: "2" },
        singleExchangeSource("<p>", "text/html"),
      ),
    ).toMatchObject({ body: "<p>", content_type: "text/html" });
    expect(
      replay(
        "get_users_by_id",
        { id: "2" },
        singleExchangeSource("{not json", "application/json; charset=utf-8"),
      ).body,
    ).toBe("{not json");
    expect(
      replay(
        "get_users_by_id",
        { id: "2" },
        singleExchangeSource('{"ok":true}', "application/vnd.api+json"),
      ).body,
    ).toEqual({ ok: true });
    expect(
      replay("get_users_by_id", { id: "2" }, singleExchangeSource(null, null)),
    ).toMatchObject({ body: null, content_type: null });
  });

  it("truncates bodies over 256 KiB at a UTF-8 boundary and flags them", () => {
    const text = "é".repeat(REPLAY_BODY_LIMIT_BYTES);
    const result = replay(
      "get_users_by_id",
      { id: "2" },
      singleExchangeSource(text, "application/json"),
    );
    expect(result.replay.truncated).toBe(true);
    expect(typeof result.body).toBe("string");
    const body = result.body as string;
    expect(Buffer.byteLength(body, "utf8")).toBe(REPLAY_BODY_LIMIT_BYTES);
    expect(body).not.toContain("�");
    const exact = "x".repeat(REPLAY_BODY_LIMIT_BYTES);
    expect(
      replay(
        "get_users_by_id",
        { id: "2" },
        singleExchangeSource(exact, "text/plain"),
      ),
    ).toMatchObject({ body: exact, replay: { truncated: false } });
  });

  it("decodes HAR base64 response content the decoder retained as bytes", () => {
    const capture = environmentManifestCaptureFixture();
    const record = capture.records.find(
      (entry) =>
        typeof entry.reported === "object" &&
        entry.reported !== null &&
        "request" in entry.reported &&
        JSON.stringify(entry.reported).includes("/api/users/2"),
    );
    if (record === undefined) throw new Error("Fixture lacks /api/users/2");
    const bytes = Buffer.from('{"login":"decoded"}', "utf8");
    const reported = structuredClone(record.reported) as {
      response: { content: { text: string; encoding?: string } };
    };
    reported.response.content.text = bytes.toString("base64");
    reported.response.content.encoding = "base64";
    record.reported = reported;
    record.binary_fields = [
      {
        pointer: "/response/content/text",
        representation: "har-base64-content",
        state: "retained",
        content_base64: bytes.toString("base64"),
        bytes: bytes.length,
        sha256: "0".repeat(64),
      },
    ];
    const evidence = analysisViewCaptureEvidence(capture);
    const manifest = inspectAnalysisView({
      source: { kind: "inline", evidence },
      view: { kind: "environment-manifest" },
    });
    if (!manifest.ok) throw manifest.error;
    const decoded = environmentServeSource({
      manifest: manifest.value,
      capture: evidence,
    });
    expect(replay("get_users_by_id", { id: "2" }, decoded).body).toEqual({
      login: "decoded",
    });
    expect(environmentServeFixture().manifest.evidence_id).not.toBe(
      manifest.value.evidence_id,
    );
  });
});
