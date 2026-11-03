#!/usr/bin/env node
// Write the derived SPL Token-Metadata interface artifact
// (`interface/token-metadata.json`).
//
// The metadata wire table is derived from the vendored upstream Rust crate by
// `src/token-metadata-interface.mjs` (see that file for the rules) and
// committed as a reviewable artifact. This tool regenerates it from the
// vendored source; `--check` verifies the committed artifact is exactly what
// the derivation produces today, so a stale artifact fails instead of being
// approved by habit.
//
// Usage: node tools/token-metadata-interface.mjs [--check]

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { deriveTokenMetadataInterface, REPO_ROOT } from '../src/token-metadata-interface.mjs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
if (ROOT !== REPO_ROOT) throw Error('tool moved; src/token-metadata-interface.mjs resolves the repo root');
const OUT_DIR = path.join(ROOT, 'interface');
const check = process.argv.includes('--check');

const doc = deriveTokenMetadataInterface();
const file = path.join(OUT_DIR, 'token-metadata.json');
const body = `${JSON.stringify(doc, null, 2)}\n`;

if (check) {
  const current = await readFile(file, 'utf8');
  if (current !== body) {
    console.error(`${file}: interface artifact is stale — re-run tools/token-metadata-interface.mjs`);
    process.exit(1);
  }
  console.log(`${file}: current (${doc.instructions.length} variants, ${doc.source.fileSha256})`);
} else {
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(file, body);
  console.log(`${file}: ${doc.instructions.length} variants, ${doc.source.fileSha256}`);
}
