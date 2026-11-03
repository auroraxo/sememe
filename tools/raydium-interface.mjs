#!/usr/bin/env node
// Write the derived Raydium AMM v4 interface artifact
// (`interface/raydium-<program>.json`).
//
// The Raydium AMM v4 wire table is derived from the vendored upstream Rust
// program source by `src/raydium-interface.mjs` (see that file for the rules)
// and committed as a reviewable artifact. This tool regenerates that artifact
// from the vendored source; `--check` verifies the committed artifact is
// exactly what the derivation produces today, so a stale artifact fails
// instead of being approved by habit.
//
// Usage: node tools/raydium-interface.mjs [--check]

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveAllRaydiumInterfaces, REPO_ROOT } from '../src/raydium-interface.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
if (ROOT !== REPO_ROOT) throw Error('tool moved; src/raydium-interface.mjs resolves the repo root');
const OUT_DIR = path.join(ROOT, 'interface');
const check = process.argv.includes('--check');

const derived = deriveAllRaydiumInterfaces();

if (check) {
  for (const doc of derived) {
    const file = path.join(OUT_DIR, `raydium-${doc.program}.json`);
    const current = await readFile(file, 'utf8');
    if (current !== `${JSON.stringify(doc, null, 2)}\n`) {
      console.error(`${file}: interface artifact is stale — re-run tools/raydium-interface.mjs`);
      process.exit(1);
    }
    const hashes = doc.source.files.map((entry) => entry.sha256.slice(7, 15)).join('+');
    console.log(`${file}: current (${doc.instructions.length} variants, sha256:${hashes})`);
  }
} else {
  await mkdir(OUT_DIR, { recursive: true });
  for (const doc of derived) {
    const file = path.join(OUT_DIR, `raydium-${doc.program}.json`);
    await writeFile(file, `${JSON.stringify(doc, null, 2)}\n`);
    const hashes = doc.source.files.map((entry) => entry.sha256.slice(7, 15)).join('+');
    console.log(`${file}: ${doc.instructions.length} variants, sha256:${hashes}`);
  }
}
