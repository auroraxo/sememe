// cp-amm wire forms: the `swap` payloads that carry bytes past the published
// interface, and where they come from.
//
// Every number below is re-derived from the two committed harvest fixtures
// (2026-10-30 and 2026-11-02) and the committed cp-amm IDL. Nothing is asserted
// from a note. The RPC-attributed half of the finding lives in
// research/cp-amm-wire-forms-2026-11-02.json (fetched by
// tools/cp-amm-wire-forms.mjs); the counts this file pins are the same ones
// that tool selects from, so the two cannot drift apart silently.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decodeData, encodeInstructionData } from '../src/codec.mjs';

const idl = JSON.parse(fs.readFileSync(new URL('./fixtures/cp-amm-idl.json', import.meta.url), 'utf8'));
const windows = [
  ['2026-10-30', JSON.parse(fs.readFileSync(new URL('./fixtures/harvest-cp-amm-2026-10-30.json', import.meta.url), 'utf8'))],
  ['2026-11-02', JSON.parse(fs.readFileSync(new URL('./fixtures/harvest-cp-amm-2026-11-02.json', import.meta.url), 'utf8'))],
];
const REPORT_PATH = new URL('../research/cp-amm-wire-forms-2026-11-02.json', import.meta.url);

const SWAP_DISC = Buffer.from(idl.instructions.find(i => i.name === 'swap').discriminator).toString('hex');
const DECLARED_LEN = 24; // 8-byte discriminator + SwapParameters {u64, u64}

function swapPayloads(harvest) {
  const out = [];
  for (const tx of harvest.transactions) {
    for (const p of (tx.payloads ?? [])) {
      if (!p.dataHex.startsWith(SWAP_DISC)) continue;
      out.push({ tx, p, bytes: Buffer.from(p.dataHex, 'hex') });
    }
  }
  return out;
}

const byWindow = windows.map(([label, harvest]) => [label, swapPayloads(harvest)]);

test('the interface declares one wire form; the chain carries three', () => {
  const swap = idl.instructions.find(i => i.name === 'swap');
  assert.equal(swap.args.length, 1);
  assert.equal(swap.args[0].type.defined.name, 'SwapParameters');
  const params = idl.types.find(t => t.name === 'SwapParameters');
  assert.deepEqual(params.type.fields.map(f => f.name), ['amount_in', 'minimum_amount_out']);
  // 8-byte discriminator + 2 x u64 = 24 bytes, the only length the interface
  // can describe.
  assert.equal(DECLARED_LEN, 8 + 8 + 8);
});

test('the observed wire-length set is exactly {24, 25, 32} / {24, 25}', () => {
  // Completeness assertion for this finding: if a future harvest sees a new
  // length, the finding must go red and be re-derived, not silently widen.
  const expected = { '2026-10-30': [24, 25, 32], '2026-11-02': [24, 25] };
  for (const [label, rows] of byWindow) {
    const lengths = [...new Set(rows.map(r => r.bytes.length))].sort((a, b) => a - b);
    assert.deepEqual(lengths, expected[label]);
  }
});

test('both windows carry the wide form, with the same trailing shape', () => {
  const perWindow = {};
  for (const [label, rows] of byWindow) {
    const wide = [];
    let exact = 0;
    for (const r of rows) {
      const d = decodeData(idl, r.bytes, { trailing: 'report' });
      assert.equal(d.instruction, 'swap');
      assert.equal(d.kind, 'instruction');
      if (d.trailing.count === 0) { exact++; continue; }
      wide.push({ ...r, d });
    }
    perWindow[label] = { total: rows.length, exact, wide: wide.length };
    assert.ok(wide.length > 0, `${label}: the wide form exists`);
    // Every wide payload's trailing bytes are ZERO: the extra length is not
    // carrying information, it is padding beyond the declared struct.
    for (const w of wide) {
      assert.equal(w.d.trailing.hex, '00'.repeat(w.d.trailing.count), `${label}: trailing bytes are zero`);
    }
  }
  assert.equal(perWindow['2026-10-30'].exact, 477);
  assert.equal(perWindow['2026-10-30'].wide, 6);
  assert.equal(perWindow['2026-11-02'].exact, 284);
  assert.equal(perWindow['2026-11-02'].wide, 3);
});

test('every wide payload was accepted on-chain', () => {
  for (const [, rows] of byWindow) {
    for (const r of rows) {
      const d = decodeData(idl, r.bytes, { trailing: 'report' });
      if (d.trailing.count === 0) continue;
      assert.equal(r.tx.txErr, null, 'the program accepted the payload it does not describe');
    }
  }
});

test('the 25-byte body is byte-identical to a swap2 body with swap_mode=0', () => {
  // Structural claim, not a coincidence: the wide form is the SwapParameters2
  // layout (u64, u64, u8) carried under the `swap` discriminator.
  let checked = 0;
  for (const [, rows] of byWindow) {
    for (const r of rows) {
      if (r.bytes.length !== 25) continue;
      const d = decodeData(idl, r.bytes, { trailing: 'report' });
      const asSwap2 = encodeInstructionData(idl, 'swap2', {
        _params: {
          amount_0: d.args._params.amount_in,
          amount_1: d.args._params.minimum_amount_out,
          swap_mode: 0,
        },
      });
      assert.equal(asSwap2.length, 25);
      assert.ok(asSwap2.subarray(8).equals(r.bytes.subarray(8)), 'the 25-byte body is a swap2 body');
      // and the trailing byte is exactly the swap_mode the swap2 layout would
      // carry for an exact-in swap
      assert.equal(r.bytes[24], 0);
      checked++;
    }
  }
  assert.ok(checked >= 6, `checked ${checked} 25-byte payloads`);
});

test('the committed report agrees with the fixtures (no silent drift)', () => {
  const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
  let wide = 0;
  let exact = 0;
  for (const [, rows] of byWindow) {
    for (const r of rows) {
      const d = decodeData(idl, r.bytes, { trailing: 'report' });
      if (d.trailing.count === 0) exact++; else wide++;
    }
  }
  assert.equal(report.selection.swapPayloads, wide + exact);
  assert.equal(report.selection.wide, wide);
  assert.equal(report.rpc.failures, 0, 'the attributed run had no failed fetch');
});
