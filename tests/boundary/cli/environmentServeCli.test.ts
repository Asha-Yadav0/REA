import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect } from "vitest";

import {
  analysisViewCaptureEvidence,
  analysisViewCaptureFixture,
} from "../../fixtures/analysisView.js";
import { writeEnvironmentServeFiles } from "../../fixtures/environmentServe.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

describe("rea environment-serve refusals", () => {
  cliTest(
    "refuses a manifest whose parent is not the supplied evidence with a typed invalid request",
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-environment-serve-cli-");
      const files = await writeEnvironmentServeFiles(root);
      const other = join(root, "other.json");
      await writeFile(
        other,
        JSON.stringify(
          analysisViewCaptureEvidence(analysisViewCaptureFixture()),
        ),
      );
      const result = await cli.run({
        arguments: [
          "environment-serve",
          files.manifestPath,
          "--evidence",
          other,
          "--port",
          "0",
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
          operation: "environment-serve",
          issues: [{ path: ["evidence", "evidence_id"] }],
        },
      });
      expect(result.stdout).toContain("different capture");
    },
  );

  cliTest(
    "reports a missing --evidence option as a usage error",
    async ({ cli }) => {
      const root = await createTestTempDirectory(
        "rea-environment-serve-usage-",
      );
      const files = await writeEnvironmentServeFiles(root);
      const result = await cli.run({
        arguments: ["environment-serve", files.manifestPath, "--json"],
        timeoutMs: 30_000,
      });
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({
        code: "VALIDATION_ERROR",
        fieldErrors: [{ path: "evidence", missing: true }],
      });
    },
  );

  cliTest(
    "refuses an unreadable manifest path before binding",
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-environment-serve-path-");
      const files = await writeEnvironmentServeFiles(root);
      const result = await cli.run({
        arguments: [
          "environment-serve",
          join(root, "missing.json"),
          "--evidence",
          files.capturePath,
          "--json",
        ],
        timeoutMs: 30_000,
      });
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({
        error: "Application workflow failed",
        code: "invalid_request",
        input_path: join(root, "missing.json"),
        input_reason: "read-failed",
        details: { operation: "environment-serve" },
      });
    },
  );
});
