import type {
  EnvironmentManifest,
  EnvironmentManifestTool,
} from "./environmentSource.js";

/** Methods whose tools accept an optional request body object. */
const WRITE_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH"]);

/** JSON Schema advertised for one tool argument. */
export interface EnvironmentToolProperty {
  readonly type: "string" | "object";
  readonly description: string;
}

/** The object schema advertised to MCP clients and in the environment card; unknown arguments are refused. */
export interface EnvironmentToolInputSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, EnvironmentToolProperty>>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

/** One manifest tool as an MCP tool: name, description and input schema. */
export interface EnvironmentToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: EnvironmentToolInputSchema;
  readonly tool: EnvironmentManifestTool;
}

const observed = (values: readonly string[]): string =>
  values.length === 0 ? "none" : values.join(", ");

const bodyDescription = (tool: EnvironmentManifestTool): string =>
  tool.body_shape === null
    ? "Request body; the capture retained no JSON body shape for this tool."
    : `Request body; recorded top-level keys: ${Object.entries(
        tool.body_shape.properties,
      )
        .map(([key, type]) => `${key} (${type})`)
        .join(", ")}.`;

/** Map one manifest tool to its advertised MCP input schema. */
export const environmentToolInputSchema = (
  tool: EnvironmentManifestTool,
): EnvironmentToolInputSchema => {
  const properties: Record<string, EnvironmentToolProperty> = {};
  for (const param of tool.params)
    properties[param.name] = {
      type: "string",
      description: `Path segment ${String(param.index)} (${param.rule}); observed: ${observed(param.observed_values)}`,
    };
  for (const name of tool.query_parameter_names)
    if (!(name in properties))
      properties[name] = {
        type: "string",
        description: `Query parameter ${name}; optional, matched against the recorded query on replay.`,
      };
  if (WRITE_METHODS.has(tool.method) && !("body" in properties))
    properties.body = { type: "object", description: bodyDescription(tool) };
  return {
    type: "object",
    properties,
    required: tool.params.map((param) => param.name),
    additionalProperties: false,
  };
};

/** Map every manifest tool to an MCP tool definition in manifest order. */
export const environmentToolDefinitions = (
  manifest: EnvironmentManifest,
  evidenceId: string,
): readonly EnvironmentToolDefinition[] =>
  manifest.tools.map((tool) => ({
    name: tool.name,
    description: `${tool.method} ${tool.path_template}; replays retained records [${tool.record_ordinals.join(", ")}]; evidence ${evidenceId}`,
    inputSchema: environmentToolInputSchema(tool),
    tool,
  }));

/** The environment card served at `/.well-known/agent-env.json`; key order is part of the contract. */
export interface EnvironmentCard {
  readonly name: string;
  readonly protocolVersion: "1.0";
  readonly url: "/agentenv";
  readonly preferredTransport: "JSONRPC";
  readonly additionalInterfaces: readonly [{ url: "/mcp"; transport: "mcp" }];
  readonly capabilities: {
    readonly extensions: null;
    readonly tools: readonly Pick<
      EnvironmentToolDefinition,
      "name" | "description" | "inputSchema"
    >[];
    readonly operations: readonly [];
  };
  readonly children_environments: null;
}

/** Build the card from the served name and the tool definitions. */
export const environmentCard = (
  name: string,
  tools: readonly EnvironmentToolDefinition[],
): EnvironmentCard => ({
  name,
  protocolVersion: "1.0",
  url: "/agentenv",
  preferredTransport: "JSONRPC",
  additionalInterfaces: [{ url: "/mcp", transport: "mcp" }],
  capabilities: {
    extensions: null,
    tools: tools.map(({ name: toolName, description, inputSchema }) => ({
      name: toolName,
      description,
      inputSchema,
    })),
    operations: [],
  },
  children_environments: null,
});
