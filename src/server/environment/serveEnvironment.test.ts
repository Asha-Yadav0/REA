import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { DEFAULT_MAX_REQUEST_BODY_SIZE } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";

import { environmentServeSource } from "../../../tests/fixtures/environmentServe.js";
import {
  environmentCard,
  environmentToolDefinitions,
} from "../../application/environment/environmentTools.js";
import { TARGET_CONTENT_RESULT_META } from "../toolResultEncoding.js";
import {
  ENVIRONMENT_CARD_PATH,
  ENVIRONMENT_RPC_PATH,
  environmentRoutes,
  serveEnvironment,
  type ServedEnvironment,
} from "./serveEnvironment.js";

const source = environmentServeSource();
const definitions = environmentToolDefinitions(
  source.manifest,
  source.evidenceId,
);

/**
 * The agentenv echo example's card, key for key. Only `name` and the tool
 * entries differ for a served manifest, so substituting them must reproduce
 * the served JSON byte for byte.
 */
const echoCardShape = (
  name: string,
  tools: readonly unknown[],
): Record<string, unknown> => ({
  name,
  protocolVersion: "1.0",
  url: "/agentenv",
  preferredTransport: "JSONRPC",
  additionalInterfaces: [{ url: "/mcp", transport: "mcp" }],
  capabilities: { extensions: null, tools, operations: [] },
  children_environments: null,
});

const route = (method: string, path: string) => {
  const found = environmentRoutes(
    environmentCard("grafana-example", definitions),
  ).find((entry) => entry.method === method && entry.path === path);
  if (found === undefined) throw new Error(`No route ${method} ${path}`);
  return found;
};

const served: ServedEnvironment[] = [];
afterEach(async () => {
  await Promise.all(served.splice(0).map((entry) => entry.close()));
});

const start = async (environmentName?: string): Promise<ServedEnvironment> => {
  const entry = await serveEnvironment({
    source,
    host: "127.0.0.1",
    port: 0,
    ...(environmentName === undefined ? {} : { environmentName }),
  });
  served.push(entry);
  return entry;
};

describe("environment routes", () => {
  it("serves the card byte-identical to the echo card shape with the manifest tools", async () => {
    const response = await route("GET", ENVIRONMENT_CARD_PATH).handle(
      new Request(`http://127.0.0.1${ENVIRONMENT_CARD_PATH}`),
    );
    expect(response.headers.get("content-type")).toContain("application/json");
    const text = await response.text();
    expect(text).toBe(
      JSON.stringify(
        echoCardShape(
          "grafana-example",
          definitions.map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
        ),
      ),
    );
    const card: unknown = JSON.parse(text);
    expect(card).toMatchObject({
      capabilities: {
        tools: expect.arrayContaining([
          expect.objectContaining({
            name: "get_users_by_id",
            inputSchema: {
              type: "object",
              properties: { id: expect.objectContaining({ type: "string" }) },
              required: ["id"],
              additionalProperties: false,
            },
          }),
        ]),
      },
    });
  });

  it("answers every data-plane method with JSON-RPC method not found", async () => {
    const rpc = route("POST", ENVIRONMENT_RPC_PATH);
    const reset = await rpc.handle(
      new Request(`http://127.0.0.1${ENVIRONMENT_RPC_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "data/reset" }),
      }),
    );
    expect(reset.status).toBe(200);
    await expect(reset.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: "method not found: data/reset" },
    });
    const noMethod = await rpc.handle(
      new Request(`http://127.0.0.1${ENVIRONMENT_RPC_PATH}`, {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: "a" }),
      }),
    );
    await expect(noMethod.json()).resolves.toMatchObject({
      id: "a",
      error: { code: -32601, message: "method not found: " },
    });
    const malformed = await rpc.handle(
      new Request(`http://127.0.0.1${ENVIRONMENT_RPC_PATH}`, {
        method: "POST",
        body: "{",
      }),
    );
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({
      id: null,
      error: { code: -32700 },
    });
  });

  it("refuses a data-plane body over the SDK bound with 413 before parsing it", async () => {
    const response = await route("POST", ENVIRONMENT_RPC_PATH).handle(
      new Request(`http://127.0.0.1${ENVIRONMENT_RPC_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: `{"jsonrpc":"2.0","id":1,"method":"${"x".repeat(DEFAULT_MAX_REQUEST_BODY_SIZE)}"}`,
      }),
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32000,
        message: `Request body must not exceed ${String(DEFAULT_MAX_REQUEST_BODY_SIZE)} bytes`,
      },
    });
  });
});

describe("serveEnvironment", () => {
  it("serves the card, lists one MCP tool per manifest tool and replays target content with provenance", async () => {
    const entry = await start();
    const url = new URL(entry.url);
    expect(url.pathname).toBe("/mcp");
    const card = await fetch(new URL(ENVIRONMENT_CARD_PATH, url));
    await expect(card.json()).resolves.toEqual(
      JSON.parse(JSON.stringify(entry.card)),
    );
    expect(entry.card.name).toBe("grafana-example");
    const transport = new StreamableHTTPClientTransport(url);
    const client = new Client({ name: "environment-adapter", version: "1" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(source.manifest.tools.length);
      const advertised = tools.find((tool) => tool.name === "get_users_by_id");
      expect(advertised?.inputSchema).toEqual(
        definitions.find(({ name }) => name === "get_users_by_id")?.inputSchema,
      );
      const exact = await client.callTool({
        name: "get_users_by_id",
        arguments: { id: "2" },
      });
      expect(exact.isError).toBeFalsy();
      expect(exact._meta).toEqual(TARGET_CONTENT_RESULT_META);
      expect(exact.structuredContent).toMatchObject({
        status: 200,
        body: { login: "probe" },
        replay: { exact_match: true, evidence_id: source.evidenceId },
      });
      expect(
        JSON.parse(String((exact.content as { text: string }[])[0]?.text)),
      ).toEqual(exact.structuredContent);
      const inexact = await client.callTool({
        name: "get_users_by_id",
        arguments: { id: "999" },
      });
      expect(inexact.structuredContent).toMatchObject({
        replay: { exact_match: false },
      });
      const missing = await client.callTool({
        name: "get_users_by_id",
        arguments: {},
      });
      expect(missing.isError).toBe(true);
      const unknown = await client.callTool({
        name: "get_users_by_id",
        arguments: { id: "2", unrecognized_option: "x" },
      });
      expect(unknown.isError).toBe(true);
      expect(unknown.structuredContent).toBeUndefined();
      const rpc = await fetch(new URL(ENVIRONMENT_RPC_PATH, url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "data/reset" }),
      });
      await expect(rpc.json()).resolves.toMatchObject({
        error: { code: -32601 },
      });
    } finally {
      await client.close();
    }
  });

  it("names the environment from the override, bounds data-plane bodies and frees the port on close", async () => {
    const entry = await start("renamed");
    expect(entry.card.name).toBe("renamed");
    const card = await fetch(new URL(ENVIRONMENT_CARD_PATH, entry.url));
    await expect(card.json()).resolves.toMatchObject({ name: "renamed" });
    const oversized = await fetch(new URL(ENVIRONMENT_RPC_PATH, entry.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "[".repeat(DEFAULT_MAX_REQUEST_BODY_SIZE + 1),
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      id: null,
      error: { code: -32000 },
    });
    await entry.close();
    await expect(
      fetch(new URL(ENVIRONMENT_CARD_PATH, entry.url)),
    ).rejects.toThrow();
  });
});
