import * as t from "@babel/types";

import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  createSemanticModuleInterop,
  semanticFreshObjectFactsReady,
} from "./javascriptModuleInterop.js";
import {
  semanticCallableResultExpressions,
  type SemanticCallableResultExpression,
} from "./javascriptSemanticCallableResults.js";
import { semanticBindingAtRead } from "./javascriptSemanticMutationInitializers.js";
import { semanticReferenceSourcesInactive } from "./javascriptSemanticReferenceSources.js";
import {
  semanticArrayIndex,
  type JavaScriptSemanticPropertyPath,
} from "./javascriptSemanticPropertyPaths.js";
import {
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticInitializer,
} from "./javascriptSemanticState.js";

/** A reference potentially handed to a caller or generator consumer. */
export interface SemanticReturnedReference {
  readonly node: t.Node;
  readonly projection: JavaScriptSemanticPropertyPath;
}

interface Candidate {
  readonly node: t.Node;
  readonly path: readonly (string | number | null)[];
  readonly initializers: ReadonlySet<JavaScriptSemanticInitializer>;
  readonly instance?: true;
}

interface CallableReference {
  readonly node: t.Function | t.Class;
  readonly projection: readonly (string | number | null)[];
}

type InitializerContext = ReadonlySet<JavaScriptSemanticInitializer>;
type CompletedExpansions = WeakMap<
  t.Node,
  Map<string, readonly InitializerContext[]>
>;

interface ExpansionFrame {
  readonly item: Candidate;
  readonly node: t.Node;
  readonly pathKey: string;
  readonly parent: ExpansionFrame | null;
  readonly blockers: Set<JavaScriptSemanticInitializer>;
}

type ExpansionTask =
  | {
      readonly kind: "visit";
      readonly item: Candidate;
      readonly parent: ExpansionFrame | null;
    }
  | { readonly kind: "complete"; readonly frame: ExpansionFrame };

const contextContains = (
  context: InitializerContext,
  required: InitializerContext,
): boolean => {
  for (const initializer of required)
    if (!context.has(initializer)) return false;
  return true;
};

const propagateBlockers = (
  blockers: InitializerContext,
  parent: ExpansionFrame | null,
): void => {
  if (parent === null) return;
  for (const initializer of blockers)
    if (parent.item.initializers.has(initializer))
      parent.blockers.add(initializer);
};

const completeExpansion = (
  frame: ExpansionFrame,
  expanded: CompletedExpansions,
): void => {
  const paths =
    expanded.get(frame.node) ??
    new Map<string, readonly InitializerContext[]>();
  const contexts = paths.get(frame.pathKey) ?? [];
  const covered = contexts.find((context) =>
    contextContains(frame.blockers, context),
  );
  if (covered === undefined) {
    paths.set(frame.pathKey, [
      ...contexts.filter(
        (context) => !contextContains(context, frame.blockers),
      ),
      frame.blockers,
    ]);
    expanded.set(frame.node, paths);
  }
  propagateBlockers(covered ?? frame.blockers, frame.parent);
};

interface ObjectTargetIndex {
  readonly propertyByName: ReadonlyMap<
    string,
    t.ObjectMethod | t.ObjectProperty
  >;
  readonly trailingUnknownsByProperty: ReadonlyMap<
    t.ObjectMethod | t.ObjectProperty,
    ObjectTargetUnknown
  >;
}

interface ObjectTargetUnknown {
  readonly node: t.ObjectMethod | t.ObjectProperty | t.SpreadElement;
  readonly previous: ObjectTargetUnknown | undefined;
}

const callableInitializersAt = (
  node: t.Identifier,
  state: JavaScriptSemanticAnalysisState,
): {
  readonly initializers: readonly JavaScriptSemanticInitializer[];
  readonly definite: boolean;
} => {
  const binding = resolveSemanticBindingState(state, node, node.name);
  if (binding === undefined) return { initializers: [], definite: false };
  const selected = semanticBindingAtRead(binding, node, state.parentsByNode);
  return {
    initializers: [
      ...selected.binding.initializers,
      ...selected.binding.referenceInitializers.filter(
        (initializer) =>
          !semanticReferenceSourcesInactive(initializer, state, "syntax-only"),
      ),
    ],
    definite:
      selected.hasDefiniteInitializer ||
      semanticStableInitializer(selected.binding, state) !== undefined,
  };
};

type ClassMember = t.ClassMethod | t.ClassProperty;
type ClassMemberLayer = "static" | "prototype" | "fields";
interface ClassTargetIndex {
  readonly static: readonly ClassMember[];
  readonly prototype: readonly ClassMember[];
  readonly fields: readonly ClassMember[];
  readonly constructorMethod?: t.ClassMethod;
}
interface ClassLineage {
  readonly classes: readonly t.Class[];
  readonly unknownBase?: t.Node;
}

/** Only a complete, unprojected local capture proves one superclass identity. */
const definiteClassAt = (
  expression: t.Node,
  state: JavaScriptSemanticAnalysisState,
): t.Class | undefined => {
  let node = unwrapJavaScriptExpression(expression).node;
  const seen = new Set<JavaScriptSemanticInitializer>();
  while (t.isIdentifier(node)) {
    const selected = callableInitializersAt(node, state);
    const initializer = selected.initializers[0];
    if (
      !selected.definite ||
      selected.initializers.length !== 1 ||
      initializer === undefined ||
      initializer.projection.length > 0 ||
      seen.has(initializer)
    )
      return undefined;
    seen.add(initializer);
    node = unwrapJavaScriptExpression(initializer.node).node;
  }
  return t.isClass(node) ? node : undefined;
};

const classLineage = (
  node: t.Class,
  state: JavaScriptSemanticAnalysisState,
  cache: WeakMap<t.Class, ClassLineage>,
): ClassLineage => {
  const prior = cache.get(node);
  if (prior !== undefined) return prior;
  const classes = [node];
  const seen = new Set<t.Class>(classes);
  let current = node;
  let unknownBase: t.Node | undefined;
  while (current.superClass != null) {
    const base = definiteClassAt(current.superClass, state);
    if (base === undefined) {
      unknownBase = current.superClass;
      break;
    }
    if (seen.has(base)) break;
    seen.add(base);
    classes.push(base);
    current = base;
  }
  const result = {
    classes,
    ...(unknownBase === undefined ? {} : { unknownBase }),
  };
  cache.set(node, result);
  return result;
};

/** Methods/accessors form descriptors; fields initialize afterward. */
const classTargetIndex = (
  node: t.Class,
  cache: WeakMap<t.Class, ClassTargetIndex>,
): ClassTargetIndex => {
  const prior = cache.get(node);
  if (prior !== undefined) return prior;
  const methods = node.body.body.filter(t.isClassMethod);
  const fields = node.body.body.filter(t.isClassProperty);
  const constructor = methods.find((member) => member.kind === "constructor");
  const result = {
    static: [
      ...methods.filter((member) => member.static),
      ...fields.filter((member) => member.static),
    ],
    prototype: methods.filter(
      (member) => !member.static && member.kind !== "constructor",
    ),
    fields: fields.filter((member) => !member.static),
    ...(constructor === undefined ? {} : { constructorMethod: constructor }),
  };
  cache.set(node, result);
  return result;
};

const selectClassTargets = (
  members: readonly ClassMember[],
  key: string | number | null | undefined,
): { readonly values: readonly t.Node[]; readonly own: boolean } => {
  const values: t.Node[] = [];
  let own = false;
  let setter = false;
  for (const member of members.toReversed()) {
    const name = semanticStaticPropertyKey(member.key, member.computed);
    if (key != null && name !== null && name !== String(key)) continue;
    const exact = key != null && name === String(key);
    if (exact) own = true;
    if (t.isClassMethod(member, { kind: "set" })) {
      if (exact) setter = true;
      continue;
    }
    // A setter pairs with an earlier getter, but replaces an earlier data slot.
    if (exact && setter && !t.isClassMethod(member, { kind: "get" })) break;
    const value = t.isClassMethod(member) ? member : member.value;
    if (value != null) values.push(value);
    if (exact) break;
  }
  return { values, own };
};

const constructorReplacesReceiver = (
  constructor: t.ClassMethod | undefined,
  results: readonly SemanticCallableResultExpression[],
  isDefinitelyObject: (node: t.Node) => boolean,
): boolean => {
  const result = results[0];
  return (
    constructor !== undefined &&
    results.length === 1 &&
    result !== undefined &&
    constructor.body.body.some((statement) => statement === result.site) &&
    result.node !== null &&
    isDefinitelyObject(result.node)
  );
};

/** Resolve possible local callable identities without claiming call execution. */
const createSemanticCallableReferences = (
  state: JavaScriptSemanticAnalysisState,
  mode: "callable" | "contents" | "function-values" | "results",
  definiteObjectProof?: (node: t.Node) => boolean,
): ((
  callee: t.Node,
  projection?: readonly (string | number | null)[],
) => readonly CallableReference[]) => {
  let results = new WeakMap<
    t.Node,
    Map<string, readonly CallableReference[]>
  >();
  const objectTargets = new WeakMap<t.ObjectExpression, ObjectTargetIndex>();
  const classTargets = new WeakMap<t.Class, ClassTargetIndex>();
  const classLineages = new WeakMap<t.Class, ClassLineage>();
  const isDefinitelyObject =
    definiteObjectProof ??
    createSemanticModuleInterop(state).isDefinitelyObject;
  let factsReady = semanticFreshObjectFactsReady(state);
  return (callee, projection = []) => {
    const ready = semanticFreshObjectFactsReady(state);
    if (factsReady !== ready) {
      // Provisional global-binding uncertainty is not a final result fact.
      factsReady = ready;
      results = new WeakMap();
    }
    const projectionKey = JSON.stringify(projection);
    const existing = results.get(callee)?.get(projectionKey);
    if (existing !== undefined) return existing;
    const functions = new Map<
      t.Function | t.Class,
      Map<string, CallableReference>
    >();
    const retain = (node: t.Function | t.Class, path: Candidate["path"]) => {
      const paths = functions.get(node) ?? new Map();
      paths.set(JSON.stringify(path), { node, projection: path });
      functions.set(node, paths);
    };
    const work: ExpansionTask[] = [
      {
        kind: "visit",
        item: { node: callee, path: projection, initializers: new Set() },
        parent: null,
      },
    ];
    // Finish descendants before memoizing an expansion. Only actual external
    // cycle blockers affect reuse; branch history is not a dependency. An
    // acyclic expression/path is consequently expanded once across a diamond.
    const expanded: CompletedExpansions = new WeakMap();
    while (work.length > 0) {
      const task = work.pop();
      if (task === undefined) break;
      if (task.kind === "complete") {
        completeExpansion(task.frame, expanded);
        continue;
      }
      const { item, parent } = task;
      const node = unwrapJavaScriptExpression(item.node).node;
      const pathKey = JSON.stringify([item.instance === true, item.path]);
      const covered = expanded
        .get(node)
        ?.get(pathKey)
        ?.find((context) => contextContains(item.initializers, context));
      if (covered !== undefined) {
        // Cached cycle dependencies must reach the caller's proof too.
        propagateBlockers(covered, parent);
        continue;
      }
      const frame: ExpansionFrame = {
        item,
        node,
        pathKey,
        parent,
        blockers: new Set(),
      };
      work.push({ kind: "complete", frame });
      const pending: Candidate[] = [];
      if (t.isIdentifier(node)) {
        for (const initializer of callableInitializersAt(node, state)
          .initializers) {
          if (item.initializers.has(initializer)) {
            frame.blockers.add(initializer);
            continue;
          }
          pending.push({
            ...item,
            node: initializer.node,
            path: [...initializer.projection, ...item.path],
            initializers: new Set([...item.initializers, initializer]),
          });
        }
      } else if (
        t.isMemberExpression(node) ||
        t.isOptionalMemberExpression(node)
      ) {
        const path: (string | number | null)[] = [];
        let receiver: t.Node = node;
        while (
          t.isMemberExpression(receiver) ||
          t.isOptionalMemberExpression(receiver)
        ) {
          path.push(
            semanticStaticPropertyKey(receiver.property, receiver.computed),
          );
          receiver = unwrapJavaScriptExpression(receiver.object).node;
        }
        pending.push({
          ...item,
          node: receiver,
          path: [...path.reverse(), ...item.path],
        });
      } else if (
        t.isConditionalExpression(node) ||
        t.isLogicalExpression(node)
      ) {
        pending.push(
          {
            ...item,
            node: t.isConditionalExpression(node) ? node.consequent : node.left,
          },
          {
            ...item,
            node: t.isConditionalExpression(node) ? node.alternate : node.right,
          },
        );
      } else if (t.isSequenceExpression(node)) {
        const last = node.expressions.at(-1);
        if (last !== undefined) pending.push({ ...item, node: last });
      } else if (t.isFunction(node) && item.instance === true) {
        // An ordinary constructor's new object is distinct from the callable.
        // Only an explicit returned value can supply a callable result here.
        for (const result of semanticCallableResultExpressions(node))
          if (result.node !== null)
            pending.push({
              node: result.node,
              path: item.path,
              initializers: item.initializers,
            });
      } else if (
        mode === "function-values" &&
        (t.isObjectMethod(node) || t.isClassMethod(node)) &&
        (node.kind === "get" || node.kind === "set")
      ) {
        // A property read selects an accessor's result, not its function.
        if (node.kind === "get")
          for (const result of semanticCallableResultExpressions(node))
            if (result.node !== null)
              pending.push({
                node: result.node,
                path: item.path,
                initializers: item.initializers,
              });
      } else if (
        t.isFunction(node) &&
        (item.path.length === 0 || mode === "function-values")
      ) {
        retain(node, item.path);
      } else if (
        t.isObjectExpression(node) &&
        (item.path.length > 0 || mode === "contents")
      )
        selectObjectTargets(node, item, pending, objectTargets);
      else if (
        t.isArrayExpression(node) &&
        (item.path.length > 0 || mode === "contents")
      ) {
        const [key, ...path] = item.path;
        const index =
          key === undefined || key === null ? null : semanticArrayIndex(key);
        let uncertainOffset = false;
        node.elements.forEach((element, offset) => {
          if (element === null) return;
          if (t.isSpreadElement(element)) {
            uncertainOffset = true;
            pending.push({
              ...item,
              node: element.argument,
              path: [null, ...path],
            });
          } else if (index === null || uncertainOffset || index === offset)
            pending.push({ ...item, node: element, path });
        });
      } else if (t.isNewExpression(node))
        pending.push({ ...item, node: node.callee, instance: true });
      else if (t.isClass(node)) {
        const prototype = item.path[0] === "prototype";
        const [key, ...path] = prototype ? item.path.slice(1) : item.path;
        const lineage = classLineage(node, state, classLineages);
        const value = (node: t.Node, path: Candidate["path"]) =>
          pending.push({ node, path, initializers: item.initializers });
        const select = (layer: ClassMemberLayer): boolean => {
          for (const owner of lineage.classes) {
            const selected = selectClassTargets(
              classTargetIndex(owner, classTargets)[layer],
              key,
            );
            for (const selectedValue of selected.values)
              value(selectedValue, path);
            if (selected.own) return true;
          }
          return false;
        };
        if (
          mode === "function-values" &&
          item.instance !== true &&
          !prototype &&
          key === undefined
        )
          retain(node, []);
        else if (mode === "contents" && key === undefined) {
          for (const owner of lineage.classes) {
            const index = classTargetIndex(owner, classTargets);
            for (const member of [
              ...index.static,
              ...index.prototype,
              ...index.fields,
            ]) {
              const selected = t.isClassMethod(member) ? member : member.value;
              if (selected != null) value(selected, []);
            }
          }
        } else if (item.instance === true && !prototype) {
          const constructor = classTargetIndex(
            node,
            classTargets,
          ).constructorMethod;
          const results =
            constructor === undefined
              ? []
              : semanticCallableResultExpressions(constructor);
          for (const result of results)
            if (result.node !== null) value(result.node, item.path);
          const replaced = constructorReplacesReceiver(
            constructor,
            results,
            isDefinitelyObject,
          );
          if (!replaced && key !== undefined) {
            // Every inherited field is an own slot on the new object, so base
            // fields precede even a derived prototype method or accessor.
            if (!select("fields")) {
              select("prototype");
              if (lineage.unknownBase !== undefined)
                pending.push({ ...item, node: lineage.unknownBase });
            }
          }
        } else if (key === undefined) {
          if (!prototype) {
            let followBaseResults = mode === "results";
            for (const owner of lineage.classes) {
              const constructor = classTargetIndex(
                owner,
                classTargets,
              ).constructorMethod;
              if (constructor === undefined) continue;
              value(constructor, []);
              // Invocation selects the first constructor, but normal derived
              // completion preserves the object supplied by super(). Only a
              // definite replacement can hide a possible inherited result.
              if (!followBaseResults) break;
              if (
                constructorReplacesReceiver(
                  constructor,
                  semanticCallableResultExpressions(constructor),
                  isDefinitelyObject,
                )
              ) {
                followBaseResults = false;
                break;
              }
            }
            if (followBaseResults && lineage.unknownBase !== undefined)
              pending.push({ ...item, node: lineage.unknownBase });
          }
        } else if (!select(prototype ? "prototype" : "static")) {
          if (!prototype && key === "__proto__" && node.superClass != null)
            pending.push({ ...item, node: node.superClass, path });
          else if (lineage.unknownBase !== undefined)
            pending.push({ ...item, node: lineage.unknownBase });
          if (
            mode === "function-values" &&
            !prototype &&
            !(key === "__proto__" && node.superClass != null)
          )
            retain(node, item.path);
        }
      }
      for (let index = pending.length - 1; index >= 0; index--) {
        const child = pending[index];
        if (child !== undefined)
          work.push({ kind: "visit", item: child, parent: frame });
      }
    }
    const output = [...functions.values()].flatMap((paths) => [
      ...paths.values(),
    ]);
    const byProjection = results.get(callee) ?? new Map();
    byProjection.set(projectionKey, output);
    results.set(callee, byProjection);
    return output;
  };
};

/** Resolve call targets, without retaining properties of their function values. */
export const createSemanticCallableTargets = (
  state: JavaScriptSemanticAnalysisState,
  mode: "callable" | "contents" = "callable",
  isDefinitelyObject?: (node: t.Node) => boolean,
) => {
  const references = createSemanticCallableReferences(
    state,
    mode,
    isDefinitelyObject,
  );
  return (callee: t.Node): readonly t.Function[] =>
    references(callee).flatMap(({ node }) =>
      t.isFunction(node) ? [node] : [],
    );
};

/** Select a callable once and leave its remaining value projection to its owner. */
export const createSemanticFunctionValueReferences = (
  state: JavaScriptSemanticAnalysisState,
  isDefinitelyObject?: (node: t.Node) => boolean,
) =>
  createSemanticCallableReferences(
    state,
    "function-values",
    isDefinitelyObject,
  );

/** Resolve local result references conservatively, without claiming call execution. */
export const createSemanticReturnedReferences = (
  state: JavaScriptSemanticAnalysisState,
  isDefinitelyObject?: (node: t.Node) => boolean,
): ((callee: t.Node) => readonly SemanticReturnedReference[]) => {
  const targets = createSemanticCallableReferences(
    state,
    "results",
    isDefinitelyObject,
  );
  let results = new WeakMap<t.Node, readonly SemanticReturnedReference[]>();
  let factsReady = semanticFreshObjectFactsReady(state);
  return (callee) => {
    const ready = semanticFreshObjectFactsReady(state);
    if (factsReady !== ready) {
      factsReady = ready;
      results = new WeakMap();
    }
    const prior = results.get(callee);
    if (prior !== undefined) return prior;
    const references = targets(callee).flatMap(({ node: callable }) =>
      semanticCallableResultExpressions(callable).flatMap(
        ({ node, delegated }) =>
          node === null ? [] : [{ node, projection: delegated ? [null] : [] }],
      ),
    );
    results.set(callee, references);
    return references;
  };
};

const selectObjectTargets = (
  node: t.ObjectExpression,
  item: Candidate,
  pending: Candidate[],
  indexes: WeakMap<t.ObjectExpression, ObjectTargetIndex>,
): void => {
  const [key, ...path] = item.path;
  if (key !== null && key !== undefined) {
    const index = objectTargetIndex(node, indexes);
    const property = index.propertyByName.get(String(key));
    if (property !== undefined) {
      const unknowns: ObjectTargetUnknown[] = [];
      for (
        let unknown = index.trailingUnknownsByProperty.get(property);
        unknown !== undefined;
        unknown = unknown.previous
      )
        unknowns.push(unknown);
      for (const { node: unknown } of unknowns.reverse())
        pending.push({
          ...item,
          node: t.isSpreadElement(unknown)
            ? unknown.argument
            : t.isObjectProperty(unknown)
              ? unknown.value
              : unknown,
          ...(t.isSpreadElement(unknown) ? {} : { path }),
        });
      pending.push({
        ...item,
        node: t.isObjectProperty(property) ? property.value : property,
        path,
      });
      return;
    }
  }
  let replaced = false;
  for (const property of [...node.properties].reverse()) {
    if (replaced) break;
    if (t.isSpreadElement(property)) {
      pending.push({ ...item, node: property.argument });
      continue;
    }
    const name = semanticStaticPropertyKey(property.key, property.computed);
    if (
      key !== null &&
      key !== undefined &&
      name !== null &&
      name !== String(key)
    )
      continue;
    if (t.isObjectProperty(property))
      pending.push({ ...item, node: property.value, path });
    else pending.push({ ...item, node: property, path });
    if (key !== null && key !== undefined && name === String(key))
      replaced = true;
  }
};

const objectTargetIndex = (
  node: t.ObjectExpression,
  indexes: WeakMap<t.ObjectExpression, ObjectTargetIndex>,
): ObjectTargetIndex => {
  const existing = indexes.get(node);
  if (existing !== undefined) return existing;
  const propertyByName = new Map<string, t.ObjectMethod | t.ObjectProperty>();
  const trailingUnknownsByProperty = new Map<
    t.ObjectMethod | t.ObjectProperty,
    ObjectTargetUnknown
  >();
  let trailingUnknown: ObjectTargetUnknown | undefined;
  for (const property of [...node.properties].reverse()) {
    if (t.isSpreadElement(property)) {
      trailingUnknown = { node: property, previous: trailingUnknown };
      continue;
    }
    const name = semanticStaticPropertyKey(property.key, property.computed);
    if (name === null) {
      trailingUnknown = { node: property, previous: trailingUnknown };
      continue;
    }
    if (propertyByName.has(name)) continue;
    propertyByName.set(name, property);
    if (trailingUnknown !== undefined)
      trailingUnknownsByProperty.set(property, trailingUnknown);
  }
  const created = { propertyByName, trailingUnknownsByProperty };
  indexes.set(node, created);
  return created;
};
