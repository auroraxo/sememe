// A RENAMED copy that declares a DIFFERENT LAYOUT must say so — without
// becoming an answer, a winner, or a refusal.
//
// WHY THIS FILE EXISTS — measured 2026-11-09, offline, from committed
// fixtures (research/stale-layout-2026-11-09.json carries the live half).
//
// test/account-union-rename.test.mjs pinned R1-R4: a copy that spells the
// account `vault` instead of `Vault` can never identify the deployed bytes
// (Anchor derives the discriminator from the exact name), the refusal must
// name the rename, and the verdict must stay `primary_only`. What that file
// could NOT see is the LAYOUT behind the rename, because it deliberately
// never decodes the renamed copy.
//
// The two copies describe the SAME 1227 bytes and partition them differently:
//
//   on-chain copy (0.7.2, answers)   Vault  12 fields … strategies: publicKey[30] …
//   published copy (0.9.5, refuses)  vault  15 fields … strategies: publicKey[29],
//                                            version: u8, totalLpSupply: u64,
//                                            padding0: u8[23]
//
// 30 × 32 = 960 and 29 × 32 + 1 + 8 + 23 = 960: the declarations are the same
// LENGTH and disagree only about how to split one 32-byte region. Which means
// the answer the user is handed today contains `strategies[29]` — a public key.
//
// OFFLINE PROOF, all 12 harvested meteora-vault accounts, no network:
//   the base58 bytes of the answer's `strategies[29]` are byte-for-byte the
//   published copy's `version: 1` ++ LE `totalLpSupply` ++ 23 zero bytes —
//   12/12. The address is not a strategy; it is three fields wearing a key's
//   clothes.
//
// LIVE ORACLE (mainnet, 2026-11-09, recorded in the artifact):
//   0/12 of those addresses exist as accounts; all 348 real strategy accounts
//   (29 × 12) DO exist; `version` is 1 and `padding0` is all-zero on 12/12.
//
// WHAT THIS FILE PINS:
//
//   S1  the verdict does not move: `primary_only`, `secondary_refused`, the
//       answer is still the on-chain copy's — R1 holds after this change;
//   S2  the refusal reason keeps the exact wording R2 pinned, and the NEW
//       information arrives as its own field instead of being smuggled into
//       the reason;
//   S3  the new field reports the LAYOUT difference itself: `strategies`
//       publicKey[30] vs publicKey[29], plus the three fields only the other
//       copy declares — so the user can see their answer is contested;
//   S4  CONTROL: a renamed copy that declares the SAME layout reports
//       `differs: false` with no differences — a rename alone is not a
//       layout conflict;
//   S5  CONTROL: no rename (a discriminator that matches nothing under any
//       spelling) gains NO layout report — nothing is invented, R3 holds;
//   S6  SYMMETRY: the same report appears when the PRIMARY is the copy that
//       cannot identify the bytes — R4 holds for layout as well.
//
// WHAT THIS MUST NOT DO (the traps, restated from the rename file):
//
//   * force-decode the renamed copy and let byte evidence arbitrate: the
//     verdict would become `name_conflict` and the plain path's answer would
//     be lost;
//   * pick the renamed copy as a winner because its layout explains more —
//     the report is NOT evidence and never enters arbitration;
//   * invent a rename, or a layout conflict, where neither exists (S5);
//   * claim which copy is right. The offline half shows the two declarations
//     partition the same bytes differently; the live oracle is recorded in
//     the artifact, not asserted by the decoder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unionAccountDecode } from '../src/account-union.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ROOT_MUTANT_DIR = path.join(ROOT, 'src');

const FIXTURES = path.join(HERE, 'fixtures');

const load = async (name) => JSON.parse(await readFile(path.join(FIXTURES, name), 'utf8'));

const onchain = await load('meteora-vault-idl.json');
const published = await load('meteora-vault-published-idl.json');
const accounts = await load('accounts-meteora-vault-2026-11-08.json');

const PROGRAM = '24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi';

const source = (idl, label, kind) => ({
  label,
  idl,
  idlMeta: { fingerprint: `sha256:${label}`, slot: 1, source: kind },
  objectPath: `/tmp/${label}.json`,
});

const vault = accounts.accounts.find((a) => {
  const head = Buffer.from(a.dataBase64, 'base64').subarray(0, 8).toString('hex');
  return head === 'd308e82b02987577';
});
assert.ok(vault, 'the harvest must carry a Vault account');

function unionWith(primaryIdl, secondaryIdl, bytes) {
  return unionAccountDecode({
    program: PROGRAM,
    primary: source(primaryIdl, 'metadata', 'metadata'),
    secondary: source(secondaryIdl, 'published', 'published'),
    bytes,
  });
}

const bytes = Buffer.from(vault.dataBase64, 'base64');
const result = unionWith(onchain, published, bytes);

test('S1: the verdict does not move — the report is not arbitration', () => {
  assert.equal(result.view.verdict, 'primary_only');
  assert.equal(result.view.arbitration.basis, 'secondary_refused');
  assert.equal(result.account, 'Vault', 'the on-chain copy still answers');
  assert.equal(result.view.primary.decoded, true);
  assert.equal(result.view.secondary.decoded, false);
});

test('S2: the R2 refusal wording is untouched; the new fact gets its own field', () => {
  const reason = result.view.secondary.refusedReason;
  assert.match(reason, /no account type in this source matches the first 8 bytes/);
  assert.match(reason, /"vault"/, `R2's rename must stay: ${reason}`);
  assert.match(reason, /"Vault"/, `R2's deployed spelling must stay: ${reason}`);
  assert.match(reason, /derives an account discriminator from the exact name/);
  assert.match(reason, /ded54f7cd8eeee83/);
  // The layout fact is NOT appended to the reason: R2 pins that string, and a
  // cross-copy fact belongs on the view where it can be read structurally.
  assert.equal(result.view.declaredLayout.primary.account, 'Vault');
});

test('S3: the layout difference is reported, field by field', () => {
  const declared = result.view.declaredLayout;
  assert.equal(declared.differs, true,
    'the two copies partition the same bytes differently');
  assert.equal(declared.secondary.account, 'vault',
    'the report names the other copy\'s spelling');

  const byPath = Object.fromEntries(declared.diffs.map((d) => [d.path, d]));
  assert.ok(byPath.strategies, `strategies must be reported: ${JSON.stringify(declared.diffs)}`);
  assert.equal(byPath.strategies.primary, 'publicKey[30]',
    'the answering copy reads 30 keys');
  assert.equal(byPath.strategies.secondary, 'publicKey[29]',
    'the other copy reads 29 keys');
  // The three fields only the other copy declares — they are what the answer
  // is silently misreading as strategies[29].
  for (const name of ['version', 'totalLpSupply', 'padding0']) {
    assert.ok(byPath[name], `${name} must be reported: ${JSON.stringify(declared.diffs)}`);
    assert.equal(byPath[name].primary, null, `${name} is declared by the other copy only`);
  }
  assert.ok(byPath.version.secondary.startsWith('u8'),
    `version is a u8, got ${byPath.version.secondary}`);
  assert.ok(byPath.totalLpSupply.secondary.startsWith('u64'),
    `totalLpSupply is a u64, got ${byPath.totalLpSupply.secondary}`);
  assert.ok(byPath.padding0.secondary.includes('23'),
    `padding0 is 23 bytes, got ${byPath.padding0.secondary}`);
});

test('S4: CONTROL — a renamed copy that declares the SAME layout is not a conflict', () => {
  // Same field list, one letter different in the account name: the rename
  // diagnosis fires, but there is nothing to warn about.
  const renamedSame = JSON.parse(JSON.stringify(onchain));
  const entry = renamedSame.accounts.find((a) => a.name === 'Vault');
  entry.name = 'vAult';
  const out = unionWith(onchain, renamedSame, bytes);

  assert.equal(out.view.verdict, 'primary_only', 'the rename still blocks identification');
  assert.ok(out.view.secondary.refusedReason.includes('DOES declare the account'),
    'R2 still names the rename');
  const declared = out.view.declaredLayout;
  assert.ok(declared, 'the layout report exists — the rename was diagnosed');
  assert.equal(declared.differs, false,
    'identical declarations are not a layout conflict');
  assert.deepEqual(declared.diffs, [],
    'a rename alone must produce no differences');
});

test('S5: CONTROL — no rename anywhere means no layout report is invented', async () => {
  // Bytes no copy of this program declares under any spelling: the R3 case.
  const damm = await load('meteora-damm-v1-published-idl.json');
  const operatorDisc = damm.accounts.find((a) => a.name === 'Operator').discriminator;
  const foreign = Buffer.from([...operatorDisc, ...Buffer.alloc(64, 3)]);

  assert.throws(
    () => unionWith(onchain, published, foreign),
    (error) => {
      assert.match(error.message, /both stored sources refuse/);
      const view = error.view ?? error.details?.view;
      assert.ok(view, 'the failure must carry the two-source view');
      // R3: the generic reason, no rename diagnosis.
      assert.ok(!/derives an account discriminator from the exact name/
        .test(view.secondary.refusedReason));
      // And no layout report either — there was nothing to compare.
      assert.equal(view.declaredLayout, undefined,
        'no rename, no account name to compare, no report');
      return true;
    },
  );
});

test('S6: SYMMETRY — the report follows whichever copy could not identify', () => {
  // Swap the roles: the PUBLISHED copy's spelling sits on the primary side
  // and derives a discriminator that cannot match, while the other source
  // pins the deployed one.
  const disc = [0xd3, 0x08, 0xe8, 0x2b, 0x02, 0x98, 0x75, 0x77];
  const declaring = {
    instructions: [],
    accounts: [{ name: 'Vault', discriminator: disc }],
    types: [{ name: 'Vault', type: { kind: 'struct', fields: [{ name: 'v', type: 'u64' }] } }],
  };
  const renamedPull = {
    instructions: [],
    accounts: [{ name: 'vAult' }],
    types: [{ name: 'vAult', type: { kind: 'struct', fields: [{ name: 'v', type: 'u64' }, { name: 'extra', type: 'u8' }] } }],
  };

  const out = unionAccountDecode({
    program: PROGRAM,
    primary: source(renamedPull, 'metadata @slot 1', 'metadata'),
    secondary: source(declaring, 'published', 'published'),
    bytes: Buffer.from([...disc, ...Buffer.alloc(24, 5)]),
  });

  assert.equal(out.view.verdict, 'fallback_secondary', 'R4 still answers');
  assert.equal(out.view.arbitration.basis, 'primary_refused');
  assert.equal(out.view.primary.decoded, false);

  const declared = out.view.declaredLayout;
  assert.ok(declared, 'the layout report is symmetric');
  assert.equal(declared.differs, true);
  const byPath = Object.fromEntries(declared.diffs.map((d) => [d.path, d]));
  assert.equal(byPath.extra.primary, 'u8', 'the primary declares the extra field');
  assert.equal(byPath.extra.secondary, null, 'the other copy does not');
  assert.equal(declared.primary.account, 'vAult');
  assert.equal(declared.secondary.account, 'Vault');
});

// ---------------------------------------------------------------------------
// MUTATIONS: each breaks exactly ONE rule and must turn the suite red.
// ---------------------------------------------------------------------------

async function withAccountUnionMutant(label, mutate) {
  const file = path.join(ROOT_MUTANT_DIR, 'account-union.mjs');
  const source = await readFile(file, 'utf8');
  const mutated = mutate(source);
  assert.notEqual(mutated, source, `${label}: the mutation must actually change the source`);
  const mutantPath = path.join(ROOT_MUTANT_DIR, `.account-union-mutant-${label.replace(/[^a-z0-9]+/gi, '-')}.mjs`);
  await writeFile(mutantPath, mutated);
  try {
    return await import(mutantPath);
  } finally {
    await rm(mutantPath, { force: true });
  }
}

test('MS1: letting the layout report change the verdict (the forbidden trap) breaks S1', async () => {
  const mutant = await withAccountUnionMutant('layout-wins', (source) => source.replace(
    'view.verdict = verdict;',
    `view.verdict = (view.declaredLayout?.differs && verdict === 'primary_only') ? 'layout_drift' : verdict;`,
  ));
  const r = mutant.unionAccountDecode({
    program: PROGRAM,
    primary: source(onchain, 'metadata', 'metadata'),
    secondary: source(published, 'published', 'published'),
    bytes,
  });
  // The mutant violated S1 by turning primary_only into layout_drift.
  assert.equal(r.view.verdict, 'layout_drift', 'the mutant must produce the forbidden verdict');
  assert.notEqual(r.view.verdict, 'primary_only');
});

test('MS2: suppressing the declared layout diffs breaks S3', async () => {
  const mutant = await withAccountUnionMutant('suppress-diffs', (source) => source.replace(
    'diffs,',
    'diffs: [],',
  ));
  const r = mutant.unionAccountDecode({
    program: PROGRAM,
    primary: source(onchain, 'metadata', 'metadata'),
    secondary: source(published, 'published', 'published'),
    bytes,
  });
  // The mutant dropped the diffs that S3 requires.
  assert.deepEqual(r.view.declaredLayout.diffs, [], 'the mutant must drop the diffs');
});
