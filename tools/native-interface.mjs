#!/usr/bin/env node
// Write the derived native interface artifacts (`interface/native-<program>.json`).
//
// The table in `src/native.mjs` is no longer hand-typed: it is derived from the vendored
// upstream Rust (see `src/native-interface.mjs` for the rules) and committed as a
// reviewable artifact. This tool regenerates that artifact from the vendored source;
// `--check` verifies the committed artifact is exactly what the derivation produces
// today, so a stale artifact fails instead of being approved by habit.
//
// Usage: node tools/native-interface.mjs [--check]

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveAll, REPO_ROOT } from '../src/native-interface.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
if (ROOT !== REPO_ROOT) throw Error('tool moved; src/native-interface.mjs resolves the repo root');
const OUT_DIR = path.join(ROOT, 'interface');
const check = process.argv.includes('--check');

const derived = deriveAll();

if (check) {
  for (const doc of derived) {
    const file = path.join(OUT_DIR, `native-${doc.program}.json`);
    const current = await readFile(file, 'utf8');
    if (current !== `${JSON.stringify(doc, null, 2)}\n`) {
      console.error(`${file}: interface artifact is stale — re-run tools/native-interface.mjs`);
      process.exit(1);
    }
    console.log(`${file}: current (${doc.instructions.length} variants, ${doc.source.fileSha256})`);
  }
} else {
  await mkdir(OUT_DIR, { recursive: true });
  for (const doc of derived) {
    const file = path.join(OUT_DIR, `native-${doc.program}.json`);
    await writeFile(file, `${JSON.stringify(doc, null, 2)}\n`);
    console.log(`${file}: ${doc.instructions.length} variants, ${doc.source.fileSha256}`);
  }
}
