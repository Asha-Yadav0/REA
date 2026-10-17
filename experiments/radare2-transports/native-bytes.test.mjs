// Boundary/oracle tests. These simulated native replies do not establish r2 behavior.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  byteInputSchema,
  MAX_NATIVE_READ_BYTES,
  readNativeBytes,
  retryNativeByteCleanup,
} from "./native-bytes.mjs";

const folder = await mkdtemp(join(tmpdir(), "rea-native-byte-oracle-"));
const path = join(folder, "selected bytes.bin");
const fixture = Buffer.from([0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80]);
await writeFile(path, fixture);
const sha256 = createHash("sha256").update(fixture).digest("hex");
const input = { address: "0x20000000000001", length: 4 };
const section = {
  name: "data",
  vaddr: "0x20000000000000",
  paddr: "1",
  size: "6",
  vsize: "16",
};
const target = {
  path,
  sha256_before: sha256,
  sha256_after: sha256,
  core_binding: "owned-process-opened-selected-path",
};
const native = (
  sections = [section],
  bytes = ["48", "64", "80", "96"],
  identity = target,
) => ({
  ok: true,
  value: {
    target: identity,
    raw: {
      sections,
      bytes,
      original_output: "retained producer representation",
    },
    replies: [sections, bytes].map((res) => ({
      command_outcome: "no_error_reported",
      res,
    })),
  },
});
const requireValue = (result) => {
  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  return result.value;
};

after(async () => {
  assert.equal(await retryNativeByteCleanup(), 0);
  await rm(folder, { recursive: true, force: true });
});

test("wide virtual coordinates and quoted bytes verify against a real file handle", async () => {
  const source = native();
  const observed = requireValue(
    await readNativeBytes(
      input,
      async (commands) => {
        assert.deepEqual(commands, [
          { cmd: "iSj", json: true },
          { cmd: "p8j 4 @ 0x20000000000001", json: true },
        ]);
        return source;
      },
      path,
    ),
  );
  assert.equal(observed.result.bytes_hex, "30405060");
  assert.equal(observed.result.complete, true);
  assert.equal(observed.result.coverage.initialized_mapping.file_offset, "0x2");
  assert.equal(observed.result.coverage.file_verification.sha256, sha256);
  assert.equal(observed.raw, source.value.raw);
});

test("full padded counts, virtual tails and ambiguous mappings never prove completeness", async () => {
  for (const sections of [
    [],
    [{ ...section, size: 1 }],
    [section, { ...section, vaddr: input.address, size: 1 }],
    [section, { ...section, paddr: "18446744073709551615" }],
    [section, { ...section, vaddr: 9_007_199_254_740_992 }],
  ]) {
    const value = requireValue(
      await readNativeBytes(input, async () => native(sections), path),
    );
    assert.equal(value.result.returned_bytes, 4);
    assert.equal(value.result.complete, null);
    assert.ok(value.result.unknowns.length);
  }
  const external = requireValue(
    await readNativeBytes(
      input,
      async () =>
        native([section], undefined, {
          ...target,
          core_binding: "unverified-external-core",
        }),
      path,
    ),
  );
  assert.equal(external.result.complete, null);
});

test("overlay differences and stale reader digests preserve both native and file observations", async () => {
  const overlay = requireValue(
    await readNativeBytes(
      input,
      async () => native([section], [0, 0, 0, 0]),
      path,
    ),
  );
  assert.equal(overlay.result.bytes_hex, "00000000");
  assert.equal(overlay.result.complete, null);
  assert.equal(overlay.result.coverage.file_verification.bytes_hex, "30405060");
  assert.equal(
    overlay.result.coverage.file_verification.native_bytes_match,
    false,
  );
  const stale = requireValue(
    await readNativeBytes(
      input,
      async () =>
        native([section], undefined, {
          ...target,
          sha256_before: "0".repeat(64),
          sha256_after: "0".repeat(64),
        }),
      path,
    ),
  );
  assert.equal(stale.result.complete, null);
  assert.equal(
    stale.result.coverage.file_verification.reader_digest_matches,
    false,
  );
});

test("malformed byte arrays fail with the observed payload intact", async () => {
  const hole = [48, 64, 80, 96];
  delete hole[2];
  for (const bytes of [[256], ["1.5"], [null], hole, [1, 2, 3, 4, 5]]) {
    const source = native([section], bytes);
    const result = await readNativeBytes(input, async () => source, path);
    assert.equal(result.ok, false);
    assert.equal(result.error._tag, "AnalysisOutputError");
    assert.equal(result.error.partialObservation.raw, source.value.raw);
  }
});

test("cancellation is a Result and preserves bytes observed before independent verification", async () => {
  const early = new AbortController();
  early.abort();
  let calls = 0;
  const cancelled = await readNativeBytes(
    input,
    async () => {
      calls++;
      return native();
    },
    path,
    { signal: early.signal },
  );
  assert.equal(cancelled.error._tag, "AnalysisCancelledError");
  assert.equal(calls, 0);
  const during = new AbortController();
  const partial = await readNativeBytes(
    input,
    async () => {
      during.abort();
      return native();
    },
    path,
    { signal: during.signal },
  );
  assert.equal(partial.error._tag, "AnalysisCancelledError");
  assert.equal(partial.error.partialObservation.result.bytes_hex, "30405060");
});

test("the capture-derived length bound and uint64 extent reject before reading", async () => {
  assert.equal(MAX_NATIVE_READ_BYTES, 1024 * 1024);
  assert.equal(
    byteInputSchema.safeParse({ address: "0x0", length: MAX_NATIVE_READ_BYTES })
      .success,
    true,
  );
  for (const value of [
    { address: "0x0", length: MAX_NATIVE_READ_BYTES + 1 },
    { address: "0xffffffffffffffff", length: 2 },
  ]) {
    let called = false;
    const result = await readNativeBytes(value, async () => {
      called = true;
      return native();
    });
    assert.equal(result.error._tag, "AnalysisInputError");
    assert.equal(called, false);
  }
});
