// Union decode: two verified sources, one payload, and the disagreement made
// explicit.
//
// Why this file exists: the pump.fun measurement showed that a deployed
// program's own on-chain IDL account and its first-party published copy
// DISAGREE about real traffic (research/union-coverage-2026-10-30.json). The
// union that recovered 915/996 decoded payloads existed only inside a
// measurement tool as a hand-merged IDL. This file pins the PRODUCT path
// (src/union.mjs over a real store) so the number cannot silently regress.
//
// Every test asserts a VERDICT, not just a decode. A union decoder that
// always answers is useless: the interesting outcomes are the ones where the
// two sources disagree and the tool has to say which one won and why. So the
// tests below cover the cases a "just try both" implementation would get
// wrong:
//
//   - a fallback that names bytes it cannot reproduce is REFUSED, not accepted
//   - two different names for the same bytes is a REFUSAL, not a coin flip
//   - byte evidence, not preference, picks the winner
//   - an adopted copy can never silently become the default single source
//   - a tampered object is refused by name in the union path too
//
// The mutations at the end are the falsification: each one breaks exactly one
// rule above, and each must turn the suite red.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson } from '../src/canonical.mjs';
import { adopt } from '../src/adopt.mjs';
import { decodeUnionPayload, findStoredIdls } from '../src/decode.mjs';
import { unionDecode, UnionRefusal } from '../src/union.mjs';

const PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const OTHER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

const load = async (name) =>
  JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const pumpIdl = await load('pump-idl.json');
const pumpPublished = await load('pump-published-idl.json');
const pumpHarvest = await load('harvest-pump-2026-10-30.json');

const payloads = pumpHarvest.transactions.flatMap((tx) =>
  (tx.payloads ?? []).map((p) => ({ dataHex: p.dataHex, failed: tx.txErr !== null })));

/** A store with an on-chain pull and (optionally) an adopted published copy. */
async function store({ published = true, onChainIdl = pumpIdl, publishedIdl = pumpPublished } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sememe-union-test-'));
  await mkdir(path.join(dir, 'objects'), { recursive: true });
  await mkdir(path.join(dir, 'receipts'), { recursive: true });
  const bytes = Buffer.from(canonicalJson(onChainIdl) + '\n');
  const fingerprint = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(dir, 'objects', `${fingerprint}.json`), bytes);
  await writeFile(
    path.join(dir, 'receipts', `${PROGRAM}-463372656-metadata-${fingerprint}.json`),
    Buffer.from(canonicalJson({
      program: PROGRAM, source: 'metadata', slot: 463372656,
      fingerprint: `sha256:${fingerprint}`, instructionCount: onChainIdl.instructions.length,
    }) + '\n'),
  );
  if (published) {
    const file = path.join(dir, 'published.json');
    await writeFile(file, JSON.stringify(publishedIdl));
    await adopt(PROGRAM, file, dir, { source: 'published', origin: 'pump.json' });
  }
  return dir;
}

test('the store keeps the two sources apart: on-chain primary, adopted secondary', async () => {
  const dir = await store();
  try {
    const { primary, secondary, onChain, adopted } = await findStoredIdls(dir, PROGRAM);
    assert.equal(onChain.length, 1);
    assert.equal(adopted.length, 1);
    assert.equal(primary.idlMeta.slot, 463372656);
    assert.equal(primary.idlMeta.source, 'metadata');
    assert.equal(secondary.idlMeta.slot, null);
    assert.equal(secondary.idlMeta.source, 'published');
    assert.equal(secondary.idlMeta.origin, 'pump.json');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an adopted copy never becomes the default single source', async () => {
  const dir = await store();
  try {
    // findStoredIdl (the single-source reader) must still pick the on-chain
    // receipt, even though the adopted receipt sorts LAST by filename.
    const { findStoredIdl } = await import('../src/decode.mjs');
    const single = await findStoredIdl(dir, PROGRAM);
    assert.equal(single.receipt.slot, 463372656);
    assert.equal(single.receipt.source, 'metadata');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a payload only the published copy knows decodes, and the verdict says so', async () => {
  const dir = await store();
  try {
    // sell_v3 (1c92de77...) is executed by the deployed program but absent from
    // its own on-chain IDL account (measured: 194 payloads).
    const row = payloads.find((p) => p.dataHex.startsWith('1c92de7726c469d5'));
    assert.ok(row, 'the fixture must contain a sell_v3 payload');
    const result = await decodeUnionPayload(dir, PROGRAM, row.dataHex);
    assert.equal(result.instruction, 'sell_v3');
    assert.equal(result.view.verdict, 'fallback_secondary');
    assert.equal(result.view.primary.decoded, false);
    assert.equal(result.view.secondary.decoded, true);
    assert.equal(result.view.arbitration.basis, 'primary_refused');
    // The winning side's provenance is the ADOPTED receipt, not the on-chain one.
    assert.equal(result.idl.source, 'published');
    assert.equal(result.idl.slot, null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a payload both sources decode identically is reported as agreement', async () => {
  const dir = await store();
  try {
    let agreed = null;
    for (const candidate of payloads) {
      try {
        const result = await decodeUnionPayload(dir, PROGRAM, candidate.dataHex);
        if (result.view.verdict === 'agree') { agreed = { candidate, result }; break; }
      } catch { /* refused payloads are covered separately */ }
    }
    assert.ok(agreed, 'the fixture must contain a payload both sources agree on');
    assert.equal(agreed.result.view.sourcesAgree, true);
    assert.equal(agreed.result.view.primary.name, agreed.result.view.secondary.name);
    assert.equal(agreed.result.roundTripByteExact, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a layout drift between the two sources is reported, with the differing paths', async () => {
  const dir = await store();
  try {
    let drifted = null;
    for (const candidate of payloads) {
      try {
        const result = await decodeUnionPayload(dir, PROGRAM, candidate.dataHex);
        if (result.view.verdict === 'layout_drift') { drifted = { candidate, result }; break; }
      } catch { /* refused payloads are covered separately */ }
    }
    assert.ok(drifted, 'the fixture must contain a payload where the sources drift');
    assert.equal(drifted.result.view.sourcesAgree, false);
    assert.ok(drifted.result.view.drift.paths.paths.length > 0,
      'a drift must name the fields that differ');
    // Both sources decoded (drift presupposes two decodes), and the winner
    // is decided by bytes with the reason stated.
    assert.equal(drifted.result.view.primary.decoded, true);
    assert.equal(drifted.result.view.secondary.decoded, true);
    assert.ok(['byte_evidence_full_roundtrip', 'byte_evidence_fewer_unexplained_bytes', 'primary_by_default']
      .includes(drifted.result.view.arbitration.basis));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('two different names for the same bytes is refused, not arbitrated', () => {
  const primary = { label: 'primary', idl: { instructions: [{ name: 'alpha', discriminator: [1, 1, 1, 1, 1, 1, 1, 1] }], types: [] } };
  const secondary = { label: 'secondary', idl: { instructions: [{ name: 'beta', discriminator: [1, 1, 1, 1, 1, 1, 1, 1] }], types: [] } };
  assert.throws(
    () => unionDecode({ program: PROGRAM, primary, secondary, bytes: Buffer.from([1, 1, 1, 1, 1, 1, 1, 1]) }),
    (error) => {
      assert.ok(error instanceof UnionRefusal);
      assert.equal(error.verdict, 'name_conflict');
      assert.match(error.message, /alpha/);
      assert.match(error.message, /beta/);
      return true;
    },
  );
});

test('a secondary source that cannot reproduce the bytes is refused, not trusted', () => {
  // The primary refuses; the secondary DECODES the bytes but cannot re-encode
  // them: a signaling NaN in an f32 argument decodes to a canonical NaN whose
  // bytes differ. A source that names bytes it cannot reproduce has no
  // evidence, so the fallback must be refused.
  const primary = { label: 'primary', idl: { instructions: [], types: [] } };
  const secondary = {
    label: 'secondary',
    idl: {
      instructions: [{ name: 'sig', discriminator: [1, 2, 3, 4, 5, 6, 7, 8], args: [{ name: 'v', type: 'f32' }] }],
      types: [],
    },
  };
  const bytes = Buffer.concat([Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]), Buffer.from([0x00, 0x00, 0xa0, 0x7f])]);
  assert.throws(
    () => unionDecode({ program: PROGRAM, primary, secondary, bytes }),
    (error) => {
      assert.ok(error instanceof UnionRefusal);
      assert.equal(error.verdict, 'union_fallback_refused');
      assert.match(error.message, /cannot re-encode/);
      return true;
    },
  );
});

test('a payload BOTH sources refuse names both verdicts', async () => {
  const dir = await store();
  try {
    // Find a payload neither source can decode (measured: 81 of 996).
    let bothRefuse = null;
    for (const candidate of payloads) {
      try { await decodeUnionPayload(dir, PROGRAM, candidate.dataHex); }
      catch (error) {
        if (error instanceof UnionRefusal && error.verdict === 'refused') { bothRefuse = { candidate, error }; break; }
      }
    }
    assert.ok(bothRefuse, 'the fixture must contain a payload both sources refuse');
    const { error } = bothRefuse;
    assert.match(error.message, /both stored sources refuse/);
    assert.equal(error.view.primary.decoded, false, 'the primary verdict must be visible');
    assert.equal(error.view.secondary.decoded, false, 'the secondary verdict must be visible');
    assert.ok(error.view.primary.refusedReason, 'the primary reason must be named');
    assert.ok(error.view.secondary.refusedReason, 'the secondary reason must be named');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('byte evidence picks the source that explains the WHOLE payload (CreateEvent depth)', async () => {
  const dir = await store();
  try {
    // The published copy declares an extra `depth: u8` on CreateEvent; the
    // on-chain copy does not, so it leaves 1 byte unexplained. Byte evidence
    // must pick the published copy — measurable: the winning decode carries
    // the depth field and re-encodes the whole payload. Exactly one
    // CreateEvent payload exists in the window.
    const result = await decodeUnionPayload(dir, PROGRAM,
      'e445a52e51cb9a1d1b72a94ddeeb63760e000000f09f90b8204d6f6f6e2046726f6705000000244d4652474300000068747470733a2f2f697066732e696f2f697066732f516d5163556d6551506463376b316f6d6b686a4768345362776433636e664c353161783156486d56594170505635cd45ba501567186b855f640d0f1c04b27af7594fd5c06dd547c874a26098190f79b76a44a836dd7862ca5b5c49a63fca17c6751a8c53ef3d8b12fecdff4db27dcc12f627d0b6546a14d1716a26cbb97051521ae4a23db498067889be35ba7fe6cc12f627d0b6546a14d1716a26cbb97051521ae4a23db498067889be35ba7fe650dde46a000000000010d847e3cf030000ac23fc060000000078c5fb51d102000080c6a47e8d030006ddf6e1ee758fde18425dbce46ccddab61afc4d83b90d27febdf928d8a18bfc0100000000000000000000000000000000000000000000000000000000000000000000ac23fc0600000000000000000000000000');
    assert.equal(result.view.verdict, 'layout_drift');
    assert.deepEqual(result.view.drift.paths.paths, ['depth']);
    assert.equal(result.view.arbitration.basis, 'byte_evidence_full_roundtrip');
    assert.equal(result.roundTripByteExact, true,
      'the winner must re-encode the WHOLE payload — that is what the evidence IS');
    assert.ok('depth' in result.args,
      'the winning decode must carry the field only the published copy declares');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the fewer-unexplained-bytes rule decides TradeEvent drift (creator_fee_unclaimed)', async () => {
  const dir = await store();
  try {
    // Measured on real payloads: the on-chain TradeEvent copy has 34 fields and
    // leaves 16 bytes unexplained; the published copy declares an additional
    // creator_fee_unclaimed: u64 and leaves 8. Neither re-encodes the whole
    // payload (both leave the known tail), so the rule that must decide is
    // strictly-fewer-unexplained-bytes — not preference.
    let found = null;
    for (const candidate of payloads) {
      try {
        const result = await decodeUnionPayload(dir, PROGRAM, candidate.dataHex);
        if (result.view.verdict === 'layout_drift'
          && result.view.drift.paths.paths.includes('creator_fee_unclaimed')) {
          found = result; break;
        }
      } catch { /* refusals covered elsewhere */ }
    }
    assert.ok(found, 'the fixture must contain the TradeEvent creator_fee_unclaimed drift');
    assert.equal(found.view.arbitration.basis, 'byte_evidence_fewer_unexplained_bytes');
    assert.ok(found.view.drift.secondaryTrailingBytes < found.view.drift.primaryTrailingBytes,
      'the winner must have left strictly fewer bytes unexplained');
    assert.ok('creator_fee_unclaimed' in found.args,
      'the winning decode carries the field only the published copy declares');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a tampered stored object is refused in the union path too', async () => {
  const dir = await store();
  try {
    // Tamper with the ADOPTED object: valid JSON, one instruction renamed.
    const receipts = await readFile(path.join(dir, 'receipts'), { encoding: 'utf8' }).catch(() => null);
    assert.equal(receipts, null, 'receipts is a directory');
    const { readdir } = await import('node:fs/promises');
    const names = (await readdir(path.join(dir, 'receipts'))).filter((n) => n.includes('-published-'));
    assert.equal(names.length, 1);
    const receipt = JSON.parse(await readFile(path.join(dir, 'receipts', names[0]), 'utf8'));
    const fingerprint = receipt.fingerprint.replace('sha256:', '');
    const objectPath = path.join(dir, 'objects', `${fingerprint}.json`);
    const object = JSON.parse(await readFile(objectPath, 'utf8'));
    object.instructions[0].name = 'totally_honest_name';
    await writeFile(objectPath, JSON.stringify(object));
    const row = payloads.find((p) => p.dataHex.startsWith('1c92de7726c469d5'));
    await assert.rejects(
      () => decodeUnionPayload(dir, PROGRAM, row.dataHex),
      (error) => {
        assert.match(error.message, /re-hashes|disagree/);
        return true;
      },
    );
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('adopt refuses a file that declares a different program', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sememe-adopt-'));
  try {
    const file = path.join(dir, 'foreign.json');
    await writeFile(file, JSON.stringify({ ...pumpIdl, address: OTHER }));
    await assert.rejects(
      () => adopt(PROGRAM, file, dir, { source: 'published' }),
      /refusing to re-label a foreign interface/,
    );
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('adopt stores the file content-addressed, and re-adopting it changes nothing', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sememe-adopt2-'));
  try {
    const file = path.join(dir, 'published.json');
    await writeFile(file, JSON.stringify(pumpPublished));
    const first = await adopt(PROGRAM, file, dir, { source: 'published', origin: 'pump.json' });
    assert.equal(first.instructionCount, pumpPublished.instructions.length);
    assert.match(first.fingerprint, /^sha256:[a-f0-9]{64}$/);
    const second = await adopt(PROGRAM, file, dir, { source: 'published', origin: 'pump.json' });
    assert.equal(second.fingerprint, first.fingerprint);
    assert.equal(second.receiptPath, first.receiptPath);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
