import { once } from "node:events";

import { describe, expect } from "vitest";

import { writeEnvironmentServeFiles } from "../../fixtures/environmentServe.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { rawHttpRequest } from "../../support/http/rawRequest.js";
import { startListeningProcess } from "../../support/mcp/streamableHttpProcess.js";
import { processTest } from "../../support/process/processFixture.js";

const SHUTDOWN_TIMEOUT_MS = 90_000;

describe("rea environment-serve shutdown", () => {
  processTest(
    "closes the listener on SIGTERM, prints one stopped document and exits 143",
    async ({ processes }) => {
      const root = await createTestTempDirectory("rea-environment-serve-stop-");
      const files = await writeEnvironmentServeFiles(root);
      const started = await startListeningProcess(processes, [
        "environment-serve",
        files.manifestPath,
        "--evidence",
        files.capturePath,
        "--port",
        "0",
        "--json",
      ]);
      let stdout = "";
      started.child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      const card = await rawHttpRequest(
        new URL("/.well-known/agent-env.json", started.url.origin),
      );
      expect(card.status).toBe(200);
      started.child.kill("SIGTERM");
      const [code, signalCode] = await once(started.child, "close");
      expect(code).toBe(143);
      expect(signalCode).toBeNull();
      expect(JSON.parse(stdout)).toMatchObject({
        status: "stopped",
        url: started.url.href,
        environment: "grafana-example",
      });
      await expect(rawHttpRequest(started.url)).rejects.toMatchObject({
        code: "ECONNREFUSED",
      });
    },
    SHUTDOWN_TIMEOUT_MS,
  );
});
