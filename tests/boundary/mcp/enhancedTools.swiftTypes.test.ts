import { afterEach, describe, expect, it } from "vitest";
import { EnhancedTools } from "../../../src/application/EnhancedTools.js";
import {
  AnalysisArtifactChangedError,
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
} from "../../../src/domain/analysisErrorCore.js";
import { err } from "../../../src/domain/result.js";
import { observed as ok } from "../../fixtures/analysisExecution.js";
import { GHIDRA_SWIFT_INVENTORY } from "../../fixtures/swift/ghidraInventory.js";
import {
  closeEnhancedToolResources,
  connect,
  jsonResult,
} from "./enhancedToolsHarness.js";

afterEach(closeEnhancedToolResources);

describe("Swift classification through MCP", () => {
  it.each([
    { arguments: {}, total: 6 },
    { arguments: { category: "structs" }, total: 5 },
    { arguments: { category: "structs", pattern: "Pair" }, total: 3 },
    { arguments: { pattern: "_$s4main4PairVMa" }, total: 1 },
  ])("classifies golden Ghidra observations with $arguments", async (test) => {
    const client = await connect({
      execute: async (operation) =>
        ok(
          operation === "list_procedures"
            ? GHIDRA_SWIFT_INVENTORY.procedures
            : GHIDRA_SWIFT_INVENTORY.symbols,
        ),
    });
    const result = await client.callTool({
      name: "analyze_swift_types",
      arguments: test.arguments,
    });
    expect(result.isError).not.toBe(true);
    const inventory = jsonResult(result);
    expect(inventory).toMatchObject({ total: test.total });
    if (test.arguments.pattern === undefined)
      expect(inventory).toMatchObject({
        categories: {
          structs: {
            items: expect.not.arrayContaining([
              expect.objectContaining({ address: "0x100000c0c" }),
            ]),
          },
        },
      });
    if (test.arguments.pattern === undefined)
      expect(jsonResult(result)).toMatchObject({
        unclassified: [
          {
            name: "main::$swiftIndirect",
            reason: "category_not_decoded",
            mangled_names: ["_$s4main13swiftIndirectySiAA7Scoring_p_SitF"],
          },
        ],
      });
    else expect(jsonResult(result)).toMatchObject({ unclassified: [] });
  });

  it("keeps provider names and supporting aliases inline", async () => {
    const client = await connect({
      execute: async (operation) =>
        ok(
          operation === "list_procedures"
            ? GHIDRA_SWIFT_INVENTORY.procedures
            : GHIDRA_SWIFT_INVENTORY.symbols,
        ),
    });
    expect(
      jsonResult(
        await client.callTool({
          name: "analyze_swift_types",
          arguments: { category: "structs", pattern: "typeMetadataAccessor" },
        }),
      ),
    ).toMatchObject({
      total: 2,
      categories: {
        structs: {
          items: [
            {
              address: "0x100000ab4",
              name: "main::Pair::typeMetadataAccessor",
              mangled_names: ["_$s4main4PairVMa"],
            },
            {
              address: "0x100000ac4",
              name: "main::Scorer::typeMetadataAccessor",
              mangled_names: ["_$s4main6ScorerVMa"],
            },
          ],
        },
      },
      unclassified: [],
    });
  });

  it("retains known facts when a provider has no symbol inventory", async () => {
    const client = await connect({
      execute: async (operation) =>
        operation === "list_procedures"
          ? ok([{ address: "0x1", value: "$s4main4PairVMa" }])
          : err(
              new AnalysisCapabilityUnavailableError(
                "fixture",
                operation,
                "no symbols",
              ),
            ),
    });
    const result = await client.callTool({
      name: "analyze_swift_types",
      arguments: { category: "structs" },
    });
    expect(result.isError).not.toBe(true);
    expect(jsonResult(result)).toMatchObject({
      total: 1,
      symbol_inventory_error: { code: "capability_unavailable" },
      limitations: expect.arrayContaining([
        expect.stringContaining("symbol inventory is unavailable"),
      ]),
    });
  });

  it.each([
    new AnalysisOutputError("list_names", "malformed symbols"),
    new AnalysisArtifactChangedError(
      "list_names",
      "/fixture",
      "fixture changed",
    ),
  ])("preserves symbol-inventory failures: $_tag", async (failure) => {
    const tools = new EnhancedTools({
      execute: async (operation) =>
        operation === "list_procedures"
          ? ok([{ address: "0x1", value: "$s4main4PairVMa" }])
          : err(failure),
    });
    expect(await tools.execute("analyze_swift_types", {})).toEqual(
      err(failure),
    );
  });

  it("returns cancellation during the symbol join", async () => {
    const controller = new AbortController();
    const tools = new EnhancedTools({
      execute: async (operation) => {
        if (operation === "list_names") controller.abort();
        return ok([{ address: "0x1", value: "$s4main4PairVMa" }]);
      },
    });
    expect(
      await tools.execute("analyze_swift_types", {}, controller.signal),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisCancelledError" } });
  });
});

describe("Unresolved Swift contexts through MCP", () => {
  it("keeps unresolved substituted contexts out of nominal categories", async () => {
    // Issue/review spellings and ABI-derived controls from a controlled provider.
    // These are not observations from a real Swift/Hopper run in this test.
    const unresolved = [
      "$s1M1WVAASHRzlE1fyyF",
      "$s1M1WVAASiRszlE1fyyF",
      "$s1M1WVAA5Other1CVRszlE1fyyF",
      // Unsupported pack-marker requirements keep context ownership unknown.
      "$s1M1WVAARvzlE1fyyF",
      "_$s1M7WrapperVAASQRzlE4sameySbxF",
      "_$s1M3BoxVAARi_zrlE1vxvM",
      "_$s1M3BoxVAARi_zrlE1vxvr.resume.0",
      "_$s1M3BoxVAARi_zrlE1vxvs",
      "_$s1M3BoxVAARi_zrlE1vACyxGx_tcfC",
    ];
    const structs = [
      // Identifier substitutions can name properties/functions in the nominal.
      "$s1M1WVAASivg",
      "$s1M1WVABSivg",
      "$s1M1WVAASiyF",
      "$s1M1WVAA5Other1CVvg",
      "_$s1M7WrapperV1vxvg",
      "_$s1M7WrapperVMa",
      "_$s1M7WrapperV1vACyxGx_tcfC",
      // Unaliased constructors use nominal substitutions for their result type.
      "_$s4main6ScorerVACycfC",
      "_$s1M1SVACycfC",
      // Operator-looking text inside literal member names is not context.
      "_$s1M7WrapperV4AASQyyF",
      "_$s1M7WrapperV4sameySExF",
      "_TtV7Fixture6Struct",
    ];
    const extension = "_$s10Foundation4DataV1ME10countTwiceSiyF";
    const procedures = [...unresolved, ...structs, extension].map(
      (value, index) => ({ address: `0x${index.toString(16)}`, value }),
    );
    const entries = (names: readonly string[]) =>
      procedures
        .filter(({ value }) => names.includes(value))
        .map(({ address, value }) => ({
          address,
          name: value,
          mangled_names: [value],
        }));
    const unclassified = entries(unresolved).map((item) => ({
      ...item,
      reason: "category_not_decoded",
    }));
    const client = await connect({
      execute: async (operation) => {
        if (operation === "list_procedures") return ok(procedures);
        if (operation === "list_names") return ok([]);
        return err(
          new AnalysisCapabilityUnavailableError(
            "fixture",
            operation,
            "unmodeled operation",
          ),
        );
      },
    });
    for (const category of ["structs", undefined] as const) {
      const result = await client.callTool({
        name: "analyze_swift_types",
        arguments: category === undefined ? {} : { category },
      });
      expect(result.isError).not.toBe(true);
      expect(jsonResult(result)).toMatchObject({
        total: category === undefined ? procedures.length : structs.length,
        categories: {
          structs: { count: structs.length, items: entries(structs) },
          extensions: {
            count: category === undefined ? 1 : 0,
            items: category === undefined ? entries([extension]) : [],
          },
          other: {
            count: category === undefined ? unresolved.length : 0,
            items: category === undefined ? entries(unresolved) : [],
          },
        },
        unclassified,
        limitations: expect.arrayContaining([
          expect.stringContaining("could not be established"),
        ]),
      });
    }
  });

  it.each([false, true])(
    "retains a decoded alias beside an unresolved context (reversed: %s)",
    async (reversed) => {
      const names = ["_$s1M7ServiceCMa", "_$s1M7WrapperVAASQRzlE4sameySbxF"];
      if (reversed) names.reverse();
      const client = await connect({
        execute: async (operation) => {
          if (operation === "list_procedures")
            return ok([{ address: "0x1", value: "provider::shared" }]);
          if (operation === "list_names")
            return ok(names.map((value) => ({ address: "0x1", value })));
          return err(
            new AnalysisCapabilityUnavailableError(
              "fixture",
              operation,
              "unmodeled operation",
            ),
          );
        },
      });
      const result = await client.callTool({
        name: "analyze_swift_types",
        arguments: { category: "classes" },
      });
      expect(result.isError).not.toBe(true);
      expect(jsonResult(result)).toMatchObject({
        total: 1,
        categories: {
          classes: {
            count: 1,
            items: [
              {
                address: "0x1",
                name: "provider::shared",
                mangled_names: names,
              },
            ],
          },
          other: { count: 0, items: [] },
        },
        unclassified: [],
      });
    },
  );
});

describe("Substituted Swift contexts through MCP", () => {
  // Preserve nominal-prefix evidence for witness/entity tails without validating
  // their bodies. Generic-context uncertainty is covered separately above.
  it.each([
    // Reported async/resume regressions and ABI-derived private/punycode names.
    ["$s5Async1SVAA1PA2aDP1fyyYaFTWTQ0_", "structs"],
    ["$s1M1SVAA1PA2aDP1xSivMTW.resume.0", "structs"],
    ["$s1M1SVAA005P_geaA2aDP1fyyFTW", "structs"],
    [
      "$s1M1SVAA8PrivateP33_0123456789ABCDEF0123456789ABCDEFLLAAAAADAELLP1fyyFTW",
      "structs",
    ],
    // Additional review regressions: grouped extension, static and nested witnesses.
    ["$s1M1WVA2A1PRzlE1fyyF", "other"],
    ["$s1M1SVAA1PA2aDP1gSiyFZTW", "structs"],
    ["$s1N1SVAA9NamespaceO1PAaeFP1fyyFTW", "structs"],
    // Identifier substitutions can also serve as module names.
    ["$s1M1SVABE1fyyF", "other"],
    // ABI-derived entity families; the classifier does not decode their bodies.
    ["$s1M1SVAA1PA2aDP1xSivgTW", "structs"],
    ["$s1M1SVAA1PA2aDP1xSivsTW", "structs"],
    ["$s1M1SVAA1PA2aDP1xSivgZTW", "structs"],
    ["$s1M1SVAA1PA2aDPyS2icigTW", "structs"],
    ["$s1M1SVAA1PA2aDPxycfCTW", "structs"],
    ["$s1M1SVAA1PA2aDPxycfcTW", "structs"],
    ["$s1M1SVAA1PA2aDPTW", "structs"],
    ["$s1M1SVAA1PA2aDTW", "structs"],
    // Equivalent grouping, nested nominal paths, and malformed boundaries.
    ["$s1M1WVAaA1PRzlE1fyyF", "other"],
    ["$s1M1WVA999999999999999999999A1PRzlE1fyyF", "structs"],
    ["$s1M1SVA1A1PA2aDP1gSiyFZTW", "structs"],
    ["$s1N1SVAA9NamespaceC1PAaeFP1fyyFTW", "structs"],
    ["$s1N1SVAA9NamespaceO5InnerV1PAagHP1fyyFZTW", "structs"],
    ["$s1N5OuterV1SVAA9NamespaceO1PAagHP1fyyFTW", "structs"],
    ["$s1N1SVAA9NamespaceO1PAaeDP1fyyFTW", "structs"],
    ["$s1N1SVAA9NamespaceO1PAacFP1fyyFTW", "structs"],
    ["$s1N1SVAA9NamespaceO1PA2aeFP1fyyFTW", "structs"],
    ["$s1N1SVAA9NamespaceO1PAae2FP1fyyFTW", "structs"],
    ["$s1N1SVAA9NamespaceO1PAaefP1fyyFTW", "structs"],
    ["$s1N1SVAA99NamespaceO1PAaeFP1fyyFTW", "structs"],
    ["$s1N1SVAA9NamespaceO01PAaeFP1fyyFTW", "structs"],
    ["$s1M1SVAA1PA2aDP1gSiyFZTWjunk", "structs"],
    ["$s1M1SVAA1PA2aDP3ZTWSiyFZTW", "structs"],
    // Reported Scorer witness; remaining names are grammar-derived controls.
    ["_$s4main6ScorerVAA7ScoringA2aDP5scoreyS2iFTW", "structs"],
    ["_$s4main6ScorerCAA7ScoringA2aDP5scoreyS2iFTW", "classes"],
    ["_$s4main6ScorerOAA7ScoringA2aDP5scoreyS2iFTW", "enums"],
    ["_$s4main5OuterV6ScorerVAA7ScoringA2aFP5scoreyS2iFTW", "structs"],
    ["_$s4main6ScorerVAA7ScoringAaaDP5scoreyS2iFTW", "structs"],
    ["_$s4main6ScorerVAA7ScoringAAAAADP5scoreyS2iFTW", "structs"],
    ["_$s4main6ScorerVAA7ScoringA2aDP4ETWWyS2iFTW", "structs"],
    [
      `_$s4main${"ABCDEFGHIJKLM"
        .split("")
        .map((name) => `1${name}V`)
        .join("")}AA7ScoringA2a0_P5scoreyS2iFTW`,
      "structs",
    ],
    // Unsupported identities/tails retain baseline nominal-prefix evidence.
    ["_$s4main6ScorerVAA7ScoringA2aEP5scoreyS2iFTW", "structs"],
    ["_$s4main6ScorerVAA7ScoringA2a_P5scoreyS2iFTW", "structs"],
    ["_$s4main6ScorerVAA7ScoringA2a0_P5scoreyS2iFTW", "structs"],
    ["_$s4main5OuterV6ScorerVAA7ScoringA2aDP5scoreyS2iFTW", "structs"],
    ["_$s4main6ScorerVAA7ScoringA999999999999aDP5scoreyS2iFTW", "structs"],
    ["_$s4main6ScorerVAA7ScoringA2adP5scoreyS2iFTW", "structs"],
    ["_$s4main6ScorerVAA7ScoringA2aDE5scoreyS2iFTW", "structs"],
    ["_$s4main6ScorerVAA7ScoringA2aDP5scoreyS2iFTWjunk", "structs"],
    ["_$s4main6ScorerVAA7ScoringA2aDP5scoreyS2iF", "structs"],
  ] as const)("classifies %s as %s", async (name, category) => {
    const client = await connect({
      execute: async (operation) => {
        if (operation === "list_procedures")
          return ok([{ address: "0x1", value: name }]);
        if (operation === "list_names") return ok([]);
        return err(
          new AnalysisCapabilityUnavailableError(
            "fixture",
            operation,
            "unmodeled operation",
          ),
        );
      },
    });
    const result = await client.callTool({
      name: "analyze_swift_types",
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    const item = { address: "0x1", name, mangled_names: [name] };
    expect(jsonResult(result)).toMatchObject({
      total: 1,
      categories: { [category]: { count: 1, items: [item] } },
      unclassified:
        category === "other"
          ? [{ ...item, reason: "category_not_decoded" }]
          : [],
    });
  });
});
