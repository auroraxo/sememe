#!/usr/bin/env node
// acquisition-gap.mjs — the qualification report behind the `sememe gap` CLI.
//
// It answers one question for every program of a committed sweep's
// no-interface set: does this program publish an interface that sememe simply
// never pulled, or does it publish nothing at all? The classifier itself
// lives in src/gap.mjs (shipped, so `sememe gap` works from an install);
// this file is the report harness around it.
//
//   node tools/acquisition-gap.mjs --report research/<sweep>.json --out <file>
//
// Exit codes: 0 measured, 2 usage/IO, 3 no verdict (a probe failed — the
// artifact still records what WAS measured, and the unknown rows are named;
// an RPC failure is never recorded as "publishes nothing").
//
// The contract this file must not break (measured, not argued):
//   - an unknown probe never becomes an absence (the crates.io-403 lesson),
//   - a program with no IDL but a pinned wire table is `vendored`, not a gap,
//   - the report's own headline is the denominator, so a hand-edited artifact
//     is refused before any probe runs.

import { readFileSync, writeFileSync } from 'node:fs';
import { probeGap, programsFromReport, summarize } from '../src/gap.mjs';

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    if (index < 0) return fallback;
    const value = args[index + 1];
    if (value === undefined) throw Error(`missing value for ${name}`);
    args.splice(index, 2);
    return value;
  };
  const reportPath = option('--report', undefined);
  if (!reportPath) {
    console.error('usage: node tools/acquisition-gap.mjs --report <sweep-report.json> [--out <file>] [--rpc <url>]');
    process.exit(2);
  }
  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const programs = programsFromReport(report);
    const url = option('--rpc', process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');
    const { rows, summary, slot } = await probeGap(programs, { url });
    const artifact = {
      tool: 'acquisition-gap',
      generatedAt: new Date().toISOString(),
      rpcUrl: url,
      slot,
      source: { report: reportPath, generatedAt: report.generatedAt, noInterface: report.noInterface },
      summary,
      rows,
    };
    const outPath = option('--out', undefined);
    if (outPath) writeFileSync(outPath, `${JSON.stringify(artifact, null, 1)}\n`);
    console.log(JSON.stringify({ ...summary, output: outPath ?? null, slot }, null, 1));
    if (summary.verdict === 'no-verdict') process.exitCode = 3;
  } catch (error) {
    console.error(JSON.stringify({ error: String(error?.message ?? error) }));
    process.exitCode = 2;
  }
}

export { probeGap, programsFromReport, summarize };
