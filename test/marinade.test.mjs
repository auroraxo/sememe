// Fifth program, fourth family: Marinade liquid staking (MarBmsSg...) — a
// staking program, not a swap AMM, not a lending market, not an order book.
//
// What this fixes and measures:
//
// The on-chain IDL (pulled 2026-10-29 at slot 462985426, legacy `anchor:idl`
// account) names 29 instructions and 26 events but carries NO discriminators —
// 0 of 55. Same premise as Kamino Lend and OpenBook v2, now on a staking
// program: a discriminator index built from the published bytes alone is
// EMPTY, so every real payload of this program is refused.
//
// The derivation rule is again checked against an implementation this repo
// shares no code with: `@coral-xyz/anchor` (anchor-ts 0.29.0) computes
// Anchor's sighash at runtime. Fixture
// `marinade-anchor-ts-discriminators.json` records its 29 instruction + 26
// event discriminators; the derived values must match byte for byte.
//
// Naming is cross-checked against an independent published copy of the same
// program's interface (`marinade_finance.json` shipped in
// marinade-finance/marinade-ts-sdk) — a different artifact from the on-chain
// account, fetched from GitHub, never from this machine's store.
//
// What the real-payload round trip proves that nothing else can: a wrong
// discriminator cannot decode AND re-encode byte-exact across real mainnet
// transactions. That is the check the naming comparison cannot replace.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withDerivedDiscriminators } from '../src/discriminators.mjs';
import {
  decodeData, encodeInstructionData, encodeEventData, instructionIndex,
} from '../src/codec.mjs';

const MARINADE = 'MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD';
const storedIdl = JSON.parse(
  await readFile(new URL('./fixtures/marinade-liquid-staking-idl.json', import.meta.url), 'utf8'));
const oracle = JSON.parse(
  await readFile(new URL('./fixtures/marinade-anchor-ts-discriminators.json', import.meta.url), 'utf8'));
const publishedIdl = JSON.parse(
  await readFile(new URL('./fixtures/marinade-finance-published-idl.json', import.meta.url), 'utf8'));
const harvest = JSON.parse(
  await readFile(new URL('./fixtures/harvest-marinade-liquid-staking-2026-10-29.json', import.meta.url), 'utf8'));

function payloads() {
  const out = [];
  for (const tx of harvest.transactions) {
    if (tx.missing) continue;
    for (const payload of tx.payloads ?? []) out.push(payload);
  }
  return out;
}
const TOTAL = harvest.counts.payloads;

test('the Marinade fixture is the program and volume it claims', () => {
  assert.equal(harvest.program, MARINADE);
  assert.equal(payloads().length, TOTAL);
  assert.ok(TOTAL >= 300, `harvest too small to measure anything: ${TOTAL}`);
  assert.ok(harvest.slotRange.oldest <= harvest.slotRange.newest);
});

test('the stored on-chain Marinade IDL carries no discriminators at all', () => {
  // Premise: an IDL without wire discriminators cannot decode a byte. If a
  // future pull starts storing them, fail loudly — the derivation is then no
  // longer load-bearing for this program.
  assert.equal(storedIdl.instructions.length, 29);
  assert.equal((storedIdl.events ?? []).length, 26);
  assert.equal(
    storedIdl.instructions.filter((i) => Array.isArray(i.discriminator)).length, 0);
  assert.equal(
    (storedIdl.events ?? []).filter((e) => Array.isArray(e.discriminator)).length, 0);
});

test('without derivation, no real Marinade payload decodes: 0/ALL', () => {
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

test('with derivation, every real Marinade payload decodes and re-encodes byte-exact', () => {
  const { idl, filled, conflicts } = withDerivedDiscriminators(storedIdl);
  assert.deepEqual(filled, { instructions: 29, events: 26 });
  assert.deepEqual(conflicts, []);

  const seen = new Set();
  let trailing = 0;
  let instructions = 0;
  for (const payload of payloads()) {
    const bytes = Buffer.from(payload.dataHex, 'hex');
    const decoded = decodeData(idl, bytes, { trailing: 'report' });
    assert.ok(decoded.kind === 'instruction' || decoded.kind === 'event',
      `unexpected decode kind ${decoded.kind}`);
    if (decoded.kind === 'instruction') {
      instructions++;
      seen.add(decoded.instruction);
      assert.ok(
        encodeInstructionData(idl, decoded.instruction, decoded.args).equals(bytes),
        `${decoded.instruction} did not round-trip byte-exact`);
    } else {
      assert.ok(
        encodeEventData(idl, decoded.event, decoded.args, { tagged: decoded.tagged }).equals(bytes),
        `${decoded.event} did not round-trip byte-exact`);
    }
    if (decoded.trailing.count > 0) trailing++;
  }
  assert.equal(instructions + (TOTAL - instructions), TOTAL);
  assert.equal(trailing, 0, 'no Marinade payload should carry unexplained bytes');
  assert.ok(seen.size >= 4, `only ${seen.size} distinct instructions observed`);
});

test('anchor-ts and the name-derived rule agree on every Marinade discriminator', () => {
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

test('naming agrees with the independently published Marinade IDL', () => {
  const sememeNames = new Set(storedIdl.instructions.map((i) => i.name));
  const publishedNames = new Set(publishedIdl.instructions.map((i) => i.name));
  assert.equal(sememeNames.size, 29);
  assert.equal(publishedNames.size, 29);
  const onlyOnChain = [...sememeNames].filter((n) => !publishedNames.has(n));
  const onlyPublished = [...publishedNames].filter((n) => !sememeNames.has(n));
  assert.deepEqual(onlyOnChain, [], 'instructions only the on-chain IDL knows');
  assert.deepEqual(onlyPublished, [], 'instructions only the published IDL knows');
});
