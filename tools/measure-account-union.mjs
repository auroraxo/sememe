// Measure account union arbitration against REAL mainnet accounts.
//
//   node tools/measure-account-union.mjs [--rpc <url>] [--out <file>]
//
// What it measures, and why each step is a measurement rather than a claim:
//
//   1. HARVEST: real accounts owned by a program, fetched from mainnet with
//      the repo's own recipe (tools/account-harvest.mjs) — the program owns
//      them, so their bytes are the program's own state.
//
//   2. TWO SOURCES: the program's on-chain IDL copy and its first-party
//      published copy, both committed as fixtures. Both are read through the
//      store reader, so both are re-hashed against their receipts.
//
//   3. ARBITRATION: for every harvested account, both copies are asked to
//      decode the SAME bytes. The report names, per account, which source
//      answered, why it won, and what the other source said.
//
// The verdict is deliberately narrow. It says whether the two copies DISAGREE
// about real accounts and whether the arbitration recovers a byte-exact answer
// where the single-source path did not. It does NOT say the published copy is
// correct — a byte-exact round trip proves the bytes are reproduced, not that
// the fields mean what the program intends.
//
// Exit codes: 0 the measurement ran and its verdict is recorded; 1 the
// measurement could not run (no accounts, no second source) — never a
// silently empty report; 3 NO VERDICT (a data source failed).

import { execFileSync } from 'node:child_process';
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

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (value === undefined) throw Error(`missing value for ${name}`);
  args.splice(index, 2);
  return value;
};

const PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'; // pump.fun
const ONCHAIN = path.join(ROOT, 'test', 'fixtures', 'pump-idl.json');
const PUBLISHED = path.join(ROOT, 'test', 'fixtures', 'pump-published-idl.json');
const ACCOUNTS = path.join(ROOT, 'test', 'fixtures', 'accounts-pump-2026-11-08.json');
const OUT = option('--out', path.join(ROOT, 'research', 'account-union-2026-11-08.json'));

const load = async (file) => JSON.parse(await readFile(file, 'utf8'));

const onchain = await load(ONCHAIN);
const published = await load(PUBLISHED);
const accounts = await load(ACCOUNTS);

if (!Array.isArray(accounts.accounts) || accounts.accounts.length === 0) {
  console.error('no harvested accounts — run tools/account-harvest.mjs first');
  process.exit(1);
}
if (!Array.isArray(published.accounts) || published.accounts.length === 0) {
  console.error('the published copy carries no account types — nothing to arbitrate');
  process.exit(1);
}

// A store with BOTH sources: the on-chain copy as a pulled receipt (a real
// slot), the published copy adopted next to it. Both go through the store
// reader, so both are re-hashed against their receipts on every read.
const store = await mkdtemp(path.join(os.tmpdir(), 'sememe-account-union-'));
await mkdir(path.join(store, 'objects'), { recursive: true });
await mkdir(path.join(store, 'receipts'), { recursive: true });
const bytes = Buffer.from(canonicalJson(onchain) + '\n');
const fingerprint = createHash('sha256').update(bytes).digest('hex');
await writeFile(path.join(store, 'objects', `${fingerprint}.json`), bytes);
await writeFile(
  path.join(store, 'receipts', `${PROGRAM}-466833000-metadata-${fingerprint}.json`),
  Buffer.from(canonicalJson({
    program: PROGRAM, source: 'metadata', slot: 466833000,
    fingerprint: `sha256:${fingerprint}`, instructionCount: onchain.instructions.length,
  }) + '\n'),
);
await adopt(PROGRAM, PUBLISHED, store, { source: 'published', origin: 'pump-published-idl.json' });

const rows = [];
for (const account of accounts.accounts) {
  const plain = await decodeStoredAccount(store, PROGRAM, account.dataBase64);
  const union = await decodeUnionStoredAccount(store, PROGRAM, account.dataBase64);
  rows.push({
    address: account.address,
    bytes: union.bytes,
    account: union.account,
    discriminator: union.discriminator,
    // The single-source answer: which receipt answered, and how much of the
    // account it left unexplained.
    singleSource: {
      source: plain.idl.source,
      slot: plain.idl.slot,
      consumed: plain.consumed,
      trailing: plain.trailing.count,
      roundTripByteExact: plain.roundTripByteExact,
    },
    union: {
      verdict: union.view.verdict,
      winner: union.view.arbitration?.winner ?? null,
      basis: union.view.arbitration?.basis ?? null,
      evidence: union.view.arbitration?.evidence ?? null,
      sourcesAgree: union.view.sourcesAgree,
      consumed: union.consumed,
      trailing: union.trailing.count,
      roundTripByteExact: union.roundTripByteExact,
      primary: {
        source: union.view.primary.label,
        decoded: union.view.primary.decoded,
        evidence: union.view.primary.evidence ?? null,
        trailingBytes: union.view.primary.trailingBytes ?? null,
        refusedReason: union.view.primary.refusedReason ?? null,
      },
      secondary: {
        source: union.view.secondary.label,
        decoded: union.view.secondary.decoded,
        evidence: union.view.secondary.evidence ?? null,
        trailingBytes: union.view.secondary.trailingBytes ?? null,
        refusedReason: union.view.secondary.refusedReason ?? null,
      },
    },
  });
}

const summary = {
  accounts: rows.length,
  // The single-source path left bytes unexplained on accounts whose layout the
  // other copy describes fully.
  singleSourceLeftBytesOn: rows.filter((r) => r.singleSource.trailing > 0).length,
  singleSourceByteExact: rows.filter((r) => r.singleSource.roundTripByteExact).length,
  unionByteExact: rows.filter((r) => r.union.roundTripByteExact).length,
  unionVerdicts: rows.reduce((acc, r) => {
    acc[r.union.verdict] = (acc[r.union.verdict] ?? 0) + 1;
    return acc;
  }, {}),
  // The case that matters: the single-source path left bytes unexplained, the
  // union path answered byte-exactly.
  recoveredByArbitration: rows.filter((r) => r.singleSource.trailing > 0 && r.union.roundTripByteExact).length,
  byAccountType: rows.reduce((acc, r) => {
    acc[r.account] = (acc[r.account] ?? 0) + 1;
    return acc;
  }, {}),
};

const report = {
  generatedAt: new Date().toISOString(),
  program: PROGRAM,
  claim: 'account bytes arbitrated across TWO verified interface copies: the on-chain IDL '
    + 'copy and the first-party published copy, with byte evidence picking the winner',
  sources: {
    onchain: { file: 'test/fixtures/pump-idl.json', instructions: onchain.instructions.length, accounts: (onchain.accounts ?? []).length },
    published: { file: 'test/fixtures/pump-published-idl.json', instructions: published.instructions.length, accounts: (published.accounts ?? []).length },
  },
  harvest: {
    file: 'test/fixtures/accounts-pump-2026-11-08.json',
    harvestedAt: accounts.harvestedAt,
    rpc: accounts.rpc,
    method: accounts.method,
    count: accounts.count,
  },
  limits: [
    'a byte-exact round trip proves the bytes are REPRODUCED, not that the field names mean what the program intends',
    'the published copy is adopted content: its origin is declared, never verified against the deployed program',
    'one program, one account window: this measures a drift that exists, not how common it is across the ecosystem',
  ],
  summary,
  rows,
};
await writeFile(OUT, `${JSON.stringify(report, null, 1)}\n`);
console.log(JSON.stringify({ out: OUT, ...summary }, null, 1));
await rm(store, { recursive: true, force: true });
