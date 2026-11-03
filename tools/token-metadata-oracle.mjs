#!/usr/bin/env node
// Reproduce research/token-metadata-oracle-2026-11-03.json — the UPSTREAM
// crate's own pack()/unpack() behaviour.
//
// Why this exists: sememe derives the token-metadata wire table from the
// vendored upstream Rust SOURCE (src/token-metadata-interface.mjs). A
// derivation that only re-reads the same source it was written from can be
// wrong in the same way twice. The falsifier has to be the PROGRAM upstream
// builds — so this tool compiles the exact pinned crates and asks them.
//
// The oracle is a Rust program (tools/token-metadata-oracle/) built against:
//   spl-token-metadata-interface 1.0.1
//   spl-discriminator            0.5.2
//   solana-nullable             1.3.0
//   borsh                       1.8.1
//   solana-address              2.6.1
// — the versions Token-2022's own Cargo.lock pins at
// 5251dcc07ecbcb721d6c4f0231090defadf00311.
//
// The output is committed, and test/token-metadata.test.mjs compares
// sememe's table against it: every discriminator, every re-encode, and every
// refusal reason.
//
// Usage: node tools/token-metadata-oracle.mjs            # write the report
//        node tools/token-metadata-oracle.mjs --check    # verify it matches
//
// Requires a Rust toolchain and the crates in the local cargo cache (the
// build is offline). Without them the tool says so and exits 2 — it never
// writes a report it could not produce.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CRATE = path.join(HERE, 'token-metadata-oracle');
const OUT = path.join(ROOT, 'research', 'token-metadata-oracle-2026-11-03.json');
const check = process.argv.includes('--check');

if (!existsSync(path.join(CRATE, 'Cargo.toml'))) {
  process.stderr.write(`the oracle crate is missing: ${CRATE}\n`);
  process.exit(2);
}

let produced;
try {
  execFileSync('cargo', ['build', '--offline', '--release', '--bin', 'oracle'], {
    cwd: CRATE,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  produced = execFileSync(path.join(CRATE, 'target', 'release', 'oracle'), {
    cwd: CRATE,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
} catch (error) {
  process.stderr.write(
    `the oracle could not be built (a Rust toolchain and the pinned crates in the\n` +
    `local cargo cache are needed; the build is offline):\n${error.message}\n`,
  );
  process.exit(2);
}

// The report must be valid JSON before it is committed — a truncated oracle
// would otherwise be committed and then "agree" with a broken decoder.
let parsed;
try {
  parsed = JSON.parse(produced);
} catch (error) {
  process.stderr.write(`the oracle produced invalid JSON: ${error.message}\n`);
  process.exit(1);
}
if (!parsed.discriminatorRule?.instructionDiscriminators || !parsed.packed?.length || !parsed.refused?.length) {
  process.stderr.write('the oracle report is missing its sections — refusing to write it\n');
  process.exit(1);
}

const body = `${JSON.stringify(parsed, null, 2)}\n`;

if (check) {
  const current = readFileSync(OUT, 'utf8');
  if (current !== body) {
    process.stderr.write(`${OUT}: the committed oracle report differs from the upstream crate — re-run this tool\n`);
    process.exit(1);
  }
  console.log(`${OUT}: current (${parsed.packed.length} packed forms, ${parsed.refused.length} refusals)`);
} else {
  writeFileSync(OUT, body);
  console.log(`${OUT}: ${parsed.packed.length} packed forms, ${parsed.refused.length} refusals`);
}
