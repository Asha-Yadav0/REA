import type { StdioServerHandle } from "@modelcontextprotocol/server/stdio";

import type { BinarySession } from "../application/binary/BinarySession.js";
import type { Logger } from "pino";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { RuntimeDependencies } from "./types.js";
import { MCP_SHUTDOWN_FAILED } from "./messages.js";

interface ShutdownCleanupOwner {
  readonly close: () => Promise<void>;
  closed: boolean;
  attempted: boolean;
}

/** Resources the started MCP transport adds to process shutdown. */
export interface McpTransportOwners {
  readonly handle: StdioServerHandle;
  readonly closeAndroid?: () => Promise<void>;
  readonly closeOptionalProviders?: () => Promise<void>;
}

/**
 * Own process shutdown from session creation onward. A shutdown request aborts
 * `signal` so startup work stops, then closes every owner attached so far.
 * Owners attached after a request are closed by `finish`. Process handlers stay
 * registered until startup settles, so a repeated request during late cleanup
 * joins or retries it instead of reaching default signal termination.
 */
export const createShutdown = (input: {
  readonly session: BinarySession;
  readonly dependencies: RuntimeDependencies;
  readonly serverLogger: Logger;
}): {
  readonly signal: AbortSignal;
  readonly attachTransport: (owners: McpTransportOwners) => void;
  readonly shutdown: () => Promise<void>;
  readonly request: () => void;
  readonly finish: () => Promise<0 | 1>;
  readonly release: () => Promise<void>;
} => {
  const { session, dependencies, serverLogger } = input;
  const requested = new AbortController();
  let shutdownAttempt: Promise<void> | undefined;
  const cleanupOwners = [
    cleanupOwner(async () => {
      const closed = await session.close({ retainProviderDocuments: true });
      if (!closed.ok) throw closed.error;
    }),
  ];
  let startupSettled = false;
  let lastAttemptFailed = false;
  let shutdownUnregistered = false;
  let unregisterShutdown = (): void => undefined;
  const unregisterOnce = (): void => {
    if (shutdownUnregistered) return;
    unregisterShutdown();
    shutdownUnregistered = true;
  };
  const shutdown = async (): Promise<void> => {
    if (shutdownAttempt !== undefined) return shutdownAttempt;
    requested.abort();
    const pending = cleanupOwners.filter(({ closed }) => !closed);
    const attempt = closeOwners(pending).then((failure) => {
      lastAttemptFailed = failure !== undefined;
      if (failure !== undefined) throw failure.cause;
      if (startupSettled) unregisterOnce();
    });
    shutdownAttempt = attempt;
    // Settled attempts release the slot so a retry or a later-attached owner
    // starts a new attempt; closed owners are never closed again.
    const releaseSlot = (): void => {
      if (shutdownAttempt === attempt) shutdownAttempt = undefined;
    };
    void attempt.then(releaseSlot, releaseSlot);
    return attempt;
  };
  const reportShutdown = (): Promise<0 | 1> =>
    shutdown().then(
      () => 0 as const,
      (cause: unknown) => {
        reportShutdownFailure(cause, dependencies, serverLogger);
        return 1 as const;
      },
    );
  const requestShutdown = (): void => {
    void reportShutdown();
  };
  const settleInFlight = async (): Promise<void> => {
    await shutdownAttempt?.catch(() => undefined);
  };
  unregisterShutdown = dependencies.registerShutdown(requestShutdown);
  return {
    signal: requested.signal,
    attachTransport: (owners) => {
      // A transport attached after a request is closed by `finish`.
      if (!requested.signal.aborted) startupSettled = true;
      cleanupOwners.unshift(
        ...[
          () => owners.handle.close(),
          owners.closeAndroid,
          owners.closeOptionalProviders,
        ].flatMap((close) =>
          close === undefined ? [] : [cleanupOwner(close)],
        ),
      );
    },
    shutdown,
    request: requestShutdown,
    // Complete a requested shutdown, including owners attached after it began.
    // A reported failure with no newer owner keeps its handlers for a retry.
    finish: async () => {
      await settleInFlight();
      startupSettled = true;
      if (
        lastAttemptFailed &&
        cleanupOwners.every(({ attempted }) => attempted)
      )
        return 1;
      return reportShutdown();
    },
    // Startup failed and closed its own resources; stop handling process events
    // unless a shutdown that raced it failed and retains owners for a retry.
    release: async () => {
      await settleInFlight();
      startupSettled = true;
      if (!lastAttemptFailed) unregisterOnce();
    },
  };
};

const cleanupOwner = (close: () => Promise<void>): ShutdownCleanupOwner => ({
  close,
  closed: false,
  attempted: false,
});

/** Close owners concurrently and return their combined failure, if any. */
const closeOwners = async (
  owners: readonly ShutdownCleanupOwner[],
): Promise<{ readonly cause: unknown } | undefined> => {
  for (const owner of owners) owner.attempted = true;
  const results = await Promise.allSettled(
    owners.map(async (owner) => {
      await owner.close();
      owner.closed = true;
    }),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );
  if (failures.length === 0) return undefined;
  return {
    cause:
      failures.length === 1
        ? failures[0]
        : new AggregateError(
            failures,
            "Multiple MCP cleanup operations failed",
          ),
  };
};

const reportShutdownFailure = (
  cause: unknown,
  dependencies: RuntimeDependencies,
  serverLogger: Logger,
): void => {
  serverLogger.debug(
    { failure_cause: describeShutdownFailure(cause) },
    "MCP shutdown rejected",
  );
  dependencies.setExitCode(1);
  serverLogger.error(MCP_SHUTDOWN_FAILED);
  dependencies.writeStderr(`${MCP_SHUTDOWN_FAILED}\n`);
  if (cause instanceof AnalysisError)
    dependencies.writeStderr(`${projectAnalysisError(cause).message}\n`);
};

const describeShutdownFailure = (
  cause: unknown,
): Readonly<Record<string, JsonValue>> =>
  describeShutdownFailureNode(cause, new WeakSet<object>());

const describeShutdownFailureNode = (
  cause: unknown,
  active: WeakSet<object>,
): Readonly<Record<string, JsonValue>> => {
  if (typeof cause === "object" && cause !== null) {
    if (active.has(cause)) return { type: "cyclic_error" };
    active.add(cause);
  }
  try {
    if (cause instanceof AnalysisError)
      return { analysis_error: projectAnalysisError(cause) };
    if (cause instanceof Error) {
      const code = "code" in cause ? cause.code : undefined;
      return {
        name: cause.name,
        message: cause.message,
        ...(typeof code === "string" ||
        (typeof code === "number" && Number.isFinite(code))
          ? { code }
          : {}),
        ...(cause instanceof AggregateError
          ? {
              errors: cause.errors.map((error: unknown) =>
                describeShutdownFailureNode(error, active),
              ),
            }
          : {}),
      };
    }
    if (
      cause === null ||
      typeof cause === "string" ||
      typeof cause === "boolean" ||
      (typeof cause === "number" && Number.isFinite(cause))
    )
      return { type: cause === null ? "null" : typeof cause, value: cause };
    return { type: typeof cause };
  } finally {
    if (typeof cause === "object" && cause !== null) active.delete(cause);
  }
};
