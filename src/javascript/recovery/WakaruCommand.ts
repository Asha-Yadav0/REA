import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { cleanupOwnedProcessGroup } from "../../process/ProcessOwnership.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
  type OwnedProviderProcessSpawnOptions,
  type SpawnedOwnedProviderProcess,
} from "../../process/ProviderProcess.js";
import {
  checkRecoveryDeadline,
  inventoryRecoveryFiles,
  fingerprintRecoveryFile,
  recoveryFailureMessage,
} from "./RecoveryFiles.js";
import { RECOVERY_LIMITS, wakaruHost } from "./WakaruRelease.js";

const OPERATION = "recover_javascript_sources";
const WAKARU_REQUIREMENT =
  "Provide an absolute REA_WAKARU_COMMAND pointing to a Wakaru ^1.13.0 binary (verified with 1.14.0); no tool is installed by REA. Linux x64 is the fully verified host; other hosts run the same protocol against the configured binary and are reported as unverified. Linux enforces the 1 GiB address-space ceiling through util-linux prlimit; on hosts without util-linux, set REA_JAVASCRIPT_PRLIMIT_COMMAND to a prlimit-compatible wrapper to keep that ceiling, otherwise the operation runs without any resource-limiter rail and says so. See docs/javascript-recovery.md#install-wakaru.";

/** Hosts without util-linux need a caller-supplied limiter or none is applied. */
const DEFAULT_PRLIMIT = "/usr/bin/prlimit";

const MISSING_LIMITER_WARNING =
  "No REA_JAVASCRIPT_PRLIMIT_COMMAND is configured on this host, so recover_javascript_sources runs without a resource-limiter rail: the 1 GiB address-space ceiling, file-size ceiling, core-dump suppression and cpu-time cap are not applied. In-process limits (120-second deadline, input/output byte and entry ceilings) still hold. Point REA_JAVASCRIPT_PRLIMIT_COMMAND at a prlimit-compatible wrapper to restore them.";

/** One-time diagnostic sink; each sink is warned at most once per process. */
export type WakaruWarning = (event: {
  readonly platform: string;
  readonly arch: string;
  readonly message: string;
}) => void;

const warnedSinks = new WeakSet<WakaruWarning>();

/** Inject the owned process launcher while retaining production protocol parsing. */
export type WakaruLauncher = (
  options: OwnedProviderProcessSpawnOptions,
) => Promise<SpawnedOwnedProviderProcess>;

/** Cleanup failure carrying the live supervisor so the provider can retry it. */
export class WakaruCleanupFailure extends ProviderCleanupError {
  constructor(
    readonly cleanupOwner: ProviderProcessSupervisor,
    readonly runId: string,
    readonly cwd: string,
    reason: string,
    previousError: unknown,
    snapshot: ReturnType<ProviderProcessSupervisor["snapshot"]>,
  ) {
    super(
      "wakaru",
      [runId, cwd],
      {
        reason,
        previous_error:
          previousError instanceof Error ? previousError.message : null,
        exit_code: snapshot.exitCode ?? null,
        signal: snapshot.signal ?? null,
      },
      { operation: OPERATION, cause: previousError },
    );
  }
}

/** Report the degraded host once per sink; the caller owns the log destination. */
const warnMissingLimiter = (
  host: ReturnType<typeof wakaruHost>,
  warn: WakaruWarning | undefined,
): void => {
  if (host.addressSpaceLimit !== "unenforced" || warn === undefined) return;
  if (warnedSinks.has(warn)) return;
  warnedSinks.add(warn);
  warn({
    platform: host.platform,
    arch: host.arch,
    message: MISSING_LIMITER_WARNING,
  });
};

/** Resolve and fingerprint explicitly configured tools; acquire nothing at startup. */
export const resolveWakaruCommand = async (
  environment: Readonly<Record<string, string | undefined>>,
  options: { readonly warn?: WakaruWarning } = {},
) => {
  const configured = environment.REA_WAKARU_COMMAND;
  if (configured === undefined || !isAbsolute(configured))
    throw new AnalysisCapabilityUnavailableError(
      "wakaru",
      OPERATION,
      WAKARU_REQUIREMENT,
      { userMessage: WAKARU_REQUIREMENT },
    );
  try {
    const command = await realpath(configured);
    await access(command, constants.R_OK | constants.X_OK);
    const fingerprint = await fingerprintRecoveryFile(
      command,
      RECOVERY_LIMITS.outputBytes,
    );
    const configuredLimiter = environment.REA_JAVASCRIPT_PRLIMIT_COMMAND;
    const limiter =
      configuredLimiter ??
      (process.platform === "linux" ? DEFAULT_PRLIMIT : undefined);
    if (limiter !== undefined) {
      if (!isAbsolute(limiter))
        throw new TypeError("REA_JAVASCRIPT_PRLIMIT_COMMAND must be absolute");
      await access(limiter, constants.X_OK);
      if (!(await stat(limiter)).isFile())
        throw new TypeError(`Resource limiter is not a regular file: ${limiter}`);
    }
    const host = wakaruHost(
      process.platform,
      process.arch,
      limiter === undefined ? "absent" : "configured",
    );
    warnMissingLimiter(host, options.warn);
    return { command, limiter, host, ...fingerprint };
  } catch (cause: unknown) {
    const reason = `Configured Wakaru or resource limiter is unavailable: ${recoveryFailureMessage(cause)}`;
    throw new AnalysisCapabilityUnavailableError("wakaru", OPERATION, reason, {
      cause,
      userMessage: reason,
    });
  }
};

type WakaruCommandContext = {
  command: string;
  /** Absent when no limiter is configured; the command then runs unwrapped. */
  limiter?: string | undefined;
  arguments: readonly string[];
  cwd: string;
  deadline: number;
  environment: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
  launcher?: WakaruLauncher;
  staging?: string;
};

/** Run one bounded command and verify cleanup before consuming its output. */
export const runWakaruCommand = async (context: WakaruCommandContext) => {
  checkRecoveryDeadline(context.deadline, context.signal);
  const runId = `rea-wakaru-${randomUUID()}`;
  const limiter = context.limiter;
  const spawned = await (context.launcher ?? spawnOwnedProviderProcess)({
    command: limiter ?? context.command,
    arguments:
      limiter === undefined
        ? [...context.arguments]
        : [
            `--as=${String(RECOVERY_LIMITS.addressSpaceBytes)}`,
            `--fsize=${String(RECOVERY_LIMITS.outputBytes)}`,
            "--core=0",
            "--cpu=120",
            "--",
            context.command,
            ...context.arguments,
          ],
    expectedCommand: null,
    runId,
    cwd: context.cwd,
    hostEnvironment: context.environment,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    env: { TMPDIR: context.cwd, RAYON_NUM_THREADS: "1", NO_COLOR: "1" },
  }).catch((cause: unknown) => {
    if (context.signal?.aborted === true)
      throw new AnalysisCancelledError(OPERATION);
    throw new ProviderAdapterError("wakaru", OPERATION, {
      cause,
      diagnostics: {
        reason:
          context.limiter === undefined
            ? "Failed to launch configured Wakaru"
            : "Failed to launch configured Wakaru through the configured resource limiter",
        command: context.command,
        detail: recoveryFailureMessage(cause),
      },
    });
  });
  let oversized = false;
  const supervisor = new ProviderProcessSupervisor(
    {
      ...spawned,
      ownsProcessLifetime: true,
      cleanup:
        spawned.cleanup ?? (() => cleanupOwnedProcessGroup(spawned.ownership)),
    },
    {
      onDiagnostic: (event) => {
        if (
          event.type === "output" &&
          event.totalBytes > RECOVERY_LIMITS.reportBytes
        )
          oversized = true;
      },
    },
  );
  let failure: unknown;
  try {
    while (!(await supervisor.waitForOutputClose(100))) {
      checkRecoveryDeadline(context.deadline, context.signal);
      if (oversized)
        throw new AnalysisOutputError(
          OPERATION,
          "Wakaru diagnostic stream exceeds 8 MiB",
        );
      if (context.staging !== undefined)
        await inventoryRecoveryFiles(context.staging, context.signal);
    }
    checkRecoveryDeadline(context.deadline, context.signal);
    if (oversized)
      throw new AnalysisOutputError(
        OPERATION,
        "Wakaru diagnostic stream exceeds 8 MiB",
      );
  } catch (cause: unknown) {
    failure = cause;
  }
  const stopped = await supervisor.stop();
  const snapshot = supervisor.snapshot();
  if (stopped.status === "incomplete")
    throw new WakaruCleanupFailure(
      supervisor,
      runId,
      context.cwd,
      stopped.reason,
      failure,
      snapshot,
    );
  if (failure !== undefined) throw failure;
  if (context.signal?.aborted === true)
    throw new AnalysisCancelledError(OPERATION);
  return {
    exit_code: snapshot.exitCode ?? null,
    signal: snapshot.signal ?? null,
    stdout: snapshot.stdout.text,
    stderr: snapshot.stderr.text,
    command: context.command,
    arguments: [...context.arguments],
    resource_limiter: context.limiter ?? null,
  };
};
