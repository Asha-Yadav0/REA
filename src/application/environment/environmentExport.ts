import { constants } from "node:fs";
import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  type AnalysisInputIssue,
} from "../../domain/analysisErrorCore.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import { readRegularFile } from "../RegularFileRead.js";
import { parseUtf8Json } from "../Utf8JsonInput.js";
import {
  ENVIRONMENT_EXPORT_OPERATION,
  planEnvironmentBundle,
  registryPackageSource,
  type EnvironmentBundlePlan,
  type EnvironmentPackageSource,
} from "./environmentBundle.js";
import type { EnvironmentSource } from "./environmentSource.js";

/** One input file read once: the bytes the bundle copies and the value they parse to. */
export interface EnvironmentExportFile {
  readonly path: string;
  readonly bytes: Buffer;
  readonly value: unknown;
}

/** The manifest and capture files as read for authentication and copying. */
export interface EnvironmentExportInputs {
  readonly manifest: EnvironmentExportFile;
  readonly evidence: EnvironmentExportFile;
}

export interface EnvironmentExportInput extends EnvironmentExportInputs {
  /** The authenticated pair the bundle replays, loaded from the parsed values of the two files. */
  readonly source: EnvironmentSource;
  /** Absolute bundle root; absent or empty. */
  readonly directory: string;
  readonly name?: string | undefined;
  /** Absolute path of a packed CLI tarball the Dockerfile installs instead of the registry package. */
  readonly packageTarball?: string | undefined;
}

/** One written file with its size, as the command reports it. */
export interface WrittenBundleFile {
  readonly path: string;
  readonly bytes: number;
}

export interface EnvironmentExportResult {
  readonly status: "exported";
  readonly directory: string;
  readonly name: string;
  readonly tool_count: number;
  readonly evidence_id: string;
  readonly manifest_evidence_id: string;
  readonly package_source: JsonValue;
  readonly files: readonly WrittenBundleFile[];
}

const inputError = (
  issue: AnalysisInputIssue,
  userMessage: string,
): AnalysisInputError =>
  new AnalysisInputError(ENVIRONMENT_EXPORT_OPERATION, { userMessage }, [
    issue,
  ]);

const systemCode = (cause: unknown): string | undefined =>
  cause instanceof Error && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;

/** Host permission failures are typed; any other filesystem failure is unexpected and propagates. */
const rethrowUnlessDenied = (cause: unknown, path: string): never => {
  const code = systemCode(cause);
  if (code === "EACCES" || code === "EPERM")
    throw new AnalysisAccessDeniedError(
      ENVIRONMENT_EXPORT_OPERATION,
      path,
      code,
      {
        cause,
      },
    );
  throw cause;
};

/** The directory may be absent or an empty directory; anything else is refused before any write. */
const checkDirectory = async (
  directory: string,
): Promise<Result<undefined, AnalysisError>> => {
  let entries: readonly string[];
  try {
    entries = await readdir(directory);
  } catch (cause: unknown) {
    const code = systemCode(cause);
    if (code === "ENOENT") return ok(undefined);
    if (code === "ENOTDIR")
      return err(
        inputError(
          {
            path: ["directory"],
            reason: "invalid_value",
            message: "The bundle directory path names a file.",
          },
          `${directory} exists and is not a directory.`,
        ),
      );
    return rethrowUnlessDenied(cause, directory);
  }
  if (entries.length > 0)
    return err(
      inputError(
        {
          path: ["directory"],
          reason: "invalid_value",
          message:
            "The bundle directory must be absent or empty; nothing is overwritten.",
        },
        `${directory} is not empty (${String(entries.length)} entries); choose an absent or empty directory.`,
      ),
    );
  return ok(undefined);
};

/** The tarball must be a regular file; its bytes are copied, never inspected. */
const checkTarball = async (
  path: string,
): Promise<Result<EnvironmentPackageSource, AnalysisError>> => {
  try {
    const info = await stat(path);
    if (!info.isFile())
      return err(
        inputError(
          {
            path: ["package_tarball"],
            reason: "invalid_value",
            message: "The package tarball must be a regular file.",
          },
          `${path} is not a regular file.`,
        ),
      );
  } catch (cause: unknown) {
    const code = systemCode(cause);
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ENAMETOOLONG")
      return err(
        inputError(
          {
            path: ["package_tarball"],
            reason: "invalid_value",
            message: "The package tarball path must name an existing file.",
          },
          `${path} does not exist.`,
        ),
      );
    return rethrowUnlessDenied(cause, path);
  }
  return ok({ kind: "tarball", path });
};

/** A path that is not a readable regular file, including inline JSON text offered as one. */
const NOT_A_FILE_CODES = new Set([
  "ENOENT",
  "EISDIR",
  "ENOTFILE",
  "ENOTDIR",
  "ENAMETOOLONG",
]);

/** Read one input once: the same bytes are parsed for authentication and copied into the bundle. */
const readInput = async (
  role: "manifest" | "evidence",
  path: string,
): Promise<Result<EnvironmentExportFile, AnalysisError>> => {
  let bytes: Buffer;
  try {
    bytes = await readRegularFile(path);
  } catch (cause: unknown) {
    if (NOT_A_FILE_CODES.has(systemCode(cause) ?? ""))
      return err(
        inputError(
          {
            path: [role],
            reason: "invalid_value",
            message: `The ${role} argument must be a readable file path; inline JSON cannot be exported.`,
          },
          `${path} could not be read as the ${role} file.`,
        ),
      );
    return rethrowUnlessDenied(cause, path);
  }
  let parsed: ReturnType<typeof parseUtf8Json>;
  try {
    parsed = parseUtf8Json(bytes, ENVIRONMENT_EXPORT_OPERATION, path);
  } catch (cause: unknown) {
    if (cause instanceof AnalysisResourceConstraintError) return err(cause);
    throw cause;
  }
  if (!parsed.ok)
    return err(
      inputError(
        {
          path: [role],
          reason: "invalid_format",
          expected: "JSON",
          message: parsed.error,
        },
        `${path} is not valid JSON: ${parsed.error}`,
      ),
    );
  return ok({ path, bytes, value: parsed.value });
};

/** Read both files once; the caller authenticates the parsed values and the export copies the same bytes. */
export const readEnvironmentExportInputs = async (
  manifestPath: string,
  evidencePath: string,
): Promise<Result<EnvironmentExportInputs, AnalysisError>> => {
  const manifest = await readInput("manifest", manifestPath);
  if (!manifest.ok) return manifest;
  const evidence = await readInput("evidence", evidencePath);
  if (!evidence.ok) return evidence;
  return ok({ manifest: manifest.value, evidence: evidence.value });
};

const writeNew = async (
  root: string,
  relative: string,
  content: string | Uint8Array,
): Promise<WrittenBundleFile> => {
  const path = join(root, relative);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { flag: "wx" });
  } catch (cause: unknown) {
    rethrowUnlessDenied(cause, path);
  }
  return { path: relative, bytes: Buffer.byteLength(content) };
};

const copyNew = async (
  root: string,
  relative: string,
  from: string,
): Promise<WrittenBundleFile> => {
  const path = join(root, relative);
  try {
    await mkdir(dirname(path), { recursive: true });
    await copyFile(from, path, constants.COPYFILE_EXCL);
    return { path: relative, bytes: (await stat(path)).size };
  } catch (cause: unknown) {
    return rethrowUnlessDenied(cause, path);
  }
};

const packageSourceValue = (source: EnvironmentPackageSource): JsonValue =>
  source.kind === "registry"
    ? { kind: "registry", specifier: source.specifier }
    : { kind: "tarball", path: source.path };

/** Write every planned file in plan order; manifest and evidence are the authenticated bytes unchanged. */
const writeBundle = async (
  input: EnvironmentExportInput,
  plan: EnvironmentBundlePlan,
): Promise<readonly WrittenBundleFile[]> => {
  const written: WrittenBundleFile[] = [];
  for (const file of plan.files)
    written.push(await writeNew(input.directory, file.path, file.content));
  written.push(
    await writeNew(input.directory, plan.copies.manifest, input.manifest.bytes),
  );
  written.push(
    await writeNew(input.directory, plan.copies.evidence, input.evidence.bytes),
  );
  if (plan.copies.tarball !== null && plan.packageSource.kind === "tarball")
    written.push(
      await copyNew(
        input.directory,
        plan.copies.tarball,
        plan.packageSource.path,
      ),
    );
  return written;
};

/** Export the authenticated pair as an agent environment bundle folder. */
export const exportEnvironmentBundle = async (
  input: EnvironmentExportInput,
): Promise<Result<EnvironmentExportResult, AnalysisError>> => {
  const directory = await checkDirectory(input.directory);
  if (!directory.ok) return directory;
  const packageSource =
    input.packageTarball === undefined
      ? ok<EnvironmentPackageSource>(registryPackageSource())
      : await checkTarball(input.packageTarball);
  if (!packageSource.ok) return packageSource;
  const plan = planEnvironmentBundle(input.source, {
    name: input.name,
    packageSource: packageSource.value,
  });
  if (!plan.ok) return plan;
  const files = await writeBundle(input, plan.value);
  return ok({
    status: "exported",
    directory: input.directory,
    name: plan.value.name,
    tool_count: plan.value.toolCount,
    evidence_id: input.source.evidenceId,
    manifest_evidence_id: input.source.manifestEvidenceId,
    package_source: packageSourceValue(plan.value.packageSource),
    files,
  });
};
