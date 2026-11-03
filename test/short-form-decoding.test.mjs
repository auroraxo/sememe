// Short-form decoding: the product can NAME a wire form the stored interface
// over-describes, but only where chain evidence covers it.
//
// The measurement that motivates this file (research/short-form-wire-forms-2026-11-03.json)
// found 171 of 172 refusals in the unbiased mainnet sample to be chain-ACCEPTED
// payloads whose interface declares one field MORE than the wire carries:
//   buy_exact_quote_in_v3  e1f7501ed5b38488  24 bytes  absent partial_fill  (152)
//   buy_exact_quote_in     c62e1552b4d9e870  24 bytes  absent track_volume  (17)
//   buy_v3                 07051dc4f5176550  24 bytes  absent partial_fill  (1)
//   buy                    66063d1201daebea  24 bytes  absent track_volume  (1)
//   0 were genuine chain-rejected refusals.
//
// These tests pin the PRODUCT behaviour that turns that measurement into
// coverage, and — just as important — the boundary it must NOT cross.
//
// The boundary is the whole point. Byte-exact re-encoding is NOT evidence that
// a field was absent: a payload cut short by a capture bug also ends on a field
// boundary and also re-encodes exactly to the shortened bytes. So the default
// stays strict, and the opt-in comes in two flavours:
//   'report'   any payload that ends on a field boundary may decode (caller risk)
//   'verified' only shapes with a chain witness may decode; everything else refuses
//
// A test that only checked "the four forms decode" would pass just as well with
// a blanket 'report' policy, so the negative cases below are the load-bearing
// ones: the fabricated boundary-aligned truncation MUST refuse under 'verified'.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  decodePayload, decodeUnionPayload, VERIFIED_SHORT_FORMS,
} from '../src/decode.mjs';
import {
  describeShortForm, assertShortFormEvidence, resolveAbsentPolicy, verifiedShortForm,
} from '../src/short-forms.mjs';
import { decodeInstructionData } from '../src/codec.mjs';
import { findStoredIdls } from '../src/decode.mjs';

const STORE = 'test/fixtures/traffic-sample-store';
const REPORT = new URL('../research/short-form-wire-forms-2026-11-03.json', import.meta.url);
const COVERAGE = new URL('../research/short-form-coverage-2026-11-03.json', import.meta.url);

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMPSWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

/** The chain-accepted witness payload for a shape, taken from the report. */
async function witnessPayload(discriminator, bytes) {
  const report = JSON.parse(await readFile(REPORT, 'utf8'));
  const row = report.rows.find((r) => r.discriminator === discriminator && r.wireBytes === bytes);
  assert.ok(row, `the report has a row for ${discriminator}/${bytes}`);
  const witness = row.witnesses.find((w) => w.accepted) ?? row.witnesses[0];
  const instruction = witness.instructions.find((i) => i.hex?.startsWith(discriminator));
  assert.ok(instruction, `a witness carries the ${discriminator} payload`);
  return instruction.hex;
}

test('the verified table is exactly what the chain measurement found', async () => {
  const report = JSON.parse(await readFile(REPORT, 'utf8'));
  assert.deepEqual(report.genuineRefusals, [],
    'the measurement found no genuine chain-rejected refusal in the sample');
  assert.equal(report.coverage.refusedPayloadsExecutedByChain, 171);
  assert.equal(report.coverage.refusals, 172, '172 refusals were the whole measured gap');
  assert.equal(report.coverage.refusalsNotExecutedByChain, 0);

  // Every entry in the product table corresponds to a measured, chain-executed
  // short form — and every measured short form is in the table. A table with
  // an extra entry would be a claim nobody witnessed; a missing one would be
  // coverage left on the table.
  const measured = new Map();
  for (const row of report.rows) {
    if (row.sememeOutcome !== 'refused' || !row.chainExecuted) continue;
    if (row.wireBytes === 25) continue; // the fully-described 25-byte form
    measured.set(`${row.program}|${row.discriminator}|${row.wireBytes}`, row);
  }
  // The report's own shortForms list is the cross-check: it must hold the same
  // four shapes the row scan finds.
  assert.equal(report.shortForms.length, 4, 'the report lists four short forms');
  for (const form of report.shortForms) {
    const key = `${form.program}|${form.discriminator}|${form.wireBytes}`;
    assert.ok(measured.has(key), `the report's shortForms entry ${key} appears in the rows`);
  }
  assert.equal(measured.size, 4, 'four distinct short wire forms were measured');
  assert.equal(VERIFIED_SHORT_FORMS.length, measured.size,
    'the product table holds exactly the measured short forms');

  for (const form of VERIFIED_SHORT_FORMS) {
    const key = `${form.program}|${form.discriminator}|${form.bytes}`;
    const row = measured.get(key);
    assert.ok(row, `the table entry ${key} was measured`);
    assert.equal(row.instructionName, form.instruction, 'the instruction name matches the witness log line');
    assert.equal(row.payloads, form.witnesses, 'the witness count matches the measured payload count');
  }
});

test('every verified short form decodes, names its absent field, and round-trips byte-exactly', async () => {
  for (const form of VERIFIED_SHORT_FORMS) {
    const hex = await witnessPayload(form.discriminator, form.bytes);
    // The union path is the product's answer for a program with two sources
    // (an on-chain IDL and an adopted published copy): both are consulted and
    // the winner is chosen by bytes. The single-source path is used where the
    // program has only one — both are exercised, because a consumer may have
    // either.
    const union = await decodeUnionPayload(STORE, form.program, hex, { absent: 'verified' });
    assert.equal(union.name, form.instruction, 'the decode names the instruction the witness logged');
    assert.deepEqual(union.absent, form.absent, 'the absent field is named, not guessed');
    assert.equal(union.roundTripByteExact, true,
      'the short form re-encodes byte-exactly once the absent field is omitted');
    assert.equal(union.shortForm.verified, true, 'the evidence covers this decode');
    assert.equal(union.shortForm.instruction, form.instruction);
    assert.equal(union.shortForm.wireBytes, form.bytes);
    assert.match(union.shortForm.source, /short-form-wire-forms-2026-11-03\.json/,
      'the evidence names the measurement it comes from');
  }
});

test('the union entry point names the short forms too', async () => {
  const form = VERIFIED_SHORT_FORMS.find((f) => f.instruction === 'buy_exact_quote_in_v3');
  const hex = await witnessPayload(form.discriminator, form.bytes);
  const result = await decodeUnionPayload(STORE, form.program, hex, { absent: 'verified' });
  assert.equal(result.name, 'buy_exact_quote_in_v3');
  assert.deepEqual(result.absent, ['partial_fill']);
  assert.equal(result.roundTripByteExact, true);
  assert.equal(result.shortForm.verified, true);
});

test('the strict default still refuses every short form', async () => {
  // The whole product stays strict unless a caller opts in. A decode that
  // names a short form by default would be claiming knowledge nobody has.
  for (const form of VERIFIED_SHORT_FORMS) {
    const hex = await witnessPayload(form.discriminator, form.bytes);
    await assert.rejects(
      () => decodeUnionPayload(STORE, form.program, hex),
      (error) => {
        assert.match(error.message, /refuse|unknown instruction discriminator|truncated input/);
        return true;
      },
      `${form.instruction} must be refused by default`);
  }
});

test('the evidence gate refuses a payload that merely ends on a field boundary', async () => {
  // A 16-byte truncation of the 24-byte form: discriminator + one u64. It ends
  // exactly on a field boundary and re-encodes byte-exactly to the shortened
  // bytes — so byte-exactness alone cannot tell it from a real short form.
  const form = VERIFIED_SHORT_FORMS.find((f) => f.instruction === 'buy_exact_quote_in_v3');
  const hex = await witnessPayload(form.discriminator, form.bytes);
  const truncated = hex.slice(0, 32); // 16 bytes: discriminator + spendable_quote_in

  // 'report' accepts it — this is exactly the risk the evidence gate exists for.
  const loose = await decodeUnionPayload(STORE, form.program, truncated, { absent: 'report' });
  assert.deepEqual(loose.absent, ['min_tokens_out', 'partial_fill'],
    'the blanket policy names two absent fields on a fabricated truncation');
  assert.equal(loose.shortForm, undefined, 'and attaches no chain evidence to it');

  // 'verified' must refuse it: no witness covers a 16-byte payload.
  await assert.rejects(
    () => decodeUnionPayload(STORE, form.program, truncated, { absent: 'verified' }),
    (error) => {
      assert.match(error.message, /refuse|unknown instruction discriminator/);
      return true;
    },
    'a payload with no chain witness must be refused under the verified policy');
});

test('the gate keys on program, discriminator AND exact length', async () => {
  const form = VERIFIED_SHORT_FORMS.find((f) => f.instruction === 'buy_exact_quote_in_v3');
  const hex = await witnessPayload(form.discriminator, form.bytes);

  // The 25-byte form of the same instruction is a DIFFERENT, fully-described
  // shape — both OptionBools are present. It must not be routed through the
  // absent path, and it must not claim chain evidence.
  const longer = await witnessPayload(form.discriminator, 25);
  const decodedLonger = await decodeUnionPayload(STORE, form.program, longer, { absent: 'verified' });
  assert.equal(decodedLonger.name, 'buy_exact_quote_in_v3');
  assert.deepEqual(decodedLonger.absent, [], 'the 25-byte form carries every declared field');
  assert.equal(decodedLonger.shortForm, undefined, 'and is not a short form');

  // The same bytes under a DIFFERENT program must not match the table.
  assert.equal(verifiedShortForm(PUMPSWAP, Buffer.from(hex, 'hex')), null);
  // The same program, a discriminator nobody measured: no match.
  assert.equal(verifiedShortForm(PUMP, Buffer.from('00'.repeat(24), 'hex')), null);
  // Right program, right discriminator, wrong length: no match.
  assert.equal(verifiedShortForm(PUMP, Buffer.from(hex, 'hex').subarray(0, 23)), null);
});

test('stale evidence is refused rather than spent on a shape nobody measured', () => {
  const form = VERIFIED_SHORT_FORMS.find((f) => f.instruction === 'buy_exact_quote_in_v3');
  // A decode that reports a DIFFERENT absent set has not reproduced the
  // measured wire form — the IDL changed since the witness was taken.
  const drifted = describeShortForm(form, {
    absent: ['partial_fill', 'brand_new_field'], instruction: form.instruction,
  }, Buffer.alloc(24));
  assert.equal(drifted.verified, false, 'a different absent set is not verified');

  // A decode under a different name is not verified either.
  const renamed = describeShortForm(form, {
    absent: ['partial_fill'], instruction: 'buy_exact_quote_in_v2',
  }, Buffer.alloc(24));
  assert.equal(renamed.verified, false, 'a different name is not verified');

  // The measured shape is verified.
  const same = describeShortForm(form, {
    absent: ['partial_fill'], instruction: form.instruction,
  }, Buffer.alloc(24));
  assert.equal(same.verified, true);
});

test('the policy resolver is explicit about what each policy allows', () => {
  const form = VERIFIED_SHORT_FORMS[0];
  const bytes = Buffer.from(`${form.discriminator}${'00'.repeat(16)}`, 'hex');

  assert.equal(resolveAbsentPolicy(form.program, bytes, undefined).policy, 'error',
    'the default is strict');
  assert.equal(resolveAbsentPolicy(form.program, bytes, 'error').policy, 'error');
  assert.equal(resolveAbsentPolicy(form.program, bytes, 'report').policy, 'report');

  const verified = resolveAbsentPolicy(form.program, bytes, 'verified');
  assert.equal(verified.policy, 'report', 'a witnessed form may decode');
  assert.equal(verified.form.instruction, form.instruction);

  const unwitnessed = resolveAbsentPolicy('some-other-program', bytes, 'verified');
  assert.equal(unwitnessed.policy, 'error', 'an unwitnessed payload stays strict');
  assert.equal(unwitnessed.form, null);

  assert.throws(() => resolveAbsentPolicy(form.program, bytes, 'nonsense'), /unknown absent policy/);
});

test('the product refuses when the evidence and the decode disagree', async () => {
  // Corrupt ONE table entry so the witness no longer matches what the decoder
  // reports, then decode the payload it covers. The product must refuse rather
  // than decode-and-label-unverified: an entry whose absent set drifted is
  // stale evidence, and stale evidence licenses nothing.
  const form = VERIFIED_SHORT_FORMS.find((f) => f.instruction === 'buy_exact_quote_in_v3');
  const hex = await witnessPayload(form.discriminator, form.bytes);
  const original = [...form.absent];
  form.absent = ['partial_fill', 'a_field_that_was_never_measured'];
  try {
    await assert.rejects(
      () => decodeUnionPayload(STORE, form.program, hex, { absent: 'verified' }),
      (error) => {
        assert.match(error.message, /short-form evidence does not cover this decode/);
        return true;
      },
      'a decode whose absence differs from the witness must be refused');
    // The single-source path resolves to the on-chain IDL, which does not know
    // this discriminator at all — so it refuses even earlier. Either way the
    // payload is NOT decoded under drifted evidence.
    await assert.rejects(
      () => decodePayload(STORE, form.program, hex, { absent: 'verified' }),
      (error) => {
        assert.match(error.message, /unknown instruction discriminator|short-form evidence does not cover/);
        return true;
      },
      'the single-source path must refuse it too');
  } finally {
    form.absent = original;
  }
  // And the same payload decodes again once the evidence is restored, so the
  // refusal above came from the drift and not from something else.
  const back = await decodeUnionPayload(STORE, form.program, hex, { absent: 'verified' });
  assert.equal(back.shortForm.verified, true);
});

test('assertShortFormEvidence is the rule, and it is strict', () => {
  const form = VERIFIED_SHORT_FORMS[0];
  const bytes = Buffer.alloc(24);
  assert.throws(
    () => assertShortFormEvidence(form, { absent: ['something_else'], instruction: form.instruction }, bytes),
    /short-form evidence does not cover this decode/,
    'a different absent set throws');
  assert.throws(
    () => assertShortFormEvidence(form, { absent: form.absent, instruction: 'buy_exact_quote_in_v2' }, bytes),
    /short-form evidence does not cover this decode/,
    'a different instruction name throws');
  const ok = assertShortFormEvidence(form, { absent: form.absent, instruction: form.instruction }, bytes);
  assert.equal(ok.verified, true);
  assert.equal(ok.wireBytes, 24);
});

test('the codec default is strict: absent decoding is never the fallback', async () => {
  // The codec is a public subpath (sememe/codec) that consumers call directly,
  // bypassing the policy resolver. Its own default must therefore be 'error':
  // a payload ending on a field boundary refuses unless the caller opted in.
  const { primary, secondary } = await findStoredIdls(STORE, PUMP);
  const form = VERIFIED_SHORT_FORMS.find((f) => f.instruction === 'buy_exact_quote_in_v3');
  const hex = await witnessPayload(form.discriminator, form.bytes);
  const data = Buffer.from(hex, 'hex');
  // The source that DECLARES this discriminator is the adopted published copy;
  // the on-chain IDL does not know it (which is why the union path fell back).
  const source = [primary, secondary].find((s) => s?.idl
    && s.idl.instructions.some((i) => i.name === form.instruction));
  assert.ok(source, 'one stored source declares this instruction');

  assert.throws(
    () => decodeInstructionData(source.idl, data),
    (error) => {
      assert.match(error.message, /truncated input/);
      return true;
    },
    'the default policy refuses the short form as truncated');

  const decoded = decodeInstructionData(source.idl, data, { absent: 'report' });
  assert.equal(decoded.instruction, form.instruction);
  assert.deepEqual(decoded.absent, form.absent, 'the opt-in names the absent field');
  assert.equal(decoded.absent.length, 1, 'only the measured field is absent');
});

test('the measured coverage gain is in the committed report, not a claim in prose', async () => {
  const coverage = JSON.parse(await readFile(COVERAGE, 'utf8'));
  const headline = coverage.headline;

  assert.equal(headline.absentPolicy, 'verified', 'the committed measurement used the evidence-gated policy');
  assert.equal(headline.shortForm, 171, '171 payloads decoded as short forms');
  assert.equal(headline.chainVerified, 171, 'and every one of them carries a matching chain witness');

  // The strict baseline must NOT have moved: the opt-in is opt-in.
  const strict = JSON.parse(await readFile(new URL('../research/traffic-coverage-2026-11-02.json', import.meta.url), 'utf8'));
  assert.equal(strict.headline.absentPolicy, 'error');
  assert.equal(strict.headline.shortForm, 0, 'the strict measurement decodes no short form');
  assert.equal(strict.headline.decoded, 12400);
  assert.equal(strict.headline.refused, 172);

  // The gain is exactly the measured short forms: 12,400 + 171 = 12,571.
  assert.equal(headline.decoded, strict.headline.decoded + 171);
  assert.equal(headline.refused, strict.headline.refused - 171);
  assert.equal(headline.refused, 1, 'one refusal remains — the Token-2022 tag-210 payload, not a short form');
  assert.equal(headline.watchedPayloads, strict.headline.watchedPayloads,
    'the denominator did not move');
  // 12,571 of 12,572 is 99.99%: with the Raydium table in place the only
  // payload neither path can name is that one Token-2022 refusal.
  assert.equal(headline.coveredPct, 100);
  assert.equal(headline.noInterface, 0,
    'the acquisition gap is closed — no payload lacks an interface');
});
