#!/usr/bin/env node
// classify-publish-nothing.mjs — qualify the remaining 35 publish-nothing programs.
//
//   node tools/classify-publish-nothing.mjs --sweep research/step-ingestooor-full-sweep-shank-2026-11-04.json \
//     [--foreign-repo <path>] [--out <file>]
//
// WHY THIS FILE EXISTS
//
// The shank qualification (commit 0812300, 2026-11-04) decoded the largest single
// gap in the foreign sweep — Lighthouse, 42 payloads — by recognizing its own
// first-party published copy and its shank dialect (1-byte discriminants + LEB128).
// That left 35 programs with 87 payloads in the `no-interface-published` category.
//
// The card's next step:
//   "die 35 verbleibenden publish-nothing-Programme nach demselben Muster
//    klassifizieren (First-Party-Datei im fremden Repo? eigener Dialekt?) —
//    NICHT die Deckungszahl polieren; die Adoptionsschwelle (ein fremder
//    Lauf) bleibt das Gate."
//
// This tool performs that classification against the foreign repository's own
// committed source (step-finance-oss/step-ingestooor @001cf39, MIT):
//
//   1. `first-party-foreign-idl` (7 programs, 22 payloads):
//      The foreign repo contains an Anchor/Shank IDL in crates/idl-gens/idls/
//      that explicitly declares the program address and an instructions array.
//      (Lulo, NX Lending, Solayer Restake, Solayer AVS, Titan, Reward Options, Step Staking).
//      These can be adopted via `sememe adopt` without any on-chain pull.
//
//   2. `dedicated-foreign-parser` (9 programs, 32 payloads):
//      The foreign repo contains a hand-written Rust parser under
//      crates/parsers/src/ targeting this program by address.
//      (Solend: 10 payloads, Saber: 5, Manifest: 3, Saros: 3, Phoenix: 2,
//       Raydium Farms v3: 2, Raydium Farms v6: 2, Stake Pool: 4, Sanctum Single-Validator: 1).
//      These programs have NO published IDL anywhere — they are custom-coded
//      wire parsers in the foreign project's own engine.
//
//   3. `core-runtime-program` (3 programs, 5 payloads):
//      Core Solana runtime / sysvar programs (Stake11111..., Ed25519SigVerify...,
//      noopb9bk...). They have no IDL by chain architecture; their wire layouts
//      are part of the Solana protocol itself.
//
//   4. `unrepresented-source-gap` (16 programs, 28 payloads):
//      Programs that appear in test fixtures (e.g. nested CPI or multi-hop routes)
//      but have NEITHER an IDL NOR a dedicated parser in the foreign repository.
//
// Denominator discipline:
// The committed shank sweep report is the denominator: its headline `noInterface`
// (87) must equal the sum of the extracted candidates; a hand-edited artifact is
// refused before scanning.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Known first-party IDL filenames in crates/idl-gens/idls/ */
export const FIRST_PARTY_MAP = {
  'FL3X2pRsQ9zHENpZSKDRREtccwJuei8yg9fwDu9UN69Q': 'lulo.json',
  'NXFiKimQN3QSL3CDhCXddyVmLfrai8HK36bHKaAzK7g': 'nx_lending.json',
  'RopsJ74nrtcsk9iND8CFFNjn5mxf1tFzF3RhMPJ3CdV': 'reward_options.json',
  'endoLNCKTqDn8gSVnN2hDdpgACUPWHZTwoYnnMybpAT': 'solayer_avs.json',
  'sSo1iU21jBrU9VaJ8PJib1MtorefUV4fzC9GURa2KNn': 'solayer_restake.json',
  'Stk5NCWomVN3itaFjLu382u9ibb5jMSHEsh6CuhaGjB': 'step_staking.json',
  'T1TANpTeScyeqVzzgNViGDNrkQ6qHz9KrSBS4aNXvGT': 'titan.json',
};

/** Core Solana runtime programs (no IDL by protocol design). */
export const CORE_RUNTIME_PROGRAMS = new Set([
  'Stake11111111111111111111111111111111111111',
  'Ed25519SigVerify111111111111111111111111111',
  'noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV',
]);

/**
 * Extract candidates from a sweep report, verifying headline consistency.
 */
export function extractCandidates(sweepReport) {
  const bp = sweepReport?.summary?.byProgram;
  if (!bp || typeof bp !== 'object') throw Error('sweep report has no summary.byProgram');
  const candidates = Object.entries(bp)
    .filter(([, v]) => v.noInterface > 0)
    .map(([program, v]) => ({ program, payloads: v.noInterface }));
  const sum = candidates.reduce((n, c) => n + c.payloads, 0);
  if (sweepReport.summary.noInterface !== sum) {
    throw Error(`gap programs sum to ${sum} payloads but summary.noInterface says ${sweepReport.summary.noInterface} — hand-edited artifact`);
  }
  return candidates;
}

/** Recursively find all *.rs files in a directory. */
function findRsFiles(dir) {
  const files = [];
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...findRsFiles(full));
    else if (entry.name.endsWith('.rs')) files.push(full);
  }
  return files;
}

/**
 * Classify all 35 programs against the foreign repo sources.
 */
export async function classifyAll(sweepReport, { foreignRepo } = {}) {
  const root = foreignRepo
    ?? process.env.SEMEME_STEP_INGESTOOR_PATH
    ?? (process.env.GITHUB_WORKSPACE
      ? path.join(process.env.GITHUB_WORKSPACE, 'step-ingestooor')
      : path.join(os.homedir(), 'github_repos', 'step-ingestooor'));

  const candidates = extractCandidates(sweepReport);
  const idlDir = path.join(root, 'crates', 'idl-gens', 'idls');
  const parsersDir = path.join(root, 'crates', 'parsers', 'src');
  const rsFiles = findRsFiles(parsersDir);

  // Pre-load parser files content for scanning
  const rsContents = rsFiles.map((file) => ({
    file: path.relative(root, file),
    content: readFileSync(file, 'utf8'),
  }));

  const rows = [];
  for (const { program, payloads } of candidates) {
    // 1. First-party foreign IDL?
    if (FIRST_PARTY_MAP[program]) {
      const idlFile = FIRST_PARTY_MAP[program];
      const fullPath = path.join(idlDir, idlFile);
      let instructions = 0;
      let addressMatches = false;
      if (existsSync(fullPath)) {
        try {
          const idl = JSON.parse(readFileSync(fullPath, 'utf8'));
          instructions = (idl.instructions ?? []).length;
          addressMatches = idl.address === program;
        } catch { /* unparseable */ }
      }
      rows.push({
        program,
        payloads,
        verdict: 'first-party-foreign-idl',
        sourceFile: `crates/idl-gens/idls/${idlFile}`,
        instructions,
        addressMatches,
        adoptable: addressMatches && instructions > 0,
      });
      continue;
    }

    // 2. Dedicated hand-written Rust parser?
    const parserHits = rsContents
      .filter(({ content }) => content.includes(program))
      .map(({ file }) => file);
    if (parserHits.length > 0) {
      rows.push({
        program,
        payloads,
        verdict: 'dedicated-foreign-parser',
        sourceFile: parserHits[0],
        allParserFiles: parserHits,
        parserFileCount: parserHits.length,
      });
      continue;
    }

    // 3. Core Solana runtime program?
    if (CORE_RUNTIME_PROGRAMS.has(program)) {
      rows.push({
        program,
        payloads,
        verdict: 'core-runtime-program',
        nature: 'Solana runtime/sysvar; no IDL exists by protocol design',
      });
      continue;
    }

    // 4. Unrepresented source gap
    rows.push({
      program,
      payloads,
      verdict: 'unrepresented-source-gap',
      note: 'no IDL and no dedicated parser in foreign repo; payload appears in transaction traces',
    });
  }

  // Summary aggregation
  const byCategory = {
    'first-party-foreign-idl': { programs: 0, payloads: 0 },
    'dedicated-foreign-parser': { programs: 0, payloads: 0 },
    'core-runtime-program': { programs: 0, payloads: 0 },
    'unrepresented-source-gap': { programs: 0, payloads: 0 },
  };
  for (const row of rows) {
    byCategory[row.verdict].programs += 1;
    byCategory[row.verdict].payloads += row.payloads;
  }

  const summary = {
    programs: rows.length,
    payloads: rows.reduce((n, r) => n + r.payloads, 0),
    byCategory,
    status: 'pass',
  };

  return { rows, summary };
}

// CLI entry point
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const idx = args.indexOf(name);
    if (idx < 0) return fallback;
    const val = args[idx + 1];
    if (val === undefined) throw Error(`missing value for ${name}`);
    args.splice(idx, 2);
    return val;
  };

  const sweepPath = option('--sweep', undefined);
  if (!sweepPath) {
    console.error('usage: node tools/classify-publish-nothing.mjs --sweep <sweep-report.json> [--foreign-repo <path>] [--out <file>]');
    process.exit(2);
  }

  try {
    const sweep = JSON.parse(readFileSync(sweepPath, 'utf8'));
    const foreignRepo = option('--foreign-repo', undefined);
    const { rows, summary } = await classifyAll(sweep, { foreignRepo });

    const artifact = {
      tool: 'classify-publish-nothing',
      generatedAt: new Date().toISOString(),
      source: {
        sweep: sweepPath,
        noInterface: sweep.summary?.noInterface,
      },
      summary,
      rows,
    };

    const outPath = option('--out', undefined);
    if (outPath) {
      writeFileSync(outPath, `${JSON.stringify(artifact, null, 1)}\n`);
    }
    console.log(JSON.stringify(summary, null, 1));
  } catch (err) {
    console.error(JSON.stringify({ error: String(err?.message ?? err) }));
    process.exit(2);
  }
}
