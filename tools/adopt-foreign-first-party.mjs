#!/usr/bin/env node
// adopt-foreign-first-party.mjs — close the MEASURED first-party share of the
// publish-nothing gap through the ONE write path `sememe adopt` uses.
//
//   node tools/adopt-foreign-first-party.mjs \
//     --sweep research/step-ingestooor-full-sweep-shank-2026-11-04.json \
//     --store test/fixtures/traffic-sample-store-2026-11-04-pulled \
//     --out research/adopt-foreign-first-party-2026-11-04.json
//
// WHY THIS FILE EXISTS
//
// The publish-nothing classification (tools/classify-publish-nothing.mjs,
// research/publish-nothing-classification-2026-11-04.json) measured that 7 of
// the 35 publish-nothing programs (22 of 87 payloads) have a first-party IDL
// INSIDE the foreign repository (crates/idl-gens/idls/, MIT, commit 001cf39).
// The card's own pattern (Lighthouse, commit 0812300) already proved this
// acquisition class: `sememe adopt` the published copy, let the union path
// arbitrate by bytes.
//
// This tool sweeps the plan into the store in ONE pass — same write path
// (src/adopt.mjs), content-addressed, receipt `source: "first-party"`, origin
// naming the foreign repo, commit and file. Nothing here touches the chain:
// adoption is provenance of BYTES, not proof the bytes describe the deployed
// program; decode/union arbitrate that, every refusal named.
//
// Exit codes: 0 measured (every planned row adopted), 2 usage/IO.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { adopt } from '../src/adopt.mjs';
import { extractCandidates, FIRST_PARTY_MAP } from './classify-publish-nothing.mjs';

export const FOREIGN_COMMIT = '001cf39';

/** The foreign clone path, same convention as the sweep tests. */
export function foreignRepoPath(explicit) {
  return explicit
    ?? process.env.SEMEME_STEP_INGESTOOR_PATH
    ?? (process.env.GITHUB_WORKSPACE
      ? path.join(process.env.GITHUB_WORKSPACE, 'step-ingestooor')
      : path.join(os.homedir(), 'github_repos', 'step-ingestooor'));
}

/**
 * Verify ONE first-party IDL file against its program.
 * `adoptable` requires: parseable, instructions array non-empty, and the
 * file's own `address` equal to the program — a file that declares another
 * program is never re-labelled (adopt.mjs refuses it too; this check names
 * it in the plan before any write).
 */
export function verifyForeignIdl(program, filePath) {
  if (!existsSync(filePath)) return { instructions: 0, addressMatches: false, adoptable: false, reason: 'missing' };
  let idl;
  try {
    idl = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return { instructions: 0, addressMatches: false, adoptable: false, reason: 'unparseable' };
  }
  const instructions = Array.isArray(idl.instructions) ? idl.instructions.length : 0;
  const addressMatches = idl.address === program;
  return { instructions, addressMatches, adoptable: instructions > 0 && addressMatches };
}

/**
 * The adoption plan: every publish-nothing program with a VERIFIED first-party
 * IDL file in the foreign repo, with its payload count from the sweep.
 */
export function plan(sweepReport, { foreignRepo } = {}) {
  const root = foreignRepoPath(foreignRepo);
  const candidates = extractCandidates(sweepReport);
  const rows = [];
  for (const { program, payloads } of candidates) {
    const file = FIRST_PARTY_MAP[program];
    if (!file) continue;
    const fullPath = path.join(root, 'crates', 'idl-gens', 'idls', file);
    const check = verifyForeignIdl(program, fullPath);
    if (!check.adoptable) continue;
    rows.push({ program, payloads, file, fullPath, instructionCount: check.instructions });
  }
  return rows;
}

/**
 * Adopt every planned row into the store through the `sememe adopt` path.
 * One write per program; any failure throws (a partial adoption must not be
 * reported as measured).
 */
export async function sweepAdopt(planRows, { store } = {}) {
  if (!store || typeof store !== 'string') throw Error('store required');
  const rows = [];
  for (const { program, payloads, file, fullPath, instructionCount } of planRows) {
    const filePath = fullPath ?? file;
    const receipt = await adopt(program, filePath, store, {
      source: 'first-party',
      origin: `step-finance-oss/step-ingestooor@${FOREIGN_COMMIT}/${path.basename(file)}`,
    });
    if (!receipt?.fingerprint?.startsWith('sha256:')) {
      throw Error(`${program}: adopt returned no content fingerprint — refusing to report it as stored`);
    }
    rows.push({
      program,
      payloads,
      file: path.basename(file),
      verdict: 'adopted',
      fingerprint: receipt.fingerprint,
      instructionCount,
    });
  }
  const adoptedPayloads = rows.reduce((n, r) => n + r.payloads, 0);
  return {
    rows,
    summary: {
      planned: planRows.length,
      adopted: rows.length,
      adoptedPayloads,
      verdict: planRows.length > 0 && rows.length === planRows.length ? 'measured' : 'no-verdict',
    },
  };
}

// CLI
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
  const store = option('--store', undefined);
  if (!sweepPath || !store) {
    console.error('usage: node tools/adopt-foreign-first-party.mjs --sweep <sweep-report.json> --store <dir> [--foreign-repo <path>] [--out <file>]');
    process.exit(2);
  }

  try {
    const sweep = JSON.parse(readFileSync(sweepPath, 'utf8'));
    const foreignRepo = option('--foreign-repo', undefined);
    const planRows = plan(sweep, { foreignRepo });
    if (!planRows.length) throw Error('no verified first-party IDL found for any publish-nothing program');
    const { rows, summary } = await sweepAdopt(planRows, { store });
    const artifact = {
      tool: 'adopt-foreign-first-party',
      generatedAt: new Date().toISOString(),
      source: {
        sweep: sweepPath,
        foreignRepo: 'step-finance-oss/step-ingestooor',
        foreignCommit: FOREIGN_COMMIT,
        store,
      },
      summary,
      rows,
    };
    const outPath = option('--out', undefined);
    if (outPath) writeFileSync(outPath, `${JSON.stringify(artifact, null, 1)}\n`);
    console.log(JSON.stringify({ ...summary, output: outPath ?? null }, null, 1));
  } catch (err) {
    console.error(JSON.stringify({ error: String(err?.message ?? err) }));
    process.exit(2);
  }
}
