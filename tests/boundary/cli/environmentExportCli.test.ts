import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect } from "vitest";

import {
  analysisViewCaptureEvidence,
  analysisViewCaptureFixture,
} from "../../fixtures/analysisView.js";
import {
  environmentServeFixture,
  writeEnvironmentServeFiles,
} from "../../fixtures/environmentServe.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const BUNDLE_FILES = [
  "README.md",
  "artifacts/check_grafana-example/verify.py",
  "envs/grafana-example/Dockerfile",
  "envs/grafana-example/env.toml",
  "envs/grafana-example/evidence.json",
  "envs/grafana-example/manifest.json",
  "tasks/smoke.json",
];

describe("rea environment-export", () => {
  cliTest(
    "writes the bundle folder from the fixture pair and prints the written files with sizes",
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-environment-export-cli-");
      const files = await writeEnvironmentServeFiles(root);
      const directory = join(root, "bundle");
      const result = await cli.run({
        arguments: [
          "environment-export",
          files.manifestPath,
          "--evidence",
          files.capturePath,
          directory,
          "--json",
        ],
        timeoutMs: 30_000,
      });
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.json).toMatchObject({
        status: "exported",
        directory,
        name: "grafana-example",
        tool_count: 19,
        package_source: { kind: "registry" },
      });
      const document = result.json as {
        files: { path: string; bytes: number }[];
      };
      expect(document.files.map((file) => file.path).sort()).toEqual(
        BUNDLE_FILES,
      );
      const written = (
        await readdir(directory, { recursive: true, withFileTypes: true })
      )
        .filter((entry) => entry.isFile())
        .map((entry) =>
          join(entry.parentPath, entry.name).slice(directory.length + 1),
        )
        .sort();
      expect(written).toEqual(BUNDLE_FILES);
      expect(
        await readFile(join(directory, "envs/grafana-example/manifest.json")),
      ).toEqual(await readFile(files.manifestPath));
      expect(
        await readFile(join(directory, "envs/grafana-example/evidence.json")),
      ).toEqual(await readFile(files.capturePath));
      const dockerfile = await readFile(
        join(directory, "envs/grafana-example/Dockerfile"),
        "utf8",
      );
      expect(dockerfile).toMatch(/^FROM node:24\.18\.0-bookworm-slim\n/u);
      expect(dockerfile).toContain('CMD ["rea","environment-serve"');
    },
  );

  cliTest(
    "refuses a non-empty directory with a typed invalid request and leaves it unchanged",
    async ({ cli }) => {
      const root = await createTestTempDirectory(
        "rea-environment-export-busy-",
      );
      const files = await writeEnvironmentServeFiles(root);
      const directory = join(root, "occupied");
      await mkdir(directory);
      await writeFile(join(directory, "notes.txt"), "keep");
      const result = await cli.run({
        arguments: [
          "environment-export",
          files.manifestPath,
          "--evidence",
          files.capturePath,
          directory,
          "--json",
        ],
        timeoutMs: 30_000,
      });
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({
        error: "Application workflow failed",
        code: "invalid_request",
        category: "invalid_input",
        details: {
          operation: "environment-export",
          issues: [{ path: ["directory"], reason: "invalid_value" }],
        },
      });
      expect(result.stdout).toContain("not empty");
      expect(await readdir(directory)).toEqual(["notes.txt"]);
    },
  );

  cliTest(
    "refuses a manifest whose parent is not the supplied evidence before creating the directory",
    async ({ cli }) => {
      const root = await createTestTempDirectory(
        "rea-environment-export-mismatch-",
      );
      const files = await writeEnvironmentServeFiles(
        root,
        environmentServeFixture(),
      );
      const other = join(root, "other.json");
      await writeFile(
        other,
        JSON.stringify(
          analysisViewCaptureEvidence(analysisViewCaptureFixture()),
        ),
      );
      const directory = join(root, "bundle");
      const result = await cli.run({
        arguments: [
          "environment-export",
          files.manifestPath,
          "--evidence",
          other,
          directory,
          "--json",
        ],
        timeoutMs: 30_000,
      });
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({
        error: "Application workflow failed",
        code: "invalid_request",
        details: {
          operation: "environment-export",
          issues: [{ path: ["evidence", "evidence_id"] }],
        },
      });
      expect(result.stdout).toContain("different capture");
      expect(await readdir(root)).not.toContain("bundle");
    },
  );
});
