// Short (non-8-byte) stored discriminators are STORED bytes, not gaps.
//
// THE DEFECT this ladder pins (found 2026-11-12, measured before/after by
// tools/measure-hadro-short-discriminator.mjs):
//
//   withDerivedDiscriminators treated ONLY 8-byte arrays as "stored". A
//   program that stores 1-byte discriminators in its published IDL (measured:
//   HADRoNbLovyqhCsocfYQYB7QdfCAAinN9HTePvBCVDQ8, 38 one-byte instruction
//   discriminators) had every one of them OVERWRITTEN with Anchor's 8-byte
//   sighash — against this module's own header rule ("stored discriminators
//   are never changed"). The overwritten table matches no real wire: the
//   product path refused 0/195 payloads on the committed sample; with the
//   stored bytes kept, 123/195 decode.
//
//   The same assumption sat in src/union.mjs prepare(): the rename map only
//   recorded 8-byte stored discriminators, so short stored bytes could never
//   be recognised as the program's own evidence.
//
// Faces (D = defect, red on the pre-fix tree; G = guard, green on both):
//   D1 1-byte INSTRUCTION discriminator is preserved, not filled
//   D2 1-byte EVENT discriminator is preserved, not filled
//   D3 HADRo store: all 38 short instruction discriminators survive
//   D4 HADRo wire: 123/195 payloads decode through the product path
//   D5 the 51 named full-byte-exact and 72 described-exact split holds
//   D6 the 72 setRiskCurve payloads stay honestly refused (IDL != wire)
//   G1 missing discriminators are still derived (8-byte gap-fill unchanged)
//   G2 shank discriminants are still copied verbatim (v0.4.19 rule intact)
//   G3 8-byte stored-vs-derived conflicts are still reported
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { withDerivedDiscriminators, verifyDerivedDiscriminators } from '../src/discriminators.mjs';
import { decodeUnionPayload } from '../src/decode.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const HADRO = 'HADRoNbLovyqhCsocfYQYB7QdfCAAinN9HTePvBCVDQ8';
const SAMPLE = path.join(ROOT, 'test', 'fixtures', 'ecosystem-sample-2026-11-11.json');
const STORE = path.join(ROOT, 'test', 'fixtures', 'ecosystem-store-2026-11-11');

const short = (list) => Array.isArray(list) && list.length === 1;

test('D1: a stored 1-byte instruction discriminator is never overwritten', () => {
  const idl = { instructions: [{ name: 'shortOne', discriminator: [4], args: [] }], events: [] };
  const { idl: out, filled, conflicts } = withDerivedDiscriminators(idl);
  assert.deepEqual(out.instructions[0].discriminator, [4],
    'a stored discriminator is a stored byte — the header rule says never change it');
  assert.equal(filled.instructions, 0, 'a short stored discriminator is not a gap');
  assert.equal(conflicts.length, 0,
    'a 1-byte stored value cannot conflict with an 8-byte sighash — different scheme, no claim either way');
});

test('D2: a stored 1-byte event discriminator is never overwritten', () => {
  const idl = { instructions: [], events: [{ name: 'shortEvent', discriminator: [0], fields: [] }] };
  const { idl: out, filled, conflicts } = withDerivedDiscriminators(idl);
  assert.deepEqual(out.events[0].discriminator, [0]);
  assert.equal(filled.events, 0);
  assert.equal(conflicts.length, 0);
});

test('D3: the HADRo store keeps all 38 short instruction discriminators', async () => {
  const { primary } = await import('../src/store-read.mjs').then((m) => m.findStoredIdls(STORE, HADRO));
  const storedShort = primary.idl.instructions.filter((ix) => short(ix.discriminator)).length;
  assert.equal(storedShort, 38, 'fixture sanity: the published HADRo IDL stores 38 1-byte discriminators');
  const { idl: out, filled } = withDerivedDiscriminators(primary.idl);
  const kept = out.instructions.filter((ix) => short(ix.discriminator)).length;
  assert.equal(kept, 38, 'every stored 1-byte discriminator survives unchanged');
  assert.equal(filled.instructions, 0, 'none of them counts as a derivation gap (pre-fix: 38 filled)');
});

test('D4+D5+D6: HADRo wire through the product path — 123 decode, 72 stay refused', async () => {
  const sample = JSON.parse(await readFile(SAMPLE, 'utf8'));
  const rows = [];
  for (const tx of sample.transactions) {
    for (const p of tx.payloads ?? []) {
      if (p.program === HADRO) rows.push(p.dataHex);
    }
  }
  assert.equal(rows.length, 195, 'fixture sanity: the committed window carries 195 HADRo payloads');

  let decoded = 0; let fullExact = 0; let describedExact = 0; let refused = 0;
  const decodedBy = {}; const refusedBy = {};
  for (const hex of rows) {
    try {
      const out = await decodeUnionPayload(STORE, HADRO, hex, { trailing: 'report', absent: 'verified' });
      decoded += 1;
      decodedBy[out.name] = (decodedBy[out.name] ?? 0) + 1;
      if (out.roundTripByteExact === true) fullExact += 1;
      else if (out.describedRoundTripByteExact === true) describedExact += 1;
    } catch (error) {
      refused += 1;
      const key = String(error?.message ?? error)
        .replace(/unknown instruction discriminator ([0-9a-f]+).*/, 'unknown-discriminator-$1')
        .replace(/truncated input.*/, 'truncated-input')
        .slice(0, 90);
      refusedBy[key] = (refusedBy[key] ?? 0) + 1;
    }
  }
  // THE NUMBER: 123/195 where the pre-fix tree decoded 0/195.
  assert.equal(decoded, 123, `short stored discriminators must decode the wire (got ${decoded})`);
  assert.equal(refused, 72);
  assert.equal(fullExact, 51, '51 payloads re-encode byte-for-byte');
  assert.equal(describedExact, 72, '72 setCurve payloads explain the prefix, trailing bytes reported');
  // Every decode is NAMED — the measurement never counts anonymous bytes.
  assert.deepEqual(decodedBy, {
    setCurve: 72,
    updateMidpriceAndSpreadFactor: 41,
    switchPriceCurve: 6,
    updateMidprice: 3,
    swapExactIn: 1,
  }, 'every decode is named; the setRiskCurve family is NOT here');
  // The 72 refusals are honest IDL-vs-wire disagreement, not a missing table:
  // the stored IDL declares a vector length the wire does not carry.
  assert.ok(Object.values(refusedBy).reduce((a, b) => a + b, 0) === 72,
    `setRiskCurve refusals must be counted, got ${JSON.stringify(refusedBy)}`);
  assert.ok(Object.keys(refusedBy).some((k) => k.includes('setRiskCurve')),
    `the refusal must be NAMED, got ${JSON.stringify(refusedBy)}`);
});

test('G1: 8-byte gap-fill still works exactly as before', () => {
  const idl = { instructions: [{ name: 'initialize', args: [] }], events: [{ name: 'TradeEvent', fields: [] }] };
  const { idl: out, filled } = withDerivedDiscriminators(idl);
  assert.equal(filled.instructions, 1);
  assert.equal(filled.events, 1);
  assert.equal(out.instructions[0].discriminator.length, 8);
  assert.equal(out.events[0].discriminator.length, 8);
});

test('G2: shank discriminants are still copied verbatim, never sighashed', async () => {
  const { globalDiscriminator } = await import('../src/discriminators.mjs');
  const idl = {
    instructions: [{ name: 'assertAccountInfoMulti', discriminant: { type: 'u8', value: 6 }, args: [] }],
    events: [],
  };
  const { idl: out, filled } = withDerivedDiscriminators(idl);
  assert.deepEqual(out.instructions[0].discriminator, [6]);
  assert.notDeepEqual(out.instructions[0].discriminator, globalDiscriminator('assertAccountInfoMulti'));
  assert.equal(filled.instructions, 0);
});

test('G3: 8-byte stored-vs-derived conflicts are still reported', () => {
  const bogus = [9, 9, 9, 9, 9, 9, 9, 9];
  const idl = { instructions: [{ name: 'initialize', discriminator: bogus, args: [] }], events: [] };
  const { conflicts, idl: out } = withDerivedDiscriminators(idl);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(out.instructions[0].discriminator, bogus, 'conflict is reported, stored bytes still untouched');
  const verify = verifyDerivedDiscriminators(idl);
  assert.equal(verify.conflicts.length, 1, 'the verifier still sees the 8-byte conflict');
});
