import {
  hostHeaderValidationResponse,
  isInitializeRequest,
  localhostAllowedHostnames,
  readRequestBody,
  WebStandardStreamableHTTPServerTransport,
  type McpServer,
  type McpServerFactory,
  type Server,
} from "@modelcontextprotocol/server";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Logger } from "pino";

import { toWebRequest, writeWebResponse } from "./nodeHttpBridge.js";
import { StreamableHttpListenError } from "./streamableHttpListenError.js";

/** MCP endpoint path shared by `rea mcp --http` and agent environment servers. */
export const MCP_HTTP_PATH = "/mcp";

/** Bind literals that keep the SDK loopback Host allowlist. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "[::1]",
]);

/** One plain HTTP route served beside the MCP endpoint as web Request to Response. */
export interface StreamableHttpRoute {
  readonly method: string;
  readonly path: string;
  readonly handle: (request: Request) => Response | Promise<Response>;
}

export interface ServeStreamableHttpOptions {
  readonly host: string;
  readonly port: number;
  /** Called once; the instance serves every session in turn on a fresh transport. */
  readonly createMcpServer: McpServerFactory;
  readonly routes?: readonly StreamableHttpRoute[];
  readonly logger?: Logger;
  /** Reports listener failures after binding; request failures are logged instead. */
  readonly onerror?: (error: Error) => void;
}

export interface StreamableHttpServer {
  /** The bound MCP endpoint URL. */
  readonly url: string;
  readonly close: () => Promise<void>;
}

/** Host header allowlist for a bind, or undefined when validation is relaxed. */
export const hostHeaderAllowlist = (host: string): string[] | undefined =>
  LOOPBACK_HOSTS.has(host) ? localhostAllowedHostnames() : undefined;

/** A JSON-RPC error answered outside any session, so its id is null. */
export const jsonRpcErrorResponse = (
  status: number,
  code: number,
  message: string,
): Response =>
  Response.json(
    { jsonrpc: "2.0", error: { code, message }, id: null },
    { status },
  );

const protocolOf = (instance: McpServer | Server): Server =>
  "server" in instance ? instance.server : instance;

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const NO_SHUTDOWN_HOOK = (): void => undefined;

/** Only a new client's initialize travels without a session id; peek within the SDK body bound. */
const isInitializePost = async (request: Request): Promise<boolean> => {
  if (request.method !== "POST" || request.headers.has("mcp-session-id"))
    return false;
  const probe = request.clone();
  try {
    const read = await readRequestBody(probe);
    if (read.tooLarge) return false;
    const body: unknown = JSON.parse(read.text);
    return Array.isArray(body)
      ? body.some((message) => isInitializeRequest(message))
      : isInitializeRequest(body);
  } catch {
    return false;
  } finally {
    await probe.body?.cancel().catch(() => undefined);
  }
};

/** The connected transport of one session and the SDK close that ends it as a server shutdown. */
interface LiveSession {
  readonly transport: WebStandardStreamableHTTPServerTransport;
  readonly shutdown: () => Promise<void>;
}

/** Owns the single connected server and the transport of its current session. */
export class McpSessionSlot {
  #live: LiveSession | undefined;
  #arming: Promise<WebStandardStreamableHTTPServerTransport> | undefined;
  /** The instance's own close hook, captured once so every session end restores exactly it. */
  readonly #shutdownHook: () => void;

  constructor(
    private readonly instance: McpServer | Server,
    private readonly logger: Logger | undefined,
  ) {
    this.#shutdownHook = protocolOf(instance).onclose ?? NO_SHUTDOWN_HOOK;
  }

  /** Route one MCP request; a new client's initialize replaces a session its predecessor left open. */
  async handle(request: Request): Promise<Response> {
    const open = this.#live;
    if (
      open?.transport.sessionId !== undefined &&
      (await isInitializePost(request))
    ) {
      this.logger?.info("MCP HTTP session replaced by a new client");
      await open.transport.close();
    }
    return (await this.#current()).handleRequest(request);
  }

  /** End the live session as part of server shutdown, so the instance's onclose runs. */
  async close(): Promise<void> {
    const open = this.#live;
    this.#live = undefined;
    await open?.shutdown();
  }

  #current(): Promise<WebStandardStreamableHTTPServerTransport> {
    if (this.#live !== undefined) return Promise.resolve(this.#live.transport);
    this.#arming ??= this.#arm().finally(() => {
      this.#arming = undefined;
    });
    return this.#arming;
  }

  async #arm(): Promise<WebStandardStreamableHTTPServerTransport> {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: () => this.logger?.info("MCP HTTP session opened"),
      onsessionclosed: () =>
        this.logger?.info("MCP HTTP session closed by the client"),
    });
    const shutdown = transport.close.bind(transport);
    // The SDK closes the transport on DELETE; that ends the session, not the server.
    transport.close = () => this.#endSession(transport, shutdown);
    await this.instance.connect(transport);
    this.#live = { transport, shutdown };
    return transport;
  }

  /** Close one session's transport while the instance's onclose hooks wait for close(). */
  async #endSession(
    transport: WebStandardStreamableHTTPServerTransport,
    shutdown: () => Promise<void>,
  ): Promise<void> {
    const protocol = protocolOf(this.instance);
    protocol.onclose = NO_SHUTDOWN_HOOK;
    try {
      await shutdown();
    } finally {
      protocol.onclose = this.#shutdownHook;
      if (this.#live?.transport === transport) this.#live = undefined;
    }
  }
}

const endpointUrl = (
  address: ReturnType<ReturnType<typeof createHttpServer>["address"]>,
): string => {
  if (address === null || typeof address === "string")
    throw new TypeError("MCP HTTP listener has no TCP address");
  const host =
    address.family === "IPv6" ? `[${address.address}]` : address.address;
  return `http://${host}:${String(address.port)}${MCP_HTTP_PATH}`;
};

/** Serve one MCP server, plus plain routes, over streamable HTTP until closed. */
export const serveStreamableHttp = async (
  options: ServeStreamableHttpOptions,
): Promise<StreamableHttpServer> => {
  const { host, port, logger, routes = [] } = options;
  const allowedHosts = hostHeaderAllowlist(host);
  const instance = await options.createMcpServer({ era: "legacy" });
  protocolOf(instance).onerror = (error) =>
    logger?.warn({ error: error.message }, "MCP HTTP request rejected");
  const slot = new McpSessionSlot(instance, logger);
  let stopped = false;
  const route = async (request: Request): Promise<Response> => {
    if (stopped)
      return jsonRpcErrorResponse(503, -32000, "Server shutting down");
    const refused =
      allowedHosts === undefined
        ? undefined
        : hostHeaderValidationResponse(request, allowedHosts);
    if (refused !== undefined) return refused;
    const { pathname } = new URL(request.url);
    if (pathname === MCP_HTTP_PATH) return slot.handle(request);
    const match = routes.find(
      (candidate) =>
        candidate.path === pathname && candidate.method === request.method,
    );
    return match === undefined
      ? jsonRpcErrorResponse(
          404,
          -32601,
          `No route for ${request.method} ${pathname}`,
        )
      : match.handle(request);
  };
  const httpServer = createHttpServer();
  try {
    httpServer.listen(port, host);
    await once(httpServer, "listening");
  } catch (cause: unknown) {
    await instance.close().catch(() => undefined);
    throw new StreamableHttpListenError(cause);
  }
  const url = endpointUrl(httpServer.address());
  const origin = new URL(url).origin;
  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    try {
      const webResponse = await route(toWebRequest(request, response, origin));
      await writeWebResponse(webResponse, response);
    } catch (cause: unknown) {
      // A client that left mid-stream is routine; a failure before headers is not.
      logger?.[response.headersSent ? "debug" : "warn"](
        { error: describe(cause) },
        "MCP HTTP request did not complete",
      );
      if (response.headersSent) response.destroy();
      else
        await writeWebResponse(
          jsonRpcErrorResponse(500, -32603, "Internal server error"),
          response,
        ).catch(() => undefined);
    }
  };
  httpServer.on("request", (request, response) => {
    void handleRequest(request, response);
  });
  httpServer.on("error", (error) => options.onerror?.(error));
  if (allowedHosts === undefined)
    logger?.warn(
      { host },
      "MCP HTTP Host header validation relaxed for a non-loopback bind",
    );
  logger?.info(
    { transport: "streamable-http", url },
    "MCP transport listening",
  );
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      stopped = true;
      httpServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
      await slot.close();
      await instance.close();
    })();
    return closing;
  };
  return { url, close };
};
