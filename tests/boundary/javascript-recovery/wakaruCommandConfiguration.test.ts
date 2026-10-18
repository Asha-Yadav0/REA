import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveWakaruCommand } from "../../../src/javascript/recovery/WakaruCommand.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it(
  "refuses a directory configured as the Wakaru resource limiter",
  async () => {
    const root = await createTestTempDirectory("rea-wakaru-limiter-");
    const command = join(root, "wakaru");
    const limiter = join(root, "prlimit");
    await writeFile(command, "#!/bin/sh\n", { mode: 0o700 });
    await mkdir(limiter);

    await expect(
      resolveWakaruCommand({
        REA_WAKARU_COMMAND: command,
        REA_JAVASCRIPT_PRLIMIT_COMMAND: limiter,
      }),
    ).rejects.toMatchObject({
      _tag: "AnalysisCapabilityUnavailableError",
      reason: expect.stringContaining(limiter),
    });
  },
);

it.skipIf(process.platform === "linux" || process.platform === "win32")(
  "keeps the command reachable without a limiter and warns once",
  async () => {
    const root = await createTestTempDirectory("rea-wakaru-no-limiter-");
    const command = join(root, "wakaru");
    await writeFile(command, "#!/bin/sh\n", { mode: 0o700 });
    const warnings: string[] = [];
    const warn = (event: { message: string }): void => {
      warnings.push(event.message);
    };

    const resolved = await resolveWakaruCommand(
      { REA_WAKARU_COMMAND: command },
      { warn },
    );
    expect(resolved.limiter).toBeUndefined();
    expect(resolved.host.addressSpaceLimit).toBe("unenforced");
    await resolveWakaruCommand({ REA_WAKARU_COMMAND: command }, { warn });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("REA_JAVASCRIPT_PRLIMIT_COMMAND");
  },
);

// Windows needs Developer Mode or elevation to create file symlinks (EPERM).
it.skipIf(process.platform === "win32")(
  "allows a symlink to a regular Wakaru resource limiter",
  async () => {
  const root = await createTestTempDirectory("rea-wakaru-limiter-symlink-");
  const command = join(root, "wakaru");
  const limiter = join(root, "prlimit");
  const target = join(root, "prlimit-bin");
  await writeFile(command, "#!/bin/sh\n", { mode: 0o700 });
  await writeFile(target, "#!/bin/sh\n", { mode: 0o700 });
  await symlink(target, limiter);

  await expect(
    resolveWakaruCommand({
      REA_WAKARU_COMMAND: command,
      REA_JAVASCRIPT_PRLIMIT_COMMAND: limiter,
    }),
  ).resolves.toMatchObject({ limiter });
  },
);
