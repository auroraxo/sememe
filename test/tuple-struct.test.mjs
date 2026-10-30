// Tuple structs: a real pump.fun payload, and the codec defect it exposed.
//
// Anchor IDLs describe a Rust tuple struct (`pub struct OptionBool(pub bool)`) as
// `{"name":"OptionBool","type":{"fields":["bool"],"kind":"struct"}}` — the fields
// array holds bare TYPES, not {name,type} pairs. sememe's struct branch demanded
// a `name` on every field entry and threw `OptionBool: malformed struct field`,
// so every instruction carrying an OptionBool refused to decode.
//
// This is not synthetic: pump.fun's `buy` is `amount u64, max_sol_cost u64,
// track_volume OptionBool` and the harvested mainnet traffic hit the defect on
// 145 of 996 payloads (on-chain IDL) / 145 of 996 (published IDL) before the fix.
// The payload below is a real mainnet `buy`, slot 463380817, and it is 25 bytes:
// 8 discriminator + 8 + 8 + ONE byte, because a tuple struct carries no variant tag.
//
// The decoded shape follows Anchor's own borsh coder (@coral-xyz/anchor 0.31.0
// decodes this same payload to {"0": false}): positional string keys, not an
// array, not an unwrapped bool. Decoding to anything else would agree with
// sememe and disagree with the reference implementation.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  decodeData, encodeInstructionData, toJsonSafe, CodecError,
} from '../src/codec.mjs';

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const idl = JSON.parse(
  await readFile(new URL('./fixtures/pump-idl.json', import.meta.url), 'utf8'));

// Real mainnet buy: signature 4yxLNCem...EEDAq, slot 463380817, inner ix of a caller.
const BUY_HEX = '66063d1201daebeaeb2f41b196080000441f68030000000000';

test('the fixture carries the program it claims', () => {
  assert.equal(idl.address, PUMP);
  const optionBool = idl.types.find((t) => t.name === 'OptionBool');
  assert.ok(optionBool, 'OptionBool type missing from fixture');
  assert.deepEqual(optionBool.type.fields, ['bool'],
    'fixture no longer carries the tuple-struct shape this test exists for');
});

test('a real mainnet buy carrying a tuple struct decodes and round-trips byte-exact', () => {
  const bytes = Buffer.from(BUY_HEX, 'hex');
  const decoded = decodeData(idl, bytes, { trailing: 'report' });
  assert.equal(decoded.kind, 'instruction');
  assert.equal(decoded.instruction, 'buy');
  assert.deepEqual(toJsonSafe(decoded.args), {
    amount: '9443311955947',
    max_sol_cost: '57155396',
    track_volume: { 0: false },
  });
  // Independent oracle: @coral-xyz/anchor 0.31.0 decodes this same payload to
  // amount 0x0896b1412feb = 9443311955947, max_sol_cost 0x03681f44 = 57155396,
  // track_volume {"0": false} — same bytes, same numbers, positional tuple key.
  assert.equal(decoded.trailing.count, 0, 'payload must be fully described');
  assert.ok(
    encodeInstructionData(idl, decoded.instruction, decoded.args).equals(bytes),
    're-encoded bytes must be identical');
});

test('the tuple byte is consumed once, not as a variant tag', () => {
  const bytes = Buffer.from(BUY_HEX, 'hex');
  // 8 disc + 8 amount + 8 max_sol_cost + 1 tuple field = 25, exactly the payload.
  const decoded = decodeData(idl, bytes, { trailing: 'report' });
  assert.equal(decoded.total, 25);
  assert.equal(decoded.consumed, 25);
  assert.equal(bytes.length, 25);
  // A one-byte-too-short payload must fail, not silently decode as false.
  assert.throws(
    () => decodeData(idl, bytes.subarray(0, 24), { trailing: 'report' }),
    (e) => e instanceof CodecError);
});

test('encode rejects a wrong tuple shape instead of guessing', () => {
  const bytes = Buffer.from(BUY_HEX, 'hex');
  const decoded = decodeData(idl, bytes, { trailing: 'report' });
  // wrong shape: bare bool (some readers unwrap single-field tuple structs)
  assert.throws(
    () => encodeInstructionData(idl, 'buy', { ...decoded.args, track_volume: false }),
    (e) => e instanceof CodecError);
  // wrong position inside the tuple: the shape is accepted but the BYTES differ,
  // which is why the recipe-level check is byte-identity, not shape validity.
  const flipped = encodeInstructionData(idl, 'buy', { ...decoded.args, track_volume: { 0: true } });
  assert.equal(flipped.length, bytes.length);
  assert.ok(!flipped.equals(bytes), 'flipping the tuple byte must change the encoding');
});
