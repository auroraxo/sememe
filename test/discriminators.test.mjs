// The derivation of Anchor discriminators, verified against real programs.
//
// This is the fix for a measurement gap the 20-program coverage run had: an
// IDL without discriminators was counted as "usable" although it cannot decode
// a single byte. Kamino Lend's on-chain IDL (pulled 2026-10-29, slot
// 462900393) has 66 instructions and 5 events, none of them carrying a
// discriminator.
//
// The rule under test is Anchor's own:
//   instruction: sha256("global:" + snake_case(name))[0..8]
//   event:       sha256("event:" + name)[0..8]
//
// It is verified against IDLs that DO store their discriminators (Whirlpool,
// Jupiter AMM v6) and applied where they are missing (Kamino Lend).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  snakeCase, globalDiscriminator, eventDiscriminator,
  verifyDerivedDiscriminators, withDerivedDiscriminators,
} from '../src/discriminators.mjs';

const whirlpool = JSON.parse(
  await readFile(new URL('./fixtures/whirlpool-idl.json', import.meta.url), 'utf8'));
const jupiter = JSON.parse(
  await readFile(new URL('./fixtures/jupiter-amm-v6-idl.json', import.meta.url), 'utf8'));

test('the derivation reproduces every stored Whirlpool discriminator', () => {
  const result = verifyDerivedDiscriminators(whirlpool);
  assert.equal(result.checked, 72, '66 instructions + 6 events');
  assert.equal(result.agree, 72);
  assert.deepEqual(result.conflicts, []);
});

test('the derivation reproduces 24 of 25 stored Jupiter discriminators, and the exception is named', () => {
  const result = verifyDerivedDiscriminators(jupiter);
  assert.equal(result.checked, 25, '19 instructions + 6 events');
  assert.equal(result.agree, 24);
  assert.equal(result.conflicts.length, 1);
  // `create_idempotent_associated_token_account` is the one stored
  // discriminator Anchor's own rule does NOT reproduce: sha256 of its name
  // gives bdbcecfa..., the IDL and mainnet say 5368c096... — and 5 real
  // harvested payloads carry 5368c096... and round-trip byte-exact, so the
  // STORED value is the true one and the name-derived guess is wrong here.
  // This is why the derivation only fills gaps and never overwrites: a name
  // is not proof of a wire discriminator.
  const [conflict] = result.conflicts;
  assert.equal(conflict.kind, 'instruction');
  assert.equal(conflict.name, 'create_idempotent_associated_token_account');
  assert.deepEqual(conflict.stored, [83, 104, 192, 150, 180, 71, 156, 198]);
  assert.deepEqual(conflict.derived, globalDiscriminator('create_idempotent_associated_token_account'));
});

test('snake_case follows Anchor: camelCase names become wire names', () => {
  assert.equal(snakeCase('borrowObligationLiquidityV2'), 'borrow_obligation_liquidity_v2');
  assert.equal(snakeCase('initLendingMarket'), 'init_lending_market');
  assert.equal(snakeCase('depositReserveLiquidityAndObligationCollateralV2'),
    'deposit_reserve_liquidity_and_obligation_collateral_v2');
});

test('a known discriminator is reproduced exactly', () => {
  // BorrowObligationLiquidityV2, taken from Kamino's own generated client
  // (@kamino-finance/klend-sdk), not from the on-chain IDL.
  assert.deepEqual(globalDiscriminator('borrowObligationLiquidityV2'),
    [161, 128, 143, 245, 171, 199, 194, 6]);
  // Jupiter's SwapEvent discriminator, taken from its on-chain IDL.
  assert.deepEqual(eventDiscriminator('SwapEvent'), [64, 198, 205, 232, 38, 8, 113, 226]);
});

test('an IDL without discriminators gets them filled in, and the fill is complete', () => {
  const bare = {
    instructions: [
      { name: 'initLendingMarket', args: [] },
      { name: 'borrowObligationLiquidityV2', args: [] },
    ],
    events: [{ name: 'BorrowOrderPlaceEvent', fields: [] }],
  };
  const { idl, filled, conflicts } = withDerivedDiscriminators(bare);
  assert.equal(filled.instructions, 2);
  assert.equal(filled.events, 1);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(idl.instructions[1].discriminator, [161, 128, 143, 245, 171, 199, 194, 6]);
  assert.deepEqual(idl.events[0].discriminator, eventDiscriminator('BorrowOrderPlaceEvent'));
});

test('a stored discriminator is never overwritten, and a conflict is reported', () => {
  const tampered = {
    instructions: [{ name: 'borrowObligationLiquidityV2', discriminator: [1, 2, 3, 4, 5, 6, 7, 8] }],
    events: [],
  };
  const { idl, filled, conflicts } = withDerivedDiscriminators(tampered);
  assert.equal(filled.instructions, 0, 'nothing was missing, so nothing was filled');
  assert.deepEqual(idl.instructions[0].discriminator, [1, 2, 3, 4, 5, 6, 7, 8],
    'the stored value wins');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].name, 'borrowObligationLiquidityV2');
});

test('the derivation is deterministic and name-sensitive', () => {
  assert.deepEqual(globalDiscriminator('route'), globalDiscriminator('route'));
  assert.notDeepEqual(globalDiscriminator('route'), globalDiscriminator('routes'));
  assert.notDeepEqual(globalDiscriminator('route'), eventDiscriminator('route'));
});
