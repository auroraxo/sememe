// Test that the newly measured 2026-11-04 chain-executed short wire forms
// decode under the evidence-gated `absent: 'verified'` policy, and that
// unwitnessed payloads ending on a field boundary stay refused.
//
// Falsification ladder:
//   Pre-fix tree: the 3 new short forms refuse under `verified` because
//                 src/short-forms.mjs only knows the 2026-11-03 witnesses.
//   Post-fix tree: all 3 decode, name the absent fields, and round-trip byte-exactly.
//   Guards on both: strict default refuses them; unwitnessed truncations refuse.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  decodeUnionPayload, VERIFIED_SHORT_FORMS, verifiedShortForm,
} from '../src/decode.mjs';

const STORE = 'test/fixtures/traffic-sample-store-2026-11-04';
const REPORT = new URL('../research/short-form-wire-forms-2026-11-04.json', import.meta.url);
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

const NEW_FORMS = [
  {
    program: PUMP,
    discriminator: '66063d1201daebea',
    bytes: 24,
    instruction: 'buy',
    absent: ['track_volume'],
    witnessHex: '66063d1201daebeaee8e43864f00000041787d0100000000',
  },
  {
    program: PUMP,
    discriminator: '38fc74089edfcd5f',
    bytes: 24,
    instruction: 'buy_exact_sol_in',
    absent: ['track_volume'],
    witnessHex: '38fc74089edfcd5f002a75150000000092fd9e3ea9010000',
  },
  {
    program: PUMP,
    discriminator: 'd6904cec5f8b31b4',
    bytes: 146,
    instruction: 'create_v2',
    absent: ['is_cashback_enabled', 'creator_fee_bps', 'is_holder_reward'],
    witnessHex: 'd6904cec5f8b31b4080000004d4f4f4e52494445050000004d524944455000000068747470733a2f2f697066732e696f2f697066732f6261666b726569637778687571693466676d6e75736d75737277646735346a373434716d65636f6670656f767a6565716833726d78336362646c34ee474ee89b38324155723a91124d22f72a54633cf2afe26b295fc7b84f16de1801',
  },
];

test('2026-11-04 report measured 7 chain-executed short-form groups with 0 genuine refusals', async () => {
  const report = JSON.parse(await readFile(REPORT, 'utf8'));
  assert.equal(report.shortForms.length, 7, '7 short-form groups were measured on the 32-block window');
  assert.deepEqual(report.genuineRefusals, [], '0 genuine chain-rejected refusals in the sample');
  assert.equal(report.coverage.refusedPayloadsExecutedByChain, 350);
  assert.equal(report.coverage.refusalsNotExecutedByChain, 0);
});

test('every newly witnessed 2026-11-04 short form decodes with absent:verified', async () => {
  for (const form of NEW_FORMS) {
    const entry = verifiedShortForm(form.program, Buffer.from(form.witnessHex, 'hex'));
    assert.ok(entry, `VERIFIED_SHORT_FORMS must cover ${form.instruction} (${form.bytes}B)`);
    assert.equal(entry.instruction, form.instruction);
    assert.deepEqual(entry.absent, form.absent);

    const result = await decodeUnionPayload(STORE, form.program, form.witnessHex, { absent: 'verified' });
    assert.equal(result.name, form.instruction);
    assert.deepEqual(result.absent, form.absent);
    assert.equal(result.roundTripByteExact, true);
    assert.equal(result.shortForm.verified, true);
  }
});

test('false-positive guard: unwitnessed truncations stay refused under verified policy', async () => {
  // A 16-byte truncation of the 24-byte buy payload ends on a field boundary
  // and would decode under loose `absent: 'report'`, but MUST be refused under `verified`.
  const truncated = Buffer.from(NEW_FORMS[0].witnessHex, 'hex').subarray(0, 16);
  assert.equal(verifiedShortForm(PUMP, truncated), null, '16-byte form has no witness');
  await assert.rejects(
    () => decodeUnionPayload(STORE, PUMP, truncated.toString('hex'), { absent: 'verified' }),
    (error) => {
      assert.match(error.message, /refuse|truncated input|unknown instruction discriminator/);
      return true;
    },
    'unwitnessed 16B truncation must stay refused under verified');
});

test('false-positive guard: strict default still refuses the new short forms', async () => {
  for (const form of NEW_FORMS) {
    await assert.rejects(
      () => decodeUnionPayload(STORE, form.program, form.witnessHex),
      (error) => {
        assert.match(error.message, /refuse|truncated input|unknown instruction discriminator/);
        return true;
      },
      `${form.instruction} must be refused by default`);
  }
});
