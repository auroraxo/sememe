// Measure the account union on the PUBLISHED v0.4.12 tag, installed from
// github into an empty directory — no clone, no checkout.
//
//   node tools/measure-account-union-tag.mjs [--tag v0.4.12] [--out <file>]
//
// Why a second artifact when research/account-union-2026-11-08.json exists:
// the working tree is not what a stranger installs. This repo has measured
// "fixed on main, absent from the tag" as its most repeated defect class, so
// the account union is re-measured on the exact bytes the documented install
// command delivers (`npm install github:auroraxo/sememe#<tag>`), from a
// directory that holds nothing else.
//
// Exit 0 the tag delivers the feature; 1 it does not (that is a finding, not
// an error to hide); 2 usage.

import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, mkdtemp as mktemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const v = args[i + 1];
  if (v === undefined) throw Error(`missing value for ${name}`);
  args.splice(i, 2);
  return v;
};

const TAG = flag('--tag', 'v0.4.12');
const OUT = flag('--out', path.join(ROOT, 'research', `account-union-${TAG}-tag-install.json`));

if (!/^v\d+\.\d+\.\d+$/.test(TAG)) {
  console.error(`--tag must look like v1.2.3, got ${TAG}`);
  process.exit(2);
}

const FIX = path.join(ROOT, 'test', 'fixtures');
const PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

const onchain = JSON.parse(await readFile(path.join(FIX, 'pump-idl.json'), 'utf8'));
const published = JSON.parse(await readFile(path.join(FIX, 'pump-published-idl.json'), 'utf8'));
const accounts = JSON.parse(await readFile(path.join(FIX, 'accounts-pump-2026-11-08.json'), 'utf8'));

const app = await mkdtemp(path.join(os.tmpdir(), 'sememe-tag-app-'));
try {
  await writeFile(path.join(app, 'package.json'),
    JSON.stringify({ name: 'stranger', version: '1.0.0', private: true }, null, 2) + '\n');
  execFileSync('npm', ['install', `github:auroraxo/sememe#${TAG}`, '--no-audit', '--no-fund'],
    { cwd: app, encoding: 'utf8', timeout: 300_000 });

  const require_ = createRequire(path.join(app, 'package.json'));
  const installed = require_.resolve('sememe/package.json');
  const installedPkg = JSON.parse(await readFile(installed, 'utf8'));
  const installDir = path.dirname(installed);

  // The feature must be on the INSTALLED bytes, not on this checkout: the entry
  // must export it, and the CLI must declare the flag.
  const entry = await import(path.join(installDir, 'index.mjs'));
  const cliSurface = await readFile(path.join(installDir, 'src', 'cli-surface.mjs'), 'utf8')
    .catch(() => null);

  const declaresUnionFlag = cliSurface
    ? /account:[\s\S]{0,200}?--union/.test(cliSurface)
    : false;
  const entryExportsUnion = typeof entry.decodeUnionStoredAccount === 'function'
    && typeof entry.unionAccountDecode === 'function';

  // A store built the way the product builds it: the on-chain copy as a pull,
  // the published copy adopted next to it — both read through the INSTALLED
  // store reader.
  const store = await mktemp(path.join(os.tmpdir(), 'sememe-tag-store-'));
  await mkdir(path.join(store, 'objects'), { recursive: true });
  await mkdir(path.join(store, 'receipts'), { recursive: true });
  const bytes = Buffer.from(entry.canonicalJson(onchain) + '\n');
  const fingerprint = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(store, 'objects', `${fingerprint}.json`), bytes);
  await writeFile(path.join(store, 'receipts', `${PROGRAM}-466833000-metadata-${fingerprint}.json`),
    Buffer.from(entry.canonicalJson({
      program: PROGRAM, source: 'metadata', slot: 466833000,
      fingerprint: `sha256:${fingerprint}`, instructionCount: onchain.instructions.length,
    }) + '\n'));
  const publishedFile = path.join(store, 'published.json');
  await writeFile(publishedFile, JSON.stringify(published));
  await entry.adopt(PROGRAM, publishedFile, store, { source: 'published', origin: 'pump-published-idl.json' });

  const rows = [];
  for (const account of accounts.accounts) {
    const plain = await entry.decodeStoredAccount(store, PROGRAM, account.dataBase64);
    const union = await entry.decodeUnionStoredAccount(store, PROGRAM, account.dataBase64);
    rows.push({
      bytes: union.bytes,
      account: union.account,
      singleSourceByteExact: plain.roundTripByteExact,
      singleSourceTrailing: plain.trailing.count,
      unionByteExact: union.roundTripByteExact,
      unionTrailing: union.trailing.count,
      verdict: union.view.verdict,
      basis: union.view.arbitration?.basis ?? null,
      evidence: union.view.arbitration?.evidence ?? null,
    });
  }

  const cliUnion = execFileSync(process.execPath,
    [path.join(installDir, 'bin', 'sememe.mjs'), 'account', '--union', PROGRAM,
      accounts.accounts[0].dataBase64, '--store', store],
    { encoding: 'utf8', timeout: 60_000 });
  const cliParsed = JSON.parse(cliUnion);

  const summary = {
    accounts: rows.length,
    singleSourceByteExact: rows.filter((r) => r.singleSourceByteExact).length,
    singleSourceLeftBytesOn: rows.filter((r) => r.singleSourceTrailing > 0).length,
    unionByteExact: rows.filter((r) => r.unionByteExact).length,
    verdicts: rows.reduce((acc, r) => {
      acc[r.verdict] = (acc[r.verdict] ?? 0) + 1;
      return acc;
    }, {}),
  };

  const report = {
    generatedAt: new Date().toISOString(),
    tag: TAG,
    install: `npm install github:auroraxo/sememe#${TAG} (empty directory, no clone)`,
    installedVersion: installedPkg.version,
    claim: 'the account union a stranger receives from the documented install command '
      + 'arbitrates the two verified sources over account bytes',
    featureOnInstalledBytes: { entryExportsUnion, declaresUnionFlag },
    cliUnionExit: 0,
    cliUnionVerdict: cliParsed.view?.verdict ?? null,
    cliUnionByteExact: cliParsed.roundTripByteExact ?? null,
    summary,
    rows,
    limits: [
      'this measures the tag as installed on this host, not the tag as installed anywhere else',
      'the store is built from committed fixtures, so the two sources are the fixture copies',
      'byte-exact means the bytes are reproduced, not that the field names mean what the program intends',
    ],
  };
  await writeFile(OUT, `${JSON.stringify(report, null, 1)}\n`);

  const ok = entryExportsUnion && declaresUnionFlag
    && summary.unionByteExact === 6 && summary.singleSourceByteExact === 0;
  console.log(JSON.stringify({ out: OUT, ok, ...report.featureOnInstalledBytes, ...summary }, null, 1));
  await rm(store, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
} finally {
  await rm(app, { recursive: true, force: true });
}
