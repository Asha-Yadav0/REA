import { describe, expect, it } from "vitest";

import { createSemanticModuleInterop } from "./javascriptModuleInterop.js";
import { indexJavaScriptBindingsWithReceiversSteps } from "./javascriptSemanticAnalysis.js";
import { createSemanticReceiverReferences } from "./javascriptSemanticReceiverReferences.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { analyzeParsedJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const SHIM = 'var Q=(e=>typeof require<"u"?require:e)(function(){});';
const USE = 'Q("electron").ipcRenderer.send("kept");';
const analyze = (setup: string) => {
  const source = `${SHIM}${setup}${USE}`;
  const parsed = parseJavaScriptSource(source, "bundle.js");
  if (parsed === null) throw new Error("Expected parsed source");
  return analyzeParsedJavaScriptStaticSource(source, parsed).electron.ipc;
};

describe("stored class-field receivers", () => {
  it.each([
    "class C{set=function(){this.Q=other}};new C().set();",
    "class C{set=function change(){this.Q=other}};new C().set();",
    "class C{static set=function(){this.Q=other}};C.set();",
    "class C{['set']=function(){this.Q=other}};new C().set();",
    "class B{set=function(){this.Q=other}};class C extends B{};new C().set();",
    "function set(){this.Q=other}class C{set=set};new C().set();",
    "class C{set=()=>{this.Q=other}};new C().set();",
  ])("keeps an invoked field's receiver separate: %s", (setup) => {
    expect(analyze(setup)).toMatchObject([{ channel: "kept" }]);
  });

  it.each([
    "class C{set=function(){this.Q=other}};new C().set.call(globalThis);",
    "class C{set=function(){this.Q=other}};const c=new C();c.set();use(c.set);",
    "class C{static set=function(){this.Q=other}};C.set();use(C.set);",
    "class C{set=function(){this.Q=other}};new C().set();use([new C()]);",
    "function set(){this.Q=other}class C{set=set};const c=new C();c.set();const run=c.set;run();",
    "class B{constructor(){return globalThis}}class C extends B{set=function(){this.Q=other}};new C().set();",
  ])("retains an escaped or global field receiver: %s", (setup) => {
    expect(analyze(setup)).toEqual([]);
  });
});

describe("normalized construction receivers", () => {
  it.each([
    "Reflect.construct(set,[]);",
    "Reflect.construct?.(set,[]);",
    "const make=Reflect.construct;make(set,[]);",
    "const {construct:make}=Reflect;make(set,[]);",
    "Reflect.construct.call(null,set,[]);",
    "Reflect.construct.apply(null,[set,[]]);",
    "Reflect.apply(Reflect.construct,null,[set,[]]);",
    "const make=Reflect.construct.bind(null,set);make([]);",
    "const make=Reflect.construct.bind(null);make.call(null,set,[]);",
    "Reflect.construct(set,[],function Alternate(){});",
    "const make=Reflect.construct;Reflect.construct=other;make(set,[]);",
    "const make=Reflect.construct.bind(null,set);Reflect.construct=other;make([]);",
    "Reflect.construct.call.call(Reflect.construct,null,set,[]);",
    "const make=Reflect.construct.call.call.bind(Reflect.construct,null,set);function fn(){}fn.call.call=other;make([]);",
    "function fn(){}fn.call=other;Reflect.construct.call.call(Reflect.construct,null,set,[]);",
    "Reflect.call={};Reflect.call.call=other;Reflect.construct.call.call(Reflect.construct,null,set,[]);",
    "const make=Reflect.construct;function fn(){}fn.call.call=other;make(set,[]);",
  ])("keeps a constructed function's receiver separate: %s", (call) => {
    expect(analyze(`function set(){this.Q=other}${call}`)).toMatchObject([
      { channel: "kept" },
    ]);
  });

  it("does not use a base constructor's returned object as its own receiver", () => {
    expect(
      analyze(
        "function set(){this.Q=other;return globalThis}Reflect.construct(set,[]);",
      ),
    ).toMatchObject([{ channel: "kept" }]);
  });

  it.each([
    "function set(){this.Q=other}Reflect.construct(set,[]);set();",
    "function set(){this.Q=other}Reflect.construct(set,[]);set.call(globalThis);",
    "function set(){this.Q=other}Reflect.construct(set,[]);use(set);",
    "function set(){this.Q=other}const Reflect={construct(fn){fn()}};Reflect.construct(set,[]);",
    "function set(){this.Q=other}Reflect.construct=other;Reflect.construct(set,[]);",
    "function set(){this.Q=other}Reflect.construct=other;const make=Reflect.construct;make(set,[]);",
    "function set(){this.Q=other}const R=Reflect;R.construct=other;R.construct(set,[]);",
    "function set(){this.Q=other}Object.defineProperty(Reflect,'construct',{value:other});Reflect.construct(set,[]);",
    "function set(){this.Q=other}Reflect.construct.call=other;Reflect.construct.call(null,set,[]);",
    "function set(){this.Q=other}Function.prototype.call=other;Reflect.construct.call(null,set,[]);",
    "function set(){this.Q=other}Reflect.apply=other;Reflect.apply(Reflect.construct,null,[set,[]]);",
    "function set(){this.Q=other}function fn(){}fn.call.call=other;Reflect.construct.call.call(Reflect.construct,null,set,[]);",
    "function set(){this.Q=other}Object.assign.call.call=other;Reflect.construct.call.call(Reflect.construct,null,set,[]);",
    "function set(){this.Q=other}const helper=Function.prototype.call;helper.call=other;Reflect.construct.call.call(Reflect.construct,null,set,[]);",
    "function set(){this.Q=other}function patch(){Reflect.construct=other}patch();Reflect.construct(set,[]);",
    "function set(){this.Q=other}patch();Reflect.construct(set,[]);function patch(){Reflect.construct=other}",
    "function set(){this.Q=other}function patch(){Reflect.construct=other}use(patch);Reflect.construct(set,[]);",
    "function set(){this.Q=other}function fn(){}function patch(){fn.call.call=other}patch();Reflect.construct.call.call(Reflect.construct,null,set,[]);",
    "function set(){this.Q=other}function patch(){Reflect.construct.bind=other}patch();const make=Reflect.construct.bind(null,set);make([]);",
    "function set(){this.Q=other}eval('Reflect.construct=other');Reflect.construct(set,[]);",
    "function set(){this.Q=other}(0,eval)('Reflect.construct=other');Reflect.construct(set,[]);",
    "function set(){this.Q=other}var make=Reflect.construct;eval('make=other');make(set,[]);",
    "function set(){this.Q=other}Reflect.construct(...args,set,[]);",
    "function set(){this.Q=other}Reflect.construct.apply(null,[set,[set]]);",
    "function set(){this.Q=other}Reflect.construct.bind(null,set)([set]);",
    "class B{constructor(){return globalThis}}class C extends B{constructor(){super();this.Q=other}}Reflect.construct(C,[]);",
    "class B{constructor(){return globalThis}}class C extends B{field=(this.Q=other)}Reflect.construct(C,[]);",
  ])("retains global, escaped, and inherited receivers: %s", (setup) => {
    expect(analyze(setup)).toEqual([]);
  });
});

it("refreshes a retained receiver query after ambient facts complete", () => {
  const parsed = parseJavaScriptSource(
    "var local={};function set(){this.Q=other}set.call(local);",
    "bundle.js",
  );
  if (parsed === null) throw new Error("Expected parsed source");
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(parsed.program),
  );
  const target = parsed.program.body[1];
  const statement =
    target?.type === "FunctionDeclaration" ? target.body.body[0] : undefined;
  const assignment =
    statement?.type === "ExpressionStatement"
      ? statement.expression
      : undefined;
  const receiver =
    assignment?.type === "AssignmentExpression" &&
    assignment.left.type === "MemberExpression"
      ? assignment.left.object
      : undefined;
  if (receiver?.type !== "ThisExpression") throw new Error("Expected receiver");
  const references = createSemanticReceiverReferences(index.bindings);
  expect(references(receiver)).toContain(parsed.program);
  completeSemanticSteps(index.indexAmbientWritesSteps());
  expect(references(receiver)).not.toContain(parsed.program);
});

it.each([
  ["eval('Reflect.construct=other');Reflect.construct(set,[]);", "opaque"],
  ["(0,eval)('Reflect.construct=other');Reflect.construct(set,[]);", "opaque"],
  [
    "const make=Reflect.construct;eval('Reflect.construct=other');make(set,[]);",
    "known",
  ],
  [
    "const make=Reflect.construct.bind(null,set);eval('Reflect.construct=other');make([]);",
    "known",
  ],
  ["var make=Reflect.construct;eval('make=other');make(set,[]);", "opaque"],
])("checks helper captures against complete eval facts: %s", (setup, kind) => {
  const parsed = parseJavaScriptSource(`function set(){}${setup}`, "bundle.js");
  if (parsed === null) throw new Error("Expected parsed source");
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(parsed.program),
  );
  completeSemanticSteps(index.indexAmbientWritesSteps());
  const state = index.bindings;
  const nominal = createSemanticModuleInterop(state);
  const checked = createSemanticModuleInterop(state, {
    intrinsicPath: nominal.intrinsicPath,
    intrinsicWriteFacts: {
      ambientWrites: state.ambientWrites,
      ambientWriteEffects: state.ambientWriteEffects,
      opaqueGlobalSites: state.opaqueEffects.globalSites,
      complete: true,
    },
  });
  const statement = parsed.program.body.at(-1);
  const call =
    statement?.type === "ExpressionStatement"
      ? statement.expression
      : undefined;
  if (call?.type !== "CallExpression") throw new Error("Expected call");
  expect(checked.intrinsicInvocation(call)?.kind).toBe(kind);
});
