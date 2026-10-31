import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The native tables used to be hand-transcribed rows in `src/native.mjs`. They are now
 * DERIVED from the vendored upstream Rust (`src/native-interface.mjs`), committed as a
 * reviewable artifact (`interface/native-<program>.json`), and re-derived AT LOAD: the
 * module refuses to decode unless the committed artifact equals a fresh derivation of
 * the vendored bytes.
 *
 * These tests pin that contract by mutation, not by assertion:
 *
 *   1. The committed artifacts are exactly today's derivation (a stale artifact fails
 *      the CLI check, so nobody approves a table nobody regenerated).
 *   2. A tampered ARTIFACT row refuses the load — the decode comes from the derivation,
 *      never from the artifact's own bytes, so editing a row cannot change what decodes.
 *   3. A tampered VENDORED SOURCE refuses the load (the hash the artifact claims).
 *   4. A MISSING vendored source refuses the load.
 *   5. Upstream's own argument names survive: the exact three names a hand
 *      transcription got wrong (`micro_lamports`, `from_seed`, `from_owner`) are pinned,
 *      and the decoded arg keys carry them.
 *
 * Falsification of the tests themselves: removing the load-time equality check turns
 * 2 and 3 into silent passes; the runtime would then decode from whichever copy won.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SYSTEM = '11111111111111111111111111111111';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';

/** A throwaway copy of everything `src/native.mjs` reads at load time. */
function copyRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sememe-native-'));
  for (const part of ['src', 'interface', 'vendor']) {
    fs.cpSync(path.join(ROOT, part), path.join(dir, part), { recursive: true });
  }
  return dir;
}

/** Import `src/native.mjs` from a copy; the load-time check runs on import. */
function loadFrom(dir) {
  const target = `${pathToFileURL(path.join(dir, 'src', 'native.mjs')).href}?t=${Date.now()}-${Math.random()}`;
  return import(target);
}

test('the committed interface artifacts are exactly what the derivation produces', () => {
  const out = execFileSync(process.execPath, ['tools/native-interface.mjs', '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const lines = out.trim().split('\n');
  assert.equal(lines.length, 2, 'both programs must be checked');
  for (const line of lines) assert.match(line, /: current \(\d+ variants, sha256:[0-9a-f]{64}\)/);
});

test('the artifacts carry the pinned source hash and dense declaration-order selectors', () => {
  for (const [program, expected] of [[SYSTEM, 14], [COMPUTE_BUDGET, 5]]) {
    const artifact = JSON.parse(fs.readFileSync(path.join(ROOT, 'interface', `native-${program}.json`), 'utf8'));
    assert.equal(artifact.program, program);
    assert.match(artifact.source.pin, /^anza-xyz\/solana-sdk@[0-9a-f]{40}$/, 'the pin is a commit hash');
    assert.match(artifact.source.fileSha256, /^sha256:[0-9a-f]{64}$/);
    assert.equal(artifact.instructions.length, expected, `${program} variant count`);
    artifact.instructions.forEach((ix, index) => assert.equal(ix.selector, index));
  }
});

test('FALSE: a tampered artifact row refuses the load instead of decoding from it', async () => {
  const dir = copyRepo();
  try {
    const file = path.join(dir, 'interface', `native-${SYSTEM}.json`);
    const artifact = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Swap two instruction names: same shape, different meaning. Exactly the edit a
    // "review the table by eye" process is supposed to catch.
    const transfer = artifact.instructions.find((ix) => ix.name === 'Transfer');
    const assign = artifact.instructions.find((ix) => ix.name === 'Assign');
    const name = transfer.name;
    transfer.name = assign.name;
    assign.name = name;
    fs.writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`);
    await assert.rejects(
      () => loadFrom(dir),
      (error) => /refuses to load/.test(error.message)
        && error.message.includes(`interface/native-${SYSTEM}.json`),
      'the refusal must name the artifact that disagrees with the derivation',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FALSE: a tampered vendored source refuses the load with the hash mismatch', async () => {
  const dir = copyRepo();
  try {
    const file = path.join(dir, 'vendor', 'anza-solana-sdk',
      '8db406e2edfafa25939ec782b77b5b6f30de164d', 'compute-budget-interface', 'src', 'lib.rs');
    const original = fs.readFileSync(file, 'utf8');
    // A one-word edit that changes a wire WIDTH — the kind of "small" hand fix that
    // broke the first consumer's table. The hash must catch it, not a reviewer.
    fs.writeFileSync(file, original.replace('SetComputeUnitLimit(u32)', 'SetComputeUnitLimit(u64)'));
    await assert.rejects(
      () => loadFrom(dir),
      (error) => /refuses to load/.test(error.message) && /sha256:[0-9a-f]{64}/.test(error.message),
      'the refusal must carry the hashes being compared',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FALSE: a missing vendored source refuses the load, not silently ignored', async () => {
  const dir = copyRepo();
  try {
    fs.rmSync(path.join(dir, 'vendor'), { recursive: true, force: true });
    await assert.rejects(() => loadFrom(dir), /ENOENT|missing|no such file/i, 'absence must be loud');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("upstream's own argument names survive; the runtime decodes with them", async () => {
  const dir = copyRepo();
  try {
    const native = await loadFrom(dir);
    const system = JSON.parse(fs.readFileSync(path.join(dir, 'interface', `native-${SYSTEM}.json`), 'utf8'));
    const computeBudget = JSON.parse(
      fs.readFileSync(path.join(dir, 'interface', `native-${COMPUTE_BUDGET}.json`), 'utf8'));

    const transferWithSeed = system.instructions.find((ix) => ix.name === 'TransferWithSeed');
    assert.deepEqual(transferWithSeed.args.map((a) => a.name), ['lamports', 'from_seed', 'from_owner'],
      'the SDK enum fields are snake_case; a hand copy had written camelCase here');
    const price = computeBudget.instructions.find((ix) => ix.name === 'SetComputeUnitPrice');
    assert.equal(price.args[0].name, 'micro_lamports', 'the SDK constructor parameter name, not camelCase');

    // The runtime decodes with those same keys, so recipes emit upstream vocabulary.
    const decoded = native.decodeNativeInstruction(
      COMPUTE_BUDGET, Buffer.from([3, 0x40, 0x0d, 0x03, 0x00, 0, 0, 0, 0]));
    assert.equal(decoded.name, 'SetComputeUnitPrice');
    assert.deepEqual(Object.keys(decoded.args), ['micro_lamports']);
    assert.equal(decoded.roundTripByteExact, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the derive module stays dependency-free: it imports only node builtins', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'native-interface.mjs'), 'utf8');
  const bare = [];
  for (const match of source.matchAll(/(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g)) {
    if (!match[1].startsWith('node:') && !match[1].startsWith('.')) bare.push(match[1]);
  }
  assert.deepEqual(bare, [], `the derivation must run without npm packages: ${bare.join(', ')}`);
});
