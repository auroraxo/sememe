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
 * The acquisition path may depend on a package: `acquire.mjs` derives the
 * Program Metadata PDA and the legacy `anchor:idl` address, which needs
 * sha256 + ed25519 curve checks, and it needs them exactly ONCE per program;
 * `pull.mjs` validates program ids with the same primitive (measured
 * 2026-11-01: the move of the acquisition helpers into src/ tripped this
 * allowlist on the first run — that is the gate working, and the entry was
 * then declared here). A consumer that only decodes never loads either file.
 * Every other third-party import
 * in `src/` is a defect, so the allowlist is explicit and per-file: adding a
 * new package anywhere fails this test until someone says why it is allowed.
 *
 * 2026-11-06: the peer moved behind `peer.mjs`, the one file that loads it
 * on demand so its ABSENCE is a refusal naming the install command instead of
 * a raw Node loader error. `peer.mjs` is now the only place a third-party
 * specifier may appear; `acquire.mjs` and `pull.mjs` reach the peer THROUGH
 * it, which is why they no longer carry a bare specifier.
 */
const ALLOWED = new Map([
  ['peer.mjs', ['@solana/web3.js']],
]);

/**
 * The bare (non-relative) specifiers a file imports.
 *
 * Comments are stripped first: the gate is about REAL imports, and a prose
 * example like `import { pull } from 'sememe/pull';` inside a comment is
 * documentation, not a dependency. Measured 2026-11-06: src/peer.mjs
 * documents the very failure it fixes, and the comment-blind regex read that
 * documentation as five extra third-party imports.
 */
function bareImports(source) {
  const found = [];
  const code = stripComments(String(source || ''));
  for (const match of code.matchAll(/(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g)) {
    found.push(match[1]);
  }
  for (const match of code.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    found.push(match[1]);
  }
  return found.filter((specifier) => !specifier.startsWith('node:') && !specifier.startsWith('.'));
}

/** Remove // and /* *\/ comments, keeping string literals intact. */
function stripComments(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch; i++;
      while (i < source.length) {
        if (source[i] === '\\') { out += source[i]; i++; if (i < source.length) { out += source[i]; i++; } continue; }
        out += source[i];
        if (source[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    out += ch; i++;
  }
  return out;
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
