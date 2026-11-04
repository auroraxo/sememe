// unrepresented-external.test.mjs — the card's next step, measured:
//   "unrepresented 16 (28 Payloads) pruefen, ob ihre Quelle ganz ausserhalb
//    des Fremd-Repos liegt"
//
// The publish-nothing classification (tools/classify-publish-nothing.mjs,
// research/publish-nothing-classification-2026-11-04.json) sorted the 35
// publish-nothing programs into 4 classes. Its "unrepresented-source-gap"
// (16 programs / 28 payloads) meant: no IDL and no dedicated parser in the
// FOREIGN repo. A git-grep premise check shows every one of the 16 appears
// in that repo ONLY as a committed transaction trace (crates/parsers/tests/**).
// The class therefore never measured the world outside that repo — this
// instrument does, with the same discipline the foreign repo was measured by:
//
//   - the search surface carries a POSITIVE CONTROL; control fails or results
//     are incomplete -> the surface is UNMEASURED -> the program is `unknown`
//     and the whole verdict is withheld (no-verdict, exit 3). A client
//     failure never becomes an absence (the crates.io-403 lesson).
//   - every idl-candidate hit (a .json outside trace-fixture paths) is
//     FETCHED and verified by content: literal present, IDL-shaped,
//     binding decided from the file itself (metadata.address vs program).
//   - a binding that points at ANOTHER program is never re-labelled
//     (bitquery manifest/manifest.json declares MNFSTqtC..., a DIFFERENT
//     program from wMNFSTkir... — measured, and it must stay that way).
//
// Ladder (written FIRST; run against the pre-tree the module does not exist
// on, so every importing test is red there; G1/G2 read only committed
// artifacts and stay green on both trees):
//   T1: tool exists and enforces the CLI contract (exit 2 without args)
//   T2: candidate extraction verifies the classification denominator
//       (16 programs / 28 payloads); a hand-edited row is refused
//   T3: path classification: trace fixtures and datasets are not sources;
//       .json outside trace paths is an idl candidate
//   T4: binding is decided by the file: declared / other-program /
//       literal-mention / unbound
//   T5: verdicts from hits: published > unbound > reference-only >
//       trace-only; failed search -> unknown, never an absence
//   T6: summary withholding: one unknown program -> no-verdict
//   T7 (G, both trees): the classification artifact partition is intact
//   T8 (G, both trees): the classified sweep still pins gap 65
//   T9: the committed external-source sweep artifact is measured, complete,
//       and agrees with the classification denominator

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'measure-unrepresented-external.mjs');
const CLASSIFICATION = path.join(ROOT, 'research', 'publish-nothing-classification-2026-11-04.json');
const CLASSIFIED_SWEEP = path.join(ROOT, 'research', 'step-ingestooor-full-sweep-classified-2026-11-04.json');
const SWEEP_ARTIFACT = path.join(ROOT, 'research', 'unrepresented-external-sweep-2026-11-04.json');

function runTool(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [TOOL, ...args], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }));
  });
}

test('T1: tool exists and enforces the CLI contract', async () => {
  const { code, stderr } = await runTool([]);
  assert.equal(code, 2, 'usage refusal expected');
  assert.match(stderr, /--classification/, 'must mention --classification');
});

test('T2: candidate extraction verifies the classification denominator', async () => {
  const { extractUnrepresented } = await import(TOOL);
  const artifact = JSON.parse(await readFile(CLASSIFICATION, 'utf8'));
  const rows = extractUnrepresented(artifact);
  assert.equal(rows.length, 16, '16 unrepresented programs');
  assert.equal(rows.reduce((n, r) => n + r.payloads, 0), 28, '28 payloads');
  assert.ok(rows.every((r) => r.program && Number.isInteger(r.payloads) && r.payloads > 0));

  // Denominator discipline: a hand-edited row must be refused before any probe.
  const tampered = JSON.parse(JSON.stringify(artifact));
  tampered.rows.find((r) => r.verdict === 'unrepresented-source-gap').payloads -= 1;
  assert.throws(() => extractUnrepresented(tampered), /denominator|sum|28/i);
  const mislabeled = JSON.parse(JSON.stringify(artifact));
  mislabeled.rows.find((r) => r.verdict === 'unrepresented-source-gap').verdict = 'core-runtime-program';
  assert.throws(() => extractUnrepresented(mislabeled), /unrepresented-source-gap/);
});

test('T3: path classification — traces and datasets are not sources', async () => {
  const { classifyHitPath } = await import(TOOL);
  const hit = (repo, p) => classifyHitPath({ repository: { full_name: repo }, path: p });

  assert.equal(hit('step-finance-oss/step-ingestooor', 'crates/parsers/tests/jupiter/dca_fill.json').class, 'trace-fixture');
  assert.equal(hit('quellen-sol/ingestooor', 'crates/parsers/tests/carrot_vault/deposit.json').class, 'trace-fixture');
  assert.equal(hit('JamesMDunn/ingestooor', 'crates/parsers/tests/kamino/v2_deser_err.json').class, 'trace-fixture');
  assert.equal(hit('ZXXYy/Solana_Failed_Tx', 'data/top_failed_program/top_failed_program.csv').class, 'dataset-trace');
  assert.equal(hit('rayaanoidPrime/blockchain-address-classifier', 'datasets/sol.csv').class, 'dataset-trace');
  assert.equal(hit('bitquery/solana-idl-lib', 'solfi/solfi.json').class, 'idl-candidate');
  assert.equal(hit('staccDOTsol/openai-idl-generat00r', 'idl_data/SoLFiHG9TfgtdUXUjWAxi3LtvYuFyDLVhBWxdMZxyCe_account.json').class, 'idl-candidate');
  assert.equal(hit('jup-ag/instruction-parser', 'src/constants.ts').class, 'reference-code');
  assert.equal(hit('duneanalytics/spellbook', 'dbt_subprojects/solana/models/jupiter/jupiter_solana_amms.sql').class, 'reference-doc');
  assert.equal(hit('tryghostxyz/solfi-sim', 'README.md').class, 'reference-doc');
});

test('T4: binding is decided by the file, never re-labelled', async () => {
  const { bindingOf } = await import(TOOL);
  const program = 'SoLFiHG9TfgtdUXUjWAxi3LtvYuFyDLVhBWxdMZxyCe';
  const other = 'MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms';
  const call = (raw) => bindingOf(program, raw, JSON.parse(raw));

  assert.equal(call(JSON.stringify({ metadata: { address: program }, instructions: [{}] })), 'declared');
  assert.equal(call(JSON.stringify({ metadata: { address: other }, instructions: [{}] })), 'other-program');
  // prose mentioning the program is a mention, not a declaration
  assert.equal(call(JSON.stringify({ note: `routes through ${program} pools` })), 'literal-mention');
  assert.equal(call(JSON.stringify({ name: 'obric_solana', instructions: [{}] })), 'unbound');
});

test('T5: verdicts from hits — a failed search is unknown, never an absence', async () => {
  const { verdictFromHits } = await import(TOOL);
  const v = (hits, verifications, searchOk = true, incomplete = false) =>
    verdictFromHits({ searchOk, incomplete, hits, verifications });

  const boundSource = { repo: 'bitquery/solana-idl-lib', path: 'solfi/solfi.json', class: 'idl-candidate',
    ok: true, shaped: true, instructions: 1, binding: 'declared' };
  assert.equal(v([boundSource], [boundSource]).verdict, 'external-interface-published');

  const unbound = { repo: 'bitquery/solana-idl-lib', path: 'obric/obric_v2.json', class: 'idl-candidate',
    ok: true, shaped: true, instructions: 12, binding: 'unbound' };
  assert.equal(v([unbound], [unbound]).verdict, 'external-interface-unbound');

  // a binding that names ANOTHER program never becomes a source
  const otherProgram = { repo: 'bitquery/solana-idl-lib', path: 'manifest/manifest.json', class: 'idl-candidate',
    ok: true, shaped: true, instructions: 15, binding: 'other-program' };
  const ref = { repo: 'jup-ag/instruction-parser', path: 'src/constants.ts', class: 'reference-code' };
  assert.equal(v([otherProgram, ref], [otherProgram]).verdict, 'external-reference-only',
    'an other-program IDL is a reference, not an interface for this program');

  const trace = { repo: 'step-finance-oss/step-ingestooor', path: 'crates/parsers/tests/kamino/v2_deser_err.json', class: 'trace-fixture' };
  assert.equal(v([trace], []).verdict, 'trace-only-no-external-reference');

  // a stale index: the candidate file was fetched but does not contain the literal
  const stale = { repo: 'x/y', path: 'p.json', class: 'idl-candidate', ok: false, shaped: false, binding: 'unbound' };
  assert.equal(v([stale], [stale]).verdict, 'unknown', 'decisive candidate unreadable -> unknown');

  assert.equal(v([], [], false).verdict, 'unknown', 'failed search -> unknown');
  assert.equal(v([], [], true).verdict, 'no-external-index-hit', 'zero hits on a controlled surface is an index-scoped measurement');
  assert.equal(v([boundSource], [boundSource], true, true).verdict, 'unknown', 'incomplete results -> unknown');
});

test('T6: summary withholding — one unknown program -> no-verdict', async () => {
  const { summarizeRows } = await import(TOOL);
  const rows = [
    { program: 'A', payloads: 4, verdict: 'external-interface-published' },
    { program: 'B', payloads: 1, verdict: 'trace-only-no-external-reference' },
    { program: 'C', payloads: 1, verdict: 'unknown' },
  ];
  const s = summarizeRows(rows);
  assert.equal(s.verdict, 'no-verdict');
  assert.equal(s.unknown, 1);
  assert.equal(s.payloads, 6);
  const full = summarizeRows(rows.slice(0, 2));
  assert.equal(full.verdict, 'measured');
  assert.equal(full.byVerdict['external-interface-published'], 1);
  assert.equal(full.payloadsByVerdict['external-interface-published'], 4);
});

test('T7 (G): the classification partition is intact', async () => {
  const artifact = JSON.parse(await readFile(CLASSIFICATION, 'utf8'));
  const un = artifact.rows.filter((r) => r.verdict === 'unrepresented-source-gap');
  assert.equal(un.length, artifact.summary.byCategory['unrepresented-source-gap'].programs);
  assert.equal(un.reduce((n, r) => n + r.payloads, 0), artifact.summary.byCategory['unrepresented-source-gap'].payloads);
  assert.equal(un.reduce((n, r) => n + r.payloads, 0), 28);
});

test('T8 (G): the classified sweep still pins gap 65', async () => {
  const report = JSON.parse(await readFile(CLASSIFIED_SWEEP, 'utf8'));
  assert.equal(report.summary.noInterface, 65);
  assert.equal(report.summary.payloadsChecked, 806);
  assert.equal(report.networkAttempts, 0);
});

test('T9: the committed external-source sweep artifact is measured and complete', { skip: !existsSync(SWEEP_ARTIFACT) && 'artifact not yet measured (run the tool first)' }, async () => {
  const artifact = JSON.parse(await readFile(SWEEP_ARTIFACT, 'utf8'));
  const classification = JSON.parse(await readFile(CLASSIFICATION, 'utf8'));

  assert.equal(artifact.summary.verdict, 'measured', 'a partial external measurement must not be quoted as one');
  assert.ok(artifact.control?.matches > 0, 'the positive control must have resolved');
  assert.equal(artifact.rows.length, 16);
  assert.equal(artifact.rows.reduce((n, r) => n + r.payloads, 0), 28);
  assert.equal(artifact.summary.unknown, 0);
  assert.equal(artifact.rows.length, classification.rows.filter((r) => r.verdict === 'unrepresented-source-gap').length);
  // every measured row names its evidence
  for (const row of artifact.rows) {
    assert.ok(['external-interface-published', 'external-interface-unbound', 'external-reference-only', 'trace-only-no-external-reference'].includes(row.verdict), `row ${row.program}: named verdict`);
    assert.ok(Array.isArray(row.hits), 'hits recorded');
  }
});
