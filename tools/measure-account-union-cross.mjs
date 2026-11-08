#!/usr/bin/env node
// tools/measure-account-union-cross.mjs — DOES ACCOUNT-UNION ARBITRATION
// GENERALIZE BEYOND THE ONE PROGRAM IT WAS BUILT ON?
//
// v0.4.12 shipped `sememe account --union` with a measurement over exactly ONE
// program (pump.fun, research/account-union-2026-11-08.json), and the README
// named that as a limit: "one program, one account window: this measures a
// drift that exists, not how common it is across the ecosystem."
//
// This tool puts the same arbitration over EVERY program the repo holds real
// mainnet account bytes for, so the headline can be falsified instead of
// extrapolated:
//
//   TWO-SOURCE programs (an on-chain copy AND a first-party published copy,
//   both committed fixtures, both re-hashed through the store reader):
//     pump.fun         12 real accounts   the program the feature was built on
//     meteora-vault    12 real accounts   second program, fresh harvest
//     meteora-damm-v1  11 real accounts   third program, fresh harvest — its
//                                          published copy declares 5 account
//                                          types (the on-chain copy 3) with
//                                          EXPLICIT discriminators
//     openbook-v2       4 real accounts   second program, older harvest
//
//   SINGLE-SOURCE controls (no published copy exists): whirlpool (27),
//   kamino-lend (8) — the union must report `single_source` and change nothing.
//
// What would FALSIFY the general claim "the arbitration recovers byte-exact
// answers where the single-source path left bytes unexplained":
//
//   * a REGRESSION: an account the plain path answered byte-exactly and the
//     union path did not (the union picking a worse source);
//   * an account the plain path decoded that the union refuses outright;
//   * a control (single-source) program where the verdict is NOT
//     `single_source`.
// Every one of those is counted in `invariants` and must be 0. The positive
// claim is deliberately narrower and reported per program: on some programs
// the copies AGREE (nothing to recover), on some the second copy cannot even
// identify the bytes (nothing to fall back to).
//
// The store is built from committed fixtures with NO network access: the
// on-chain copy becomes a pulled receipt under a SYNTHETIC slot (recorded as
// `slotKind: "synthetic"` in the artifact — it only exists to make the receipt
// read as an on-chain pull rather than an adopted copy), the published copy is
// adopted with `sememe adopt`'s own writer.
//
// Exit codes: 0 the measurement ran and its verdict is recorded; 1 it could
// not run (a fixture missing, no accounts, no store sources) — never a
// silently empty report; 3 NO VERDICT (a source failed mid-run).

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../src/canonical.mjs';
import { adopt } from '../src/adopt.mjs';
import { decodeStoredAccount, decodeUnionStoredAccount } from '../src/decode.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (value === undefined) throw Error(`missing value for ${name}`);
  args.splice(index, 2);
  return value;
};
const OUT = option('--out', path.join(ROOT, 'research', 'account-union-cross-2026-11-08.json'));

// The slot written into the synthetic on-chain receipt. It is NOT a claim
// about where these IDLs were pulled from — see the header. It only has to be
// a real slot number so the receipt sorts as an on-chain pull next to the
// adopted copy (which carries no slot at all).
const SYNTHETIC_SLOT = 466833000;

const PROGRAMS = [
  {
    name: 'pump.fun',
    program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    onchain: 'pump-idl.json',
    published: 'pump-published-idl.json',
    accounts: 'accounts-pump-2026-11-08.json',
    role: 'the program the feature was built on',
  },
  {
    name: 'meteora-vault',
    program: '24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi',
    onchain: 'meteora-vault-idl.json',
    published: 'meteora-vault-published-idl.json',
    accounts: 'accounts-meteora-vault-2026-11-08.json',
    role: 'second two-source program, fresh harvest',
  },
  {
    name: 'meteora-damm-v1',
    program: 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB',
    onchain: 'meteora-damm-v1-idl.json',
    published: 'meteora-damm-v1-published-idl.json',
    accounts: 'accounts-meteora-damm-v1-2026-11-08.json',
    role: 'third two-source program, fresh harvest',
  },
  {
    name: 'openbook-v2',
    program: 'opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb',
    onchain: 'openbook-v2-idl.json',
    published: 'openbook-v2-published-idl.json',
    accounts: 'accounts-openbook-v2-2026-10-29.json',
    role: 'second two-source program, older harvest',
  },
  {
    name: 'whirlpool',
    program: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
    onchain: 'whirlpool-idl.json',
    published: null,
    accounts: 'accounts-whirlpool-2026-10-29.json',
    role: 'single-source control: no published copy exists',
  },
  {
    name: 'kamino-lend',
    program: 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD',
    onchain: 'kamino-lend-idl.json',
    published: null,
    accounts: 'accounts-kamino-lend-2026-10-29.json',
    role: 'single-source control: no published copy exists',
  },
];

const loadFixture = async (file) => {
  try {
    return JSON.parse(await readFile(path.join(FIXTURES, file), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

/** Build a store holding the on-chain copy as a pull and (if any) the
 *  published copy as an adopted second source — both through the store
 *  reader, so both are re-hashed against their receipts on every read. */
async function buildStore(spec) {
  const onchain = await loadFixture(spec.onchain);
  if (!onchain) throw Error(`missing fixture ${spec.onchain}`);
  const published = spec.published ? await loadFixture(spec.published) : null;
  if (spec.published && !published) throw Error(`missing fixture ${spec.published}`);

  const dir = await mkdtemp(path.join(os.tmpdir(), 'sememe-account-union-cross-'));
  await mkdir(path.join(dir, 'objects'), { recursive: true });
  await mkdir(path.join(dir, 'receipts'), { recursive: true });

  const bytes = Buffer.from(canonicalJson(onchain) + '\n');
  const fingerprint = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(dir, 'objects', `${fingerprint}.json`), bytes);
  await writeFile(
    path.join(dir, 'receipts', `${spec.program}-${SYNTHETIC_SLOT}-metadata-${fingerprint}.json`),
    Buffer.from(canonicalJson({
      program: spec.program,
      source: 'metadata',
      slot: SYNTHETIC_SLOT,
      fingerprint: `sha256:${fingerprint}`,
      instructionCount: (onchain.instructions ?? []).length,
    }) + '\n'),
  );
  if (published) {
    await adopt(spec.program, path.join(FIXTURES, spec.published), dir, {
      source: 'published',
      origin: spec.published,
    });
  }
  return { dir, onchain, published };
}

const programs = [];
const invariants = {
  // A REGRESSION: plain answered byte-exactly, union did not. The union
  // picking a worse source than the one it replaced would be the worst
  // possible outcome of adding arbitration — it must never happen.
  unionRegressedWherePlainWasExact: [],
  // An account the plain path decoded that the union refused outright
  // (name_conflict or otherwise): arbitration must not take answers away.
  unionRefusedWherePlainAnswered: [],
  // A single-source control whose verdict is not `single_source`.
  controlVerdictNotSingleSource: [],
  // A row the two paths DISAGREE on about the account NAME (the plain path
  // and the union naming different account types for the same bytes).
  plainUnionNameMismatch: [],
};

let fatal = null;
for (const spec of PROGRAMS) {
  const accounts = await loadFixture(spec.accounts);
  if (!accounts || !Array.isArray(accounts.accounts) || accounts.accounts.length === 0) {
    throw new Error(`missing or empty account fixture ${spec.accounts}`);
  }
  const store = await buildStore(spec);
  try {
    const rows = [];
    for (const account of accounts.accounts) {
      let plain = null;
      let plainError = null;
      try {
        const p = await decodeStoredAccount(store.dir, spec.program, account.dataBase64);
        plain = {
          source: p.idl.source,
          slot: p.idl.slot ?? null,
          account: p.account,
          consumed: p.consumed,
          trailing: p.trailing.count,
          roundTripByteExact: p.roundTripByteExact,
        };
      } catch (error) {
        plainError = String(error?.message ?? error).slice(0, 300);
      }

      let union = null;
      let unionError = null;
      let unionCode = null;
      try {
        const u = await decodeUnionStoredAccount(store.dir, spec.program, account.dataBase64);
        union = {
          verdict: u.view.verdict,
          account: u.account,
          consumed: u.consumed,
          trailing: u.trailing.count,
          roundTripByteExact: u.roundTripByteExact,
          sourcesAgree: u.view.sourcesAgree,
          basis: u.view.arbitration?.basis ?? null,
          winner: u.view.arbitration?.winner ?? null,
          primary: {
            label: u.view.primary.label,
            decoded: u.view.primary.decoded,
            refusedReason: u.view.primary.refusedReason ?? null,
            trailingBytes: u.view.primary.trailingBytes ?? null,
          },
          secondary: u.view.secondary?.present
            ? {
              label: u.view.secondary.label,
              decoded: u.view.secondary.decoded,
              refusedReason: u.view.secondary.refusedReason ?? null,
              trailingBytes: u.view.secondary.trailingBytes ?? null,
            }
            : null,
        };
      } catch (error) {
        unionError = String(error?.message ?? error).slice(0, 300);
        unionCode = error?.code ?? null;
      }

      // Invariants — each one would falsify the general claim.
      if (plain?.roundTripByteExact && union && !union.roundTripByteExact) {
        invariants.unionRegressedWherePlainWasExact.push(`${spec.name}/${account.address}`);
      }
      if (plain && unionError) {
        invariants.unionRefusedWherePlainAnswered.push(`${spec.name}/${account.address}: ${unionCode} ${unionError}`);
      }
      if (plain && union && plain.account !== union.account) {
        invariants.plainUnionNameMismatch.push(`${spec.name}/${account.address}: ${plain.account} != ${union.account}`);
      }
      if (!spec.published && union && union.verdict !== 'single_source') {
        invariants.controlVerdictNotSingleSource.push(`${spec.name}/${account.address}: ${union.verdict}`);
      }

      rows.push({
        address: account.address,
        bytes: Buffer.from(account.dataBase64, 'base64').length,
        plain,
        plainError,
        union,
        unionError,
        unionCode,
      });
    }

    const twoSource = Boolean(spec.published);
    const verdicts = rows.reduce((acc, r) => {
      const key = r.union ? r.union.verdict : `refused:${r.unionCode}`;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});

    const plainByteExact = rows.filter((r) => r.plain?.roundTripByteExact).length;
    const unionByteExact = rows.filter((r) => r.union?.roundTripByteExact).length;
    const plainLeavesBytes = rows.filter((r) => r.plain && r.plain.trailing > 0).length;

    programs.push({
      name: spec.name,
      role: spec.role,
      program: spec.program,
      sources: {
        onchain: spec.onchain,
        published: spec.published,
        twoSource,
      },
      accounts: rows.length,
      summary: {
        plainDecoded: rows.filter((r) => r.plain).length,
        plainRefused: rows.filter((r) => r.plainError).length,
        plainLeftBytesOn: plainLeavesBytes,
        plainByteExact,
        unionByteExact,
        // The case the feature exists for: plain left bytes unexplained,
        // union answered byte-exactly.
        recoveredByArbitration: rows.filter((r) => r.plain && r.plain.trailing > 0 && r.union?.roundTripByteExact).length,
        verdicts,
        // Second source present but unable to identify these bytes — the
        // honest no-fallback state, kept visible instead of averaged away.
        secondaryRefused: rows.filter((r) => r.union?.secondary && !r.union.secondary.decoded).length,
      },
      rows,
    });
  } finally {
    await rm(store.dir, { recursive: true, force: true });
  }
}

const twoSourcePrograms = programs.filter((p) => p.sources.twoSource);
const controlPrograms = programs.filter((p) => !p.sources.twoSource);

const totals = {
  programs: programs.length,
  accounts: programs.reduce((n, p) => n + p.accounts, 0),
  twoSourcePrograms: twoSourcePrograms.length,
  controlPrograms: controlPrograms.length,
  plainByteExact: programs.reduce((n, p) => n + p.summary.plainByteExact, 0),
  unionByteExact: programs.reduce((n, p) => n + p.summary.unionByteExact, 0),
  recoveredByArbitration: programs.reduce((n, p) => n + p.summary.recoveredByArbitration, 0),
  // On how many of the two-source programs did arbitration recover anything?
  twoSourceProgramsWithRecovery: twoSourcePrograms.filter((p) => p.summary.recoveredByArbitration > 0).length,
};

const invariantFailures = Object.fromEntries(
  Object.entries(invariants).map(([key, list]) => [key, list.length]),
);
const ok = Object.values(invariantFailures).every((n) => n === 0);

const report = {
  measuredAt: new Date().toISOString(),
  claim: 'account-union arbitration measured across EVERY program with real account bytes in the repo: '
    + 'per-program recovery, agreement, and refusal — with regression invariants that must stay 0',
  method: {
    store: 'built from committed fixtures, no network: on-chain copy as a pulled receipt under a synthetic slot, published copy via sememe adopt',
    slotKind: 'synthetic',
    slot: SYNTHETIC_SLOT,
    fixtures: 'test/fixtures',
  },
  totals,
  invariants,
  invariantFailures,
  ok,
  limits: [
    'fixture bytes, not a live harvest: the accounts were harvested on the dates their fixture names carry, from the RPC each fixture records',
    'a synthetic slot stands in for a real pull — it changes which receipt is "newest", it must not change which source answers (that is what the controls check)',
    'a byte-exact round trip proves the bytes are REPRODUCED, not that the field names mean what the program intends',
    'the published copy is adopted content: its origin is declared, never verified against the deployed program',
    'only programs with committed account fixtures are measured — absence of a program here is absence of data, not a verdict',
  ],
  programs,
};

if (!ok) {
  await writeFile(OUT, `${JSON.stringify(report, null, 1)}\n`);
  console.error(JSON.stringify({ out: OUT, ok, invariantFailures }, null, 1));
  process.exit(1);
}
if (totals.accounts === 0 || twoSourcePrograms.length === 0) {
  console.error('no verdict: nothing measured');
  process.exit(3);
}
await writeFile(OUT, `${JSON.stringify(report, null, 1)}\n`);
console.log(JSON.stringify({ out: OUT, ok, totals, invariantFailures }, null, 1));
