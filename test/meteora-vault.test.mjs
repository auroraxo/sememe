// Sixth program, fifth family: Meteora Vault (24Uqj9J...) — a yield vault
// with strategy rotation, not a swap AMM, not lending, not an order book,
// not liquid staking.
//
// What this fixes and measures:
//
// The on-chain IDL (pulled 2026-10-29 at slot 463051650, legacy `anchor:idl`
// account, version 0.7.2) names 14 instructions and 8 events but carries NO
// discriminators — 0 of 22. Same premise as Kamino Lend, OpenBook v2 and
// Marinade: a discriminator index built from the published bytes alone is
// EMPTY, so every real payload of this program is refused.
//
// The derivation rule is again checked against an implementation this repo
// shares no code with: `@coral-xyz/anchor` (anchor-ts 0.29.0) computes
// Anchor's sighash at runtime. Fixture `meteora-vault-anchor-ts-discriminators.json`
// records its 14 instruction + 8 event discriminators; the derived values must
// match byte for byte.
//
// The independent published copy of the interface (idl.ts shipped in
// MeteoraAg/vault-sdk) is version 0.9.5 — NEWER than the on-chain 0.7.2
// account. That drift is itself a finding: the naming cross-check therefore
// asserts agreement on the names BOTH copies know and reports the
// divergence instead of pretending the two inventories are identical.
//
// What the real-payload round trip proves that nothing else can: a wrong
// discriminator cannot decode AND re-encode byte-exact across real mainnet
// transactions.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withDerivedDiscriminators } from '../src/discriminators.mjs';
import {
  decodeData, encodeInstructionData, encodeEventData, instructionIndex,
} from '../src/codec.mjs';

const VAULT = '24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi';
const storedIdl = JSON.parse(
  await readFile(new URL('./fixtures/meteora-vault-idl.json', import.meta.url), 'utf8'));
const oracle = JSON.parse(
  await readFile(new URL('./fixtures/meteora-vault-anchor-ts-discriminators.json', import.meta.url), 'utf8'));
const publishedIdl = JSON.parse(
  await readFile(new URL('./fixtures/meteora-vault-published-idl.json', import.meta.url), 'utf8'));
const harvest = JSON.parse(
  await readFile(new URL('./fixtures/harvest-meteora-vault-2026-10-29.json', import.meta.url), 'utf8'));
const coverageReport = JSON.parse(
  await readFile(new URL('../research/coverage-meteora-vault-2026-10-29.json', import.meta.url), 'utf8'));

function payloads() {
  const out = [];
  for (const tx of harvest.transactions) {
    if (tx.missing) continue;
    for (const payload of tx.payloads ?? []) out.push(payload);
  }
  return out;
}
const TOTAL = harvest.counts.payloads;

test('the Meteora Vault fixture is the program and volume it claims', () => {
  assert.equal(harvest.program, VAULT);
  assert.equal(payloads().length, TOTAL);
  assert.ok(TOTAL >= 300, `harvest too small to measure anything: ${TOTAL}`);
  assert.ok(harvest.slotRange.oldest <= harvest.slotRange.newest);
});

test('the stored on-chain Meteora Vault IDL carries no discriminators at all', () => {
  // Premise: an IDL without wire discriminators cannot decode a byte. If a
  // future pull starts storing them, fail loudly — the derivation is then no
  // longer load-bearing for this program.
  assert.equal(storedIdl.instructions.length, 14);
  assert.equal((storedIdl.events ?? []).length, 8);
  assert.equal(
    storedIdl.instructions.filter((i) => Array.isArray(i.discriminator)).length, 0);
  assert.equal(
    (storedIdl.events ?? []).filter((e) => Array.isArray(e.discriminator)).length, 0);
});

test('without derivation, no real Meteora Vault payload decodes: 0/ALL', () => {
  const index = instructionIndex(storedIdl);
  assert.equal(index.size, 0, 'a discriminator index built from the stored IDL is empty');
  let refused = 0;
  for (const payload of payloads()) {
    try {
      decodeData(storedIdl, Buffer.from(payload.dataHex, 'hex'), { trailing: 'report' });
    } catch (error) {
      assert.match(error.message, /unknown (instruction|event) discriminator/);
      refused++;
    }
  }
  assert.equal(refused, TOTAL);
});

test('with derivation, every real Meteora Vault payload decodes and re-encodes byte-exact', () => {
  const { idl, filled, conflicts } = withDerivedDiscriminators(storedIdl);
  assert.deepEqual(filled, { instructions: 14, events: 8 });
  assert.deepEqual(conflicts, []);

  const seen = new Set();
  const seenEvents = new Set();
  let trailing = 0;
  for (const payload of payloads()) {
    const bytes = Buffer.from(payload.dataHex, 'hex');
    const decoded = decodeData(idl, bytes, { trailing: 'report' });
    assert.ok(decoded.kind === 'instruction' || decoded.kind === 'event',
      `unexpected decode kind ${decoded.kind}`);
    if (decoded.kind === 'instruction') {
      seen.add(decoded.instruction);
      assert.ok(
        encodeInstructionData(idl, decoded.instruction, decoded.args).equals(bytes),
        `${decoded.instruction} did not round-trip byte-exact`);
    } else {
      seenEvents.add(decoded.event);
      assert.ok(
        encodeEventData(idl, decoded.event, decoded.args, { tagged: decoded.tagged }).equals(bytes),
        `${decoded.event} did not round-trip byte-exact`);
    }
    if (decoded.trailing.count > 0) trailing++;
  }
  assert.equal(trailing, 0, 'no Meteora Vault payload should carry unexplained bytes');
  // Honest limit: vault traffic is two flows (deposit/withdraw) at high
  // volume, not a tour of all 14 instructions.
  assert.ok(seen.size >= 2, `only ${seen.size} distinct instructions observed`);
  assert.ok(seen.size <= 14, 'more distinct instructions than the IDL declares');
  return { distinctInstructions: seen.size, distinctEvents: seenEvents.size };
});

test('anchor-ts and the name-derived rule agree on every Meteora Vault discriminator', () => {
  const { idl } = withDerivedDiscriminators(storedIdl);
  const mismatches = [];
  for (const ix of idl.instructions) {
    const derived = ix.discriminator.slice(0, 8);
    const theirs = oracle.instructions[ix.name];
    assert.ok(theirs, `anchor-ts has no discriminator for ${ix.name}`);
    if (!derived.every((byte, index) => byte === theirs[index])) {
      mismatches.push({ name: ix.name, derived, anchorTs: theirs });
    }
  }
  assert.deepEqual(mismatches, []);
  const eventMismatches = [];
  for (const event of idl.events ?? []) {
    const derived = event.discriminator.slice(0, 8);
    const theirs = oracle.events[event.name];
    assert.ok(theirs, `anchor-ts has no discriminator for event ${event.name}`);
    if (!derived.every((byte, index) => byte === theirs[index])) {
      eventMismatches.push({ name: event.name, derived, anchorTs: theirs });
    }
  }
  assert.deepEqual(eventMismatches, []);
});

test('the interface drift between on-chain 0.7.2 and published 0.9.5 is exactly what was measured', () => {
  // The published sdk IDL is 0.9.5, the on-chain account is 0.7.2: the two
  // inventories are NOT identical and this test does not pretend otherwise.
  // The drift is pinned as a measured fact so a future pull that changes it
  // fails loudly instead of silently redefining "same interface".
  const publishedNames = new Set(publishedIdl.instructions.map((i) => i.name));
  const onchainNames = new Set(storedIdl.instructions.map((i) => i.name));
  const onchainOnly = [...onchainNames].filter((n) => !publishedNames.has(n)).sort();
  const publishedOnly = [...publishedNames].filter((n) => !onchainNames.has(n)).sort();
  assert.deepEqual(onchainOnly, ['collectDust', 'withdraw2'],
    'on-chain instruction names absent from the published interface changed');
  assert.deepEqual(publishedOnly, [
    'claimRewards', 'getUnlockedAmount', 'initializeIdleVault', 'migrateVault',
    'transferAdmin', 'transferFeeVault', 'updateLockedProfitDegradation',
  ], 'published-only instruction names changed');
  const publishedEvents = new Set((publishedIdl.events ?? []).map((e) => e.name));
  const onchainOnlyEvents = (storedIdl.events ?? [])
    .map((e) => e.name)
    .filter((n) => !publishedEvents.has(n));
  assert.deepEqual(onchainOnlyEvents, [],
    'every on-chain event name must exist in the published interface');
  assert.notEqual(publishedIdl.version, storedIdl.version,
    'expected the published and on-chain interface versions to differ (0.9.5 vs 0.7.2)');
});

test('every instruction name observed in real traffic exists in BOTH interface copies', () => {
  // The naming cross-check that matters for shipped bytes: a payload the
  // decoder names must be nameable by an independent copy of the interface
  // too. If the on-chain IDL had a name the published copy dropped, real
  // traffic would eventually expose it here.
  const publishedNames = new Set(publishedIdl.instructions.map((i) => i.name));
  const observed = new Set(Object.keys(coverageReport.byInstruction));
  assert.ok(observed.size >= 1, 'no instruction observed in traffic');
  const missing = [...observed].filter((n) => !publishedNames.has(n));
  assert.deepEqual(missing, [], 'observed instruction absent from the published interface');
  const onchainNames = new Set(storedIdl.instructions.map((i) => i.name));
  const missingOnchain = [...observed].filter((n) => !onchainNames.has(n));
  assert.deepEqual(missingOnchain, [], 'observed instruction absent from the on-chain interface');
});
