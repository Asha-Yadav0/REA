import { parseExpression } from "@babel/parser";
import * as t from "@babel/types";

import type { JavaScriptModuleOrigin } from "./javascriptSemanticIr.js";
import {
  isUnshadowedGlobal,
  resolveSemanticBindingState,
  semanticScopeId,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import { semanticRequireOrigin } from "./javascriptSemanticRequireOrigin.js";
import {
  semanticBindingAtRead,
  semanticEffectFollowsInitialCapture,
} from "./javascriptSemanticMutationInitializers.js";
import {
  childNodes,
  javaScriptAstChildKeys,
} from "./javascriptSemanticTraversal.js";
import {
  electronMemberPath,
  type JavaScriptIntrinsicInvocation,
} from "./javascriptElectronMemberWrites.js";
import {
  expandJavaScriptInvocationArguments,
  resolveJavaScriptIntrinsicInvocation,
} from "./javascriptIntrinsicInvocation.js";
import {
  SemanticPropertyPathCoverage,
  semanticPropertyPathKeyMatches,
} from "./javascriptSemanticPropertyPaths.js";
import { semanticPossibleFunctionValueIdentities } from "./javascriptSemanticFunctionValues.js";
import {
  readExactJavaScriptLiteral,
  runtimeFunctionParameters,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  semanticGlobalBindingReadMayHaveChanged,
  semanticOpaqueBindingReadMayHaveChanged,
  type SemanticGlobalBindingFacts,
} from "./javascriptSemanticOpaqueEffects.js";

// Match the complete Rolldown runtime operations, including its live getters.
// Names and formatting are irrelevant; lexical roles, operators and keys are not.
const TO_ESM = parseExpression(`(mod, isNodeMode, target) => (
  target = mod != null ? __create(__getProtoOf(mod)) : {},
  __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default")
    ? __defProp(target, "default", {value: mod, enumerable: true}) : target, mod)
)`);
const COPY_PROPS = parseExpression(`(to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function")
    for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
      key = keys[i];
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, {
          get: ((k) => from[k]).bind(null, key),
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
    }
  return to;
}`);
const INTRINSICS: Readonly<Record<string, readonly string[]>> = {
  __create: ["Object", "create"],
  __getProtoOf: ["Object", "getPrototypeOf"],
  __defProp: ["Object", "defineProperty"],
  __getOwnPropNames: ["Object", "getOwnPropertyNames"],
  __getOwnPropDesc: ["Object", "getOwnPropertyDescriptor"],
  __hasOwnProp: ["Object", "prototype", "hasOwnProperty"],
};

interface IntrinsicDependency {
  readonly path: readonly string[];
  readonly capturedAt?: t.Node;
}

interface InteropOrigin {
  readonly origin: JavaScriptModuleOrigin;
  readonly dependencies: readonly IntrinsicDependency[];
  readonly defaultIsModule: boolean;
}

interface InteropHelper {
  readonly dependencies: readonly IntrinsicDependency[];
  readonly readyAfter: number;
  readonly identity: boolean;
}

const completedFreshObjectFacts =
  new WeakSet<JavaScriptSemanticAnalysisState>();

/** Derived mutation caches must distinguish provisional and final proofs. */
export const semanticFreshObjectFactsReady = (
  state: JavaScriptSemanticAnalysisState,
): boolean => completedFreshObjectFacts.has(state);

/** Ambient writes and deferred opaque calls must both be indexed first. */
export const completeSemanticFreshObjectFacts = (
  state: JavaScriptSemanticAnalysisState,
): void => {
  completedFreshObjectFacts.add(state);
};

/** Prove one inert namespace conversion without relaxing general assignment semantics. */
export const createSemanticModuleInterop = (
  state: JavaScriptSemanticAnalysisState,
  options?: {
    readonly intrinsicPath: (node: t.Node) => readonly string[] | undefined;
    /** Complete canonical effects, kept separate from nominal alias paths. */
    readonly intrinsicWriteFacts?: SemanticGlobalBindingFacts;
    /** A producer may supply complete provisional facts before publication. */
    readonly bindingReadMayHaveChanged?: (
      binding: JavaScriptSemanticBindingState,
      read: t.Node,
    ) => boolean;
  },
) => {
  const globalBindingFacts = {
    ambientWrites: state.ambientWrites,
    ambientWriteEffects: state.ambientWriteEffects,
    get complete() {
      return completedFreshObjectFacts.has(state);
    },
  };
  const helpers = new Map<string, InteropHelper | null>();
  const origins = new Map<string, InteropOrigin>();
  const calls = new WeakMap<t.Node, InteropOrigin>();
  const intrinsicBindings = new Map<string, readonly string[] | null>();
  const writes: {
    readonly scope: string;
    readonly offset: number;
    readonly coverage: SemanticPropertyPathCoverage;
  }[] = [];
  const invalidatedBindings = new Map<string, boolean>();
  const invalidatedCalls = new WeakMap<t.Node, boolean>();
  const opaqueMutationPath = (node: t.Node): readonly string[] => {
    let current: t.Node | undefined = node;
    while (current !== undefined) {
      if (t.isFunction(current))
        return ["opaque-intrinsic", semanticScopeId("function", current)];
      current = state.parentsByNode.get(current);
    }
    return ["intrinsic"];
  };

  const intrinsicPath =
    options?.intrinsicPath ??
    ((node: t.Node): readonly string[] | undefined => {
      let current = node;
      const visited = new Set<string>();
      const pending: { id: string; suffixLength: number }[] = [];
      let suffix: readonly string[] = [];
      const finish = (
        path: readonly string[] | undefined,
      ): readonly string[] | undefined => {
        for (const binding of pending)
          intrinsicBindings.set(
            binding.id,
            path === undefined
              ? null
              : path.slice(0, path.length - binding.suffixLength),
          );
        return path;
      };
      for (;;) {
        const { root, members } = electronMemberPath(current);
        if (members.some((member) => member === null)) return finish(undefined);
        suffix = [...(members as readonly string[]), ...suffix];
        for (const global of ["Object", "Function", "Reflect"])
          if (isUnshadowedGlobal(root, state, global))
            return finish(["intrinsic", global, ...suffix]);
        for (const global of ["globalThis", "global", "window", "self"])
          if (isUnshadowedGlobal(root, state, global))
            return finish(["intrinsic", ...suffix]);
        if (!t.isIdentifier(root)) return finish(undefined);
        const binding = resolveSemanticBindingState(state, root, root.name);
        const cached =
          binding === undefined
            ? undefined
            : intrinsicBindings.get(binding.bindingId);
        if (cached !== undefined)
          return finish(cached === null ? undefined : [...cached, ...suffix]);
        const initializer = semanticStableInitializer(binding, state);
        if (
          binding === undefined ||
          initializer === undefined ||
          initializer.projection.some((segment) => segment === null) ||
          visited.has(binding.bindingId)
        )
          return finish(undefined);
        visited.add(binding.bindingId);
        pending.push({ id: binding.bindingId, suffixLength: suffix.length });
        suffix = [...initializer.projection.map(String), ...suffix];
        current = initializer.node;
      }
    });

  // A nominal alias path is sufficient for conservative mutation lookup, but
  // helper proof also needs each read to follow initialization. An alias copy
  // retains the earlier function capture; a member read captures it anew.
  const intrinsicBindingReadMayHaveChanged = (
    binding: JavaScriptSemanticBindingState,
    read: t.Node,
  ): boolean =>
    options?.intrinsicWriteFacts !== undefined &&
    (semanticOpaqueBindingReadMayHaveChanged(binding, read, state) ||
      semanticGlobalBindingReadMayHaveChanged(
        binding,
        read,
        state,
        options.intrinsicWriteFacts,
      ));
  const capturedIntrinsic = (node: t.Node): IntrinsicDependency | undefined => {
    const path = intrinsicPath(node);
    if (path === undefined) return undefined;
    const visited = new Set<string>();
    let current = node;
    let capturedAt = node;
    let suffixLength = 0;
    for (;;) {
      const { root, members } = electronMemberPath(current);
      suffixLength += members.length;
      if (!t.isIdentifier(root)) return undefined;
      const binding = resolveSemanticBindingState(state, root, root.name);
      if (binding === undefined) return { path, capturedAt };
      if (intrinsicBindingReadMayHaveChanged(binding, root)) return undefined;
      const initializer = semanticStableInitializer(binding, state);
      if (
        initializer === undefined ||
        (initializer.node.end ?? Infinity) >= (root.start ?? -1) ||
        visited.has(binding.bindingId)
      )
        return undefined;
      visited.add(binding.bindingId);
      if (suffixLength === 0) capturedAt = initializer.node;
      suffixLength += initializer.projection.length;
      current = initializer.node;
    }
  };

  const staticString = (node: t.Node | undefined): string | undefined => {
    if (node === undefined) return undefined;
    const visited = new Set<string>();
    let current = node;
    for (;;) {
      const literal = readExactJavaScriptLiteral(current);
      if (literal.found)
        return typeof literal.value === "string" ? literal.value : undefined;
      const expression = unwrapJavaScriptExpression(current).node;
      if (!t.isIdentifier(expression)) return undefined;
      const binding = resolveSemanticBindingState(
        state,
        expression,
        expression.name,
      );
      const initializer = semanticStableInitializer(binding, state);
      if (
        binding === undefined ||
        initializer === undefined ||
        initializer.projection.length !== 0 ||
        (initializer.node.end ?? Infinity) >= (expression.start ?? -1) ||
        visited.has(binding.bindingId)
      )
        return undefined;
      visited.add(binding.bindingId);
      current = initializer.node;
    }
  };

  const intrinsicReadChanged = (
    node: t.Node,
    path: readonly string[],
  ): boolean => {
    const dependency = capturedIntrinsic(node);
    const capture = dependency?.capturedAt ?? node;
    const facts = options?.intrinsicWriteFacts;
    if (facts !== undefined) {
      if (
        facts.complete !== true ||
        (dependency === undefined && intrinsicPath(node) !== undefined)
      )
        return true;
      if (
        (facts.opaqueGlobalSites ?? state.opaqueEffects.globalSites).some(
          (effect) =>
            !semanticEffectFollowsInitialCapture(capture, effect, state),
        )
      )
        return true;
      const nominal = ["global", ...path.slice(1)];
      const dependencies = new Map<string, readonly string[]>([
        [JSON.stringify(nominal), nominal],
      ]);
      const retain = (dependency: readonly string[]) =>
        dependencies.set(JSON.stringify(dependency), dependency);
      for (let index = 2; index < nominal.length; index += 1) {
        const prefix = nominal.slice(0, index);
        for (const owner of semanticPossibleFunctionValueIdentities(prefix))
          retain([...owner, nominal[index]!]);
        for (const selected of semanticPossibleFunctionValueIdentities([
          ...prefix,
          nominal[index]!,
        ]))
          retain(selected);
      }
      // Possible value identities only invalidate a read; they never establish
      // intrinsic identity. Unknown cross-function execution order stays unsafe.
      const writtenDependencies = [...dependencies.values()].filter(
        (dependency) => facts.ambientWrites.covers(dependency),
      );
      if (
        writtenDependencies.length > 0 &&
        facts.ambientWriteEffects.some(
          (effect) =>
            writtenDependencies.some(
              (dependency) =>
                effect.path.length <= dependency.length &&
                effect.path.every((key, index) =>
                  semanticPropertyPathKeyMatches(key, dependency[index]!),
                ),
            ) &&
            !semanticEffectFollowsInitialCapture(capture, effect.node, state),
        )
      )
        return true;
    }
    const scope = opaqueMutationPath(capture).join(".");
    const method = path.at(-1);
    const invocationMethod =
      method === "bind" || method === "call" || method === "apply";
    return writes.some(
      (write) =>
        (write.scope === scope || write.scope === "intrinsic") &&
        write.offset < (capture.start ?? -1) &&
        (write.coverage.covers(path) ||
          (invocationMethod &&
            write.coverage.covers([
              "intrinsic",
              "Function",
              "prototype",
              method,
            ]))),
    );
  };

  const resolveBoundIntrinsic = (
    node: t.Node,
  ): JavaScriptIntrinsicInvocation | undefined => {
    const visited = new Set<string>();
    const argumentGroups: t.CallExpression["arguments"][] = [];
    const bindReads: t.Node[] = [];
    const callableReads: t.Node[] = [];
    let opaqueArguments = false;
    let receiver: t.Node | undefined;
    let current = node;
    for (;;) {
      current = unwrapJavaScriptExpression(current).node;
      if (t.isIdentifier(current)) {
        const binding = resolveSemanticBindingState(
          state,
          current,
          current.name,
        );
        const initializer = semanticStableInitializer(binding, state);
        if (
          binding === undefined ||
          intrinsicBindingReadMayHaveChanged(binding, current) ||
          initializer === undefined ||
          initializer.projection.length !== 0 ||
          (initializer.node.end ?? Infinity) >= (current.start ?? -1) ||
          visited.has(binding.bindingId)
        )
          return undefined;
        visited.add(binding.bindingId);
        current = initializer.node;
        continue;
      }
      if (!t.isCallExpression(current)) return undefined;
      const { root, members } = electronMemberPath(current.callee);
      let bindTarget = root;
      let bindingArguments: JavaScriptIntrinsicInvocation["arguments"] =
        expandJavaScriptInvocationArguments(current.arguments);
      let captured = capturedIntrinsic(current.callee);
      const calleePath = captured?.path ?? intrinsicPath(current.callee);
      let terminal = calleePath?.at(-1) === "bind";
      let path: readonly string[] | undefined = calleePath?.slice(0, -1);
      if (members.at(-1) === "bind") {
        // A direct .bind may continue a bound callable, without discarding members.
        if (!terminal && members.length !== 1) return undefined;
        bindReads.push(captured?.capturedAt ?? current.callee);
      } else {
        // Reuse the invocation owner for generic call/apply/Reflect.apply of bind.
        const invocation = resolveJavaScriptIntrinsicInvocation(
          current,
          intrinsicPath,
          boundIntrinsic,
          intrinsicReadChanged,
        );
        if (
          invocation?.kind !== "known" ||
          invocation.path.join(".") !== "intrinsic.Function.prototype.bind" ||
          invocation.receiver === undefined
        )
          return undefined;
        bindTarget = invocation.receiver;
        bindingArguments = invocation.arguments;
        captured = capturedIntrinsic(bindTarget);
        path = captured?.path ?? intrinsicPath(bindTarget);
        terminal = path !== undefined;
      }
      // A possible alias can still invoke an intrinsic through bind. Keep its
      // effects when capture proof is unavailable, without proving arguments or
      // weakening the stricter capture proof used for namespace helpers.
      callableReads.push(current.callee, bindTarget);
      opaqueArguments ||= terminal && captured === undefined;
      receiver = bindingArguments?.[0];
      const ownArguments = bindingArguments?.slice(1) ?? [];
      opaqueArguments ||=
        bindingArguments === undefined || t.isSpreadElement(receiver);
      opaqueArguments ||= ownArguments.some((argument) =>
        t.isSpreadElement(argument),
      );
      argumentGroups.push(ownArguments);
      if (!terminal || path === undefined) {
        current = bindTarget;
        continue;
      }
      const boundPath = [...path, "bind"];
      opaqueArguments ||= bindReads.some((capture) =>
        intrinsicReadChanged(capture, boundPath),
      );
      return {
        kind: opaqueArguments ? "opaque" : "known",
        path,
        callableReads,
        ...(receiver === undefined ? {} : { receiver }),
        // Rebinding appends arguments to the earlier bound argument list.
        arguments: opaqueArguments
          ? undefined
          : argumentGroups.toReversed().flat(),
      };
    }
  };

  const activeBoundValues = new WeakSet<t.Node>();
  const boundIntrinsic = (
    node: t.Node,
  ): JavaScriptIntrinsicInvocation | undefined => {
    if (activeBoundValues.has(node)) return undefined;
    activeBoundValues.add(node);
    try {
      return resolveBoundIntrinsic(node);
    } finally {
      activeBoundValues.delete(node);
    }
  };

  const isObjectValue = (node: t.Node, mode: "fresh" | "definite"): boolean => {
    const visited = new Set<string>();
    let current = node;
    for (;;) {
      current = unwrapJavaScriptExpression(current).node;
      if (
        t.isObjectExpression(current) ||
        t.isArrayExpression(current) ||
        t.isFunction(current) ||
        (t.isClass(current) &&
          (mode === "definite" || !current.decorators?.length)) ||
        t.isRegExpLiteral(current) ||
        // Successful construction always supplies an object, but a constructor
        // can return an existing object instead of its fresh instance.
        (mode === "definite" && t.isNewExpression(current))
      )
        return true;
      if (!t.isIdentifier(current)) return false;
      const binding = resolveSemanticBindingState(state, current, current.name);
      if (
        binding !== undefined &&
        (options?.bindingReadMayHaveChanged?.(binding, current) ??
          (semanticOpaqueBindingReadMayHaveChanged(binding, current, state) ||
            semanticGlobalBindingReadMayHaveChanged(
              binding,
              current,
              state,
              globalBindingFacts,
            )))
      )
        return false;
      const selected =
        binding === undefined
          ? undefined
          : semanticBindingAtRead(binding, current, state.parentsByNode);
      const [initial] = selected?.binding.initializers ?? [];
      const initializer =
        unprojectedInitializer(binding, state) ??
        (selected?.hasDefiniteInitializer &&
        selected.binding.initializers.length === 1 &&
        selected.binding.referenceInitializers.length === 0 &&
        initial?.projection.length === 0
          ? initial.node
          : undefined);
      if (
        binding === undefined ||
        initializer === undefined ||
        (!t.isFunctionDeclaration(initializer) &&
          (initializer.end ?? Infinity) >= (current.start ?? -1)) ||
        visited.has(binding.bindingId)
      )
        return false;
      visited.add(binding.bindingId);
      current = initializer;
    }
  };

  const helperProof = (
    binding: JavaScriptSemanticBindingState,
  ): InteropHelper | undefined => {
    const cached = helpers.get(binding.bindingId);
    if (cached !== undefined) return cached ?? undefined;
    helpers.set(binding.bindingId, null);
    if (state.scopesById.get(binding.scopeId)?.kind !== "program")
      return undefined;
    const wrapper = unprojectedInitializer(binding, state);
    if (wrapper === undefined) return undefined;
    if (identityFunction(wrapper, state)) {
      const proof = {
        dependencies: [],
        readyAfter: t.isFunctionDeclaration(wrapper)
          ? -1
          : (wrapper.end ?? Infinity),
        identity: true,
      };
      helpers.set(binding.bindingId, proof);
      return proof;
    }
    const wrapperRoles = canonicalRoles(wrapper, TO_ESM, state);
    const copyBinding = wrapperRoles?.get("__copyProps");
    const copy = unprojectedInitializer(copyBinding, state);
    const copyRoles =
      copy === undefined ? undefined : canonicalRoles(copy, COPY_PROPS, state);
    if (
      wrapperRoles === undefined ||
      copyRoles === undefined ||
      copy === undefined
    )
      return undefined;
    const dependencies: IntrinsicDependency[] = [];
    let readyAfter = Math.max(wrapper.end ?? Infinity, copy.end ?? Infinity);
    for (const roles of [wrapperRoles, copyRoles])
      for (const [role, dependency] of roles) {
        const expected = INTRINSICS[role];
        if (expected === undefined) continue;
        const initializer = unprojectedInitializer(dependency, state);
        const captured =
          initializer === undefined
            ? undefined
            : capturedIntrinsic(initializer);
        if (
          initializer === undefined ||
          captured === undefined ||
          JSON.stringify(captured.path) !==
            JSON.stringify(["intrinsic", ...expected])
        )
          return undefined;
        readyAfter = Math.max(readyAfter, initializer.end ?? Infinity);
        dependencies.push(captured);
        if (role === "__hasOwnProp")
          dependencies.push({ path: [...captured.path, "call"] });
      }
    dependencies.push(
      { path: ["intrinsic", "Function", "prototype", "bind"] },
      { path: ["intrinsic", "Function", "prototype", "call"] },
    );
    const proof = {
      dependencies,
      identity: false,
      readyAfter,
    };
    helpers.set(binding.bindingId, proof);
    return proof;
  };

  const provenCall = (node: t.Node) => {
    if (!t.isCallExpression(node) || !t.isIdentifier(node.callee))
      return undefined;
    const helper = resolveSemanticBindingState(
      state,
      node.callee,
      node.callee.name,
    );
    const proof = helper === undefined ? undefined : helperProof(helper);
    const input = node.arguments[0];
    const mode = node.arguments[1];
    const literalMode =
      mode === undefined
        ? { found: true, value: false }
        : t.isExpression(mode)
          ? readExactJavaScriptLiteral(mode)
          : { found: false };
    if (
      proof === undefined ||
      proof.readyAfter >= (node.start ?? -1) ||
      !t.isExpression(input) ||
      node.arguments.length > 2 ||
      !literalMode.found
    )
      return undefined;
    return {
      input,
      // A truthy node mode forces the module-valued default. Other modes
      // preserve named exports without proving the source's default property.
      defaultIsModule: !proof.identity && Boolean(literalMode.value),
      dependencies: proof.dependencies.map((dependency) => ({
        ...dependency,
        capturedAt: dependency.capturedAt ?? node,
      })),
    };
  };

  const callOrigin = (node: t.Node): InteropOrigin | undefined => {
    const cached = calls.get(node);
    if (cached !== undefined) return cached;
    const { root, members } = electronMemberPath(node);
    if (!members.every((member): member is string => member !== null))
      return undefined;
    const converted = provenCall(root);
    const required =
      converted === undefined
        ? undefined
        : semanticRequireOrigin(converted.input, state)?.origin;
    if (
      converted === undefined ||
      required === undefined ||
      required.importedPath.length !== 0 ||
      (members[0] === "default" && !converted.defaultIsModule)
    )
      return undefined;
    const result = {
      origin: { ...required, importedPath: members },
      dependencies: converted.dependencies,
      defaultIsModule: converted.defaultIsModule,
    };
    calls.set(node, result);
    return result;
  };

  const origin = (
    binding: JavaScriptSemanticBindingState,
  ): InteropOrigin | undefined => {
    const single = semanticStableInitializer(binding, state);
    if (single !== undefined) {
      if (
        !single.projection.every(
          (key): key is string => typeof key === "string",
        )
      )
        return undefined;
      const converted = callOrigin(single.node);
      if (
        converted?.origin.importedPath.length === 0 &&
        single.projection[0] === "default" &&
        !converted.defaultIsModule
      )
        return undefined;
      const result =
        converted === undefined
          ? undefined
          : {
              ...converted,
              origin: {
                ...converted.origin,
                importedPath: [
                  ...converted.origin.importedPath,
                  ...single.projection,
                ],
              },
            };
      if (result !== undefined) origins.set(binding.bindingId, result);
      return result;
    }
    const [initial, converted] = binding.initializers;
    if (
      binding.definitions.length !== 2 ||
      binding.definitions[0]?.kind !== "variable" ||
      binding.definitions[1]?.kind !== "assignment" ||
      binding.initializers.length !== 2 ||
      initial === undefined ||
      converted === undefined ||
      initial.projection.length !== 0 ||
      converted.projection.length !== 0 ||
      state.conditionallySkippedExpressions.has(initial.node)
    )
      return undefined;
    const call = converted.node;
    const assignment = state.parentsByNode.get(call);
    const statement =
      assignment === undefined
        ? undefined
        : state.parentsByNode.get(assignment);
    const declaration = state.parentsByNode.get(initial.node);
    const declarationStatement =
      declaration === undefined
        ? undefined
        : state.parentsByNode.get(declaration);
    if (
      !t.isCallExpression(call) ||
      !t.isIdentifier(call.callee) ||
      !t.isAssignmentExpression(assignment, { operator: "=" }) ||
      assignment.right !== call ||
      !t.isIdentifier(assignment.left, { name: binding.name }) ||
      !t.isExpressionStatement(statement) ||
      !t.isVariableDeclarator(declaration) ||
      !t.isVariableDeclaration(declarationStatement) ||
      state.parentsByNode.get(statement) !==
        state.parentsByNode.get(declarationStatement) ||
      (initial.node.start ?? Infinity) >= (call.start ?? -1)
    )
      return undefined;
    const convertedCall = provenCall(call);
    const input = convertedCall?.input;
    if (
      !t.isIdentifier(input) ||
      resolveSemanticBindingState(state, input, input.name) !== binding
    )
      return undefined;
    const required = semanticRequireOrigin(initial.node, state)?.origin;
    if (required === undefined || required.importedPath.length !== 0)
      return undefined;
    if (convertedCall === undefined) return undefined;
    const result = {
      origin: required,
      dependencies: convertedCall.dependencies,
      defaultIsModule: convertedCall.defaultIsModule,
    };
    origins.set(binding.bindingId, result);
    return result;
  };
  const invalidatedOrigin = (record: InteropOrigin | undefined): boolean =>
    record?.dependencies.some(({ path, capturedAt }) => {
      if (capturedAt === undefined) return true;
      const scope = opaqueMutationPath(capturedAt).join(".");
      // Captured function values survive later replacement of global
      // properties. Other callable bodies are not execution evidence.
      return writes.some(
        (write) =>
          (write.scope === scope || write.scope === "intrinsic") &&
          write.offset < (capturedAt.start ?? -1) &&
          write.coverage.covers(path),
      );
    }) ?? false;
  return {
    origin,
    callOrigin,
    intrinsicPath,
    intrinsicInvocation: (node: t.CallExpression | t.OptionalCallExpression) =>
      resolveJavaScriptIntrinsicInvocation(
        node,
        intrinsicPath,
        boundIntrinsic,
        intrinsicReadChanged,
      ),
    boundIntrinsic,
    staticString,
    isFreshObject: (node: t.Node) => isObjectValue(node, "fresh"),
    isDefinitelyObject: (node: t.Node) => isObjectValue(node, "definite"),
    opaqueMutationPath,
    retainWrite: (node: t.Node, path: readonly (string | null)[]) => {
      const coverage = new SemanticPropertyPathCoverage();
      coverage.retain(path[0] === "opaque-intrinsic" ? ["intrinsic"] : path);
      writes.push({
        scope: opaqueMutationPath(node).join("."),
        offset: node.start ?? Infinity,
        coverage,
      });
    },
    invalidated: (binding: JavaScriptSemanticBindingState): boolean => {
      const cached = invalidatedBindings.get(binding.bindingId);
      if (cached !== undefined) return cached;
      const result = invalidatedOrigin(origins.get(binding.bindingId));
      invalidatedBindings.set(binding.bindingId, result);
      return result;
    },
    invalidatedCall: (node: t.Node): boolean => {
      const cached = invalidatedCalls.get(node);
      if (cached !== undefined) return cached;
      const result = invalidatedOrigin(calls.get(node));
      invalidatedCalls.set(node, result);
      return result;
    },
  };
};

const identityFunction = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (
    !t.isFunction(node) ||
    node.async ||
    node.generator ||
    runtimeFunctionParameters(node).length !== 1
  )
    return false;
  const parameter = runtimeFunctionParameters(node)[0];
  const result = t.isBlockStatement(node.body)
    ? node.body.body.length === 1 && t.isReturnStatement(node.body.body[0])
      ? node.body.body[0].argument
      : undefined
    : node.body;
  return (
    t.isIdentifier(parameter) &&
    t.isIdentifier(result) &&
    resolveSemanticBindingState(state, parameter, parameter.name) !==
      undefined &&
    resolveSemanticBindingState(state, parameter, parameter.name) ===
      resolveSemanticBindingState(state, result, result.name)
  );
};

const unprojectedInitializer = (
  binding: JavaScriptSemanticBindingState | undefined,
  state: JavaScriptSemanticAnalysisState,
): t.Node | undefined => {
  const initializer = semanticStableInitializer(binding, state);
  return initializer?.projection.length === 0 ? initializer.node : undefined;
};

/** Match operations and lexical roles, allowing single-statement control blocks. */
const canonicalRoles = (
  actual: t.Node,
  pattern: t.Node,
  state: JavaScriptSemanticAnalysisState,
): ReadonlyMap<string, JavaScriptSemanticBindingState> | undefined => {
  const roles = new Map<string, JavaScriptSemanticBindingState>();
  const used = new Map<string, string>();
  const pending: { actual: t.Node; pattern: t.Node; parent: t.Node | null }[] =
    [{ actual, pattern, parent: null }];
  while (pending.length !== 0) {
    const pair = pending.pop();
    if (pair === undefined) return undefined;
    const { parent } = pair;
    const controlBody =
      (t.isIfStatement(parent) &&
        (parent.consequent === pair.pattern ||
          parent.alternate === pair.pattern)) ||
      (t.isForStatement(parent) && parent.body === pair.pattern);
    const node = controlBody ? controlBodyOperation(pair.actual) : pair.actual;
    const expected = controlBody
      ? controlBodyOperation(pair.pattern)
      : pair.pattern;
    if (node.type !== expected.type) return undefined;
    const literalKey =
      parent !== null &&
      ((t.isMemberExpression(parent) &&
        !parent.computed &&
        parent.property === expected) ||
        (t.isObjectProperty(parent) &&
          !parent.computed &&
          parent.key === expected));
    if (t.isIdentifier(expected) && t.isIdentifier(node) && !literalKey) {
      const binding = resolveSemanticBindingState(state, node, node.name);
      if (
        binding === undefined ||
        (roles.has(expected.name) && roles.get(expected.name) !== binding) ||
        (used.has(binding.bindingId) &&
          used.get(binding.bindingId) !== expected.name)
      )
        return undefined;
      roles.set(expected.name, binding);
      used.set(binding.bindingId, expected.name);
    }
    const visitorKeys = javaScriptAstChildKeys(expected);
    for (const [key, field] of Object.entries(
      t.NODE_FIELDS[expected.type] ?? {},
    )) {
      if (
        visitorKeys.includes(key) ||
        (t.isIdentifier(expected) && key === "name" && !literalKey)
      )
        continue;
      const fallback: unknown = Reflect.get(field, "default");
      if (
        JSON.stringify(Reflect.get(node, key) ?? fallback) !==
        JSON.stringify(Reflect.get(expected, key) ?? fallback)
      )
        return undefined;
    }
    const children = childNodes(node),
      expectedChildren = childNodes(expected);
    if (children.length !== expectedChildren.length) return undefined;
    for (const [index, child] of children.entries()) {
      const expectedChild = expectedChildren[index];
      if (expectedChild !== undefined)
        pending.push({
          actual: child,
          pattern: expectedChild,
          parent: expected,
        });
    }
  }
  return roles;
};

// Braces around one control-body statement do not add operations. Keep other
// blocks, directives and extra statements intact; their semantics need proof.
// Lexical declarations/references still pass through canonicalRoles' bijection.
const controlBodyOperation = (node: t.Node): t.Node => {
  while (
    t.isBlockStatement(node) &&
    node.directives.length === 0 &&
    node.body.length === 1
  ) {
    const statement = node.body[0];
    if (statement === undefined) break;
    node = statement;
  }
  return node;
};
