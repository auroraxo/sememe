// Seventh program, and the last of the five "derivation-only" programs from
// the 20-program strict coverage measurement: Meteora DAMM v1 (Eo7WjKq...),
// a constant-product / stable-swap AMM from Meteora.
//
// What this fixes and measures:
//
// The on-chain IDL (pulled 2026-10-29 at slot 463068495, legacy `anchor:idl`
// account, version 0.5.2) names 26 instructions and 18 events but carries NO
// discriminators — 0 of 44. Same premise as Kamino Lend, OpenBook v2,
// Marinade and Meteora Vault: an index built from the published bytes alone
// is EMPTY, so every real payload of this program is refused.
//
// NEW in this program: the on-chain copy names instructions in camelCase
// (`removeBalanceLiquidity`) while the published sdk copy names them in
// snake_case (`remove_balance_liquidity`). The naming cross-check therefore
// cannot compare raw strings — it compares the discriminator bytes and the
// snake_cased name, which is exactly what Anchor's rule hashes anyway. A
// disagreement in bytes or in snake_cased names is still a disagreement.
//
// The derivation rule is checked against two implementations this repo shares
// no code with:
//   1. `@coral-xyz/anchor` (anchor-ts 0.29.0) computes Anchor's sighash at
//      runtime — fixture `meteora-damm-v1-anchor-ts-discriminators.json`.
//   2. The published sdk IDL (MeteoraAg/damm-v1-sdk, ts-client/src/amm/idl.json)
//      STORES its own discriminators; 30/30 of them agree with the rule.
//
// What the real-payload round trip proves that nothing else can: a wrong
// discriminator cannot decode AND re-encode byte-exact across real mainnet
// transactions.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withDerivedDiscriminators, snakeCase } from '../src/discriminators.mjs';
import {
  decodeData, encodeInstructionData, encodeEventData, instructionIndex,
} from '../src/codec.mjs';

const DAMM = 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB';
const storedIdl = JSON.parse(
  await readFile(new URL('./fixtures/meteora-damm-v1-idl.json', import.meta.url), 'utf8'));
const oracle = JSON.parse(
  await readFile(new URL('./fixtures/meteora-damm-v1-anchor-ts-discriminators.json', import.meta.url), 'utf8'));
const publishedIdl = JSON.parse(
  await readFile(new URL('./fixtures/meteora-damm-v1-published-idl.json', import.meta.url), 'utf8'));
const harvest = JSON.parse(
  await readFile(new URL('./fixtures/harvest-meteora-damm-v1-2026-10-29.json', import.meta.url), 'utf8'));
const coverageReport = JSON.parse(
  await readFile(new URL('../research/coverage-meteora-damm-v1-2026-10-29.json', import.meta.url), 'utf8'));

function payloads() {
  const out = [];
  for (const tx of harvest.transactions) {
    if (tx.missing) continue;
    for (const payload of tx.payloads ?? []) out.push(payload);
  }
  return out;
}
const TOTAL = harvest.counts.payloads;

test('the Meteora DAMM v1 fixture is the program and volume it claims', () => {
  assert.equal(harvest.program, DAMM);
  assert.equal(payloads().length, TOTAL);
  assert.ok(TOTAL >= 300, `harvest too small to measure anything: ${TOTAL}`);
  assert.ok(harvest.slotRange.oldest <= harvest.slotRange.newest);
});

test('the stored on-chain Meteora DAMM v1 IDL carries no discriminators at all', () => {
  // Premise: an IDL without wire discriminators cannot decode a byte. If a
  // future pull starts storing them, fail loudly — the derivation is then no
  // longer load-bearing for this program.
  assert.equal(storedIdl.instructions.length, 26);
  assert.equal((storedIdl.events ?? []).length, 18);
  assert.equal(
    storedIdl.instructions.filter((i) => Array.isArray(i.discriminator)).length, 0);
  assert.equal(
    (storedIdl.events ?? []).filter((e) => Array.isArray(e.discriminator)).length, 0);
});

test('without derivation, no real Meteora DAMM v1 payload decodes: 0/ALL', () => {
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

test('with derivation, every real Meteora DAMM v1 payload decodes and re-encodes byte-exact', () => {
  const { idl, filled, conflicts } = withDerivedDiscriminators(storedIdl);
  assert.deepEqual(filled, { instructions: 26, events: 18 });
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
  assert.equal(trailing, 0, 'no Meteora DAMM v1 payload should carry unexplained bytes');
  assert.ok(seen.size >= 2, `only ${seen.size} distinct instructions observed`);
  assert.ok(seen.size <= 26, 'more distinct instructions than the IDL declares');
  return { distinctInstructions: seen.size, distinctEvents: seenEvents.size };
});

test('anchor-ts and the name-derived rule agree on every Meteora DAMM v1 discriminator', () => {
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

test('the published sdk IDL stores its own discriminators and they match the rule', async () => {
  // Independent confirmation number 2: unlike the on-chain copy, the
  // published MeteoraAg/damm-v1-sdk idl.json carries discriminator arrays
  // written by the program's own IDL generator. The Anchor rule re-derived
  // from THIS repo must reproduce them, and the published inventory must be
  // a strict superset of the on-chain one (0.5.7 vs on-chain 0.5.2).
  const { createHash } = await import('node:crypto');
  // Anchor's instruction rule snake_cases the name first; the event rule
  // hashes the event name verbatim (see src/discriminators.mjs).
  const sha256 = (text) => createHash('sha256').update(text).digest();
  const instructionRule = (name) =>
    Array.from(sha256(`global:${snakeCase(name)}`).subarray(0, 8));
  const eventRule = (name) =>
    Array.from(sha256(`event:${name}`).subarray(0, 8));

  const disagree = [];
  for (const ix of publishedIdl.instructions) {
    if (!Array.isArray(ix.discriminator)) continue;
    const derived = instructionRule(ix.name);
    if (!derived.every((byte, index) => byte === ix.discriminator[index])) {
      disagree.push(ix.name);
    }
  }
  assert.equal(publishedIdl.instructions.filter((i) => Array.isArray(i.discriminator)).length, 30);
  assert.deepEqual(disagree, [], 'published discriminators must equal the Anchor rule');

  const eventDisagree = [];
  for (const ev of publishedIdl.events ?? []) {
    if (!Array.isArray(ev.discriminator)) continue;
    const derived = eventRule(ev.name);
    if (!derived.every((byte, index) => byte === ev.discriminator[index])) {
      eventDisagree.push(ev.name);
    }
  }
  assert.equal((publishedIdl.events ?? []).filter((e) => Array.isArray(e.discriminator)).length, 19);
  assert.deepEqual(eventDisagree, []);

  // Every on-chain instruction must be nameable by the published copy once
  // both sides are snake_cased — the two copies differ only in case style.
  const publishedNames = new Set(publishedIdl.instructions.map((i) => i.name));
  const onchainOnly = storedIdl.instructions
    .map((i) => i.name)
    .filter((n) => !publishedNames.has(snakeCase(n)));
  assert.deepEqual(onchainOnly, [],
    'every on-chain instruction must exist in the published interface after snake_casing');

  // The drift that is real: four published-only instructions (0.5.7 vs 0.5.2).
  const onchainNames = new Set(storedIdl.instructions.map((i) => snakeCase(i.name)));
  const publishedOnly = [...publishedNames].filter((n) => !onchainNames.has(n)).sort();
  assert.deepEqual(publishedOnly, [
    'claim_protocol_fee2', 'close_operator_account',
    'create_operator_account', 'zap_protocol_fee',
  ], 'published-only instruction names changed');

  // camelCase vs snake_case between the two copies is itself a measured fact.
  assert.ok(
    storedIdl.instructions.some((i) => /[A-Z]/.test(i.name)),
    'expected the on-chain copy to use camelCase names');
  assert.ok(
    publishedIdl.instructions.every((i) => !/[A-Z]/.test(i.name)),
    'expected the published copy to use snake_case names');
  // ... and Anchor's rule snake_cases before hashing, so the case difference
  // cannot change the wire bytes: this is exactly what the byte comparisons
  // above and the traffic round trip jointly establish.
  const camelPublished = new Set(publishedIdl.instructions.map((i) => i.name));
  for (const ix of storedIdl.instructions) {
    assert.ok(camelPublished.has(snakeCase(ix.name)),
      `published copy has no instruction for snake_cased ${ix.name}`);
  }
});

test('every instruction name observed in real traffic exists in BOTH interface copies', () => {
  const publishedNames = new Set(publishedIdl.instructions.map((i) => i.name));
  const observed = new Set(Object.keys(coverageReport.byInstruction));
  assert.ok(observed.size >= 1, 'no instruction observed in traffic');
  const missing = [...observed]
    .filter((n) => !publishedNames.has(snakeCase(n)));
  assert.deepEqual(missing, [],
    'observed instruction absent from the published interface (after snake_casing)');
  const onchainNames = new Set(storedIdl.instructions.map((i) => i.name));
  const missingOnchain = [...observed].filter((n) => !onchainNames.has(n));
  assert.deepEqual(missingOnchain, [],
    'observed instruction absent from the on-chain interface');
});
