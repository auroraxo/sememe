// Count-from-header: a vector whose length the wire carries in a header
// field, not as a Borsh length prefix.
//
// THE DEFECT THIS FILE PINS (measured 2026-11-13, 13.11. PULS AD -> AE).
//
// HADRoNbLovyqhCsocfYQYB7QdfCAAinN9HTePvBCVDQ8 publishes an on-chain IDL
// whose `setCurve` / `setRiskCurve` instructions declare
//
//   setCurve     slot u8, side u8, defaultInterpolation u8, numPoints u8,
//                xMode u8, points vec<CurvePointInput>
//   setRiskCurve slot u8, side u8, defaultInterpolation u8, numPoints u8,
//                xMode u8, riskMode u8, points vec<CurvePointInput>
//
// A `vec` in that IDL means "a u32 Borsh length prefix, then the elements".
// The wire carries NO such prefix: the element count is the `numPoints`
// u8 the instruction ALREADY declares in its own header, and the bytes
// follow the header directly (measured: 1-byte discriminator + u8 header
// + numPoints x 21-byte CurvePointInput + an 8-byte tail the stored IDL
// does not declare).
//
// What the product did with that, measured on the committed 144 chain-
// ACCEPTED payloads (prefix face in research/hadro-count-from-header-
// 2026-11-13.json; the defect narrative lives in the two-tree measurement
// and in docs/measured-history.md):
//
//   * the 72 setRiskCurve payloads were REFUSED with a garbage number
//     ("vector length 1814753837 needs 38109830577 byte(s)") — the u32
//     prefix the product read was actually the first four bytes of the
//     first curve point;
//   * the 72 setCurve payloads were "decoded" with points: [] and 46
//     trailing bytes — an EMPTY curve, described, not decoded.
//
// So the product called 72 payloads decoded that it did not decode, and
// refused 72 it could have decoded. The layout is a LAYOUT fact, not a
// codec bug — but the layout was never spoken, so the codec read a
// prefix that is not there.
//
// THE RULE (src/wire-layout.mjs carries the measured table):
//   For a listed program+instruction, the vector argument named in the
//   table takes its element count from the declared count argument
//   (numPoints) and carries NO length prefix on the wire. The encoder
//   half writes the elements without a prefix. A count that does not fit
//   the remaining bytes is refused by NAME ("no length prefix on the
//   wire"), never by a garbage number.
//
// The rule is EVIDENCE-GATED, not a general "vec without prefix" guess:
//   * it applies only to the program+instruction pairs in the table;
//   * it applies only when the IDL itself declares the count argument
//     (an integer) BEFORE the vector argument;
//   * every other interface keeps the strict u32-prefix codec, byte for
//     byte (guards G1/G4 pin this).
//
// Faces (D = defect, red on the pre-fix tree; G = guard, green on both):
//   D1 all 144 committed payloads decode (0 refusals)
//   D2 setCurve decodes TWO REAL points (not an empty curve)
//   D3 setRiskCurve decodes the points the header count names
//   D4 the decoded prefix re-encodes byte-exactly (no silent garbage)
//   D5 the decoded count equals the header byte on the wire, 144/144
//   D6 a count that does not fit is refused BY NAME (the voice), and the
//      refusal no longer quotes a garbage vector length
//   G1 an unrelated program (Whirlpool) decodes unchanged
//   G2 the encoder half writes no prefix and refuses a count mismatch
//   G3 the rule stays inert for an interface that does not declare the
//      count argument
//   G4 the rule stays inert for the same shape under another address

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
const SAMPLE = path.join(ROOT, 'test', 'fixtures', 'ecosystem-sample-2026-11-11.json');
const STORE = path.join(ROOT, 'test', 'fixtures', 'ecosystem-store-2026-11-11');

const HEADER_BYTES = { setCurve: 5, setRiskCurve: 6 };
const POINT_BYTES = 21;

const sample = JSON.parse(readFileSync(SAMPLE, 'utf8'));
const payloads = [];
for (const tx of sample.transactions) {
  for (const payload of tx.payloads ?? []) {
    if (payload.program !== HADRO) continue;
    if (!payload.dataHex.startsWith('04') && !payload.dataHex.startsWith('08')) continue;
    payloads.push({
      hex: payload.dataHex,
      signature: tx.signature,
      slot: tx.slot,
      accepted: tx.failed === false,
      instruction: payload.dataHex.startsWith('04') ? 'setCurve' : 'setRiskCurve',
    });
  }
}

const storedIdl = JSON.parse(readFileSync(path.join(
  STORE, 'objects', '96252a7a1a84263bdd6185b2a6e51d292db5ce9be8442ff9eceb78cd6680b6ad.json'), 'utf8'));

test('fixture sanity: 144 chain-accepted payloads, 72 per instruction', () => {
  assert.equal(payloads.length, 144);
  assert.equal(payloads.filter((p) => p.instruction === 'setCurve').length, 72);
  assert.equal(payloads.filter((p) => p.instruction === 'setRiskCurve').length, 72);
  assert.equal(payloads.filter((p) => p.accepted).length, 144,
    'every committed payload is chain-accepted (failed:false)');
  // The wire layout itself: header + n x 21 bytes + an 8-byte tail.
  for (const payload of payloads) {
    const bytes = Buffer.from(payload.hex, 'hex');
    const head = HEADER_BYTES[payload.instruction];
    const count = bytes[4];
    assert.equal(bytes.length, 1 + head + count * POINT_BYTES + 8,
      `fixture sanity: ${payload.instruction} length ${bytes.length} must fit the header-count layout`);
  }
});

test('D1: all 144 committed payloads decode through the product path', async () => {
  let decoded = 0;
  const refused = [];
  for (const payload of payloads) {
    try {
      const result = await decodeUnionPayload(STORE, HADRO, payload.hex, {});
      decoded += 1;
      assert.ok(['setCurve', 'setRiskCurve'].includes(result.name),
        `unexpected instruction ${result.name}`);
    } catch (error) {
      refused.push(String(error.message ?? error).slice(0, 160));
    }
  }
  assert.equal(refused.length, 0,
    `every committed payload must decode; refusals: ${JSON.stringify([...new Set(refused)])}`);
  assert.equal(decoded, 144);
});

test('D2: setCurve decodes TWO REAL points, not an empty curve', async () => {
  const curves = payloads.filter((p) => p.instruction === 'setCurve');
  for (const payload of curves) {
    const result = await decodeUnionPayload(STORE, HADRO, payload.hex, {});
    assert.equal(result.args.points.length, 2,
      'the header count names two points and the decode must carry two');
    for (const point of result.args.points) {
      assert.equal(typeof point.amountIn, 'string', 'u64 fields travel as strings');
      assert.equal(point.params.length, 4, 'the [u8;4] params field is four bytes');
    }
  }
});

test('D3: setRiskCurve decodes exactly the points the header count names', async () => {
  const curves = payloads.filter((p) => p.instruction === 'setRiskCurve');
  const histogram = {};
  for (const payload of curves) {
    const bytes = Buffer.from(payload.hex, 'hex');
    const count = bytes[4];
    const result = await decodeUnionPayload(STORE, HADRO, payload.hex, {});
    assert.equal(result.args.points.length, count,
      'the decoded point count must equal the header count');
    histogram[count] = (histogram[count] ?? 0) + 1;
  }
  assert.deepEqual(histogram, { 2: 6, 3: 12, 5: 4, 6: 20, 7: 8, 8: 4, 14: 4, 15: 6, 16: 4, 18: 3, 19: 1 },
    'the measured histogram of header counts must hold');
});

test('D4: the decoded prefix re-encodes byte-exactly', async () => {
  for (const payload of payloads) {
    const result = await decodeUnionPayload(STORE, HADRO, payload.hex, {});
    assert.equal(result.describedRoundTripByteExact, true,
      `the described prefix must re-encode byte-exactly (${payload.instruction})`);
  }
});

test('D5: the decoded count equals the header byte on the wire, 144/144', async () => {
  for (const payload of payloads) {
    const bytes = Buffer.from(payload.hex, 'hex');
    const result = await decodeUnionPayload(STORE, HADRO, payload.hex, {});
    assert.equal(result.args.numPoints, bytes[4],
      'the count argument must be the header byte, not a re-derived guess');
    assert.equal(result.args.points.length, bytes[4]);
  }
});

test('D6: a count that does not fit is refused BY NAME, not by a garbage number', async () => {
  const payload = payloads.find((p) => p.instruction === 'setRiskCurve');
  const bytes = Buffer.from(payload.hex, 'hex');
  // Claim more points than the payload can carry.
  bytes[4] = 0xff;
  await assert.rejects(
    () => decodeUnionPayload(STORE, HADRO, bytes.toString('hex'), {}),
    (error) => {
      const message = String(error.message ?? error);
      assert.match(message, /no length prefix on the wire/,
        `the refusal must name the layout rule; got: ${message.slice(0, 200)}`);
      assert.doesNotMatch(message, /vector length 1814753837/,
        'the garbage vector length must be gone');
      return true;
    },
    'a count that does not fit must be refused by name',
  );
});

test('G1: an unrelated program decodes unchanged', async () => {
  // Whirlpool's swap_v2 is pinned by an existing test; the rule must not
  // touch an interface that declares no count argument for its vector.
  const whirlpoolId = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
  const whirlpoolPayload = sample.transactions
    .flatMap((tx) => (tx.payloads ?? []).map((payload) => ({ ...payload, accepted: tx.failed === false })))
    .find((payload) => payload.program === whirlpoolId && payload.accepted);
  assert.ok(whirlpoolPayload, 'the committed sample must carry a Whirlpool payload');
  const { decodePayload } = await import('../src/decode.mjs');
  const result = await decodePayload(STORE, whirlpoolId, whirlpoolPayload.dataHex, {});
  assert.equal(result.name, 'swap');
  assert.equal(result.roundTripByteExact, true,
    'an unrelated interface must keep its byte-exact decode');
});

test('G2: the encoder half writes no prefix and refuses a count mismatch', () => {
  const payload = payloads.find((p) => p.instruction === 'setCurve');
  const bytes = Buffer.from(payload.hex, 'hex');
  const decoded = decodeInstructionData(storedIdl, bytes, { trailing: 'report' });
  assert.equal(decoded.args.numPoints, 2);
  const reencoded = encodeInstructionData(storedIdl, 'setCurve', decoded.args, {});
  // No prefix: the re-encoded bytes are the described prefix, 4 bytes
  // SHORTER than a prefix-carrying encoding of the same elements would be.
  assert.ok(!reencoded.subarray(6, 10).equals(Buffer.from([2, 0, 0, 0])),
    'the encoder must not write a u32 length prefix');
  assert.equal(reencoded.length, 1 + 5 + 2 * POINT_BYTES);
  assert.ok(bytes.subarray(0, reencoded.length).equals(reencoded),
    'the re-encoded bytes must equal the wire prefix');
  // A count that disagrees with the elements is refused, not silently fixed.
  assert.throws(
    () => encodeInstructionData(storedIdl, 'setCurve', { ...decoded.args, numPoints: 3 }, {}),
    (error) => {
      assert.ok(error instanceof CodecError);
      assert.match(String(error.message), /numPoints/,
        'the refusal must name the count argument');
      return true;
    },
  );
});

test('G3: the rule stays inert when the interface does not declare the count argument', () => {
  const withoutCount = structuredClone(storedIdl);
  for (const instruction of withoutCount.instructions) {
    if (instruction.name !== 'setCurve' && instruction.name !== 'setRiskCurve') continue;
    instruction.args = instruction.args.filter((argument) => argument.name !== 'numPoints');
  }
  // The table is keyed to the on-chain copy it was measured on; keep that
  // identity and remove ONLY the declared count argument.
  assert.equal(withoutCount.metadata.name, 'hadron');
  const bytes = Buffer.from(payloads.find((p) => p.instruction === 'setRiskCurve').hex, 'hex');
  // Without the declared count there is no evidence for the rule, so the
  // strict u32-prefix codec answers — and it refuses these bytes.
  assert.throws(() => decodeInstructionData(withoutCount, bytes, { trailing: 'report' }),
    (error) => {
      assert.doesNotMatch(String(error.message), /no length prefix on the wire/,
        'the rule must not fire without a declared count argument');
      return true;
    });
});

test('G4: the same interface shape under another address keeps the strict codec', () => {
  const elsewhere = structuredClone(storedIdl);
  elsewhere.address = '11111111111111111111111111111111';
  // The other half of the address gate: the table's program at a shape the
  // table does not name must keep the strict codec too.
  const renamed = structuredClone(storedIdl);
  for (const instruction of renamed.instructions) {
    if (instruction.name === 'setRiskCurve') instruction.name = 'setWhateverElse';
  }
  const bytes = Buffer.from(payloads.find((p) => p.instruction === 'setRiskCurve').hex, 'hex');
  for (const idl of [elsewhere, renamed]) {
    assert.throws(() => decodeInstructionData(idl, bytes, { trailing: 'report' }),
      (error) => {
        assert.match(String(error.message), /vector length|unknown instruction/,
          `the strict codec must answer with its own refusal; got ${String(error.message).slice(0, 120)}`);
        assert.doesNotMatch(String(error.message), /no length prefix on the wire/,
          'the rule belongs to the program+instruction it was measured on');
        return true;
      });
  }
});
