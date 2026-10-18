import { isJsonLike } from "../../domain/analysisView/EnvironmentManifestAccumulator.js";
import { mediaTypeEssence } from "../../domain/analysisView/webNetworkRouteTemplates.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { jsonValueSchema, type JsonValue } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import { safeParseJson } from "../../domain/safeJson.js";
import {
  ENVIRONMENT_SERVE_OPERATION,
  type EnvironmentManifestTool,
  type EnvironmentSource,
  type RecordedExchange,
} from "./environmentSource.js";

/** Replayed bodies larger than this are cut at a UTF-8 boundary and flagged. */
export const REPLAY_BODY_LIMIT_BYTES = 256 * 1024;

/** Caller arguments as the MCP tool receives them. */
export type ReplayArguments = Readonly<Record<string, unknown>>;

/** What one tool call returns: the recorded response and where it came from. */
export interface ReplayResult {
  readonly status: number | null;
  readonly content_type: string | null;
  readonly body: JsonValue;
  readonly replay: {
    readonly record_ordinal: number;
    readonly evidence_id: string;
    readonly exact_match: boolean;
    readonly recorded_path: string;
    readonly recorded_query: string | null;
    readonly truncated: boolean;
  };
}

interface MatchScore {
  readonly pathMatches: number;
  readonly queryMatches: number;
  readonly exact: boolean;
}

const decoded = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

/** Count how many supplied path and query values the recorded request line satisfies. */
const scoreExchange = (
  tool: EnvironmentManifestTool,
  exchange: RecordedExchange,
  args: ReplayArguments,
): MatchScore => {
  const segments = exchange.path.split("/").slice(1);
  let pathProvided = 0;
  let pathMatches = 0;
  for (const param of tool.params) {
    const value = args[param.name];
    if (typeof value !== "string") continue;
    pathProvided += 1;
    const segment = segments[param.index];
    if (
      segment !== undefined &&
      (segment === value || decoded(segment) === value)
    )
      pathMatches += 1;
  }
  const query = new URLSearchParams(exchange.query ?? "");
  let queryProvided = 0;
  let queryMatches = 0;
  for (const name of tool.query_parameter_names) {
    const value = args[name];
    if (typeof value !== "string") continue;
    queryProvided += 1;
    if (query.getAll(name).includes(value)) queryMatches += 1;
  }
  return {
    pathMatches,
    queryMatches,
    exact: pathMatches === pathProvided && queryMatches === queryProvided,
  };
};

/** Choose the record whose path segments, then query values, best match the call; ties keep manifest order. */
export const selectReplayExchange = (
  tool: EnvironmentManifestTool,
  exchanges: ReadonlyMap<number, RecordedExchange>,
  args: ReplayArguments,
):
  | { readonly exchange: RecordedExchange; readonly exact: boolean }
  | undefined => {
  let best: { exchange: RecordedExchange; score: MatchScore } | undefined;
  for (const ordinal of tool.record_ordinals) {
    const exchange = exchanges.get(ordinal);
    if (exchange === undefined) continue;
    const score = scoreExchange(tool, exchange, args);
    if (
      best === undefined ||
      score.pathMatches > best.score.pathMatches ||
      (score.pathMatches === best.score.pathMatches &&
        score.queryMatches > best.score.queryMatches)
    )
      best = { exchange, score };
  }
  return best === undefined
    ? undefined
    : { exchange: best.exchange, exact: best.score.exact };
};

/** Cut text at the last UTF-8 character boundary within the byte limit. */
const truncateUtf8 = (text: string, maxBytes: number): string => {
  const bytes = Buffer.from(text, "utf8");
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.toString("utf8", 0, end);
};

/** Parse a retained body as JSON when its content type is JSON-like; otherwise return the text. */
const replayBody = (
  exchange: RecordedExchange,
): { readonly body: JsonValue; readonly truncated: boolean } => {
  const text = exchange.bodyText;
  if (text === null) return { body: null, truncated: false };
  if (Buffer.byteLength(text, "utf8") > REPLAY_BODY_LIMIT_BYTES)
    return {
      body: truncateUtf8(text, REPLAY_BODY_LIMIT_BYTES),
      truncated: true,
    };
  if (
    exchange.contentType !== null &&
    isJsonLike(mediaTypeEssence(exchange.contentType))
  ) {
    const parsed = safeParseJson(text);
    const value = parsed.ok
      ? jsonValueSchema.safeParse(parsed.value)
      : undefined;
    if (value?.success === true) return { body: value.data, truncated: false };
  }
  return { body: text, truncated: false };
};

/** Replay one tool call from the retained record that best matches its arguments. */
export const replayEnvironmentTool = (
  source: EnvironmentSource,
  tool: EnvironmentManifestTool,
  args: ReplayArguments,
): Result<ReplayResult, AnalysisError> => {
  const selected = selectReplayExchange(tool, source.exchanges, args);
  if (selected === undefined)
    return err(
      new AnalysisInputError(
        ENVIRONMENT_SERVE_OPERATION,
        {
          userMessage: `Tool ${tool.name} cites no retained record to replay.`,
        },
        [{ path: ["tool"], reason: "invalid_value", expected: tool.name }],
      ),
    );
  const { exchange, exact } = selected;
  const { body, truncated } = replayBody(exchange);
  return ok({
    status: exchange.status,
    content_type: exchange.contentType,
    body,
    replay: {
      record_ordinal: exchange.ordinal,
      evidence_id: source.evidenceId,
      exact_match: exact,
      recorded_path: exchange.path,
      recorded_query: exchange.query,
      truncated,
    },
  });
};
