const LEGACY_CATEGORIES = [
  ["_TtC", "classes"],
  ["_TtV", "structs"],
  ["_TtO", "enums"],
  ["_TtP", "protocols"],
  ["_TtE", "extensions"],
] as const;

/** Supported procedure categories derived from Swift symbol encodings. */
export type SwiftTypeCategory = (typeof LEGACY_CATEGORIES)[number][1] | "other";

const NOMINAL_CATEGORIES: ReadonlyMap<string, SwiftTypeCategory> = new Map([
  ["C", "classes"],
  ["V", "structs"],
  ["O", "enums"],
  ["P", "protocols"],
]);

/**
 * Decode literal module/nominal prefixes, stopping at supported substituted
 * extension contexts. Unresolved generic contexts cannot establish nominal
 * ownership; other tails are not subjected to full mangling validation.
 */
export const classifySwiftSymbol = (
  name: string,
): { readonly category: SwiftTypeCategory | null } | undefined => {
  const prefix = /^_?(?:\$[sS]|_T0)/u.exec(name);
  if (prefix === null) {
    if (!name.includes("_Tt")) return undefined;
    return {
      category:
        LEGACY_CATEGORIES.find(([prefix]) => name.startsWith(prefix))?.[1] ??
        null,
    };
  }
  const mangling = name.slice(prefix[0].length);
  let offset = identifierEnd(mangling, 0);
  if (offset === undefined) return { category: null };
  let category: SwiftTypeCategory | null = null;
  // Swift registers each literal identifier and each constructed nominal type.
  const substitutions: Array<"identifier" | "nominal"> = ["identifier"];
  for (;;) {
    const end = identifierEnd(mangling, offset);
    if (end === undefined) {
      if (mangling.charAt(offset) === "A") {
        const cursor: SubstitutionCursor = {
          offset,
          index: 0,
          remaining: 0,
          continuing: false,
        };
        if (
          category !== null &&
          readSubstitutedContext(mangling, cursor, substitutions) !== "nominal"
        )
          category = null;
      }
      break;
    }
    const kind = mangling.charAt(end);
    const nominal = NOMINAL_CATEGORIES.get(kind);
    if (nominal === undefined) {
      // Current swiftc emits protocol descriptors as `…<Nominal>Mp` without
      // the nominal `P` marker (e.g. `_$s4main7ScoringMp`). Decode that exact
      // suffix; unknown substitution encodings stay unclassified, never guessed.
      if (mangling.slice(end) === "Mp") category = "protocols";
      else if (kind === "E" && category !== null) category = "extensions";
      break;
    }
    category = nominal;
    substitutions.push("identifier", "nominal");
    offset = end + 1;
  }
  return { category };
};

type SubstitutionCursor = {
  offset: number;
  index: number;
  remaining: number;
  continuing: boolean;
};

type SubstitutedContext = "extension" | "nominal" | "unresolved";

/**
 * Read module + [generic signature] + E at ABI token boundaries. A requirement
 * we cannot decode leaves context identity unresolved, not proven nominal.
 * Protocol-conformance/entity tails are left alone: this is not a demangler or
 * a witness-body validator. See Swift ABI Mangling.rst, Generics.
 */
const readSubstitutedContext = (
  mangling: string,
  cursor: SubstitutionCursor,
  substitutions: readonly ("identifier" | "nominal")[],
): SubstitutedContext => {
  const module = readSubstitution(mangling, cursor);
  if (module === undefined || substitutions[module] !== "identifier")
    return "nominal";
  const atBoundary = () => cursor.remaining === 0 && !cursor.continuing;
  const terminatedContext = (): SubstitutedContext =>
    mangling.charAt(cursor.offset + 1) === "E" ? "extension" : "nominal";
  if (atBoundary() && mangling.charAt(cursor.offset) === "E")
    return "extension";
  let genericContext = false;
  for (;;) {
    if (atBoundary()) {
      // Single-parameter and explicit parameter-count signature terminators.
      if (mangling.charAt(cursor.offset) === "l") return terminatedContext();
      if (mangling.charAt(cursor.offset) === "r") {
        cursor.offset++;
        while (mangling.charAt(cursor.offset) !== "l") {
          if (mangling.charAt(cursor.offset) === "z") cursor.offset++;
          else {
            const end = indexEnd(mangling, cursor.offset);
            if (end === undefined) return "unresolved";
            cursor.offset = end;
          }
        }
        return terminatedContext();
      }
      const kind = mangling.charAt(cursor.offset);
      if (kind === "R") {
        // Inverse requirements have an extra index before the parameter index.
        if (!mangling.startsWith("Ri", cursor.offset)) return "unresolved";
        const end = indexEnd(mangling, cursor.offset + 2);
        if (end === undefined) return "unresolved";
        cursor.offset = end;
      } else if (kind === "S") {
        // Standard substitutions are S + optional repetition + type code;
        // the second family uses c + code. Do not whitelist individual types.
        const token = /^S(?:[1-9][0-9]*)?(?:c[A-Za-z]|[A-Za-z])/u.exec(
          mangling.slice(cursor.offset),
        )?.[0];
        if (token === undefined) return "unresolved";
        cursor.offset += token.length;
        // Protocol, base-class, same-type and same-shape requirements share
        // a parameter-index boundary. Other requirement forms stay unknown.
        const requirement = /^R(?:[bsh])?/u.exec(
          mangling.slice(cursor.offset),
        )?.[0];
        // The initial identifier substitution may instead be a declaration
        // name (identifier ::= substitution), followed by its member type.
        // A type operand alone does not establish a generic context; require
        // a requirement operator before discarding nominal-prefix evidence.
        if (requirement === undefined)
          return genericContext ? "unresolved" : "nominal";
        cursor.offset += requirement.length;
      } else if (!readNamedRequirement(mangling, cursor, substitutions))
        return genericContext ? "unresolved" : "nominal";
    } else if (!readNamedRequirement(mangling, cursor, substitutions))
      return genericContext ? "unresolved" : "nominal";
    genericContext = true;
    const end = genericParamIndexEnd(mangling, cursor.offset);
    if (end === undefined) return "unresolved";
    cursor.offset = end;
  }
};

/** Read a literal protocol/type operand and its requirement operator only. */
const readNamedRequirement = (
  mangling: string,
  cursor: SubstitutionCursor,
  substitutions: readonly ("identifier" | "nominal")[],
): boolean => {
  if (
    cursor.remaining !== 0 ||
    cursor.continuing ||
    mangling.charAt(cursor.offset) === "A"
  ) {
    const module = readSubstitution(mangling, cursor);
    if (module === undefined || substitutions[module] !== "identifier")
      return false;
  } else {
    const end = identifierEnd(mangling, cursor.offset);
    if (end === undefined) return false;
    cursor.offset = end;
  }
  if (cursor.remaining !== 0 || cursor.continuing) return false;
  let end = identifierEnd(mangling, cursor.offset);
  if (end === undefined) return false;
  // A named type can contain nested literal nominals. Their markers belong to
  // the operand; a following R operator establishes the generic requirement.
  while (NOMINAL_CATEGORIES.has(mangling.charAt(end))) {
    cursor.offset = end + 1;
    if (mangling.charAt(cursor.offset) === "R") break;
    end = identifierEnd(mangling, cursor.offset);
    if (end === undefined) return false;
  }
  if (mangling.charAt(end) === "R") cursor.offset = end;
  const requirement = /^R(?:[bsh])?/u.exec(mangling.slice(cursor.offset))?.[0];
  if (requirement === undefined) return false;
  cursor.offset += requirement.length;
  return true;
};

// Swift's demangleIndex accepts decimal digits (including 0) then underscore.
const indexEnd = (mangling: string, offset: number): number | undefined => {
  const token = /^(?:[0-9]+)?_/u.exec(mangling.slice(offset))?.[0];
  if (token === undefined || Number(token.slice(0, -1)) >= 0x7fffffff)
    return undefined;
  return offset + token.length;
};

const genericParamIndexEnd = (
  mangling: string,
  offset: number,
): number | undefined => {
  const kind = mangling.charAt(offset);
  if (kind === "z" || kind === "s") return offset + 1;
  if (kind !== "d") return indexEnd(mangling, offset);
  const depthEnd = indexEnd(mangling, offset + 1);
  return depthEnd === undefined ? undefined : indexEnd(mangling, depthEnd);
};

/** Read one reference lazily; repeated groups never allocate expanded arrays. */
const readSubstitution = (
  mangling: string,
  cursor: SubstitutionCursor,
): number | undefined => {
  if (cursor.remaining > 0) {
    cursor.remaining--;
    return cursor.index;
  }
  if (!cursor.continuing && mangling.charAt(cursor.offset++) !== "A")
    return undefined;
  const token = /^(?:([1-9][0-9]*)?([a-zA-Z])|([0-9]+)?_)/u.exec(
    mangling.slice(cursor.offset),
  );
  if (token === null) return undefined;
  const letter = token[2];
  const index =
    letter === undefined
      ? token[3] === undefined
        ? 26
        : Number(token[3]) + 27
      : letter.toUpperCase().charCodeAt(0) - 65;
  const repeat = letter === undefined ? 1 : Number(token[1] ?? 1);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(repeat))
    return undefined;
  cursor.offset += token[0].length;
  cursor.index = index;
  cursor.remaining = repeat - 1;
  cursor.continuing = letter !== undefined && letter !== letter.toUpperCase();
  return index;
};

/**
 * Prefixes accepted by Swift's demangler as manglings. This is deliberately
 * narrower than visible Swift runtime class names (`_Tt…`): those names are
 * useful metadata symbols but are not themselves demangler manglings.
 */
const SWIFT_MANGLING_PREFIXES = [
  "_T0",
  "$S",
  "_$S",
  "$s",
  "_$s",
  "@__swiftmacro_",
  "$e",
  "_$e",
] as const;

/** Recognize names the Swift demangler accepts as mangled symbols. */
export const isSwiftMangledSymbolName = (name: string): boolean =>
  SWIFT_MANGLING_PREFIXES.some((prefix) => name.startsWith(prefix));

const identifierEnd = (
  mangling: string,
  offset: number,
): number | undefined => {
  const lengthToken = /^[1-9][0-9]*/u.exec(mangling.slice(offset))?.[0];
  if (lengthToken === undefined) return undefined;
  const start = offset + lengthToken.length;
  const end = start + Number(lengthToken);
  // Swift identifiers with substitutions/punycode need a fuller decoder.
  if (
    !Number.isSafeInteger(end) ||
    end > mangling.length ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(mangling.slice(start, end))
  )
    return undefined;
  return end;
};
