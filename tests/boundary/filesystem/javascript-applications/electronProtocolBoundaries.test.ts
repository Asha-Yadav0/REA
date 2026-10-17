import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import {
  analyzeJavaScriptApplication,
  reconstructJavaScriptArtifact,
} from "../../../support/javascriptApplicationScope.js";
import { parseEvidence } from "../../../../src/domain/evidence.js";
import { parseJavaScriptApplicationGraph } from "../../../../src/domain/javascript/javascriptApplicationGraph.js";

const MAIN = String.raw`
const { app, protocol } = require("electron");
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true } },
]);
app.setAsDefaultProtocolClient("notes");
app.whenReady().then(() => {
  protocol.handle("app", (request) => fetch(request.url));
  protocol.handle(config.scheme, (request) => fetch(request.url));
});
`;

const protocolFixture = async (): Promise<string> => {
  const root = await createTestTempDirectory("rea-electron-protocols-");
  await Promise.all([
    writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "rea-electron-protocols", main: "main.cjs" }),
    ),
    writeFile(join(root, "main.cjs"), MAIN),
  ]);
  return root;
};

describe("Electron URL scheme boundaries", () => {
  it("projects each registered scheme into the application graph", async () => {
    const result = await reconstructJavaScriptArtifact({
      input_path: await protocolFixture(),
    });
    const graph = parseJavaScriptApplicationGraph(result.graph);
    const schemes = graph.nodes.filter(({ kind }) => kind === "url-scheme");
    const byLabel = new Map(
      schemes.map((node) => [node.observations[0]?.label, node]),
    );

    expect([...byLabel.keys()].toSorted()).toEqual([
      "app",
      "config.scheme",
      "notes",
    ]);
    // The privileged registration and the handler describe one entry point.
    expect(
      byLabel
        .get("app")
        ?.observations.map(({ properties }) => properties)
        .toSorted((left, right) =>
          String(left.role).localeCompare(String(right.role)),
        ),
    ).toMatchObject([
      { api: "handle", role: "handler", scheme: "app", resolution: "literal" },
      {
        api: "registerSchemesAsPrivileged",
        role: "privileged-scheme",
        enabled_privileges: ["secure", "standard"],
      },
    ]);
    expect(byLabel.get("notes")?.observations[0]?.properties).toMatchObject({
      api: "setAsDefaultProtocolClient",
      role: "os-default-client",
    });
    expect(
      byLabel.get("config.scheme")?.observations[0]?.properties,
    ).toMatchObject({ scheme: null, resolution: "dynamic" });

    const relations = graph.edges
      .filter(({ target_node_id: target }) =>
        schemes.some(({ node_id: id }) => id === target),
      )
      .map(({ relation, properties }) => [relation, properties.role])
      .toSorted((left, right) =>
        String(left[1]).localeCompare(String(right[1])),
      );
    expect(relations).toEqual([
      ["handles", "handler"],
      ["handles", "handler"],
      ["handles", "os-default-client"],
      ["exposes", "privileged-scheme"],
    ]);
  });

  it("counts every registration in the application summary", async () => {
    const result = await analyzeJavaScriptApplication({
      input_path: await protocolFixture(),
    });
    if (!result.ok) throw result.error;
    expect(parseEvidence(result.value)).toMatchObject({
      normalized_result: { summary: { protocol_registrations: 4 } },
    });
  });
});
