// The pump.fun second-source measurement: 442 refusals are SOURCE LAG, and
// the first-party published copy closes every one of them on the same bytes.
//
// This file pins the committed artifact of
// tools/measure-pump-second-source.mjs:
//
//   research/pump-second-source-2026-11-12.json
//
// WHAT THE MEASUREMENT FOUND (the point of pinning it):
//
//   research/ecosystem-coverage-2026-11-11.json reports pump.fun decoded
//   400/842 (47.5%) INSIDE the curated watchlist — the program the union path
//   decoded 915/996 for in the 10-28 window. The 11-11 capture store holds
//   only the on-chain pull (47 instructions @slot 468262003); the first-party
//   published copy (56 instructions, pump-fun/pump-public-docs idl/pump.json)
//   was never adopted into this window. The card named that next step (2).
//
//   Baseline (the committed store, as-is) reproduces the artifact exactly:
//   400 decoded / 442 refused / 249 byte-exact. Union (throwaway copy of the
//   SAME store + one `adopt` through the product's write path): 842 decoded /
//   0 refused. +442 decoded, 442 refusals closed, on the same committed
//   payload bytes, offline. The five closed discriminators are NAMED
//   (e1f7501ed x251, 20f6bf340 x98, 1c92de772 x84, 07051dc4f x5, e19a7516d x3)
//   — instructions the deployed program emits that the stale on-chain IDL
//   account does not list but the published copy does.
//
//   The evidence classes stay apart (src/adopt.mjs rule): the pull still
//   answers 249, the adopted copy 593, and the adopted copy sits at slot null
//   so it can never displace the pull as the primary source.
//
//   Licensing: pump-public-docs ships NO LICENSE file at the pinned commit,
//   so the bytes are NOT vendored into this MIT repository (the same gate
//   tools/preview-external-adoption.mjs enforces for unlicensed sources).
//   They were adopted into a throwaway store copy that the tool deletes; the
//   committed store is byte-untouched (readdir before/after check in the tool,
//   `committedStoreModified: false`).
//
// THE INVARIANTS are the falsification half:
//   * the committed artifact is what the tool derives right now from the
//     committed fixtures (no hand-edited numbers);
//   * baseline == the ecosystem artifact's own pump.fun face — a measurement
//     that cannot see the defect proves nothing about the fix;
//   * union closes ALL 442 (a partial close would mean the copy also lags);
//   * pulled + adopted answers == decoded (no third source, no double count);
//   * no host path in the artifact; the committed store gained no receipt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'measure-pump-second-source.mjs');
const ARTIFACT = path.join(ROOT, 'research', 'pump-second-source-2026-11-12.json');
const STORE = path.join(ROOT, 'test', 'fixtures', 'ecosystem-store-2026-11-11');

const artifact = JSON.parse(await readFile(ARTIFACT, 'utf8'));
const m = artifact.measured;

test('the artifact is what the tool derives from the committed fixtures (no hand-edited numbers)', () => {
  const fresh = path.join(ROOT, 'research', '.pump-second-source-fresh.json');
  try {
    execFileSync(process.execPath, [TOOL, '--out', fresh], {
      cwd: ROOT, stdio: 'ignore', timeout: 420_000,
    });
    assert.ok(existsSync(fresh), 'the tool produced no output');
    const produced = JSON.parse(readFileSync(fresh, 'utf8'));
    const strip = (r) => {
      const copy = { ...r };
      delete copy.generatedAt;
      return copy;
    };
    assert.deepEqual(strip(produced), strip(artifact),
      'the committed artifact is not what the tool derives — re-run the tool and commit its output');
  } finally {
    rmSync(fresh, { force: true });
  }
});

test('baseline reproduces the ecosystem artifact\'s own pump.fun face before anything is claimed', () => {
  const coverage = JSON.parse(readFileSync(
    path.join(ROOT, 'research', 'ecosystem-coverage-2026-11-11.json'), 'utf8'));
  const entry = coverage.programs.find((p) => p.program === artifact.program);
  assert.equal(m.baseline.decoded, entry.decoded);
  assert.equal(m.baseline.refused, entry.refused);
  assert.equal(m.baseline.byteExact, entry.byteExact);
  assert.equal(m.payloads, entry.payloads);
});

test('the union closes every one of the 442 refusals, named per discriminator', () => {
  assert.equal(m.delta.decoded, 442);
  assert.equal(m.delta.refusalsClosed, 442);
  assert.equal(m.union.refused, 0);
  assert.deepEqual(m.unionRefusals, {});
  assert.equal(Object.values(m.closedDiscriminators).reduce((s, v) => s + v, 0), 442);
  assert.equal(m.union.coveredPct, 100);
  // Baseline decodes the union re-assigned to the adopted copy (byte
  // arbitration: the published copy explains the documented TradeEvent tail).
  // None of them was LOST — see the name-agreement pin below.
  assert.equal(m.delta.reAssignedToAdopted, 151);
  assert.equal(m.union.pulledAnswered + m.delta.reAssignedToAdopted, m.baseline.decoded);
});

test('the two evidence classes stay apart and never overlap', () => {
  assert.equal(m.union.adoptedAnswered + m.union.pulledAnswered, m.union.decoded);
  // The union never LOSES a baseline decode: the pull answered 400 before,
  // and byte arbitration may re-assign an answer to the adopted copy where
  // it explains more bytes (the documented TradeEvent tail), but the count
  // of answered payloads only grows.
  assert.ok(m.union.pulledAnswered + m.union.adoptedAnswered >= m.baseline.decoded,
    'the union lost payloads the pull alone decoded');
  assert.ok(m.union.decoded >= m.baseline.decoded);
  assert.equal(m.receipt.slot, null);
  assert.equal(m.union.byteExact >= m.baseline.byteExact, true);
  assert.equal(artifact.pin.canonicalFingerprint, m.receipt.fingerprint);
});

test('the published copy is canonicalized content-addressed at the pinned commit', () => {
  // The committed fixture object IS the pinned canonical bytes: re-hash now.
  const objPath = path.resolve(ROOT, artifact.pin.sourceReadFrom);
  const bytes = readFileSync(objPath);
  const digest = createHash('sha256').update(bytes).digest('hex');
  assert.equal(digest, artifact.pin.canonicalFingerprint.slice('sha256:'.length),
    'the object the measurement read does not hash to its own name');
  assert.equal(m.receipt.instructionCount, 56);
  // License gate: nothing unlicensed is vendored.
  assert.equal(artifact.pin.license, null);
  assert.equal(artifact.committedStoreModified, false);
  assert.ok(!existsSync(path.join(ROOT, 'vendor', 'pump')),
    'unlicensed bytes must never be vendored into this repository');
});

test('the artifact carries no host path', () => {
  const text = readFileSync(ARTIFACT, 'utf8');
  assert.doesNotMatch(text, /\/home\//, 'a committed measurement must not name a home directory');
  assert.doesNotMatch(text, /\/tmp\//, 'a committed measurement must not name a scratch path');
});

test('FALSIFIED: tampered source bytes refuse with NO VERDICT before any measurement', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sememe-pump-pin-'));
  const bad = path.join(dir, 'pump.json');
  const real = JSON.parse(readFileSync(path.resolve(ROOT, artifact.pin.sourceReadFrom), 'utf8'));
  real.instructions = real.instructions.slice(0, 40); // a hand-truncated copy
  writeFileSync(bad, JSON.stringify(real));
  let code = 0;
  let stderr = '';
  try {
    execFileSync(process.execPath, [TOOL, '--source', bad, '--out', path.join(dir, 'out.json')], {
      cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000,
    });
  } catch (error) {
    code = error.status;
    stderr = String(error.stderr ?? '');
  } finally {
    rmSync(dir, { recursive: true, force: true, retryDelay: 200, maxRetries: 3 });
  }
  assert.equal(code, 3, 'the pin check must refuse tampered bytes with exit 3');
  assert.match(stderr, /pump-pin-hash-mismatch/);
  assert.match(stderr, /NO VERDICT/);
});
