import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { writeFile, readFile as readFileAsync } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFileCb);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');

// The legacy Archer Swap wire form: a chain-executed short form that ends
// INSIDE the args struct, not at a top-level field boundary. Before this
// fix the absent-field policy (src/codec.mjs decodeInstructionData) only
// checked `cursor.remaining === 0` where a TOP-LEVEL argument would begin,
// so a struct whose trailing field was missing was refused under every
// policy with `truncated input: need 4 byte(s)` — measured 2026-11-12 in
// research/archer-second-source-2026-11-12.json (1 of 83 payloads).
//
// Evidence rule (same three legs as the engine short forms): err:null on
// mainnet, byte-identical payload, and the program's own success — see
// research/archer-legacy-swap-witness-2026-11-12.json. The interface bytes
// are NOT vendored (Apache-2.0, house rule): this file fetches them at the
// pinned commit and adopts them into a throwaway store, exactly like
// test/archer-second-source.test.mjs.
//
// Ladder (each test names the mutation that must catch it):
//   P0 artifact pins the pre-fix measurement (no mutation; the frozen record)
//   D1 struct boundary decodes under verified through BOTH engines — M1 (boundary check removed from struct decode)
//   D2 codec layer reports the absence under report — M2 (mirror dropped in decodeInstructionData)
//   D3 bytes cut INSIDE a field stay refused — M3 (mid-field cut accepted)
//   D4 strict default still refuses at a true struct boundary — M4 ('report' forced by default)
//   D5 evidence gate refuses a DIFFERENT struct-absent shape — M5 (exact-length key dropped)
//   D6 measured absent set reproduces the wire on re-encode — M6 (encoder ignores absent)
//   G1 false-positive guard: the full form keeps decoding (GREEN on both trees)
//   G2 false-positive guard: an engine short form keeps decoding (GREEN on both trees)

const ARCHER = 'Archer8kgiavM61GyusMzaaS2ft5sALtNsD1HxkUPMhy';
const SWAP_FULL = '0f43000000000000000000000000000000010043000000';
const SWAP_LEGACY = '0f430000000000000000000000000000000100';
// 13 bytes: tag + amount + HALF of threshold. A cut INSIDE a u64 — no field
// boundary is reachable, so every policy must refuse it. (Even-length hex of
// >=16 chars so parsePayload treats it as hex, not base58.)
const CUT_INSIDE_FIELD = '0f430000000000000000000000';
// 18 bytes: ends exactly after `side`, i.e. on the boundary BEFORE `mode` —
// a nameable boundary cut that NO witness covers (the witness is 19 bytes),
// so 'report' decodes it and 'verified' must refuse it.
const UNWITNESSED_BOUNDARY = '0f4300000000000000000000000000000001';
const WITNESS_STORE = 'test/fixtures/traffic-sample-store';

const REPO = 'ballista-tech/archer-sdk';
const COMMIT = '5d07c895207ebd02f1ce70078b2d0c1ec3f186b5';
const IDL_FILE = 'idl/archer_v1.json';
const FINGERPRINT = '4354dc49ea9a9294960aca0f595e3ed4523046506572a028550c2318ded1a805';

async function ghAuthed() {
  try { await run('gh', ['auth', 'status'], { timeout: 15000 }); return true; }
  catch { return false; }
}

async function fetchAt(file, ref = COMMIT) {
  const res = await run('gh', ['api', `repos/${REPO}/contents/${file}?ref=${ref}`,
    '-H', 'Accept: application/vnd.github.raw'], { timeout: 60000, maxBuffer: 8 << 20 });
  return res.stdout;
}

/**
 * Fetch the pinned interface, verify its canonical fingerprint, adopt it into
 * a throwaway store under /tmp (never into the repo), and hand back the path.
 * Returns null when gh is unauthenticated so tests can skip by name.
 */
async function archerStore() {
  if (!await ghAuthed()) return null;
  const raw = await fetchAt(IDL_FILE);
  const parsed = JSON.parse(raw);
  const { canonicalJson } = await import('../src/canonical.mjs');
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update(Buffer.from(canonicalJson(parsed) + '\n')).digest('hex');
  assert.equal(hash, FINGERPRINT, 'the fetched interface must be the pinned bytes');
  const base = mkdtempSync(path.join(os.tmpdir(), 'archer-pulse-'));
  const source = path.join(base, 'archer_v1.json');
  await writeFile(source, raw);
  const store = path.join(base, 'store');
  const { adopt } = await import('../src/adopt.mjs');
  await adopt(ARCHER, source, store, {
    source: 'published',
    origin: 'ballista-tech/archer-sdk@5d07c895207ebd02f1ce70078b2d0c1ec3f186b5:idl/archer_v1.json',
  });
  return store;
}

function releaseStore(store) {
  // store lives under a private mkdtemp base; remove that base only, never /tmp.
  rmSync(path.dirname(store), { recursive: true, force: true });
}

test('P0 artifact pins the pre-fix measurement: the struct-internal absence was refused', () => {
  assert.equal(Buffer.from(SWAP_LEGACY, 'hex').length, 19);
  assert.equal(Buffer.from(CUT_INSIDE_FIELD, 'hex').length, 13);
  assert.equal(Buffer.from(UNWITNESSED_BOUNDARY, 'hex').length, 18);
  const artifact = JSON.parse(readFileSync(
    new URL('../research/archer-second-source-2026-11-12.json', import.meta.url), 'utf8'));
  assert.equal(artifact.face.find((f) => f.tag === '0f').length, 19);
  assert.equal(artifact.measured.legacySwapRefusalCount, 1);
  assert.match(String(artifact.measured.legacySwapRefusal), /truncated input.*need 4 byte/);
  const witness = JSON.parse(readFileSync(
    new URL('../research/archer-legacy-swap-witness-2026-11-12.json', import.meta.url), 'utf8'));
  assert.equal(witness.witness.chainAccepted, true);
  assert.equal(witness.witness.err, null);
  assert.equal(witness.witness.payloadHex, SWAP_LEGACY);
  assert.equal(witness.witness.absent[0], 'swapParams.builderFeePpm');
  assert.equal(witness.pin.canonicalFingerprint, FINGERPRINT);
});

test('D1: the 19-byte legacy Swap form decodes under verified through BOTH engines', async (t) => {
  const store = await archerStore();
  if (!store) { t.skip('gh CLI not authenticated; skipping network-gated store test'); return; }
  try {
    const { decodePayload, decodeUnionPayload } = await import('../src/decode.mjs');

    const union = await decodeUnionPayload(store, ARCHER, SWAP_LEGACY, { absent: 'verified' });
    assert.equal(union.name, 'Swap');
    assert.deepEqual(union.args.swapParams, { amount: '67', threshold: '0', side: 1, mode: 0 });
    assert.deepEqual(union.absent, ['swapParams.builderFeePpm']);
    assert.equal(union.shortForm.verified, true);
    assert.equal(union.shortForm.instruction, 'Swap');
    assert.equal(union.shortForm.wireBytes, 19);
    assert.equal(union.shortForm.witnesses, 1);
    assert.match(union.shortForm.source, /archer-legacy-swap-witness-2026-11-12/);
    assert.equal(union.roundTripByteExact, true, 're-encode must reproduce the 19 wire bytes');

    const single = await decodePayload(store, ARCHER, SWAP_LEGACY, { absent: 'verified' });
    assert.equal(single.name, 'Swap');
    assert.deepEqual(single.args.swapParams, { amount: '67', threshold: '0', side: 1, mode: 0 });
    assert.deepEqual(single.absent, ['swapParams.builderFeePpm']);
    assert.equal(single.roundTripByteExact, true);
    assert.equal(single.shortForm?.verified, true);
  } finally {
    releaseStore(store);
  }
});

test('D2: the codec layer itself reports the struct-internal absence under report', async (t) => {
  if (!await ghAuthed()) { t.skip('gh CLI not authenticated; skipping codec-level fetch'); return; }
  const { decodeInstructionData } = await import('../src/codec.mjs');
  const raw = await fetchAt(IDL_FILE);
  const parsed = JSON.parse(raw);
  const decoded = decodeInstructionData(parsed, Buffer.from(SWAP_LEGACY, 'hex'), { absent: 'report' });
  assert.equal(decoded.instruction, 'Swap');
  assert.deepEqual(decoded.args.swapParams, { amount: 67n, threshold: 0n, side: 1, mode: 0 });
  assert.deepEqual(decoded.absent, ['swapParams.builderFeePpm']);
  assert.equal(decoded.trailing.count, 0);
});

test('D3: bytes cut INSIDE a field refuse under every policy; an unwitnessed boundary cut decodes only under report', async (t) => {
  const store = await archerStore();
  if (!store) { t.skip('gh CLI not authenticated; skipping network-gated store test'); return; }
  try {
    const { decodeUnionPayload } = await import('../src/decode.mjs');
    // Mid-field cut: no field boundary is reachable, so even the loose
    // policy refuses — a partial u64 is not a value.
    for (const absent of [undefined, 'verified', 'report', 'error']) {
      await assert.rejects(
        () => decodeUnionPayload(store, ARCHER, CUT_INSIDE_FIELD, { ...(absent ? { absent } : {}) }),
        (error) => { assert.match(error.message, /truncated|refus/); return true; },
        `absent:${absent ?? '(default)'} must refuse a mid-field cut`);
    }
    // 18-byte boundary cut: nameable but UNWITNESSED. 'report' decodes it
    // with caller risk and attaches NO chain evidence; 'verified' refuses
    // because no witness covers exactly 18 bytes.
    const loose = await decodeUnionPayload(store, ARCHER, UNWITNESSED_BOUNDARY, { absent: 'report' });
    assert.equal(loose.name, 'Swap');
    assert.deepEqual(loose.absent, ['swapParams.mode', 'swapParams.builderFeePpm']);
    assert.equal(loose.shortForm, undefined, 'report attaches no chain evidence');
    await assert.rejects(
      () => decodeUnionPayload(store, ARCHER, UNWITNESSED_BOUNDARY, { absent: 'verified' }),
      (error) => { assert.match(error.message, /refuse|truncated|unknown instruction discriminator/); return true; },
      'verified must refuse a boundary cut no witness covers');
  } finally {
    releaseStore(store);
  }
});

test('D4: the strict default still refuses the legacy form even at a true struct boundary', async (t) => {
  const store = await archerStore();
  if (!store) { t.skip('gh CLI not authenticated; skipping network-gated store test'); return; }
  try {
    const { decodeUnionPayload } = await import('../src/decode.mjs');
    await assert.rejects(
      () => decodeUnionPayload(store, ARCHER, SWAP_LEGACY),
      (error) => { assert.match(error.message, /truncated input/); return true; });
  } finally {
    releaseStore(store);
  }
});

test('D5: the evidence gate refuses a DIFFERENT struct-absent shape nobody witnessed (1-byte args)', async (t) => {
  const store = await archerStore();
  if (!store) { t.skip('gh CLI not authenticated; skipping network-gated store test'); return; }
  try {
    const { decodeUnionPayload } = await import('../src/decode.mjs');
    // tag only: under 'verified' no form matches (1 !== 19), so policy stays
    // strict and the payload refuses — even though the boundary rule would
    // happily name the whole argument absent under a blanket 'report'.
    await assert.rejects(
      () => decodeUnionPayload(store, ARCHER, '0x0f', { absent: 'verified' }),
      (error) => { assert.match(error.message, /truncated|refus/); return true; },
      'verified must stay scoped to program + discriminator + EXACT length');
    // And a longer-than-witnessed form must not claim the witness either:
    // 21 bytes ends INSIDE builderFeePpm (needs 4, has 2) and no witness
    // covers it.
    await assert.rejects(
      () => decodeUnionPayload(store, ARCHER, SWAP_LEGACY + '0000', { absent: 'verified' }),
      (error) => { assert.match(error.message, /truncated|refus/); return true; },
      'a 21-byte cut ends inside builderFeePpm and is not the witnessed form');
  } finally {
    releaseStore(store);
  }
});

test('D6: the measured absent set travels to the re-encode and reproduces the wire', async (t) => {
  const store = await archerStore();
  if (!store) { t.skip('gh CLI not authenticated; skipping network-gated store test'); return; }
  try {
    const { decodeUnionPayload } = await import('../src/decode.mjs');
    const union = await decodeUnionPayload(store, ARCHER, SWAP_LEGACY, { absent: 'verified' });
    assert.equal(union.roundTripByteExact, true);
    assert.equal(union.describedRoundTripByteExact, true);
    assert.deepEqual(union.absent, ['swapParams.builderFeePpm']);
  } finally {
    releaseStore(store);
  }
});

test('G1 false-positive guard: the full 22-byte Swap form still decodes byte-exactly under every policy', async (t) => {
  const store = await archerStore();
  if (!store) { t.skip('gh CLI not authenticated; skipping network-gated store test'); return; }
  try {
    const { decodeUnionPayload } = await import('../src/decode.mjs');
    for (const absent of [undefined, 'verified', 'report', 'error']) {
      const decoded = await decodeUnionPayload(store, ARCHER, SWAP_FULL,
        { ...(absent ? { absent } : {}) });
      assert.equal(decoded.name, 'Swap');
      assert.deepEqual(decoded.args.swapParams,
        { amount: '67', threshold: '0', side: 1, mode: 0, builderFeePpm: 67 });
      assert.deepEqual(decoded.absent, [], 'the full form carries every declared field');
      assert.equal(decoded.roundTripByteExact, true);
      assert.equal(decoded.shortForm, undefined, 'the full form is not a short form');
    }
  } finally {
    releaseStore(store);
  }
});

test('G2 false-positive guard: the pump.fun engine short form still decodes byte-exactly', async () => {
  const { decodeUnionPayload, VERIFIED_SHORT_FORMS } = await import('../src/decode.mjs');
  const form = VERIFIED_SHORT_FORMS.find((f) => f.instruction === 'buy_exact_quote_in_v3');
  assert.ok(form, 'the engine short form must still be in the table');
  const report = JSON.parse(readFileSync(
    new URL('../research/short-form-wire-forms-2026-11-03.json', import.meta.url), 'utf8'));
  const row = report.rows.find((r) => r.discriminator === form.discriminator && r.wireBytes === form.bytes);
  assert.ok(row, 'the report carries the engine witness');
  const witness = row.witnesses.find((w) => w.accepted) ?? row.witnesses[0];
  const instruction = witness.instructions.find((i) => i.hex?.startsWith(form.discriminator));
  assert.ok(instruction, 'the witness carries the payload');
  const decoded = await decodeUnionPayload(WITNESS_STORE, form.program, instruction.hex, { absent: 'verified' });
  assert.equal(decoded.name, form.instruction);
  assert.deepEqual(decoded.absent, form.absent);
  assert.equal(decoded.roundTripByteExact, true);
  assert.equal(decoded.shortForm.verified, true);
});

test('G3: the absent-help surface names the Archer legacy form with its evidence', async () => {
  const res = await run('node', [path.join(ROOT, 'bin', 'sememe.mjs'), 'absent-help'],
    { timeout: 30000, maxBuffer: 4 << 20 });
  const printed = JSON.parse(res.stdout);
  assert.match(printed.source, /short-form-wire-forms-2026-11-03\.json/);
  assert.match(printed.source, /archer-legacy-swap-witness-2026-11-12\.json/);
  const form = printed.forms.find((f) => f.program === ARCHER);
  assert.ok(form, 'the Archer legacy form must be listed');
  assert.equal(form.discriminator, '0f');
  assert.equal(form.bytes, 19);
  assert.equal(form.instruction, 'Swap');
  assert.deepEqual(form.absent, ['swapParams.builderFeePpm']);
  assert.equal(form.witnesses, 1);
  assert.equal(form.missingFieldInsideStruct, true);
});
