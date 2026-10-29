// Second-program coverage (Jupiter AMM v6) and the two defects it exposed.
//
// Both defects were found by running sememe's stored on-chain IDL against a
// SECOND real mainnet program, not by a synthetic case:
//
// 1. The vector pre-check sized an enum element by its LARGEST variant.
//    Jupiter's `Swap` enum has 204 variants; the widest one needs 85 bytes,
//    so every `route` payload was refused with "vector length 1 needs 85
//    byte(s) but 25 remain" — while the payload itself decodes byte-exact.
//    Measured: 342 of 773 payloads failed this way.
//
// 2. Anchor's `emit_cpi!` emits an instruction to the program itself whose
//    data is EVENT_IX_TAG_LE ++ event_discriminator ++ borsh(fields). Those
//    payloads arrive like instructions, so the decoder reported them as
//    "unknown instruction discriminator". Measured: 396 of 773 payloads.
//
// The fixtures below are real mainnet data (harvested 2026-10-29, slots
// 462867935..462867982) and are committed so both defects stay closed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  decodeData, decodeInstructionData, decodeEventData, encodeInstructionData,
  encodeEventData, eventIndex, isEventData, EVENT_IX_TAG_HEX, toJsonSafe, CodecError,
} from '../src/codec.mjs';

const JUP6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const idl = JSON.parse(
  await readFile(new URL('./fixtures/jupiter-amm-v6-idl.json', import.meta.url), 'utf8'));
const harvest = JSON.parse(
  await readFile(new URL('./fixtures/harvest-jupiter-amm-v6-2026-10-29.json', import.meta.url), 'utf8'));

function payloads() {
  const out = [];
  for (const tx of harvest.transactions) {
    if (tx.missing) continue;
    for (const payload of tx.payloads ?? []) out.push(payload);
  }
  return out;
}

test('the Jupiter fixture carries the pinned payloads it claims', () => {
  assert.equal(harvest.program, JUP6);
  assert.equal(payloads().length, 773);
  assert.ok(harvest.slotRange.oldest <= harvest.slotRange.newest);
});

test('every real Jupiter payload decodes and re-encodes byte-exact', () => {
  let instructions = 0;
  let events = 0;
  let trailing = 0;
  for (const payload of payloads()) {
    const bytes = Buffer.from(payload.dataHex, 'hex');
    const decoded = decodeData(idl, bytes, { trailing: 'report' });
    if (decoded.kind === 'instruction') {
      instructions++;
      assert.ok(
        encodeInstructionData(idl, decoded.instruction, decoded.args).equals(bytes),
        `instruction ${decoded.instruction} did not round-trip`);
    } else {
      events++;
      assert.ok(
        encodeEventData(idl, decoded.event, decoded.args, { tagged: decoded.tagged }).equals(bytes),
        `event ${decoded.event} did not round-trip`);
    }
    if (decoded.trailing.count > 0) trailing++;
  }
  assert.equal(instructions, 377);
  assert.equal(events, 396);
  assert.equal(trailing, 0, 'no Jupiter payload should carry unexplained bytes');
});

test('the enum sizing bug is closed: a vector of enum elements is not refused', () => {
  // The route payload that used to be rejected:
  // "route.route_plan: vector length 1 needs 85 byte(s) but 25 remain"
  const route = Buffer.from(
    'e517cb977ae3ad2a010000002f010064000100e57530010000007bc7090000000000000000', 'hex');
  const decoded = decodeInstructionData(idl, route, { trailing: 'report' });
  assert.equal(decoded.instruction, 'route');
  assert.equal(decoded.trailing.count, 0);
  assert.ok(encodeInstructionData(idl, decoded.instruction, decoded.args).equals(route));

  // The pre-check must still refuse a hostile length prefix: the guard exists
  // for a reason, it just has to use the SMALLEST variant as the bound.
  const hostile = Buffer.from(route);
  hostile.writeUInt32LE(0x7fffffff, 8);
  assert.throws(() => decodeInstructionData(idl, hostile), /vector length|exceeds limit/);
});

test('an Anchor event self-CPI decodes as an event, not as an unknown instruction', () => {
  // A real Jupiter SwapEvent self-CPI from the harvest.
  const sample = payloads().find((payload) =>
    payload.dataHex.startsWith(EVENT_IX_TAG_HEX) && payload.dataHex.slice(16, 32) === '40c6cde8260871e2');
  assert.ok(sample, 'expected a tagged SwapEvent payload in the fixture');
  const bytes = Buffer.from(sample.dataHex, 'hex');

  assert.throws(() => decodeInstructionData(idl, bytes), /unknown instruction discriminator/);
  assert.equal(isEventData(idl, bytes), true);

  const decoded = decodeEventData(idl, bytes, { trailing: 'report' });
  assert.equal(decoded.kind, 'event');
  assert.equal(decoded.event, 'SwapEvent');
  assert.equal(decoded.discriminator, '40c6cde8260871e2');
  assert.equal(decoded.tagged, true);
  assert.equal(decoded.trailing.count, 0);
  assert.ok(encodeEventData(idl, decoded.event, decoded.args, { tagged: true }).equals(bytes));

  // decodeData dispatches to the event path automatically.
  const viaData = decodeData(idl, bytes, { trailing: 'report' });
  assert.equal(viaData.kind, 'event');
  assert.equal(viaData.event, 'SwapEvent');
});

test('the event tag constant is Anchor\'s own, not a guess', () => {
  // anchor/lang/src/event.rs: EVENT_IX_TAG = 0x1d9acb512ea545e4
  assert.equal(EVENT_IX_TAG_HEX, 'e445a52e51cb9a1d');
  const bytes = Buffer.from(EVENT_IX_TAG_HEX, 'hex');
  assert.equal(bytes.readBigUInt64LE(), 0x1d9acb512ea545e4n);
});

test('the bare event-discriminator form decodes too (no CPI tag)', () => {
  const tagged = payloads().find((payload) => payload.dataHex.startsWith(EVENT_IX_TAG_HEX));
  const bytes = Buffer.from(tagged.dataHex, 'hex');
  const bare = bytes.subarray(8);
  const decoded = decodeEventData(idl, bare, { trailing: 'report' });
  assert.equal(decoded.tagged, false);
  assert.equal(decoded.event, decoded.event);
  assert.ok(encodeEventData(idl, decoded.event, decoded.args, { tagged: false }).equals(bare));
});

test('an unknown event discriminator is refused, not guessed', () => {
  // Tagged form: the tag alone says "this is an event CPI", so the guard
  // accepts it and the refusal happens inside the decoder, naming the
  // discriminator it could not resolve.
  const tagged = Buffer.concat([
    Buffer.from(EVENT_IX_TAG_HEX, 'hex'),
    Buffer.from('deadbeefdeadbeef', 'hex'),
    Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]),
  ]);
  assert.throws(() => decodeEventData(idl, tagged), /unknown event discriminator/);
  assert.equal(isEventData(idl, tagged), true);

  // Bare form: without the tag the only evidence is the discriminator itself,
  // so an unknown one is not an event at all.
  const bare = Buffer.concat([
    Buffer.from('deadbeefdeadbeef', 'hex'),
    Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]),
  ]);
  assert.equal(isEventData(idl, bare), false);
  assert.throws(() => decodeEventData(idl, bare), /unknown event discriminator/);
});

test('the event index has one entry per stored event and no duplicate disc', () => {
  const index = eventIndex(idl);
  assert.equal(index.size, 6);
  assert.ok(index.has('40c6cde8260871e2'));
  assert.throws(() => eventIndex({ events: [
    { name: 'a', discriminator: [1, 1, 1, 1, 1, 1, 1, 1] },
    { name: 'b', discriminator: [1, 1, 1, 1, 1, 1, 1, 1] },
  ] }), /duplicate event discriminator/);
});

test('decodeData prefers an instruction over an event on an ambiguous prefix', () => {
  // An instruction discriminator wins; the event path is only a fallback.
  const bogus = Buffer.from('ffffffffffffffff01000000', 'hex');
  assert.throws(() => decodeData(idl, bogus), /unknown instruction discriminator/);
});
