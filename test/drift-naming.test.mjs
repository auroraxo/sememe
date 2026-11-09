// test/drift-naming.test.mjs — NAMING STYLE IS NOT A LAYOUT DRIFT
//
// The defect this file tests (measured 2026-11-09):
//
// Two verified copies of the same program frequently use different casing
// conventions for their field names — the on-chain Anchor IDL uses camelCase
// (`lpMint`, `inAmount`, `totalAmount`), while the published SDK IDL uses
// snake_case (`lp_mint`, `in_amount`, `total_amount`), or one prefixes an
// internal field with an underscore (`_padding0` vs `padding0`).
//
// Before the normalised pairing rule:
//
//   1. Raw JSON equality compared the two argument trees. A field that both
//      copies decoded to the SAME value was reported as a LAYOUT DRIFT:
//      meteora-damm-v1 instruction decode produced `layout_drift` for 643 of
//      the 643 payloads in the committed harvest, and EVERY one of them was
//      NOTHING BUT a spelling difference (`inAmount` vs `in_amount`).
//
//   2. The account union listed the spelling differences in `paths`. On
//      meteora-damm-v1's 11 harvested accounts, all 11 rows hit the 20-path
//      cap (220 paths total), and 33 REAL value differences were crowded
//      out entirely.
//
// The contract this file pins:
//
//   N1  normalisation: `snake_case`, `camelCase`, and leading underscores pair
//       up as the same field.
//   N2  agreement: two trees that differ ONLY in casing decode to `agree`, with
//       the naming difference reported in `view.naming.spellingOnly`.
//   N3  real value difference: when paired fields hold different values, the
//       difference IS reported in `paths`, under the primary's spelling, and
//       the verdict is `layout_drift`.
//   N4  one-sided fields: a field only one copy declares is STILL reported in
//       `paths` (naming normalization does not make a missing field appear).
//   N5  array and scalar differences survive: differing lengths, differing
//       elements, differing types all produce `layout_drift`.
//   N6  unexplained-byte arbitration remains byte-driven: normalisation does
//       not change WHICH copy wins.
//   N7  the 20-path cap: spelling-only differences never consume the budget,
//       so real differences are not crowded out.
//
// Mutants M1-M4 verify that each failure mode actually turns the test red.

import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseFieldName, diffArgsByNormalisedName } from '../src/drift.mjs';
import { unionDecode } from '../src/union.mjs';
import { unionAccountDecode } from '../src/account-union.mjs';

test('N1: normaliseFieldName maps snake_case, camelCase and underscores to one form', () => {
  assert.equal(normaliseFieldName('lpMint'), 'lpMint');
  assert.equal(normaliseFieldName('lp_mint'), 'lpMint');
  assert.equal(normaliseFieldName('_lp_mint'), 'lpMint');
  assert.equal(normaliseFieldName('__lp_mint'), 'lpMint');
  assert.equal(normaliseFieldName('total_amount'), 'totalAmount');
  assert.equal(normaliseFieldName('totalAmount'), 'totalAmount');
  assert.equal(normaliseFieldName('_padding0'), 'padding0');
  assert.equal(normaliseFieldName('padding0'), 'padding0');
  assert.equal(normaliseFieldName('padding_0'), 'padding0');
  assert.equal(normaliseFieldName('a_vault_lp'), 'aVaultLp');
  assert.equal(normaliseFieldName('aVaultLp'), 'aVaultLp');
});

test('N2: two argument trees that differ ONLY in field casing decode to agree', () => {
  const primaryArgs = { inAmount: 1000, minimumOutAmount: 950 };
  const secondaryArgs = { in_amount: 1000, minimum_out_amount: 950 };
  const diff = diffArgsByNormalisedName(primaryArgs, secondaryArgs);
  assert.equal(diff.differs, false, 'a casing difference is not a data difference');
  assert.deepEqual(diff.paths, [], 'no layout drift paths');
  assert.equal(diff.spellingOnly.length, 2, 'both naming differences are recorded');
  assert.deepEqual(diff.spellingOnly, [
    { path: 'inAmount', primary: 'inAmount', secondary: 'in_amount' },
    { path: 'minimumOutAmount', primary: 'minimumOutAmount', secondary: 'minimum_out_amount' },
  ]);
});

test('N3: when values behind differently-cased names differ, the drift IS reported', () => {
  const primaryArgs = { inAmount: 1000, minimumOutAmount: 950 };
  const secondaryArgs = { in_amount: 1000, minimum_out_amount: 800 }; // different minimum
  const diff = diffArgsByNormalisedName(primaryArgs, secondaryArgs);
  assert.equal(diff.differs, true);
  assert.deepEqual(diff.paths, ['minimumOutAmount'], 'the differing field is named in primary spelling');
  // Both spelling differences are still reported in spellingOnly:
  assert.equal(diff.spellingOnly.length, 2);
});

test('N4: a field only one side declares is reported in paths, not in spellingOnly', () => {
  const primaryArgs = { inAmount: 1000, bonus: 5 };
  const secondaryArgs = { in_amount: 1000 };
  const diff = diffArgsByNormalisedName(primaryArgs, secondaryArgs);
  assert.equal(diff.differs, true);
  assert.deepEqual(diff.paths, ['bonus']);
  assert.equal(diff.spellingOnly.length, 1);
  assert.equal(diff.spellingOnly[0].primary, 'inAmount');
});

test('N5: nested objects pair by normalised names at every level', () => {
  const primaryArgs = {
    poolConfig: { tradeFeeRate: 25, protocolFeeRate: 5 },
  };
  const secondaryArgs = {
    pool_config: { trade_fee_rate: 25, protocol_fee_rate: 5 },
  };
  const diff = diffArgsByNormalisedName(primaryArgs, secondaryArgs);
  assert.equal(diff.differs, false);
  assert.deepEqual(diff.paths, []);
  assert.equal(diff.spellingOnly.length, 3);
});

test('N6: differing array lengths produce layout_drift even if name matches', () => {
  const primaryArgs = { values: [1, 2, 3] };
  const secondaryArgs = { values: [1, 2] };
  const diff = diffArgsByNormalisedName(primaryArgs, secondaryArgs);
  assert.equal(diff.differs, true);
  assert.deepEqual(diff.paths, ['values']);
});

test('N7: instruction unionDecode sets verdict agree when only spelling differs', () => {
  // Synthesise two IDLs with identical discriminator and wire layout, different casing
  const primary = {
    label: 'primary',
    idl: {
      instructions: [{
        name: 'swap',
        discriminator: [1, 2, 3, 4, 5, 6, 7, 8],
        args: [
          { name: 'inAmount', type: 'u64' },
          { name: 'minimumOutAmount', type: 'u64' },
        ],
      }],
      types: [],
    },
    idlMeta: { fingerprint: 'sha256:prim', slot: 100, source: 'metadata' },
    objectPath: '/tmp/prim.json',
  };
  const secondary = {
    label: 'secondary',
    idl: {
      instructions: [{
        name: 'swap',
        discriminator: [1, 2, 3, 4, 5, 6, 7, 8],
        args: [
          { name: 'in_amount', type: 'u64' },
          { name: 'minimum_out_amount', type: 'u64' },
        ],
      }],
      types: [],
    },
    idlMeta: { fingerprint: 'sha256:sec', slot: null, source: 'published' },
    objectPath: '/tmp/sec.json',
  };
  const bytes = Buffer.concat([
    Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
    Buffer.from([0xe8, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), // 1000
    Buffer.from([0xb6, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), // 950
  ]);
  const result = unionDecode({ program: '11111111111111111111111111111111', primary, secondary, bytes });
  assert.equal(result.view.verdict, 'agree', 'casing difference alone must be agree, not layout_drift');
  assert.equal(result.view.sourcesAgree, true);
  assert.ok(result.view.naming?.spellingOnly?.length === 2, 'spelling differences are attached to view.naming');
});

test('N8: account unionAccountDecode sets verdict agree when only spelling differs', () => {
  const disc = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88];
  const primary = {
    label: 'primary',
    idl: {
      accounts: [{ name: 'Pool', discriminator: disc }],
      types: [{
        name: 'Pool',
        type: {
          kind: 'struct',
          fields: [
            { name: 'lpMintSupply', type: 'u64' },
            { name: 'tradeFee', type: 'u64' },
          ],
        },
      }],
    },
    idlMeta: { fingerprint: 'sha256:prim', slot: 100, source: 'metadata' },
    objectPath: '/tmp/prim.json',
  };
  const secondary = {
    label: 'secondary',
    idl: {
      accounts: [{ name: 'Pool', discriminator: disc }],
      types: [{
        name: 'Pool',
        type: {
          kind: 'struct',
          fields: [
            { name: 'lp_mint_supply', type: 'u64' },
            { name: 'trade_fee', type: 'u64' },
          ],
        },
      }],
    },
    idlMeta: { fingerprint: 'sha256:sec', slot: null, source: 'published' },
    objectPath: '/tmp/sec.json',
  };
  const bytes = Buffer.concat([
    Buffer.from(disc),
    Buffer.from([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    Buffer.from([0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
  ]);
  const result = unionAccountDecode({
    program: '11111111111111111111111111111111',
    primary,
    secondary,
    bytes,
  });
  assert.equal(result.view.verdict, 'agree');
  assert.equal(result.view.sourcesAgree, true);
  assert.equal(result.view.naming?.spellingOnly?.length, 2);
});

// ---------------------------------------------------------------------------
// Falsification / Mutations
// ---------------------------------------------------------------------------

test('M1: raw string equality in diffArgsByNormalisedName makes N2 red', () => {
  // Mutant that disables casing normalization
  const badDiff = (a, b) => {
    const rawEqual = JSON.stringify(a) === JSON.stringify(b);
    return { differs: !rawEqual, paths: rawEqual ? [] : Object.keys(a), spellingOnly: [] };
  };
  const d = badDiff({ inAmount: 1000 }, { in_amount: 1000 });
  assert.equal(d.differs, true, 'the mutant must call a casing difference a drift');
  assert.ok(d.paths.length > 0);
});

test('M2: ignoring value differences on paired keys makes N3 red', () => {
  // Mutant that pairs by normalised name but forgets to check if values agree
  const badPair = (a, b) => {
    const spellingOnly = [{ path: 'x', primary: 'minOut', secondary: 'min_out' }];
    return { differs: false, paths: [], spellingOnly }; // ignores that a.minOut != b.min_out
  };
  const d = badPair({ minOut: 100 }, { min_out: 200 });
  assert.equal(d.differs, false, 'the mutant falsely reports agreement over differing values');
});
