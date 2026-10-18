import * as t from "@babel/types";

import {
  readExactJavaScriptLiteral,
  semanticStaticPropertyKey,
  semanticWriteSiteTarget,
  semanticWriteTargets,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { traverseJavaScriptAstSteps } from "./javascriptSemanticTraversal.js";

/** Match Electron's supported module entry points. */
export const ELECTRON_MODULE =
  /^electron(?:\/(?:common|main|renderer|utility))?$/u;

/**
 * Electron's CommonJS exports define no `default` member, so a leading
 * `default` segment can only denote the module object itself, as an ES module
 * default import (`import electron from "electron"`) binds it.
 */
export const electronExportPath = (
  importedPath: readonly string[],
): readonly string[] =>
  importedPath[0] === "default" ? importedPath.slice(1) : importedPath;

/** Static identity recovery cannot establish the absence of Electron usage. */
export const ELECTRON_IDENTITY_LIMITATION =
  "Electron API identity follows proven lexical module aliases and structurally verified module-namespace interop. Other reassignments, dynamic selections, and visibly overwritten namespace members are unresolved; missing findings do not establish absence. Arbitrary call side effects and runtime registration are not evaluated.";

/** Preserve exact property segments instead of flattening literal dotted keys. */
export const electronMemberPath = (
  node: t.Node,
): {
  readonly root: t.Node;
  readonly members: readonly (string | null)[];
} => {
  let root = unwrapJavaScriptExpression(node).node;
  const members: (string | null)[] = [];
  while (t.isMemberExpression(root) || t.isOptionalMemberExpression(root)) {
    members.push(semanticStaticPropertyKey(root.property, root.computed));
    root = unwrapJavaScriptExpression(root.object).node;
  }
  return { root, members: members.toReversed() };
};

/** A known intrinsic callable and its examined positional arguments. */
export interface JavaScriptIntrinsicInvocation {
  readonly kind: "known" | "opaque";
  /** The original bound receiver; rebinding cannot replace it. */
  readonly receiver?: t.Node;
  /** Callable selections consumed while recovering a bound invocation. */
  readonly callableReads?: readonly t.Node[];
  readonly path: readonly string[];
  readonly arguments:
    | readonly t.CallExpression["arguments"][number][]
    | undefined;
}

/** Parsed recipient evidence can be refined when binding facts are complete. */
export interface JavaScriptIntrinsicMutationRecipient {
  readonly invocation: JavaScriptIntrinsicInvocation;
  readonly target: t.Node | undefined;
}

/** Select possible property-write recipients, preserving unknown receiver aliases. */
export const semanticIntrinsicMutationTargets = (
  invocation: JavaScriptIntrinsicInvocation,
  freshObject: (node: t.Node) => boolean,
): readonly (t.Node | undefined)[] => {
  const args = invocation.arguments;
  if (
    invocation.path.join(".") !== "intrinsic.Reflect.set" ||
    args === undefined ||
    (args.length < 4 && !args.some(t.isSpreadElement))
  )
    return [args?.[0]];
  if (args.some(t.isSpreadElement)) return [args[0], undefined];
  const receiver = args[3];
  // A fresh object receives its own data slot. An unknown receiver may still
  // be the target itself, so retain that possible alias as well.
  return receiver !== undefined &&
    (freshObject(receiver) || readExactJavaScriptLiteral(receiver).found)
    ? [receiver]
    : [args[0], receiver];
};

/**
 * Index writes through possible lexical object identities. Resolve the complete
 * object before appending the written key: self-reference properties can denote
 * the same object, while replacing that property is a distinct write.
 */
export function* collectJavaScriptIdentityWritesSteps(
  program: t.Program,
  origin: (
    root: t.Node,
    kind: "binding" | "member" | "opaque-call",
    writeSite: t.Node,
  ) => readonly (readonly (string | null)[])[],
  intrinsicInvocation: (
    node: t.CallExpression | t.OptionalCallExpression,
  ) => JavaScriptIntrinsicInvocation | undefined,
  staticString: (node: t.Node | undefined) => string | undefined,
  freshObject: (node: t.Node) => boolean,
  retain: (
    node: t.Node,
    path: readonly (string | null)[],
    recipient?: JavaScriptIntrinsicMutationRecipient,
  ) => void,
  observeInvocation?: (
    node:
      | t.CallExpression
      | t.OptionalCallExpression
      | t.NewExpression
      | t.TaggedTemplateExpression,
    invocation: JavaScriptIntrinsicInvocation | undefined,
  ) => void,
): Generator<void> {
  const objectMutators = new Set([
    "defineProperty",
    "defineProperties",
    "assign",
    "setPrototypeOf",
  ]);
  const reflectMutators = new Set([
    "set",
    "deleteProperty",
    "defineProperty",
    "setPrototypeOf",
  ]);
  const keyedMutators = new Set(["set", "deleteProperty", "defineProperty"]);
  yield* traverseJavaScriptAstSteps(program, {
    enter: (node) => {
      if (
        t.isCallExpression(node) ||
        t.isOptionalCallExpression(node) ||
        t.isNewExpression(node) ||
        t.isTaggedTemplateExpression(node)
      ) {
        const invocation =
          t.isNewExpression(node) || t.isTaggedTemplateExpression(node)
            ? undefined
            : intrinsicInvocation(node);
        observeInvocation?.(node, invocation);
        if (t.isNewExpression(node) || t.isTaggedTemplateExpression(node))
          return;
        if (invocation?.kind === "opaque") {
          for (const scope of origin(node, "opaque-call", node))
            retain(node, scope);
          return;
        }
        const callee = invocation?.path;
        const arguments_ = invocation?.arguments;
        const method = callee?.at(-1);
        const owner = callee?.length === 3 ? callee[1] : undefined;
        if (
          (owner === "Object" && objectMutators.has(method ?? "")) ||
          (owner === "Reflect" && reflectMutators.has(method ?? ""))
        ) {
          const targets = semanticIntrinsicMutationTargets(
            invocation!,
            freshObject,
          );
          for (const target of targets) {
            const recipient = { invocation: invocation!, target };
            // A known mutator with an opaque argument list can overwrite any
            // captured intrinsic. Do not turn an unexamined target into proof.
            if (target === undefined || t.isSpreadElement(target)) {
              for (const scope of origin(node, "opaque-call", node))
                retain(node, scope, recipient);
            }
            if (t.isNode(target) && !t.isSpreadElement(target)) {
              const identities = origin(target, "member", node);
              if (identities.length > 0) {
                const key = keyedMutators.has(method ?? "")
                  ? [staticString(arguments_?.[1]) ?? null]
                  : // Mutating a target's contents does not replace the target.
                    // Retain an unknown child key, rather than its own identity.
                    [null];
                for (const identity of identities)
                  retain(node, [...identity, ...key], recipient);
              } else if (!freshObject(target)) {
                for (const scope of origin(node, "opaque-call", node))
                  retain(node, scope, recipient);
              }
            }
          }
        }
      }
      const target = semanticWriteSiteTarget(node);
      if (target === null) return;
      for (const leaf of semanticWriteTargets(target)) {
        if (t.isIdentifier(leaf)) {
          for (const identity of origin(leaf, "binding", node))
            retain(node, identity);
          continue;
        }
        const member = unwrapJavaScriptExpression(leaf).node;
        if (
          !t.isMemberExpression(member) &&
          !t.isOptionalMemberExpression(member)
        )
          continue;
        const key = semanticStaticPropertyKey(member.property, member.computed);
        for (const identity of origin(member.object, "member", node))
          retain(node, [...identity, key]);
      }
    },
  });
}
