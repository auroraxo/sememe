#!/usr/bin/env node
// Write the derived SPL Token interface artifacts (`interface/token-<program>.json`).
//
// The token wire tables are derived from the vendored upstream Rust crates by
// `src/token-interface.mjs` (see that file for the rules) and committed as
// reviewable artifacts. This tool regenerates those artifacts from the vendored
// source; `--check` verifies the committed artifacts are exactly what the
// derivation produces today, so a stale artifact fails instead of being
// approved by habit.
//
// Usage: node tools/token-interface.mjs [--check]

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveAllTokenInterfaces, REPO_ROOT } from '../src/token-interface.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
if (ROOT !== REPO_ROOT) throw Error('tool moved; src/token-interface.mjs resolves the repo root');
const OUT_DIR = path.join(ROOT, 'interface');
const check = process.argv.includes('--check');

const derived = deriveAllTokenInterfaces();

if (check) {
  for (const doc of derived) {
    const file = path.join(OUT_DIR, `token-${doc.program}.json`);
    const current = await readFile(file, 'utf8');
    if (current !== `${JSON.stringify(doc, null, 2)}\n`) {
      console.error(`${file}: interface artifact is stale — re-run tools/token-interface.mjs`);
      process.exit(1);
    }
    console.log(`${file}: current (${doc.instructions.length} variants, ${doc.source.fileSha256})`);
  }
} else {
  await mkdir(OUT_DIR, { recursive: true });
  for (const doc of derived) {
    const file = path.join(OUT_DIR, `token-${doc.program}.json`);
    await writeFile(file, `${JSON.stringify(doc, null, 2)}\n`);
    console.log(`${file}: ${doc.instructions.length} variants, ${doc.source.fileSha256}`);
  }
}
