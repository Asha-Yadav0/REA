import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import pino from "pino";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";

import {
  expectForeignHostRefused,
  rawHttpRequest,
} from "../../../tests/support/http/rawRequest.js";
import {
  hostHeaderAllowlist,
  McpSessionSlot,
  serveStreamableHttp,
  type StreamableHttpServer,
} from "./serveStreamableHttp.js";
import { StreamableHttpListenError } from "./streamableHttpListenError.js";

const servers: StreamableHttpServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** An echo server whose protocol onclose hook counts as a shutdown, as rea's provider cleanup does. */
const createEchoServer = (onShutdown: () => void): McpServer => {
  const server = new McpServer({ name: "echo-fixture", version: "1" });
  server.registerTool(
    "echo",
    { description: "Echo text", inputSchema: { text: z.string() } },
    ({ text }) => ({ content: [{ type: "text", text }] }),
  );
  server.server.onclose = onShutdown;
  return server;
};

const start = async (
  overrides: Partial<Parameters<typeof serveStreamableHttp>[0]> = {},
) => {
  const logs: string[] = [];
  const logger = pino({ level: "debug" }, { write: (line) => logs.push(line) });
  let factoryCalls = 0;
  let shutdownHooks = 0;
  const served = await serveStreamableHttp({
    host: "127.0.0.1",
    port: 0,
    createMcpServer: () => {
      factoryCalls += 1;
      return createEchoServer(() => {
        shutdownHooks += 1;
      });
    },
    logger,
    ...overrides,
  });
  servers.push(served);
  return {
    served,
    messages: () =>
      logs.map((line) => (JSON.parse(line) as { msg: string }).msg),
    entries: () =>
      logs.map((line) => JSON.parse(line) as Record<string, unknown>),
    factoryCalls: () => factoryCalls,
    shutdownHooks: () => shutdownHooks,
  };
};

const connect = async (url: string) => {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: "streamable-http-adapter", version: "1" });
  await client.connect(transport);
  return { transport, client };
};

const echo = async (client: Client, text: string): Promise<unknown> => {
  const result = await client.callTool({ name: "echo", arguments: { text } });
  return result.content;
};

/** A new client's initialize as the bridge hands it to the slot: no session id yet. */
const initializeRequest = (): Request =>
  new Request("http://127.0.0.1/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "racing-client", version: "1" },
      },
    }),
  });

it("announces the bound URL and serves one session at a time on one live instance", async () => {
  const { served, entries, messages, factoryCalls, shutdownHooks } =
    await start();
  expect(new URL(served.url).pathname).toBe("/mcp");
  expect(entries()).toContainEqual(
    expect.objectContaining({
      transport: "streamable-http",
      url: served.url,
      msg: "MCP transport listening",
    }),
  );
  const first = await connect(served.url);
  const sessionId = first.transport.sessionId;
  expect(sessionId).toEqual(expect.any(String));
  await expect(echo(first.client, "hi")).resolves.toEqual([
    { type: "text", text: "hi" },
  ]);
  // A new client's initialize replaces the open session; the earlier client is refused.
  const second = await connect(served.url);
  expect(second.transport.sessionId).toEqual(expect.any(String));
  expect(second.transport.sessionId).not.toBe(sessionId);
  await expect(echo(first.client, "stale")).rejects.toThrow();
  await expect(echo(second.client, "live")).resolves.toEqual([
    { type: "text", text: "live" },
  ]);
  await first.client.close();
  // DELETE ends the session, not the server: the instance keeps serving.
  await second.transport.terminateSession();
  expect(second.transport.sessionId).toBeUndefined();
  await second.client.close();
  const third = await connect(served.url);
  await expect(echo(third.client, "again")).resolves.toEqual([
    { type: "text", text: "again" },
  ]);
  expect(factoryCalls()).toBe(1);
  expect(shutdownHooks()).toBe(0);
  expect(
    messages().filter((msg) => msg === "MCP HTTP session opened"),
  ).toHaveLength(3);
  expect(messages()).toContain("MCP HTTP session replaced by a new client");
  // Closing the listener with a session open is the shutdown the instance's hook waits for.
  await served.close();
  expect(shutdownHooks()).toBe(1);
  await third.client.close();
});

it("keeps the instance's shutdown hook when two initialize requests race to replace an open session", async () => {
  let shutdownHooks = 0;
  const slot = new McpSessionSlot(
    createEchoServer(() => {
      shutdownHooks += 1;
    }),
    undefined,
  );
  const opened = await slot.handle(initializeRequest());
  expect(opened.status).toBe(200);
  // Both requests see the same open session and end it in lockstep.
  const raced = await Promise.all([
    slot.handle(initializeRequest()),
    slot.handle(initializeRequest()),
  ]);
  expect(raced.map((response) => response.status).sort()).toEqual([200, 400]);
  const winner = raced.find((response) => response.status === 200);
  expect(winner?.headers.get("mcp-session-id")).toEqual(expect.any(String));
  expect(shutdownHooks).toBe(0);
  // Only the slot's own close is the shutdown the instance's hook waits for.
  await slot.close();
  expect(shutdownHooks).toBe(1);
});

it("serves plain routes beside the MCP endpoint and answers unknown paths with 404", async () => {
  const { served } = await start({
    routes: [
      {
        method: "GET",
        path: "/.well-known/probe",
        handle: () => Response.json({ probe: true }),
      },
    ],
  });
  const probe = await fetch(new URL("/.well-known/probe", served.url));
  await expect(probe.json()).resolves.toEqual({ probe: true });
  const missing = await fetch(new URL("/missing", served.url));
  expect(missing.status).toBe(404);
  await expect(missing.json()).resolves.toMatchObject({
    error: { code: -32601 },
  });
  const wrongMethod = await fetch(new URL("/.well-known/probe", served.url), {
    method: "POST",
    body: "{}",
  });
  expect(wrongMethod.status).toBe(404);
});

it("refuses foreign Host headers on a loopback bind and frees the port on close", async () => {
  const { served } = await start();
  const url = new URL(served.url);
  await expectForeignHostRefused(url);
  await served.close();
  await served.close();
  await expect(rawHttpRequest(url)).rejects.toMatchObject({
    code: "ECONNREFUSED",
  });
});

it("reports a port that cannot be bound as a typed listen error naming the cause", async () => {
  const { served } = await start();
  const failed = serveStreamableHttp({
    host: "127.0.0.1",
    port: Number(new URL(served.url).port),
    createMcpServer: () => createEchoServer(() => undefined),
  });
  await expect(failed).rejects.toBeInstanceOf(StreamableHttpListenError);
  await expect(failed).rejects.toThrow(/EADDRINUSE/u);
});

it("keeps the SDK loopback allowlist only for loopback binds", () => {
  expect(hostHeaderAllowlist("127.0.0.1")).toEqual([
    "localhost",
    "127.0.0.1",
    "[::1]",
  ]);
  expect(hostHeaderAllowlist("localhost")).toBeDefined();
  expect(hostHeaderAllowlist("::1")).toBeDefined();
  expect(hostHeaderAllowlist("192.0.2.10")).toBeUndefined();
  expect(hostHeaderAllowlist("::")).toBeUndefined();
});
