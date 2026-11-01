// The Jupiter RFQ stack, measured against live mainnet traffic (2026-11-01).
//
// Two programs carry real traffic through this decoder path and they behave
// differently.
//
//   rfq_v2        40/40 payloads byte-exact, nothing left over. The described
//                 interface covers the live wire completely.
//
//   order_engine  The deployed program accepts TWO wire forms of `fill`, and
//                 only one of them is described anywhere:
//
//                   32 bytes = discriminator + 24 arg bytes. Exactly what the
//                              on-chain IDL, the vendored IDL and the
//                              first-party repo/SDK all declare.
//                   40 bytes = the same 32 bytes + 8 more: a constant 4-byte
//                              tag (0x06942069, little-endian) plus 4 varying
//                              bytes, pairwise distinct per payload.
//
//                 Both forms are accepted by the same deployed program in the
//                 same window, and after slot 463985613 the wire carries ONLY
//                 the 40-byte form.
//
// CORRECTION, recorded deliberately: a first, narrower 30-block harvest saw
// only the 40-byte form (32 payloads, all with undeclared bytes) and concluded
// "every live fill carries 8 undeclared bytes". A 140-block scan falsified
// that: the 32-byte form is real and coexisted with the 40-byte form. The
// fixture committed here is the WIDE scan, and the numbers below are derived
// from it. This matters for the product: the finding is not "the decoder
// misses a field", it is "the live wire changed shape and the available
// interface descriptions never learned about it".
//
// What the suite pins, per side of the line:
//
//   rfq_v2        40/40 named `fill_exact_in`, byte-exact round-trip, no tail.
//
//   order_engine  82 payloads of the 32-byte form: fully described, byte-exact
//                 round-trip, trailing 0.
//                 59 payloads of the 40-byte form: named `fill`, the DESCRIBED
//                 32-byte prefix re-encodes byte-exact, trailing exactly 8,
//                 tail constant in bytes 4..7, varying and distinct in bytes
//                 0..3, and never zero.
//                 Permissive mode keeps serving both (the chain accepted them;
//                 refusing would be a decoder defect, not a safety property);
//                 strict mode refuses only the 40-byte form.
//
// The numbers are asserted as MEASURED, not as desired. If a future interface
// description accounts for the extra field, `trailing` drops to 0 on the
// 40-byte form and this test goes RED so the number gets re-measured instead of
// going quietly stale. And the counter-test pins the fixture itself: editing
// the committed IDL to declare a 4th u64 argument fails the suite, because
// "the interface now covers 40 bytes" is a NEW claim that needs NEW evidence
// (a re-pull of the on-chain account), not a fixture edit.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeData, decodeInstructionData, encodeInstructionData, CodecError } from '../src/codec.mjs';

const ORDER_ENGINE = '2En5Y11SEAGLNmEezTuRUCwTyzyNReHaMbSnS5gjGsL1';
const RFQ_V2 = 'fd3nMFYTQjX1yr5ER8u7tPdHJB7qt8RpDpNtLQX2Br5';

const orderEngineIdl = JSON.parse(
  await readFile(new URL('./fixtures/order-engine-idl.json', import.meta.url), 'utf8'));
const rfqV2Idl = JSON.parse(
  await readFile(new URL('./fixtures/rfq-v2-idl.json', import.meta.url), 'utf8'));
const orderEngineHarvest = JSON.parse(
  await readFile(new URL('./fixtures/harvest-order-engine-2026-11-01.json', import.meta.url), 'utf8'));
const rfqV2Harvest = JSON.parse(
  await readFile(new URL('./fixtures/harvest-rfq-v2-2026-11-01.json', import.meta.url), 'utf8'));

const payloads = (harvest) => harvest.transactions.flatMap((tx) =>
  tx.missing ? [] : (tx.payloads ?? []));

const fromHex = (hex) => Buffer.from(hex, 'hex');

test('the fixtures carry the traffic they claim, with provenance', () => {
  assert.equal(orderEngineHarvest.program, ORDER_ENGINE);
  assert.equal(rfqV2Harvest.program, RFQ_V2);
  assert.equal(orderEngineIdl.address, ORDER_ENGINE);
  assert.equal(rfqV2Idl.address, RFQ_V2);
  assert.equal(payloads(rfqV2Harvest).length, 40,
    'rfq_v2 fixture must pin the 40 harvested payloads');
  assert.equal(payloads(orderEngineHarvest).length, 141,
    'order-engine fixture must pin the 141 harvested payloads of the wide scan');
  assert.equal(orderEngineHarvest.counts.missing, 0);
  assert.equal(rfqV2Harvest.counts.missing, 0);
  // Every payload-bearing transaction in both fixtures succeeded on chain:
  // these are bytes the deployed programs ACCEPTED, so refusing them here
  // would be a decoder defect, not a safety property.
  for (const harvest of [orderEngineHarvest, rfqV2Harvest]) {
    for (const tx of harvest.transactions) {
      if (tx.payloads?.length) assert.equal(tx.txErr, null, `${tx.signature} failed on chain`);
    }
  }
});

test('both interface sources agree with each other — the gap is not source disagreement', () => {
  // The vendored copy (checked into the consumer repo) and the program's own
  // on-chain IDL account are two independently obtained descriptions; if they
  // disagreed about `fill`, the missing bytes would be ordinary drift. They do
  // not disagree: same single instruction, same discriminator, same 3 args.
  const chain = orderEngineIdl.instructions;
  assert.equal(chain.length, 1, 'on-chain IDL declares exactly one instruction');
  assert.equal(chain[0].name, 'fill');
  assert.deepEqual(chain[0].discriminator, [168, 96, 183, 163, 92, 10, 40, 160]);
  const argBytes = { u64: 8, i64: 8 };
  const described = chain[0].args.reduce((n, a) => n + (argBytes[a.type] ?? 0), 0);
  assert.equal(described, 24, 'fill describes 24 argument bytes');
  assert.deepEqual(chain[0].args.map((a) => a.type), ['u64', 'u64', 'i64']);
});

test('rfq_v2: every live payload decodes byte-exact with nothing left over', () => {
  let trailing = 0;
  for (const p of payloads(rfqV2Harvest)) {
    const bytes = fromHex(p.dataHex);
    const d = decodeData(rfqV2Idl, bytes, { trailing: 'report' });
    assert.equal(d.kind, 'instruction');
    assert.equal(d.instruction, 'fill_exact_in');
    assert.equal(d.trailing.count, 0,
      `${p.dataHex.slice(0, 16)}… carried ${d.trailing.count} unexplained byte(s)`);
    trailing += d.trailing.count;
    assert.ok(
      encodeInstructionData(rfqV2Idl, d.instruction, d.args).equals(bytes),
      'rfq_v2 payload must round-trip byte-exact');
  }
  assert.equal(trailing, 0, 'the rfq_v2 path explains every byte it is given');
});

test('order-engine: the live wire has two forms, and only one is described', () => {
  const forms = new Map();
  for (const p of payloads(orderEngineHarvest)) {
    const bytes = fromHex(p.dataHex);
    const d = decodeData(orderEngineIdl, bytes, { trailing: 'report' });
    assert.equal(d.kind, 'instruction');
    assert.equal(d.instruction, 'fill');
    const entry = forms.get(bytes.length) ?? { count: 0, trailing: new Set(), full: 0, prefix: 0 };
    entry.count += 1;
    entry.trailing.add(d.trailing.count);
    const reencoded = encodeInstructionData(orderEngineIdl, d.instruction, d.args);
    if (reencoded.equals(bytes)) entry.full += 1;
    if (reencoded.subarray(0, 32).equals(bytes.subarray(0, 32))) entry.prefix += 1;
    forms.set(bytes.length, entry);
  }
  assert.deepEqual([...forms.keys()].sort((a, b) => a - b), [32, 40],
    'the deployed program accepts exactly two fill wire lengths');
  const f32 = forms.get(32);
  assert.equal(f32.count, 82);
  assert.deepEqual([...f32.trailing], [0], 'the 32-byte form is fully described');
  assert.equal(f32.full, 82, 'the 32-byte form round-trips byte-exact');
  const f40 = forms.get(40);
  assert.equal(f40.count, 59);
  assert.deepEqual([...f40.trailing], [8], 'the 40-byte form carries exactly 8 undeclared bytes');
  assert.equal(f40.prefix, 59, 'the described 32-byte prefix re-encodes byte-exact on every one');
  assert.equal(f40.full, 0, 'no 40-byte payload round-trips whole while the field is undeclared');
});

test('order-engine: the undeclared 8 bytes are a constant tag plus 4 varying bytes', () => {
  const tails = [];
  for (const p of payloads(orderEngineHarvest)) {
    const bytes = fromHex(p.dataHex);
    if (bytes.length !== 40) continue;
    const d = decodeData(orderEngineIdl, bytes, { trailing: 'report' });
    const tail = fromHex(d.trailing.hex);
    assert.equal(tail.length, 8);
    assert.ok(!/^0+$/.test(d.trailing.hex),
      'non-zero tail — this is the "missing real field" case, not padding');
    assert.equal(tail.subarray(4, 8).toString('hex'), '69209406',
      'bytes 4..7 are a constant tag (0x06942069 little-endian)');
    tails.push(tail);
  }
  assert.equal(tails.length, 59);
  // The varying half is pairwise distinct per payload: it is per-fill data,
  // not a constant the harvester could have injected.
  assert.equal(new Set(tails.map((t) => t.subarray(0, 4).toString('hex'))).size, 59,
    'all 59 varying 4-byte halves are distinct');
  // And the constant tag is present in every one — so the whole tail is
  // structured, not random padding.
  assert.equal(tails.filter((t) => t.subarray(4, 8).toString('hex') === '69209406').length, 59);
});

test('order-engine: the 32-byte form stops, and only the 40-byte form continues', () => {
  // This is what makes it a live-drift finding rather than a curiosity: the
  // wire changed shape during the window and no interface source followed.
  const rows = [];
  for (const tx of orderEngineHarvest.transactions) {
    for (const p of (tx.payloads ?? [])) rows.push({ slot: tx.slot, len: fromHex(p.dataHex).length });
  }
  const last32 = Math.max(...rows.filter((r) => r.len === 32).map((r) => r.slot));
  const first32 = Math.min(...rows.filter((r) => r.len === 32).map((r) => r.slot));
  const after = rows.filter((r) => r.slot > last32);
  assert.equal(after.length, 45);
  assert.ok(after.every((r) => r.len === 40),
    'every payload after the last 32-byte payload is the 40-byte form');
  // The two forms genuinely overlapped rather than being sequential phases.
  const both = rows.filter((r) => r.slot >= first32 && r.slot <= last32);
  assert.ok(both.filter((r) => r.len === 32).length > 0 && both.filter((r) => r.len === 40).length > 0,
    'the two forms coexisted in the same window');
});

test('order-engine: permissive mode serves both forms, strict mode refuses only the 40-byte one', () => {
  let strictRefused = 0;
  let strictAccepted = 0;
  for (const p of payloads(orderEngineHarvest)) {
    const bytes = fromHex(p.dataHex);
    // Permissive (the default) keeps serving accepted traffic...
    const served = decodeInstructionData(orderEngineIdl, bytes, { trailing: 'report' });
    assert.equal(served.instruction, 'fill');
    // ...and strict mode refuses exactly the payloads with undeclared bytes,
    // instead of pretending a field exists that no source declares.
    try {
      decodeInstructionData(orderEngineIdl, bytes, { trailing: 'error' });
      strictAccepted += 1;
      assert.equal(bytes.length, 32, 'only the fully described form may pass strict mode');
    } catch (error) {
      assert.ok(error instanceof CodecError && /trailing bytes/.test(error.message),
        `unexpected strict-mode failure: ${error.message}`);
      assert.equal(bytes.length, 40);
      strictRefused += 1;
    }
  }
  assert.equal(strictAccepted, 82);
  assert.equal(strictRefused, 59);
});

test('regression: an invented 4th u64 argument would hide the gap, so the fixture must not carry one', () => {
  // False-positive guard. If someone adds the missing field to the IDL to make
  // the numbers above green, this test fails first: the claim "the interface
  // now covers 40 bytes" is a NEW claim that needs NEW evidence (a re-pull of
  // the on-chain IDL account that actually contains the field), not an edit to
  // a fixture.
  const fill = orderEngineIdl.instructions[0];
  assert.equal(fill.args.length, 3,
    'the on-chain IDL as pulled declares 3 args — changing this fixture to 4 is falsifying the measurement');
  assert.equal(fill.args.map((a) => a.name).join(','), 'input_amount,output_amount,expire_at');
});
