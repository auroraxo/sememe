#!/usr/bin/env node
// Write the derived SPL Associated Token Account interface artifact
// (`interface/ata-<program>.json`).
//
// The ATA wire table is derived from the vendored upstream Rust sources by
// `src/ata-interface.mjs` (see that file for the rules) and committed as a
// reviewable artifact. This tool regenerates that artifact from the vendored
// source; `--check` verifies the committed artifact is exactly what the
// derivation produces today, so a stale artifact fails instead of being
// approved by habit.
//
// Usage: node tools/ata-interface.mjs [--check]

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveAtaInterface, ATA_SPEC, REPO_ROOT } from '../src/ata-interface.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
if (ROOT !== REPO_ROOT) throw Error('tool moved; src/ata-interface.mjs resolves the repo root');
const OUT_DIR = path.join(ROOT, 'interface');
const check = process.argv.includes('--check');

const doc = deriveAtaInterface(ATA_SPEC);
const file = path.join(OUT_DIR, `ata-${doc.program}.json`);

if (check) {
  let current;
  try {
    current = await readFile(file, 'utf8');
  } catch {
    console.error(`${file}: interface artifact is missing — run tools/ata-interface.mjs`);
    process.exit(1);
  }
  if (current !== `${JSON.stringify(doc, null, 2)}\n`) {
    console.error(`${file}: interface artifact is stale — re-run tools/ata-interface.mjs`);
    process.exit(1);
  }
  console.log(`${file}: current (${doc.instructions.length} variants, ${doc.source.files[0].sha256})`);
} else {
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(file, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`${file}: ${doc.instructions.length} variants, ${doc.source.files[0].sha256}`);
}
