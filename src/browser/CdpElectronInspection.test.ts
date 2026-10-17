import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";
import {
  captureFrames,
  inspectCdpElectronPage,
} from "./CdpElectronInspection.js";
import type { CdpEvent } from "./CdpConnection.js";
import type { CdpConnection } from "./CdpConnection.js";
import {
  ingestElectronScriptEvent,
  type ElectronScriptDraft,
} from "./CdpElectronScriptEvents.js";
import { captureElectronScripts } from "./CdpElectronScripts.js";
import { inspectElectronPageInputSchema } from "../domain/javascript/electronObservation.js";

const temporary: string[] = [];

const inspectRaceConnection = (connection: CdpConnection, mainUrl: string) =>
  inspectCdpElectronPage({
    connection,
    sessionId: undefined,
    discovery: {
      webSocket: { scope: "browser", url: "ws://127.0.0.1:9222" },
      version: {
        product: "fixture",
        protocol_version: "1",
        revision: "",
        user_agent: "fixture",
        js_version: "",
      },
      targets: [],
    },
    target: {
      id: "page",
      type: "page",
      title: "fixture",
      url: mainUrl,
      attached: false,
    },
    input: inspectElectronPageInputSchema.parse({
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "page",
      observation_ms: 0,
    }),
  });

it.each(["initial", "refreshed", "final", "ancestor", "stable"])(
  "binds frame authorization to the tree read across file checks: %s",
  async (stage) => {
    const root = await mkdtemp(join(tmpdir(), "rea-frame-generation-race-"));
    temporary.push(root);
    const main = join(root, "main.html"),
      child = join(root, "child.html"),
      script = join(root, "app.js");
    await Promise.all([
      writeFile(main, "main"),
      writeFile(child, "child"),
      writeFile(script, "void 0;"),
    ]);
    const mainUrl = pathToFileURL(main).href,
      childUrl = pathToFileURL(child).href;
    let listener: (event: CdpEvent) => void = () => {};
    let reads = 0,
      fired = false;
    const emitScript = () => {
      listener({
        method: "Runtime.executionContextCreated",
        params: { context: { id: 7, auxData: { frameId: "child" } } },
      });
      listener({
        method: "Debugger.scriptParsed",
        params: {
          scriptId: "new-document-script",
          url: pathToFileURL(script).href,
          executionContextId: 7,
          hash: "new-document",
        },
      });
    };
    const inject = () => {
      listener({
        method: "Page.frameNavigated",
        params: {
          frame: {
            id: stage === "ancestor" ? "parent" : "child",
            parentId: "main",
            url: "https://foreign.test/new-document",
          },
        },
      });
      if (stage !== "initial") emitScript();
    };
    const connection = {
      onEvent: (value: typeof listener) => {
        listener = value;
        return () => {};
      },
      send: async (method: string) => {
        if (method === "Page.getFrameTree") {
          reads++;
          const shouldInject =
            (stage === "initial" && reads === 1) ||
            (stage === "refreshed" && reads === 2) ||
            (stage === "ancestor" && reads === 2) ||
            (stage === "final" && reads === 3);
          return {
            frameTree: {
              frame: { id: "main", url: mainUrl },
              childFrames:
                (stage === "initial" && reads > 1) ||
                (stage === "refreshed" && reads !== 2) ||
                (stage === "ancestor" && reads !== 2) ||
                (stage === "final" && reads === 1)
                  ? []
                  : [
                      {
                        frame: {
                          id: stage === "ancestor" ? "parent" : "child",
                          parentId: "main",
                          get url() {
                            if (
                              shouldInject &&
                              stage !== "ancestor" &&
                              !fired
                            ) {
                              fired = true;
                              queueMicrotask(inject);
                            }
                            return childUrl;
                          },
                        },
                        ...(stage === "ancestor"
                          ? {
                              childFrames: [
                                {
                                  frame: {
                                    id: "child",
                                    parentId: "parent",
                                    get url() {
                                      if (shouldInject && !fired) {
                                        fired = true;
                                        queueMicrotask(inject);
                                      }
                                      return childUrl;
                                    },
                                  },
                                },
                              ],
                            }
                          : {}),
                      },
                    ],
            },
          };
        }
        if (method === "Debugger.enable" && stage === "initial") emitScript();
        if (method === "Debugger.enable" && stage === "stable") {
          listener({
            method: "Runtime.executionContextCreated",
            params: { context: { id: 7, auxData: { frameId: "child" } } },
          });
          listener({
            method: "Debugger.scriptParsed",
            params: {
              scriptId: "stable-script",
              url: pathToFileURL(script).href,
              executionContextId: 7,
              hash: "stable",
            },
          });
        }
        if (method === "Page.getResourceTree")
          return {
            frameTree: { frame: { id: "main", url: mainUrl }, resources: [] },
          };
        if (method === "DOMSnapshot.captureSnapshot")
          return { strings: [], documents: [] };
        if (method === "Target.getTargets") return { targetInfos: [] };
        return {};
      },
    } as unknown as CdpConnection;
    const result = await inspectRaceConnection(connection, mainUrl);
    if (stage === "stable")
      expect(result.scripts.items).toContainEqual(
        expect.objectContaining({ frame_id: "child", cdp_hash: "stable" }),
      );
    else {
      expect(fired).toBe(true);
      if (stage !== "final")
        expect(result.scripts.items).toContainEqual(
          expect.objectContaining({ frame_id: null, cdp_hash: "new-document" }),
        );
      expect(result.completeness.attach_limited_sections).toContain("frames");
    }
  },
);

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Electron frame capture", () => {
  it.each([7, undefined])(
    "classifies a malformed child frame ID as unavailable: %s",
    async (childId) => {
      const root = await mkdtemp(join(tmpdir(), "rea-electron-frame-"));
      temporary.push(root);
      const main = join(root, "index.html");
      const child = join(root, "child.html");
      await Promise.all([writeFile(main, "main"), writeFile(child, "child")]);
      const mainUrl = pathToFileURL(main).href;
      const childUrl = pathToFileURL(child).href;
      const completeness = new CdpCaptureCompleteness();

      const frames = await captureFrames(
        {
          frameTree: {
            frame: { id: "frame-main", url: mainUrl },
            childFrames: [
              {
                frame: {
                  ...(childId === undefined ? {} : { id: childId }),
                  url: childUrl,
                },
              },
            ],
          },
        },
        completeness,
      );

      expect(frames.map((frame) => frame.frame_id)).toEqual(["frame-main"]);
      expect(completeness.snapshot()).toMatchObject({
        unavailable_sections: ["frames"],
        excluded: [
          { section: "frames", reason: "invalid_protocol_value", count: 1 },
        ],
      });
      expect(completeness.snapshot().policy_filtered_sections).not.toContain(
        "frames",
      );
      expect(completeness.snapshot().conditions).toContain("attach_limited");
    },
  );

  it("preserves script records across context teardown and ID reuse", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-electron-script-frame-"));
    temporary.push(root);
    const scriptPath = join(root, "app.js");
    await writeFile(scriptPath, "export const app = true;");
    const scripts: ElectronScriptDraft[] = [];
    const executionContextFrames = new Map<string, string>();
    const completeness = new CdpCaptureCompleteness();
    const ingest = (method: string, params: unknown): void =>
      ingestElectronScriptEvent({
        event: { method, params },
        scripts,
        executionContextFrames,
        completeness,
      });
    const context = (frameId: string) => ({
      context: { id: 7, auxData: { frameId } },
    });
    const parsed = (
      scriptId: string,
      hash: string,
      url = pathToFileURL(scriptPath).href,
    ) => ({
      scriptId,
      url,
      hash,
      executionContextId: 7,
    });

    ingest("Runtime.executionContextCreated", context("frame-old"));
    ingest("Debugger.scriptParsed", parsed("script-old", "shared"));
    ingest("Runtime.executionContextDestroyed", { executionContextId: 7 });
    ingest("Runtime.executionContextCreated", context("frame-new"));
    ingest("Debugger.scriptParsed", parsed("script-new", "shared"));
    ingest("Runtime.executionContextsCleared", {});
    ingest("Debugger.scriptParsed", parsed("script-unknown", "unknown"));
    ingest("Runtime.executionContextCreated", context("frame-outside"));
    ingest("Debugger.scriptParsed", parsed("script-outside", "outside"));
    ingest(
      "Debugger.scriptParsed",
      parsed(
        "script-out-of-scope",
        "out-of-scope",
        "https://example.test/app.js",
      ),
    );

    const capture = await captureElectronScripts({
      connection: {
        send: async () => {
          throw new Error("Source capture must remain disabled in this test");
        },
      } as unknown as CdpConnection,
      sessionId: undefined,
      request: inspectElectronPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "page-1",
        observation_ms: 0,
        include_script_sources: false,
      }),
      scripts,
      frameForScript: (script) =>
        script.frameId !== null &&
        new Set(["frame-old", "frame-new"]).has(script.frameId)
          ? script.frameId
          : null,
      completeness,
    });

    expect(capture.total).toBe(4);
    const sharedScripts = capture.items.filter(
      (item) => item.cdp_hash === "shared",
    );
    expect(new Set(sharedScripts.map((item) => item.frame_id))).toEqual(
      new Set(["frame-old", "frame-new"]),
    );
    expect(new Set(sharedScripts.map((item) => item.script_key)).size).toBe(2);
    expect(
      Object.fromEntries(
        capture.items
          .filter((item) => item.cdp_hash !== "shared")
          .map((item) => [item.cdp_hash, item.frame_id]),
      ),
    ).toEqual({
      unknown: null,
      outside: null,
    });
    expect(completeness.snapshot().excluded).toContainEqual({
      section: "scripts",
      reason: "out_of_target_scope",
      count: 1,
    });
  });
});
