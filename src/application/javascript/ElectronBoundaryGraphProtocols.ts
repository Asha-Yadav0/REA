import type { ElectronProtocolFinding } from "../../domain/javascript/electronStaticAnalysisTypes.js";
import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";
import {
  artifactLocalIdentity,
  javascriptAnalysisCoverage,
  type JavaScriptArtifactGraphContext,
  type JavaScriptArtifactGraphCoverage,
} from "./JavaScriptArtifactGraphContext.js";
import { astObservationEvidence } from "./JavaScriptArtifactGraphEvidence.js";
import {
  addElectronInferenceEdge,
  electronFindingSourceNode,
  electronObservationIdentity,
  electronRangeKey,
} from "./ElectronBoundaryGraphContext.js";

interface ProtocolInput {
  readonly context: JavaScriptArtifactGraphContext;
  readonly file: JavaScriptArtifactFile;
  readonly value: ElectronProtocolFinding;
  readonly coverage: JavaScriptArtifactGraphCoverage;
}

const REGISTRATION_LIMITATION =
  "A registration shows a reachable entry point in source; whether the operating system or a session currently routes the scheme to this application is not established.";

/** Project custom URL scheme registrations as schemes the application claims. */
export const addElectronProtocolBoundaries = (
  context: JavaScriptArtifactGraphContext,
): void => {
  for (const analyzed of context.analysis.files) {
    const { file, javascript } = analyzed;
    if (javascript === null) continue;
    const coverage = javascriptAnalysisCoverage(javascript);
    for (const value of javascript.electron.protocols)
      addProtocolRegistration({ context, file, value, coverage });
  }
};

const addProtocolRegistration = (input: ProtocolInput): void => {
  const { context, file, value, coverage } = input;
  const source = electronFindingSourceNode(
    context,
    file,
    value.module_key,
    value.module_runtime,
  );
  if (source === undefined) return;
  const scheme =
    value.scheme.status === "literal" && typeof value.scheme.value === "string"
      ? value.scheme.value
      : null;
  const facts = {
    scheme,
    scheme_expression: value.scheme.expression,
    resolution: scheme === null ? "dynamic" : "literal",
    api: value.api,
    role: value.role,
    session: value.session,
    enabled_privileges: value.enabled_privileges,
  };
  const limitations =
    scheme === null
      ? [
          REGISTRATION_LIMITATION,
          "The scheme expression is dynamic; its runtime value remains unknown.",
        ]
      : [REGISTRATION_LIMITATION];
  // One node per literal scheme across the artifact, so a scheme that is both
  // privileged and handled is one entry point with several registrations.
  const node = context.accumulator.addNode({
    kind: "url-scheme",
    identity:
      scheme === null
        ? artifactLocalIdentity(
            file.sha256,
            "electron-dynamic-url-scheme",
            `${value.api}:${electronRangeKey(value.location)}`,
          )
        : electronObservationIdentity(
            context,
            "electron-url-scheme",
            `literal:${scheme}`,
          ),
    observations: [
      {
        label: scheme ?? value.scheme.expression,
        properties: facts,
        evidence: astObservationEvidence({
          sha256: file.sha256,
          path: file.path,
          range: value.location,
          operation: "observe-protocol-registration",
          coverage,
          limitations,
        }),
      },
    ],
  });
  addElectronInferenceEdge(context, {
    source,
    target: node,
    file,
    range: value.location,
    coverage,
    // Granting privileges exposes the scheme; the other roles claim its links.
    relation: value.role === "privileged-scheme" ? "exposes" : "handles",
    operation: "map-protocol-registration",
    properties: facts,
    limitations,
  });
};
