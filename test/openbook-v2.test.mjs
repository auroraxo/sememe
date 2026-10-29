// Fourth program, and the first one where the Anchor rule is checked against
// a completely independent implementation of Anchor's sighash.
//
// OpenBook v2 (opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb) is a central
// limit order book — a third program family after the swap AMMs (Whirlpool,
// Jupiter AMM v6) and the lending market (Kamino Lend). Its on-chain IDL was
// pulled on 2026-10-29 at slot 462921401 (legacy `anchor:idl` account,
// fingerprint sha256:d12a2e16...) and carries 29 instructions and 8 events
// with ZERO discriminators, exactly like Kamino Lend.
//
// The oracle here is stronger than "another program that stores its
// discriminators": `@coral-xyz/anchor` (anchor-ts) computes Anchor's sighash
// at runtime from the very same IDL. The fixture
// `openbook-anchor-ts-discriminators.json` was produced by anchor-ts's own
// BorshInstructionCoder / BorshEventCoder over the on-chain IDL — an
// implementation this repository does not share a line of code with.
//
// If the name-derived rule were wrong for OpenBook, the two would disagree
// here, byte for byte.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withDerivedDiscriminators } from '../src/discriminators.mjs';
import {
  decodeData, encodeInstructionData, instructionIndex,
} from '../src/codec.mjs';

const OPENBOOK = 'opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb';
const storedIdl = JSON.parse(
  await readFile(new URL('./fixtures/openbook-v2-idl.json', import.meta.url), 'utf8'));
const oracle = JSON.parse(
  await readFile(new URL('./fixtures/openbook-anchor-ts-discriminators.json', import.meta.url), 'utf8'));
const publishedIdl = JSON.parse(
  await readFile(new URL('./fixtures/openbook-v2-published-idl.json', import.meta.url), 'utf8'));
const harvest = JSON.parse(
  await readFile(new URL('./fixtures/harvest-openbook-v2-2026-10-29.json', import.meta.url), 'utf8'));

function payloads() {
  const out = [];
  for (const tx of harvest.transactions) {
    if (tx.missing) continue;
    for (const payload of tx.payloads ?? []) out.push(payload);
  }
  return out;
}

test('the OpenBook fixture is the program and volume it claims', () => {
  assert.equal(harvest.program, OPENBOOK);
  assert.equal(payloads().length, 600);
  assert.ok(harvest.slotRange.oldest <= harvest.slotRange.newest);
});

test('without derivation, no real OpenBook payload decodes: 0/600', () => {
  // Same premise as Kamino Lend, now on a third program family: a discriminator
  // index built from the published bytes alone is EMPTY, so every real payload
  // is refused. This is what the strict coverage number's "published bytes
  // alone" row measures.
  const index = instructionIndex(storedIdl);
  assert.equal(index.size, 0);
  let refused = 0;
  for (const payload of payloads()) {
    try {
      decodeData(storedIdl, Buffer.from(payload.dataHex, 'hex'), { trailing: 'report' });
    } catch (error) {
      assert.match(error.message, /unknown instruction discriminator/);
      refused++;
    }
  }
  assert.equal(refused, 600);
});

test('with derivation, every real OpenBook payload decodes and re-encodes byte-exact', () => {
  const { idl, filled, conflicts } = withDerivedDiscriminators(storedIdl);
  assert.deepEqual(filled, { instructions: 29, events: 8 });
  assert.deepEqual(conflicts, []);

  const seen = new Set();
  let trailing = 0;
  for (const payload of payloads()) {
    const bytes = Buffer.from(payload.dataHex, 'hex');
    const decoded = decodeData(idl, bytes, { trailing: 'report' });
    assert.equal(decoded.kind, 'instruction');
    seen.add(decoded.instruction);
    assert.ok(
      encodeInstructionData(idl, decoded.instruction, decoded.args).equals(bytes),
      `${decoded.instruction} did not round-trip byte-exact`);
    if (decoded.trailing.count > 0) trailing++;
  }
  assert.equal(trailing, 0, 'no OpenBook payload should carry unexplained bytes');
  // 600 payloads are not 600 instructions: place_take_order dominates the
  // sampled traffic. Assert the instruction diversity actually observed so a
  // fixture swap cannot quietly collapse the sample onto one instruction.
  assert.ok(seen.size >= 6, `only ${seen.size} distinct instructions observed`);
});

test('naming agrees with the independently published OpenBook IDL', () => {
  // The published copy (openbook-dex/openbook-v2, idl/openbook_v2.json) is a
  // different artifact from the on-chain account: it is fetched from GitHub,
  // never from this machine's store. It carries no discriminators either, so
  // the naming comparison runs through the same Anchor rule on both sides —
  // what it can still catch is a name disagreement.
  const sememeNames = new Set(storedIdl.instructions.map((i) => i.name));
  const publishedNames = new Set(publishedIdl.instructions.map((i) => i.name));
  assert.equal(sememeNames.size, 29);
  assert.equal(publishedNames.size, 29);
  const onlyOnChain = [...sememeNames].filter((n) => !publishedNames.has(n));
  const onlyPublished = [...publishedNames].filter((n) => !sememeNames.has(n));
  assert.deepEqual(onlyOnChain, [], 'instructions only the on-chain IDL knows');
  assert.deepEqual(onlyPublished, [], 'instructions only the published IDL knows');
});

test('the stored on-chain OpenBook IDL carries no discriminators at all', () => {
  // The premise: an IDL without wire discriminators cannot decode a byte.
  assert.equal(storedIdl.instructions.length, 29);
  assert.equal(storedIdl.events.length, 8);
  assert.equal(storedIdl.instructions.filter((i) => Array.isArray(i.discriminator)).length, 0);
  assert.equal(storedIdl.events.filter((e) => Array.isArray(e.discriminator)).length, 0);
});

test('anchor-ts and the name-derived rule agree on every OpenBook discriminator', () => {
  const { idl, filled, conflicts } = withDerivedDiscriminators(storedIdl);
  assert.deepEqual(filled, { instructions: 29, events: 8 });
  assert.deepEqual(conflicts, []);

  const mismatches = [];
  for (const instruction of idl.instructions) {
    const expected = oracle.instructions[instruction.name];
    if (!expected) { mismatches.push({ kind: 'instruction', name: instruction.name, reason: 'missing in oracle' }); continue; }
    if (!instruction.discriminator.every((byte, index) => byte === expected[index])) {
      mismatches.push({ kind: 'instruction', name: instruction.name, oracle: expected, derived: instruction.discriminator });
    }
  }
  for (const event of idl.events) {
    const expected = oracle.events[event.name];
    if (!expected) { mismatches.push({ kind: 'event', name: event.name, reason: 'missing in oracle' }); continue; }
    if (!event.discriminator.every((byte, index) => byte === expected[index])) {
      mismatches.push({ kind: 'event', name: event.name, oracle: expected, derived: event.discriminator });
    }
  }
  assert.deepEqual(mismatches, [],
    'anchor-ts sighash and the derived discriminators must be byte-identical');
  assert.equal(Object.keys(oracle.instructions).length, 29);
  assert.equal(Object.keys(oracle.events).length, 8);
});

test('the derivation is stable: two runs produce identical bytes', () => {
  const first = withDerivedDiscriminators(storedIdl);
  const second = withDerivedDiscriminators(JSON.parse(JSON.stringify(storedIdl)));
  assert.deepEqual(first.idl.instructions.map((i) => i.discriminator),
    second.idl.instructions.map((i) => i.discriminator));
  assert.deepEqual(first.idl.events.map((e) => e.discriminator),
    second.idl.events.map((e) => e.discriminator));
});
