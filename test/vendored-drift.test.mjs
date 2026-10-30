import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
// A filesystem PATH, not a file:// URL: `node <url>` is not a valid invocation, and
// execFile passes its argument straight through as a module path.
const TOOL = fileURLToPath(new URL('../tools/vendored-drift.mjs', import.meta.url));

/**
 * A vendored IDL with a known address, so the tool can decide whether an on-chain
 * copy exists for it. The fixture is written here rather than read from a
 * repository, because what these tests check is the TOOL's rules — a stale copy
 * must be counted, an unbound copy must be counted differently, and a program with
 * no on-chain IDL must not be counted as stale at all.
 */
async function writeFixture(dir, name, idl) {
  const idlDir = path.join(dir, 'idl');
  await mkdir(idlDir, { recursive: true });
  await writeFile(path.join(idlDir, name), `${JSON.stringify(idl, null, 2)}\n`);
}

async function tool(args) {
  try {
    const { stdout } = await run(process.execPath, [TOOL, ...args], { maxBuffer: 32 * 1024 * 1024 });
    return { status: 0, stdout };
  } catch (error) {
    return { status: error.code ?? 1, stdout: error.stdout ?? '' };
  }
}

/** The smallest thing that counts as a usable IDL: instructions with discriminators. */
const instruction = (name, disc) => ({
  name,
  discriminator: [...Buffer.from(disc, 'hex')],
  accounts: [],
  args: [],
});

test('a stale vendored copy is counted, and the missing names are listed', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'drift-stale-'));
  const store = await mkdtemp(path.join(tmpdir(), 'drift-store-'));
  try {
    await writeFixture(dir, 'amm.json', {
      address: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
      instructions: [instruction('route', '0000000000000001')],
    });
    await tool(['--repo', dir, '--store', store]); // no artifacts yet: no on-chain copy
    const out = path.join(dir, 'report.json');
    const res = await tool(['--repo', dir, '--store', store, '--out', out]);
    assert.equal(res.status, 0, res.stdout);
    const report = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(report.stale, 0, 'a program with no stored artifact cannot be called stale');
    assert.equal(report.withOnChain, 0);
    assert.equal(report.findings[0].onChainAvailable, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }
});

test('a vendored file with no program address is unbound, not stale', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'drift-unbound-'));
  const store = await mkdtemp(path.join(tmpdir(), 'drift-store2-'));
  try {
    await writeFixture(dir, 'nameless.json', {
      instructions: [instruction('swap', '0000000000000002')],
    });
    const out = path.join(dir, 'report.json');
    const res = await tool(['--repo', dir, '--store', store, '--out', out]);
    assert.equal(res.status, 0, res.stdout);
    const report = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(report.unbound, 1, 'an unbound file must be reported as its own defect');
    assert.equal(report.stale, 0, 'an unbound file is not a stale copy');
    assert.equal(report.findings[0].defect, 'unbound');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }
});

test('a file with no instructions is not a finding at all', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'drift-empty-'));
  try {
    await writeFixture(dir, 'empty.json', { address: 'x', instructions: [] });
    const out = path.join(dir, 'report.json');
    const res = await tool(['--repo', dir, '--out', out]);
    assert.equal(res.status, 0, res.stdout);
    const report = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(report.files, 0, 'an IDL with no instructions carries no decoder site');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an unparsable vendored file is reported, not silently skipped', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'drift-bad-'));
  const store = await mkdtemp(path.join(tmpdir(), 'drift-store3-'));
  try {
    const idlDir = path.join(dir, 'idl');
    await mkdir(idlDir, { recursive: true });
    await writeFile(path.join(idlDir, 'broken.json'), '{not json');
    const out = path.join(dir, 'report.json');
    const res = await tool(['--repo', dir, '--store', store, '--out', out]);
    assert.equal(res.status, 0, res.stdout);
    const report = JSON.parse(await readFile(out, 'utf8'));
    assert.ok(
      report.findings.some((f) => f.defect === 'unparsable'),
      'a file that cannot be parsed must be named, not dropped',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }
});

test('the committed report is the one the tool produces (no hand-edited numbers)', async (t) => {
  const reportPath = fileURLToPath(new URL('../research/vendored-drift-tx-remix-2026-10-30.json', import.meta.url));
  let committed;
  try {
    committed = JSON.parse(await readFile(reportPath, 'utf8'));
  } catch {
    t.fail(`committed drift report missing at ${reportPath}`);
    return;
  }
  assert.ok(Array.isArray(committed.findings) && committed.findings.length > 0);
  // The headline this repository publishes. If it is not what the findings add up
  // to, the report and the tool have drifted apart.
  const stale = committed.findings.filter(
    (f) => f.onChainAvailable && f.missingOnChain.length > 0,
  ).length;
  assert.equal(
    committed.stale,
    stale,
    'summary.stale must equal the number of findings with missing instructions',
  );
});
