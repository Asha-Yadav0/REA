import {
  DEFAULT_MAX_REQUEST_BODY_SIZE,
  fromJsonSchema,
  McpServer,
  readRequestBody,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import type { Logger } from "pino";

import {
  replayEnvironmentTool,
  type ReplayArguments,
} from "../../application/environment/environmentReplay.js";
import type { EnvironmentSource } from "../../application/environment/environmentSource.js";
import {
  environmentCard,
  environmentToolDefinitions,
  type EnvironmentCard,
  type EnvironmentToolDefinition,
} from "../../application/environment/environmentTools.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { safeParseJson } from "../../domain/safeJson.js";
import { PRODUCT_IDENTITY } from "../../identity.js";
import {
  jsonRpcErrorResponse,
  serveStreamableHttp,
  type StreamableHttpRoute,
  type StreamableHttpServer,
} from "../http/serveStreamableHttp.js";
import { TARGET_CONTENT_RESULT_META } from "../toolResultEncoding.js";

/** Where the environment card is served. */
export const ENVIRONMENT_CARD_PATH = "/.well-known/agent-env.json";
/** The JSON-RPC data plane the card advertises; this increment answers every method as unknown. */
export const ENVIRONMENT_RPC_PATH = "/agentenv";

const METHOD_NOT_FOUND = -32601;
const PARSE_ERROR = -32700;
/** The SDK's code for a body over its bound, so `/agentenv` and `/mcp` refuse alike. */
const PAYLOAD_TOO_LARGE = -32000;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Build the MCP server whose tools replay retained records; every result is target content. */
export const createEnvironmentMcpServer = (
  name: string,
  source: EnvironmentSource,
  tools: readonly EnvironmentToolDefinition[],
): McpServer => {
  const server = new McpServer({
    name,
    version: PRODUCT_IDENTITY.packageVersion,
  });
  for (const definition of tools)
    server.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: fromJsonSchema<ReplayArguments>(definition.inputSchema),
      },
      (args): CallToolResult => {
        const replayed = replayEnvironmentTool(source, definition.tool, args);
        if (!replayed.ok)
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(projectAnalysisError(replayed.error)),
              },
            ],
          };
        return {
          content: [{ type: "text", text: JSON.stringify(replayed.value) }],
          structuredContent: replayed.value,
          _meta: TARGET_CONTENT_RESULT_META,
        };
      },
    );
  return server;
};

/** Answer the data plane with a JSON-RPC method-not-found error for every request within the body bound. */
const answerRpc = async (request: Request): Promise<Response> => {
  const read = await readRequestBody(request, DEFAULT_MAX_REQUEST_BODY_SIZE);
  if (read.tooLarge)
    return jsonRpcErrorResponse(
      413,
      PAYLOAD_TOO_LARGE,
      `Request body must not exceed ${String(DEFAULT_MAX_REQUEST_BODY_SIZE)} bytes`,
    );
  const parsed = safeParseJson(read.text);
  if (!parsed.ok) return jsonRpcErrorResponse(400, PARSE_ERROR, "parse error");
  const body = isRecord(parsed.value) ? parsed.value : {};
  const method = typeof body.method === "string" ? body.method : "";
  const id = body.id;
  return Response.json({
    jsonrpc: "2.0",
    id: typeof id === "string" || typeof id === "number" ? id : null,
    error: { code: METHOD_NOT_FOUND, message: `method not found: ${method}` },
  });
};

/** The plain routes an agent environment serves beside `/mcp`. */
export const environmentRoutes = (
  card: EnvironmentCard,
): readonly StreamableHttpRoute[] => [
  {
    method: "GET",
    path: ENVIRONMENT_CARD_PATH,
    handle: () => Response.json(card),
  },
  { method: "POST", path: ENVIRONMENT_RPC_PATH, handle: answerRpc },
];

export interface ServeEnvironmentOptions {
  readonly source: EnvironmentSource;
  readonly host: string;
  readonly port: number;
  /** Served name; defaults to the manifest's environment name. */
  readonly environmentName?: string;
  readonly logger?: Logger;
  /** Reports a listener failure after binding; the failure is logged either way. */
  readonly onerror?: (error: Error) => void;
}

/** A listening agent environment and the card it serves. */
export interface ServedEnvironment extends StreamableHttpServer {
  readonly card: EnvironmentCard;
}

/** Serve one manifest as an agent environment until closed. */
export const serveEnvironment = async (
  options: ServeEnvironmentOptions,
): Promise<ServedEnvironment> => {
  const { source, host, port, logger } = options;
  const name = options.environmentName ?? source.manifest.name;
  const tools = environmentToolDefinitions(source.manifest, source.evidenceId);
  const card = environmentCard(name, tools);
  const served = await serveStreamableHttp({
    host,
    port,
    createMcpServer: () => createEnvironmentMcpServer(name, source, tools),
    routes: environmentRoutes(card),
    ...(logger === undefined ? {} : { logger }),
    onerror: (error) => {
      logger?.error(
        { error: error.message },
        "Agent environment listener failed",
      );
      options.onerror?.(error);
    },
  });
  return { ...served, card };
};
