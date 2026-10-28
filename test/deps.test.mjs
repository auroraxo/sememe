import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');

/**
 * The files a CONSUMER imports to decode instructions. `solana-tx-remix` has
 * no package.json and no node_modules, and it is the first consumer that
 * decodes instructions from a sememe store — so these must import nothing
 * outside `node:` builtins and their own files.
 */
const DECODE_CORE = ['base58.mjs', 'canonical.mjs', 'codec.mjs', 'decode.mjs'];

/**
 * The acquisition path may depend on a package: `pull.mjs` derives the
 * Program Metadata PDA and the legacy `anchor:idl` address, which needs
 * sha256 + ed25519 curve checks, and it needs them exactly ONCE per program.
 * A consumer that only decodes never pulls. Every other third-party import
 * in `src/` is a defect, so the allowlist is explicit and per-file: adding a
 * new package anywhere fails this test until someone says why it is allowed.
 */
const ALLOWED = new Map([
  ['pull.mjs', ['@solana/web3.js']],
]);

function bareImports(source) {
  const found = [];
  for (const match of source.matchAll(/(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g)) {
    found.push(match[1]);
  }
  for (const match of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    found.push(match[1]);
  }
  return found.filter((specifier) => !specifier.startsWith('node:') && !specifier.startsWith('.'));
}

test('the decode core imports no npm package at all', async () => {
  const violations = [];
  for (const name of DECODE_CORE) {
    const source = await readFile(path.join(SRC, name), 'utf8');
    for (const specifier of bareImports(source)) {
      violations.push(`${name} imports ${specifier}`);
    }
  }
  assert.deepEqual(violations, [],
    `the decode core must be importable in a dependency-free repository:\n  ${violations.join('\n  ')}`);
});

test('no src/ file imports an npm package beyond the documented allowlist', async () => {
  const files = (await readdir(SRC)).filter((name) => name.endsWith('.mjs'));
  assert.ok(files.length >= 4, `expected the src files, found ${files.join(', ')}`);

  const violations = [];
  for (const name of files) {
    const source = await readFile(path.join(SRC, name), 'utf8');
    const allowed = ALLOWED.get(name) ?? [];
    for (const specifier of bareImports(source)) {
      if (allowed.includes(specifier)) continue;
      violations.push(`${name} imports ${specifier}`);
    }
  }
  assert.deepEqual(violations, [],
    `unexpected npm import in src/:\n  ${violations.join('\n  ')}`);
});
