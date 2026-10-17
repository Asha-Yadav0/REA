// Python's benchmark delegates identity and signaling to REA's process owner.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { text } from "node:stream/consumers";
import { setTimeout as delay } from "node:timers/promises";
import {
  cleanupOwnedProcessGroup,
  verifyNoTokenOwnedProcesses,
} from "../../dist/process/ProcessOwnership.js";
import {
  prepareProcessOwnershipInspection,
  systemProcessOwnershipHost as host,
} from "../../dist/process/ProcessOwnershipObservation.js";

try {
  await prepareProcessOwnershipInspection();
  if (process.argv[2] === "prepare") {
    console.log(
      JSON.stringify({
        runId: randomUUID(),
        expectedParentPid: process.ppid,
        sweepTokenOwnedProcesses: true,
        captureBaseline: await host.captureBaseline(),
      }),
    );
  } else if (process.argv[2] === "cleanup") {
    const ownership = JSON.parse(
      process.argv[3]
        ? await readFile(process.argv[3], "utf8")
        : await text(process.stdin),
    );
    let result = await cleanupOwnedProcessGroup(ownership);
    if (result.cleaned) {
      for (let attempt = 0; attempt < 20; attempt++) {
        result = await verifyNoTokenOwnedProcesses(
          ownership.runId,
          host,
          ownership.captureBaseline,
          ownership,
        );
        if (result.cleaned) break;
        await delay(50);
      }
    }
    console.log(JSON.stringify(result));
  } else
    throw new Error(
      "Expected prepare or cleanup [ownership.json]; defaults to JSON stdin",
    );
} finally {
  await host.close?.();
}
