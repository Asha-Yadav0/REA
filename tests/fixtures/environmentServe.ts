import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { inspectAnalysisView } from "../../src/application/analysisView/AnalysisViewService.js";
import {
  loadEnvironmentSource,
  type EnvironmentSource,
} from "../../src/application/environment/environmentSource.js";
import type { Evidence } from "../../src/domain/evidence.js";
import {
  analysisViewCaptureEvidence,
  environmentManifestCaptureFixture,
} from "./analysisView.js";

/** Every opt-in rule, so the fixture yields `uid` and `plugin_id` parameters. */
export const ALL_TEMPLATE_RULES = [
  "after-uid-literal",
  "opaque-token",
  "sibling-variance",
] as const;

/** Manifest Evidence and the capture Evidence it was projected from. */
export interface EnvironmentServeFixture {
  readonly manifest: Evidence;
  readonly capture: Evidence;
}

/** Project the Grafana-shaped capture through the real view service. */
export const environmentServeFixture = (
  templateRules: readonly (typeof ALL_TEMPLATE_RULES)[number][] = ALL_TEMPLATE_RULES,
): EnvironmentServeFixture => {
  const capture = analysisViewCaptureEvidence(
    environmentManifestCaptureFixture(),
  );
  const manifest = inspectAnalysisView({
    source: { kind: "inline", evidence: capture },
    view: { kind: "environment-manifest", template_rules: [...templateRules] },
  });
  if (!manifest.ok) throw manifest.error;
  return { manifest: manifest.value, capture };
};

/** The fixture pair authenticated and cross-checked as the serve command loads it. */
export const environmentServeSource = (
  fixture: EnvironmentServeFixture = environmentServeFixture(),
): EnvironmentSource => {
  const source = loadEnvironmentSource(fixture.manifest, fixture.capture);
  if (!source.ok) throw source.error;
  return source.value;
};

/** Paths of the two Evidence files the serve command reads. */
export interface EnvironmentServeFiles {
  readonly manifestPath: string;
  readonly capturePath: string;
}

/** Write the fixture pair into a caller-owned temporary directory. */
export const writeEnvironmentServeFiles = async (
  root: string,
  fixture: EnvironmentServeFixture = environmentServeFixture(),
): Promise<EnvironmentServeFiles> => {
  const manifestPath = join(root, "manifest.json");
  const capturePath = join(root, "capture.json");
  await Promise.all([
    writeFile(manifestPath, JSON.stringify(fixture.manifest)),
    writeFile(capturePath, JSON.stringify(fixture.capture)),
  ]);
  return { manifestPath, capturePath };
};
