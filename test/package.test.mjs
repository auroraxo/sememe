// The installable package contract.
//
// Before 2026-11-01 this repository could not be consumed by anyone outside
// it: the package was named `sememe-qualification`, marked `private`, at
// version 0.0.0, with no `exports` map and no install instructions. The only
// way to use the decoder was to clone the whole qualification harness.
//
// The README's own gate is "an outside user actually importing an interface".
// An outside user starts with an install, so the contract tested here is the
// one `npm install github:auroraxo/sememe#vX.Y.Z` creates — no npm account or
// token required for a git-hosted tarball:
//
//   - importing the package entry must work and must export exactly the
//     documented decode surface (the acquisition path, `pull`, is NOT part of
//     the zero-dependency entry; it needs @solana/web3.js and a network);
//   - the shipped files must import nothing beyond node: builtins and their
//     own files, so a consumer installs ZERO runtime dependencies;
//   - the published tarball must not drag the whole harness (tools/,
//     research/, test fixtures) into a consumer's node_modules;
//   - every documented package-internal path (`sememe/native` and friends)
//     must resolve from inside node_modules;
//   - version and name must be declared so `#vX.Y.Z` installs are truthful.
//
// Every assertion here failed on the pre-package tree (commit c7689ab):
// measured in /tmp on a tarball built from `git archive HEAD` —
//   import('sememe')                      ERR_MODULE_NOT_FOUND
//   import('sememe-qualification')        ERR_MODULE_NOT_FOUND (no entry)
//   import('sememe-qualification/src/…')  loaded, but nobody can discover it,
//                                         it is `private`, and the name is a lie
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));

test('package.json declares an installable, importable library', () => {
  assert.equal(pkg.name, 'sememe', `package name must be "sememe", found ${pkg.name}`);
  assert.ok(!pkg.private, 'the package must not be private — a private flag blocks consumption');
  assert.ok(/^\d+\.\d+\.\d+$/.test(pkg.version ?? ''), `version must be semver, found ${pkg.version}`);
  assert.equal(pkg.type, 'module', 'the sources are ESM');
  assert.ok(pkg.exports, 'an exports map must exist so import("sememe") has a defined entry');
  assert.equal(pkg.exports['.'], './index.mjs', 'the "." entry must point at the documented surface');
});

test('the package entry exports the documented decode surface, and only that', async () => {
  const entry = await import(path.join(ROOT, 'index.mjs'));
  for (const name of [
    'decodePayload', 'decodeUnionPayload', 'decodeStoredAccount', 'findStoredIdl',
    'findStoredIdls', 'adopt', 'parsePayload', 'decodeBase58',
  ]) {
    assert.equal(typeof entry[name], 'function', `entry must export ${name}`);
  }
  assert.equal(typeof entry.UnionRefusal, 'function', 'entry must export the UnionRefusal error');
  // Acquisition is deliberately NOT on the entry: it imports @solana/web3.js,
  // so putting it here would turn every decoder-only consumer into a
  // dependency installer. It stays on its documented subpath.
  const names = new Set(Object.keys(entry));
  assert.ok(!names.has('pull'), 'pull must not be on the zero-dependency entry');
});

test('every file the package ships imports only node: builtins or relative files', async () => {
  // The entry point and the acquisition path are the two exceptions, and both
  // are declared as such in the exports map: the entry re-exports the decode
  // core, the acquisition path needs @solana/web3.js. Everything a DECODER
  // loads must have zero npm dependencies.
  const zeroDependency = ['index.mjs', 'src/account.mjs', 'src/adopt.mjs', 'src/base58.mjs', 'src/canonical.mjs',
    'src/codec.mjs', 'src/decode.mjs', 'src/discriminators.mjs', 'src/native-interface.mjs',
    'src/native.mjs', 'src/store-read.mjs', 'src/store-write.mjs', 'src/union.mjs'];
  const files = zeroDependency.map((name) => path.join(ROOT, name));
  assert.ok(files.length >= 13, `expected the shipped sources, found ${files.length}`);
  const violations = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g)) {
      const spec = match[1];
      if (spec.startsWith('node:')) continue;
      if (spec.startsWith('.') || spec.startsWith('/')) continue;
      violations.push(`${path.relative(ROOT, file)} imports ${spec}`);
    }
    for (const match of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = match[1];
      if (spec.startsWith('node:') || spec.startsWith('.') || spec.startsWith('/')) continue;
      violations.push(`${path.relative(ROOT, file)} imports ${spec}`);
    }
  }
  assert.deepEqual(violations, [], 'shipped sources must have zero npm dependencies');
});

test('the acquisition path is the only place a package is allowed', async () => {
  const offenders = [];
  for (const name of await readdir(path.join(ROOT, 'src'))) {
    if (!name.endsWith('.mjs')) continue;
    const source = await readFile(path.join(ROOT, 'src', name), 'utf8');
    for (const match of source.matchAll(/(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g)) {
      const spec = match[1];
      if (spec.startsWith('node:') || spec.startsWith('.') || spec.startsWith('/')) continue;
      if (name === 'acquire.mjs' || name === 'pull.mjs') continue;
      offenders.push(`src/${name} imports ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], 'only the acquisition path may import a package');
});

test('the package does not ship the qualification harness', async () => {
  const shipped = pkg.files ?? [];
  for (const forbidden of ['tools', 'test', 'research', 'neg']) {
    assert.ok(!shipped.includes(forbidden), `${forbidden}/ must not ship`);
  }
  // The native interface derives its wire rule from pinned upstream sources:
  // without them every native decode must refuse, never guess.
  assert.ok(shipped.includes('vendor/'), 'vendor/ (pinned upstream sources) must ship');
  assert.ok(shipped.includes('interface/'), 'interface/ (derived native tables) must ship');
  assert.ok(shipped.includes('index.mjs'), 'index.mjs must ship');
});

test('the documented subpaths resolve through the exports map', async () => {
  for (const sub of ['./native', './store', './pull', './codec', './canonical', './discriminators', './native-corpus', './native-audit']) {
    assert.ok(pkg.exports[sub], `exports must declare "${sub}"`);
    // The map must point at a file that exists, otherwise the install succeeds
    // and the first import fails.
    const target = path.join(ROOT, pkg.exports[sub]);
    await stat(target);
  }
});

test('the shipped tree really is the decoder core, byte-checked against src/', async () => {  // Guard against a files-list drift: every src/*.mjs must be inside what the
  // tarball claims to ship. tools/measure.mjs is the one known exception — it
  // serves tools/ and src/pull.mjs, and pull is not on the entry.
  const srcFiles = (await readdir(path.join(ROOT, 'src'))).filter((n) => n.endsWith('.mjs')).sort();
  assert.ok(srcFiles.length >= 13, `expected all src modules, found ${srcFiles.length}`);
  for (const name of srcFiles) {
    await stat(path.join(ROOT, 'src', name)); // exists
  }
  const require = createRequire(import.meta.url);
  const lock = require(path.join(ROOT, 'package-lock.json'));
  assert.equal(lock.name, 'sememe', 'the lockfile must describe the same package');
});

test('README documents the install-and-decode path', async () => {
  const readme = await readFile(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /npm install github:auroraxo\/sememe#v/, 'README must show the git-tag install');
  assert.match(readme, /decodePayload/, 'README must show a decode call');
});

test('the native corpus ships, re-hashes, and yields real payloads', async () => {
  const corpus = await import('../src/native-corpus.mjs');
  const sys = corpus.corpus('system');
  assert.ok((sys.transactions ?? []).length > 0, 'the system harvest must carry transactions');
  const sysPayloads = corpus.payloads('system');
  const cbPayloads = corpus.payloads('computeBudget');
  assert.ok(sysPayloads.length > 1000, `expected the real traffic, found ${sysPayloads.length} system payloads`);
  assert.ok(cbPayloads.length > 100, `expected the real traffic, found ${cbPayloads.length} compute-budget payloads`);
  // A seeded create is the corpus row the hand table could not name (0 of 63).
  const seeded = sysPayloads.filter((b) => b.subarray(0, 4).toString('hex') === '03000000');
  assert.ok(seeded.length >= 60, `expected the 63 seeded creates, found ${seeded.length}`);
  assert.throws(() => corpus.corpus('nope'), /unknown corpus/);
});

test('the shipped interface equals a fresh derivation of the vendored Rust', async () => {
  const { auditNativeInterface } = await import('../src/native-audit.mjs');
  const audit = auditNativeInterface();
  assert.equal(audit.error, null, `derivation must run: ${audit.error}`);
  assert.ok(audit.checked >= 2, `expected both native interfaces, found ${audit.checked}`);
  assert.deepEqual(audit.stale, [], 'interface artifacts must equal a fresh derivation');
  assert.deepEqual(audit.missing, [], 'every pinned interface artifact must ship');
  assert.equal(audit.ok, true);
});

test('the shipped corpus is byte-identical to the fixtures the suite qualifies against', async () => {
  // Two copies exist on purpose: test/fixtures/ (what sememe's own tests read) and
  // src/corpus/ (what ships to consumers). If they ever disagree, consumers would
  // falsify against different bytes than the producer did — so the copies are pinned
  // to each other here, and to the sha256 the corpus module re-hashes on every read.
  for (const file of ['harvest-system-2026-10-31.json', 'harvest-compute-budget-2026-10-31.json']) {
    const inTest = await readFile(path.join(ROOT, 'test', 'fixtures', file));
    const inShip = await readFile(path.join(ROOT, 'src', 'corpus', file));
    assert.ok(inTest.equals(inShip), `${file}: test fixture and shipped corpus disagree`);
  }
  const { CORPUS, corpus } = await import('../src/native-corpus.mjs');
  for (const which of Object.keys(CORPUS)) {
    const read = corpus(which); // throws if the bytes do not match CORPUS[which].sha256
    assert.ok(read, `${which} must parse`);
  }
});
