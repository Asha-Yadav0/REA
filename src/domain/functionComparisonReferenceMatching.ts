import { canonicalJson } from "./comparisonSemantics.js";

/**
 * Endpoint identity and edge matching for the reference comparison: sort order
 * is not identity, and an unresolved endpoint is a knowledge asymmetry rather
 * than a difference.
 */

/** A projected endpoint; see `referenceEndpoint` for what identifies a target. */
export type ReferenceEndpoint =
  | { readonly address: string; readonly name: string | null }
  | { readonly name: string }
  | null;

export type EndpointComparison = "equal" | "changed" | "asymmetric";

/**
 * Compare two endpoints. An endpoint the other record leaves unresolved is a
 * knowledge asymmetry rather than a difference: no known endpoint differs, and
 * equality cannot be established either. Within one artifact the address
 * identifies the target and a resolved name is supplementary, so a named
 * endpoint and an unnamed one at the same address agree.
 */
export const compareEndpoint = (
  left: ReferenceEndpoint,
  right: ReferenceEndpoint,
): EndpointComparison => {
  if (left === null || right === null) return "asymmetric";
  if ("address" in left && "address" in right)
    return left.address === right.address ? "equal" : "changed";
  if ("address" in left || "address" in right) return "asymmetric";
  return left.name === right.name ? "equal" : "changed";
};

/** The identity a comparison may rely on, without supplementary detail. */
export type NormalizedEndpoint =
  | { readonly address: string }
  | { readonly name: string }
  | null;

export const normalizedEndpoint = (
  endpoint: ReferenceEndpoint,
): NormalizedEndpoint => {
  if (endpoint === null) return null;
  return "address" in endpoint
    ? { address: endpoint.address }
    : { name: endpoint.name };
};

export type ProjectedReference = {
  readonly direction: string;
  readonly source: ReferenceEndpoint;
  readonly target: ReferenceEndpoint;
};

type PairKind = "resolved" | "wild" | "incompatible";

/**
 * Classify one endpoint pair: both records resolve it to the same target
 * (`resolved`), at least one side leaves it unresolved so the pair imposes no
 * identity constraint (`wild`), or both resolve it to different targets.
 */
const endpointPairKind = (
  left: ReferenceEndpoint,
  right: ReferenceEndpoint,
): PairKind => {
  const outcome = compareEndpoint(left, right);
  if (outcome === "changed") return "incompatible";
  return outcome === "equal" ? "resolved" : "wild";
};

/** Worst pair kind across both endpoints: any conflict rejects the pairing. */
const edgePairKind = (
  left: ProjectedReference,
  right: ProjectedReference,
): PairKind => {
  const source = endpointPairKind(left.source, right.source);
  if (source === "incompatible") return "incompatible";
  const target = endpointPairKind(left.target, right.target);
  if (target === "incompatible") return "incompatible";
  return source === "wild" || target === "wild" ? "wild" : "resolved";
};

type MatchedPair<T> = {
  readonly left: T;
  readonly right: T;
  readonly wild: boolean;
};

/**
 * Find a perfect matching between two equal-length edge lists, where a pair is
 * admissible unless both records resolve an endpoint to different targets
 * (plus whatever extra constraint `pairKind` rejects). The records can
 * describe the same edges exactly when such a matching exists; greedily
 * pairing resolved endpoints first would report differences that an
 * alternative pairing through unresolved endpoints rules out. Returns null
 * when none exists, and otherwise the pairs with their wildcard status.
 */
const perfectMatch = <T>(
  left: readonly T[],
  right: readonly T[],
  pairKind: (l: T, r: T) => PairKind,
): readonly MatchedPair<T>[] | null => {
  if (left.length !== right.length) return null;
  // Identical projections are the common unchanged case; pair positionally
  // without any search and keep it linear.
  const identical =
    canonicalJson(left, "Function matching") ===
    canonicalJson(right, "Function matching");
  const adjacency: number[][] = identical
    ? left.map((_, index) => [index])
    : left.map((leftEdge) => {
        const row: number[] = [];
        right.forEach((rightEdge, index) => {
          if (pairKind(leftEdge, rightEdge) !== "incompatible") row.push(index);
        });
        return row;
      });
  const match: number[] = new Array<number>(right.length).fill(-1);
  const augment = (i: number, seen: boolean[]): boolean => {
    for (const j of adjacency[i] ?? []) {
      if (seen[j]) continue;
      seen[j] = true;
      if (match[j] === -1 || augment(match[j]!, seen)) {
        match[j] = i;
        return true;
      }
    }
    return false;
  };
  for (let i = 0; i < left.length; i += 1)
    if (!augment(i, new Array<boolean>(right.length).fill(false))) return null;
  const matchOfLeft: number[] = new Array<number>(left.length).fill(-1);
  match.forEach((i, j) => {
    if (i !== -1) matchOfLeft[i] = j;
  });
  return left.map((leftEdge, i) => {
    const rightEdge = right[matchOfLeft[i]!]!;
    return {
      left: leftEdge,
      right: rightEdge,
      // Identical rows can still pair through unresolved endpoints.
      wild: pairKind(leftEdge, rightEdge) === "wild",
    };
  });
};

/**
 * Match projected edges by endpoint identity rather than by canonical sort
 * position. Equal-length lists whose edges admit an identity-consistent
 * pairing compare equal (or as a knowledge asymmetry when the pairing needed
 * an unresolved endpoint); otherwise a known endpoint really differs.
 */
export const matchEndpointLists = (
  left: readonly ProjectedReference[],
  right: readonly ProjectedReference[],
): "equal" | "changed" | "asymmetric" => {
  if (left.length !== right.length) return "changed";
  const pairs = perfectMatch(left, right, edgePairKind);
  if (pairs === null) return "changed";
  return pairs.some(({ wild }) => wild) ? "asymmetric" : "equal";
};

export type KindReference = {
  readonly direction: string;
  readonly source: ReferenceEndpoint;
  readonly target: ReferenceEndpoint;
  readonly kind: Readonly<Record<string, unknown>>;
};

const kindJson = (row: KindReference): string =>
  canonicalJson(row.kind, "Function comparison");

const kindRowPairKind = (
  left: KindReference,
  right: KindReference,
): PairKind => {
  const endpoints = edgePairKind(left, right);
  if (endpoints === "incompatible") return "incompatible";
  // The edge semantics must agree for the pairing: two edges that swapped
  // kinds between the same endpoints cannot be explained by re-pairing.
  if (kindJson(left) !== kindJson(right)) return "incompatible";
  return endpoints;
};

/**
 * Compare edge-semantics rows that each carry their endpoints. The rows
 * describe the same edges when a pairing exists that respects both endpoint
 * identity and edge semantics; a known kind difference is a change whatever
 * the endpoint identity, and an unresolved endpoint stays a knowledge
 * asymmetry rather than kind evidence.
 */
export const compareKindRows = (
  left: readonly unknown[],
  right: readonly unknown[],
): "equal" | "changed" | "asymmetric" => {
  const leftRows = left as readonly KindReference[];
  const rightRows = right as readonly KindReference[];
  const pairs = perfectMatch(leftRows, rightRows, kindRowPairKind);
  if (pairs === null) return "changed";
  return pairs.some(({ wild }) => wild) ? "asymmetric" : "equal";
};
