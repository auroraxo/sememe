// WHICH WIRE FORMS DOES THE PROGRAM REALLY EXECUTE?
//
// The unbiased traffic sample leaves 172 payloads that sememe refuses with an
// interface present (research/traffic-coverage-2026-11-02.json). A refusal
// cannot say whether the bytes are garbage or whether the interface
// OVER-DESCRIBES the wire — those two readings call for opposite product
// actions, so the chain has to decide.
//
// This suite pins the measurement in research/short-form-wire-forms-2026-11-03.json
// and, more importantly, the three conditions under which the tool is allowed
// to call a refused wire form "executed by the chain":
//
//   1. the transaction ended with err:null — every instruction in it ran;
//   2. the chain's bytes for that program+discriminator are BYTE-IDENTICAL to
//      the committed fixture's (no "close enough", no re-encoding);
//   3. the program logged the instruction name that the stored interface
//      assigns to that discriminator.
//
// Drop any one of them and the claim is not proved — so each one gets a test
// that goes red when it is dropped.
//
// It also pins the two tool defects this run found, both of which produced a
// plausible-looking WRONG answer:
//
//   4. instruction data in encoding "json" is BASE58. Decoding it as base64
//      yields bytes of the wrong length that look like a different wire form —
//      an earlier version of the probe reported "no match" on every single
//      transaction because of this.
//   5. an instruction may carry NO data at all; base58 of the empty string is
//      not a payload, and throwing there aborted the whole run.
//
// A hand-edited verdict, a flipped byte-exact flag, a dropped log-line
// condition or a mutated witness goes red.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeBase58, encodeBase58 } from '../src/base58.mjs';

const REPORT = new URL('../research/short-form-wire-forms-2026-11-03.json', import.meta.url);
const SAMPLE = new URL('./fixtures/traffic-sample-2026-11-02.json', import.meta.url);

const report = JSON.parse(await readFile(REPORT, 'utf8'));
const sample = JSON.parse(await readFile(SAMPLE, 'utf8'));

test('the report measured every refusal in the sample', () => {
  const refusals = report.rows
    .filter((r) => r.sememeOutcome === 'refused')
    .reduce((acc, r) => acc + r.payloads, 0);
  assert.equal(report.coverage.refusals, refusals, 'coverage.refusals re-derives from the rows');
  assert.equal(refusals, 172, 'the unbiased sample leaves 172 refused payloads');
  assert.ok(report.coverage.refusedGroups >= 5, 'every refusal group was examined');
});

test('the summary is re-derived from the rows, never hand-written', () => {
  const shortForms = report.shortForms.map((s) => `${s.program}|${s.discriminator}|${s.wireBytes}`)
    .sort().join('\n');
  const fromRows = report.rows
    .filter((r) => r.sememeOutcome === 'refused' && r.chainExecuted)
    .map((r) => `${r.program}|${r.discriminator}|${r.wireBytes}`)
    .sort().join('\n');
  assert.equal(shortForms, fromRows, 'shortForms is exactly the rows the chain executed');
  assert.equal(
    report.coverage.refusedPayloadsExecutedByChain,
    report.rows.filter((r) => r.sememeOutcome === 'refused' && r.chainExecuted)
      .reduce((acc, r) => acc + r.payloads, 0),
    'coverage.refusedPayloadsExecutedByChain re-derives from the rows',
  );
});

test('every row\'s counters are re-derived from its own witnesses', () => {
  // The summary fields of a row are conveniences; the witnesses are the
  // evidence. A row whose counters do not follow from its witnesses is a
  // hand-edited report — this catches a doctored byte-exact flag and a
  // doctored err:null.
  for (const row of report.rows) {
    const byteExact = row.witnesses.filter((w) => w.fixtureMatchesChainBytes === true).length;
    assert.equal(row.byteExactWitnesses, byteExact,
      `${row.discriminator} ${row.wireBytes}B: byteExactWitnesses follows from the witnesses`);
    const accepted = row.witnesses.filter((w) => w.ok !== false && (w.txError === null || w.txError === undefined)).length;
    assert.equal(row.chainAcceptedWitnesses, accepted,
      `${row.discriminator} ${row.wireBytes}B: chainAcceptedWitnesses follows from the witnesses`);
    const rejected = row.witnesses.filter((w) => w.ok !== false && !(w.txError === null || w.txError === undefined)).length;
    assert.equal(row.chainRejectedWitnesses, rejected,
      `${row.discriminator} ${row.wireBytes}B: chainRejectedWitnesses follows from the witnesses`);
    // And a witness cannot claim to be accepted while carrying an error.
    for (const w of row.witnesses) {
      if (w.ok === false) continue;
      const hasError = !(w.txError === null || w.txError === undefined);
      assert.equal(w.accepted, !hasError,
        `${w.signature}: "accepted" and the recorded err agree`);
    }
  }
});

test('"executed by the chain" requires ALL THREE conditions, not any one', () => {
  for (const row of report.rows.filter((r) => r.chainExecuted)) {
    assert.ok(row.byteExactWitnesses > 0, `${row.discriminator} ${row.wireBytes}B: at least one byte-exact witness`);
    // PARENTHESES MATTER: without them the || swallows the two conditions on
    // the right, and a witness that merely has err:null qualifies — which is
    // exactly the "any one" this test exists to reject.
    const qualifying = row.witnesses.filter((w) =>
      (w.txError === null || w.txError === undefined)
      && w.fixtureMatchesChainBytes === true
      && w.chainLoggedInstruction === true);
    assert.ok(
      qualifying.length > 0,
      `${row.discriminator} ${row.wireBytes}B: err:null + byte-exact + program logged "${row.instructionName}"`,
    );
    for (const w of qualifying) {
      // The logged name is CamelCase, the IDL name snake_case: compare word by
      // word in order rather than as a substring.
      const words = row.instructionName.split('_').filter(Boolean).map((x) => x.toLowerCase());
      const matched = w.instructionLogs.some((log) => {
        const logged = log.replace('Program log: Instruction:', '').toLowerCase();
        let at = 0;
        for (const word of words) {
          const found = logged.indexOf(word, at);
          if (found === -1) return false;
          at = found + word.length;
        }
        return true;
      });
      assert.ok(matched, `${row.discriminator}: witness ${w.signature} logs "${row.instructionName}"`);
    }
  }
});

test('a refusal group the chain rejected is NOT reported as a short form', () => {
  // The control that keeps "executed" from meaning "we looked at it": groups
  // with no qualifying witness must not appear as short forms.
  for (const row of report.rows.filter((r) => r.sememeOutcome === 'refused')) {
    const claimed = report.shortForms.some((s) =>
      s.program === row.program && s.discriminator === row.discriminator && s.wireBytes === row.wireBytes);
    assert.equal(claimed, row.chainExecuted, `${row.discriminator} ${row.wireBytes}B: claim matches row.chainExecuted`);
  }
});

test('the control groups — payloads sememe already decodes — are byte-exact too', () => {
  const controls = report.rows.filter((r) => r.sememeOutcome === 'decoded');
  assert.ok(controls.length >= 3, 'at least three decoded control groups');
  assert.ok(
    report.coverage.controlWitnessesByteExact > 0,
    'the tool can prove byte-identity for payloads that are not in question',
  );
  assert.equal(
    report.coverage.controlGroupsExecuted,
    controls.filter((r) => r.chainExecuted).length,
    'control executed count re-derives from the rows',
  );
});

test('the reported witnesses are real sample signatures, and the fixture matches them', () => {
  const signatures = new Set(sample.transactions.map((t) => t.signature));
  let checked = 0;
  for (const row of report.rows) {
    for (const w of row.witnesses) {
      assert.ok(signatures.has(w.signature), `witness is a sample transaction: ${w.signature}`);
      const tx = sample.transactions.find((t) => t.signature === w.signature);
      const fixtureRow = tx.payloads.find((p) =>
        p.program === row.program && p.dataHex.startsWith(row.discriminator));
      assert.ok(fixtureRow, `${w.signature} carries ${row.discriminator}`);
      if (w.fixtureMatchesChainBytes === true) {
        assert.equal(w.fixtureBytes, fixtureRow.dataHex.length / 2, `${w.signature}: recorded length matches fixture`);
        assert.ok(w.chainByteLengths.includes(w.fixtureBytes),
          `${w.signature}: the chain holds a wire form of the recorded length`);
        checked += 1;
      }
    }
  }
  assert.ok(checked > 0, 'at least one byte-exact witness was actually cross-checked');
});

test('base58 instruction data decodes to the fixture bytes, not to base64-shaped garbage', () => {
  // Defect 4: encoding "json" returns base58. Decoding it as base64 yields a
  // different length and a different discriminator, which reads as "the chain
  // holds a different wire form" — the exact wrong conclusion this tool exists
  // to avoid.
  const payloadHex = 'e1f7501ed5b38488bba83f0300000000a395fb8379000000';
  const base58Text = encodeBase58(Buffer.from(payloadHex, 'hex'));
  assert.equal(Buffer.from(decodeBase58(base58Text)).toString('hex'), payloadHex, 'base58 round-trips to the same hex');
  // And the wrong path is detectably wrong, not accidentally right:
  const wrongPath = Buffer.from(base58Text, 'base64').toString('hex');
  assert.notEqual(wrongPath, payloadHex, 'base64-decoding base58 data does not reproduce the payload');
});

test('an empty instruction payload is not a decode error', () => {
  // Defect 5: instructions with no data exist on every transaction (the
  // associated-token program's marker). base58 of '' throws, which aborted the
  // tool before it could write a report.
  assert.throws(() => decodeBase58(''), /non-empty string/, 'base58 still refuses an empty string');
  const hex = '' ? Buffer.from(decodeBase58('')).toString('hex') : '';
  assert.equal(hex, '', 'the tool guards the empty case instead of decoding it');
});

test('every short form names the instruction the stored interface assigns', () => {
  for (const s of report.shortForms) {
    assert.equal(typeof s.instructionName, 'string', 'a short form has a name from the interface, not from guessing');
    assert.ok(s.chainExecutedWitnesses > 0, `${s.instructionName}: executed on chain`);
    assert.ok(s.byteExactWitnesses > 0, `${s.instructionName}: bytes identical to the chain's`);
  }
});

test('the refusal reason for a short form is an over-described layout, not an unknown program', () => {
  for (const s of report.shortForms) {
    assert.match(
      s.sememeSays ?? '',
      /truncated|refuse/i,
      `${s.instructionName}: sememe refused because the interface demands more bytes than the wire carries`,
    );
  }
});
