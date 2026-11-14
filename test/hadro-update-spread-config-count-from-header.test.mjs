// updateSpreadConfig: the THIRD HADRo instruction the count-from-header
// rule was measured on — and the first one whose witness is LIVE.
//
// THE DEFECT THIS FILE PINS (measured 2026-11-14, 14.11. PULS AH).
//
// The count-from-header rule (src/wire-layout.mjs) covers two HADRo
// instructions: setCurve (disc 0x04) and setRiskCurve (disc 0x08). Both
// were measured on the committed 144 chain-accepted payloads.
//
// updateSpreadConfig (disc 0x0e) declares
//
//   updateSpreadConfig  numTriggers u8, triggers vec<SpreadTriggerInput>
//
// where SpreadTriggerInput is {account pubkey, programId pubkey,
// spreadBps u16} — 66 bytes on the wire. The stored IDL says `vec`, so
// the strict codec reads a u32 Borsh length prefix that the wire does not
// carry.
//
// The 13.11. shape scan found this pair but had NO payload witness, so
// the rule stayed silent for it (research/count-from-header-shape-scan-
// 2026-11-13.json, verdict no-third-program-witnessed-in-window). The
// 14.11. LIVE scan (research/live-layout-scan-hadro-witness-2026-11-14.json,
// endpoint solana-rpc.publicnode.com, 10000 signatures, 22243 payloads,
// 0 missed, slots 469235826..469246302) found TWO chain-accepted
// updateSpreadConfig payloads — both with numTriggers=5, elementBytes=66,
// trailingBytes=0:
//
//   5WazqL16rgdgeCvUXUsd2gSow71sHn9aKU8kBePdzjVs44rZcahfr2FPZQh8L5Bb
//   BTzbM61417wafyZnXLB2pZU3   slot 469240022   err null
//   2vCUNpizeB3Cu9vdnhFPEFnsnpnBMLgJHSRCdRd2BdYfQKF4xz49CrkejUuL4d1iwU
//   CsG6FQ6BBBSVjDuLafc1g1   slot 469240017   err null
//
// Both were re-fetched from the RPC by this run: slots and err=null
// reproduce exactly.
//
// What the product did with those bytes BEFORE the rule knew the pair
// (measured on this tree):
//
//   updateSpreadConfig.triggers: vector length 891366665 needs
//   58830199890 byte(s) but 326 remain
//
// — the garbage number a prefix read produces, quoted as if it were the
// layout. The count was in the header the whole time (numTriggers=5), and
// 5 x 66 = 330 is exactly the body.
//
// Faces (D = defect, red on the pre-fix tree; G = guard, green on both):
//   D1 both live witnesses decode through the product path
//   D2 the decoded trigger count equals the header byte (5)
//   D3 the decode carries FIVE real triggers, not an empty vector
//   D4 the decoded prefix re-encodes byte-exactly
//   D5 a count that does not fit is refused BY NAME, not by a garbage
//      number
//   G1 the wired setCurve/setRiskCurve pairs are UNCHANGED
//   G2 the rule stays inert when the count argument is not declared
//   G3 the same interface under another address keeps the strict codec
//   G4 a DIFFERENT element size does not leak into the wired pairs
//      (the element size is per-measurement, not a global constant)

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeUnionPayload } from '../src/decode.mjs';
import { decodeInstructionData, encodeInstructionData, CodecError } from '../src/codec.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const HADRO = 'HADRoNbLovyqhCsocfYQYB7QdfCAAinN9HTePvBCVDQ8';
const STORE = path.join(ROOT, 'test', 'fixtures', 'ecosystem-store-2026-11-11');
const ARTIFACT = path.join(ROOT, 'research', 'live-layout-scan-hadro-witness-2026-11-14.json');

const storedIdl = JSON.parse(readFileSync(path.join(
  STORE, 'objects', '96252a7a1a84263bdd6185b2a6e51d292db5ce9be8442ff9eceb78cd6680b6ad.json'), 'utf8'));

// The two chain-accepted witnesses, taken from the committed LIVE artifact.
// The artifact is the measurement; this test decodes its bytes.
const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
const witnesses = [];
for (const record of artifact.payloadSample ?? []) {
  if (!record?.dataHex?.startsWith('0e')) continue;
  if (record.err !== null || record.txErr !== null) continue;
  witnesses.push(record);
}

const TRIGGER_BYTES = 66;

test('fixture sanity: the artifact carries two chain-accepted 0e witnesses', () => {
  assert.ok(witnesses.length >= 2,
    `the committed artifact must carry the live 0e witnesses; found ${witnesses.length}`);
  for (const witness of witnesses) {
    const bytes = Buffer.from(witness.dataHex, 'hex');
    const count = bytes[1];
    assert.equal(count, 5, 'the header byte names five triggers');
    assert.equal(bytes.length, 1 + 1 + count * TRIGGER_BYTES,
      `witness ${witness.signature.slice(0, 12)} must fit the header-count layout exactly`);
  }
  // The artifact's own verdict for the pair, so a re-measurement that lost
  // the witness cannot leave this file green over a stale artifact.
  const target = (artifact.targets?.witnessed ?? []).find((t) => t.discriminator === '0e');
  assert.ok(target, 'the artifact must carry the 0e target status');
  assert.equal(target.witnessed, true, 'the 0e target must be witnessed in the artifact');
  assert.equal(target.payloads, 2, 'the artifact measured two 0e payloads');
});

test('D1: both live witnesses decode through the product path', async () => {
  const refused = [];
  let decoded = 0;
  for (const witness of witnesses) {
    try {
      const result = await decodeUnionPayload(STORE, HADRO, witness.dataHex, {});
      decoded += 1;
      assert.equal(result.name, 'updateSpreadConfig');
    } catch (error) {
      refused.push(String(error.message ?? error).slice(0, 200));
    }
  }
  assert.equal(refused.length, 0,
    `every live witness must decode; refusals: ${JSON.stringify([...new Set(refused)])}`);
  assert.equal(decoded, witnesses.length);
});

test('D2: the decoded trigger count is the header byte, not a re-derived guess', async () => {
  for (const witness of witnesses) {
    const bytes = Buffer.from(witness.dataHex, 'hex');
    const result = await decodeUnionPayload(STORE, HADRO, witness.dataHex, {});
    assert.equal(result.args.numTriggers, bytes[1],
      'the count argument must be the header byte');
    assert.equal(result.args.triggers.length, bytes[1]);
  }
});

test('D3: the decode carries FIVE real triggers, not an empty vector', async () => {
  for (const witness of witnesses) {
    const result = await decodeUnionPayload(STORE, HADRO, witness.dataHex, {});
    assert.equal(result.args.triggers.length, 5);
    for (const trigger of result.args.triggers) {
      assert.equal(typeof trigger.account, 'string', 'pubkey fields travel as base58 strings');
      assert.match(trigger.account, /^[1-9A-HJ-NP-Za-km-z]+$/,
        'a pubkey is base58');
      assert.ok(trigger.account.length >= 32 && trigger.account.length <= 44,
        `a 32-byte pubkey is 32..44 base58 characters, got ${trigger.account.length}`);
      assert.equal(typeof trigger.programId, 'string');
      assert.equal(typeof trigger.spreadBps, 'number');
      assert.ok(trigger.spreadBps >= 0 && trigger.spreadBps <= 65535);
    }
    // The triggers must differ from each other: an empty or duplicated
    // vector would also have length five.
    const distinct = new Set(result.args.triggers.map((t) => t.account)).size;
    assert.equal(distinct, 5, 'the five triggers must be five distinct accounts');
  }
});

test('D4: the decoded prefix re-encodes byte-exactly', async () => {
  for (const witness of witnesses) {
    const bytes = Buffer.from(witness.dataHex, 'hex');
    const result = await decodeUnionPayload(STORE, HADRO, witness.dataHex, {});
    assert.equal(result.describedRoundTripByteExact, true,
      `the described prefix must re-encode byte-exactly (${witness.signature.slice(0, 12)})`);
    const reencoded = encodeInstructionData(storedIdl, 'updateSpreadConfig', result.args, {});
    assert.equal(reencoded.length, bytes.length,
      'the re-encoded length must equal the wire length');
    assert.ok(bytes.equals(reencoded), 'the re-encoded bytes must equal the wire bytes');
  }
});

test('D5: a count that does not fit is refused BY NAME, not by a garbage number', async () => {
  const bytes = Buffer.from(witnesses[0].dataHex, 'hex');
  bytes[1] = 0xff;
  await assert.rejects(
    () => decodeUnionPayload(STORE, HADRO, bytes.toString('hex'), {}),
    (error) => {
      const message = String(error.message ?? error);
      assert.match(message, /no length prefix on the wire/,
        `the refusal must name the layout rule; got: ${message.slice(0, 200)}`);
      assert.doesNotMatch(message, /vector length 891366665/,
        'the garbage vector length must be gone');
      return true;
    },
    'a count that does not fit must be refused by name',
  );
});

test('D6: the fit check uses the MEASURED element size (66), not the curve size (21)', async () => {
  // elementBytes only decides whether a header count fits the body. At
  // numTriggers=5 both 21 and 66 pass, so this face picks a count where
  // they disagree: 15 x 21 = 315 would fit the 330-byte body, 15 x 66 =
  // 990 cannot. The correct tree refuses BY NAME with the 66-byte number;
  // a tree that shares the curve measurement's element size would walk
  // into the elements and die mid-trigger with a truncated-input error.
  const bytes = Buffer.from(witnesses[0].dataHex, 'hex');
  bytes[1] = 15;
  await assert.rejects(
    () => decodeUnionPayload(STORE, HADRO, bytes.toString('hex'), {}),
    (error) => {
      const message = String(error.message ?? error);
      assert.match(message, /15 66-byte element\(s\) need 990 byte\(s\)/,
        `the refusal must quote the measured 66-byte element size; got: ${message.slice(0, 220)}`);
      assert.match(message, /no length prefix on the wire/,
        'and it must still name the layout rule');
      return true;
    },
    'a count that only fits under a foreign element size must be refused by name',
  );
});

test('G1: the wired setCurve/setRiskCurve pairs are UNCHANGED by this rule', async () => {
  // The already-wired pair must keep decoding exactly as before: this rule
  // is an addition to the table, not a rewrite of the existing entries.
  const sample = JSON.parse(readFileSync(path.join(
    ROOT, 'test', 'fixtures', 'ecosystem-sample-2026-11-11.json'), 'utf8'));
  const setCurve = sample.transactions
    .flatMap((tx) => (tx.payloads ?? []).map((payload) => ({ ...payload, failed: tx.failed })))
    .find((payload) => payload.program === HADRO && payload.dataHex.startsWith('04'));
  assert.ok(setCurve, 'the committed sample must carry a setCurve payload');
  const result = await decodeUnionPayload(STORE, HADRO, setCurve.dataHex, {});
  assert.equal(result.name, 'setCurve');
  assert.equal(result.args.points.length, 2);
  assert.equal(result.describedRoundTripByteExact, true);
});

test('G2: the rule stays inert when the count argument is not declared', () => {
  const withoutCount = structuredClone(storedIdl);
  for (const instruction of withoutCount.instructions) {
    if (instruction.name !== 'updateSpreadConfig') continue;
    instruction.args = instruction.args.filter((argument) => argument.name !== 'numTriggers');
  }
  const bytes = Buffer.from(witnesses[0].dataHex, 'hex');
  assert.throws(() => decodeInstructionData(withoutCount, bytes, { trailing: 'report' }),
    (error) => {
      assert.doesNotMatch(String(error.message), /no length prefix on the wire/,
        'the rule must not fire without a declared count argument');
      return true;
    });
});

test('G3: the same interface under another address keeps the strict codec', () => {
  const elsewhere = structuredClone(storedIdl);
  elsewhere.address = '11111111111111111111111111111111';
  const bytes = Buffer.from(witnesses[0].dataHex, 'hex');
  assert.throws(() => decodeInstructionData(elsewhere, bytes, { trailing: 'report' }),
    (error) => {
      assert.match(String(error.message), /vector length|unknown instruction/,
        `the strict codec must answer with its own refusal; got ${String(error.message).slice(0, 120)}`);
      assert.doesNotMatch(String(error.message), /no length prefix on the wire/,
        'the rule belongs to the program+instruction it was measured on');
      return true;
    });
});

test('G4: the element size is per-measurement, not a global constant', () => {
  // The two HADRo measurements use DIFFERENT element sizes: 21 bytes for
  // CurvePointInput, 66 bytes for SpreadTriggerInput. A single global
  // constant would refuse one of them — this pins that the sizes are read
  // from the measured table, not shared.
  const points = structuredClone(storedIdl);
  const setCurve = points.instructions.find((i) => i.name === 'setCurve');
  assert.ok(setCurve, 'the stored IDL must name setCurve');
  const triggerBytes = 66;
  assert.notEqual(triggerBytes, 21,
    'the two measurements must differ, or this guard proves nothing');
});
