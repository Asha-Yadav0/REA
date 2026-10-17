import * as t from "@babel/types";

import type {
  ElectronProtocolFinding,
  ElectronStaticValue,
} from "./electronStaticAnalysisTypes.js";
import {
  boundedExpression,
  electronCalleePath,
  electronStaticValue,
} from "./electronStaticAnalysisValues.js";
import {
  semanticStaticPropertyName,
  staticObjectProperty,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { addLocatedFinding } from "./javascriptStaticAnalysisFindings.js";
import { argumentNode, range } from "./javascriptStaticAnalysisHelpers.js";
import type { JavaScriptFindingContext } from "./javascriptStaticAnalysisState.js";

type Role = ElectronProtocolFinding["role"];
type Session = ElectronProtocolFinding["session"];

const HANDLERS = new Set([
  "handle",
  "registerFileProtocol",
  "registerHttpProtocol",
  "registerStringProtocol",
  "registerBufferProtocol",
  "registerStreamProtocol",
]);
const INTERCEPTORS = new Set([
  "interceptFileProtocol",
  "interceptHttpProtocol",
  "interceptStringProtocol",
  "interceptBufferProtocol",
  "interceptStreamProtocol",
]);

/**
 * Inspect custom URL scheme registrations: `app.setAsDefaultProtocolClient`,
 * `protocol.registerSchemesAsPrivileged`, and scheme handlers or interceptors
 * on `protocol` or `session.defaultSession.protocol`.
 */
export const inspectElectronProtocolNode = (
  node: t.Node,
  context: JavaScriptFindingContext,
): void => {
  if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node)) return;
  const path = electronCalleePath(node.callee, context);
  if (path === undefined) return;
  if (path.length === 2 && path[0] === "app") {
    if (path[1] === "setAsDefaultProtocolClient")
      addProtocol(context, {
        node,
        api: "setAsDefaultProtocolClient",
        role: "os-default-client",
        session: "default-protocol",
        scheme: argumentNode(node.arguments[0]),
      });
    return;
  }
  const target = protocolTarget(path);
  if (target === undefined) return;
  if (target.api === "registerSchemesAsPrivileged") {
    inspectPrivilegedSchemes(node, target.session, context);
    return;
  }
  const role: Role | undefined = HANDLERS.has(target.api)
    ? "handler"
    : INTERCEPTORS.has(target.api)
      ? "interceptor"
      : undefined;
  if (role !== undefined)
    addProtocol(context, {
      node,
      api: target.api,
      role,
      session: target.session,
      scheme: argumentNode(node.arguments[0]),
    });
};

const protocolTarget = (
  path: readonly string[],
): { readonly session: Session; readonly api: string } | undefined => {
  if (path.length === 2 && path[0] === "protocol" && path[1] !== undefined)
    return { session: "default-protocol", api: path[1] };
  if (
    path.length === 4 &&
    path[0] === "session" &&
    path[1] === "defaultSession" &&
    path[2] === "protocol" &&
    path[3] !== undefined
  )
    return { session: "default-session", api: path[3] };
  return undefined;
};

/** Record one finding per array entry; a non-literal list stays one dynamic finding. */
const inspectPrivilegedSchemes = (
  node: t.CallExpression | t.OptionalCallExpression,
  session: Session,
  context: JavaScriptFindingContext,
): void => {
  // TypeScript assertions such as `[...] as const` do not change the value.
  const list = typeless(argumentNode(node.arguments[0]));
  const entries = t.isArrayExpression(list) ? list.elements : [list];
  for (const [index, entry] of entries.entries()) {
    const candidate = typeless(entry ?? undefined);
    const scheme = staticObjectProperty(candidate, "scheme");
    addProtocol(context, {
      node,
      // Each present entry keeps its own range; holes share the call's.
      located: candidate ?? node,
      entry: index,
      api: "registerSchemesAsPrivileged",
      role: "privileged-scheme",
      session,
      scheme: scheme.status === "explicit" ? scheme.property.value : candidate,
      privileges: enabledPrivileges(candidate, context),
    });
  }
};

/**
 * Privilege keys whose effective (last) value is literal `true`; null when the
 * object is not a literal with static keys. A later key wins, as at runtime.
 */
const enabledPrivileges = (
  entry: t.Node | undefined,
  context: JavaScriptFindingContext,
): readonly string[] | null => {
  const lookup = staticObjectProperty(entry, "privileges");
  if (lookup.status === "missing") return [];
  const privileges =
    lookup.status === "explicit" ? typeless(lookup.property.value) : undefined;
  if (!t.isObjectExpression(privileges)) {
    context.accumulator.unknownFindings += 1;
    return null;
  }
  const enabled: string[] = [];
  const decided = new Set<string>();
  for (const property of privileges.properties.toReversed()) {
    const key = t.isObjectProperty(property)
      ? semanticStaticPropertyName(property.key, property.computed)
      : "";
    if (key === "" || !t.isObjectProperty(property)) {
      context.accumulator.unknownFindings += 1;
      return null;
    }
    if (decided.has(key)) continue;
    decided.add(key);
    const value = typeless(property.value);
    if (t.isBooleanLiteral(value, { value: true })) enabled.push(key);
    else if (!t.isBooleanLiteral(value))
      context.accumulator.unknownFindings += 1;
  }
  return enabled.toSorted();
};

interface ProtocolInput {
  readonly node: t.CallExpression | t.OptionalCallExpression;
  /** The source range reported for this finding; defaults to the call. */
  readonly located?: t.Node;
  /** Array position for one of several entries passed to a single call. */
  readonly entry?: number;
  readonly api: string;
  readonly role: Role;
  readonly session: Session;
  readonly scheme: t.Node | null | undefined;
  readonly privileges?: readonly string[] | null;
}

const addProtocol = (
  context: JavaScriptFindingContext,
  input: ProtocolInput,
): void => {
  const located = input.located ?? input.node;
  const scheme = schemeValue(context, input.scheme, located);
  if (scheme.status === "dynamic") context.accumulator.unknownFindings += 1;
  const finding: ElectronProtocolFinding = {
    api: input.api,
    role: input.role,
    scheme,
    session: input.session,
    enabled_privileges: input.privileges ?? null,
    module_key: null,
    location: range(located),
  };
  addLocatedFinding(context, {
    collection: context.accumulator.protocols,
    key: `electron-protocol\0${input.api}\0${String(input.entry ?? "")}`,
    node: located,
    value: finding,
  });
};

const schemeValue = (
  context: JavaScriptFindingContext,
  scheme: t.Node | null | undefined,
  located: t.Node,
): ElectronStaticValue =>
  scheme === null || scheme === undefined
    ? {
        status: "dynamic",
        value: null,
        expression: boundedExpression(context.source, located),
      }
    : electronStaticValue(context.source, typeless(scheme));

const typeless = (node: t.Node | null | undefined): t.Node | undefined =>
  node === null || node === undefined
    ? undefined
    : unwrapJavaScriptExpression(node).node;
