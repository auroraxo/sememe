// dedicated-parser-upstream.test.mjs — the card's next step for the LAST
// unmeasured class, measured:
//
//   "dedicated-parser 9/32 haben NIE ein IDL, nur per Upstream-Dialekt-Pin
//    erreichbar"  (card notes, 04.11.)
//
// The dedicated-foreign-parser class (9 programs / 32 payloads: Solend,
// Saber, Manifest, Saros, Phoenix, Raydium Farms v3/v6, Stake Pool, Sanctum
// Single-Validator) was classified from the FOREIGN repo alone: hand-written
// Rust parsers there, no IDL file there. The claim "no published IDL" was
// never measured against the UPSTREAM repos those parsers were written
// against (solendprotocol/solana-program-library, saber-hq/stable-swap,
// CKS-Systems/manifest, ...). This instrument measures exactly that surface
// — the dialect pin the card names as the only path for this class.
//
// Discipline (same as the sibling unrepresented-external instrument):
//   - positive control on the search surface; control fails -> everything
//     `unknown` -> no-verdict (exit 3). A client failure never becomes an
//     absence (the crates.io-403 lesson).
//   - every .json candidate is fetched and content-verified; binding is
//     decided by the file itself; another program's address is never
//     re-labelled.
//   - the license gate is measured per repo (SPDX from the API); null and
//     GPL-* may not be committed. The gate is a property of the finding.
//   - a falsified premise (no parser source in the foreign repo) surfaces as
//     `foreign-parser-not-found` and is NOT absorbed into an external verdict.
//
// Ladder (tests written FIRST; the tool module does not exist on the pre-tree,
// so every importing test is red there; G-guards read only committed
// artifacts and stay green on both trees):
//   T1: tool exists and enforces the CLI contract (exit 2 without args)
//   T2: candidate extraction verifies the classification denominator
//       (9 programs / 32 payloads); a hand-edited artifact is refused
//   T3: path classification: trace fixtures and datasets are not sources;
//       .json outside trace paths is an idl candidate
//   T4: binding is decided by the file: declared / other-program /
//       literal-mention / unbound (never re-labelled)
//   T5: verdicts: published > unbound > reference-only > no-index-hit;
//       failed search -> unknown; missing parser -> foreign-parser-not-found
//   T6: summary withholding: one unknown program -> no-verdict
//   T7: license gate: null -> unlicensed, NOASSERTION -> undetermined,
//       GPL-* -> copyleft, MIT -> permissive; the first three block the commit
//       (measured live: solendprotocol/... returns NOASSERTION)
//   T8: the dialect pin is derived from the foreign parsers (citations),
//       never guessed: saros.rs cites nothing -> no pin is invented
//       (skips with a named reason when the foreign clone is absent)
//   T9 (G, both trees): the classified sweep still pins gap 65
//   T10: the committed upstream artifact is measured, complete, agrees with
//       the classification denominator, and every published/unbound finding
//       is content-verified

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'measure-dedicated-parser-upstream.mjs');
const CLASSIFICATION = path.join(ROOT, 'research', 'publish-nothing-classification-2026-11-04.json');
const CLASSIFIED_SWEEP = path.join(ROOT, 'research', 'step-ingestooor-full-sweep-classified-2026-11-04.json');
const ARTIFACT = path.join(ROOT, 'research', 'dedicated-parser-upstream-2026-11-04.json');
// The foreign clone: CI provides it via SEMEME_STEP_INGESTOOR_PATH (pinned to
// 001cf39); locally it lives next to the other repos. A test that needs it
// skips with a NAMED reason when it is absent — never a silent pass.
const FOREIGN_REPO = process.env.SEMEME_STEP_INGESTOOR_PATH
  ?? path.join(os.homedir(), 'github_repos', 'step-ingestooor');

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

test('T2: extraction verifies the 9/32 denominator and refuses hand-edited artifacts', async () => {
  const { extractDedicated } = await import(TOOL);
  const classification = JSON.parse(await readFile(CLASSIFICATION, 'utf8'));
  const rows = extractDedicated(classification);
  assert.equal(rows.length, 9);
  assert.equal(rows.reduce((n, r) => n + r.payloads, 0), 32);
  const sum = classification.summary.byCategory['dedicated-foreign-parser'];
  assert.deepEqual(sum, { programs: 9, payloads: 32 });
  // a hand-edited row (payloads bumped) must be refused
  const tampered = JSON.parse(JSON.stringify(classification));
  tampered.rows.find((r) => r.verdict === 'dedicated-foreign-parser').payloads += 1;
  assert.throws(() => extractDedicated(tampered), /denominator mismatch/);
  // a class shrink must be refused
  const shrunk = JSON.parse(JSON.stringify(classification));
  shrunk.summary.byCategory['dedicated-foreign-parser'] = { programs: 8, payloads: 31 };
  assert.throws(() => extractDedicated(shrunk), /denominator mismatch/);
});

test('T3: path classification — traces and datasets are not sources', async () => {
  const { classifyHitPath } = await import(TOOL);
  assert.equal(classifyHitPath({ path: 'crates/parsers/tests/solend/deposit.json' }).class, 'trace-fixture');
  assert.equal(classifyHitPath({ path: 'testdata/foo.json' }).class, 'trace-fixture');
  assert.equal(classifyHitPath({ path: 'data/programs.csv' }).class, 'dataset-trace');
  assert.equal(classifyHitPath({ path: 'idl/solend_lending.json' }).class, 'idl-candidate');
  assert.equal(classifyHitPath({ path: 'src/parser.rs' }).class, 'reference-code');
  assert.equal(classifyHitPath({ path: 'README.md' }).class, 'reference-doc');
});

test('T4: binding decided by the file; another program is never re-labelled', async () => {
  const { bindingOf } = await import(TOOL);
  const P = 'SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy';
  const Q = 'SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY';
  assert.equal(bindingOf(P, JSON.stringify({ metadata: { address: P }, instructions: [{}] }), { metadata: { address: P } }), 'declared');
  assert.equal(bindingOf(P, JSON.stringify({ metadata: { address: Q } }), { metadata: { address: Q } }), 'other-program');
  assert.equal(bindingOf(P, `docs mention ${P} in prose`, null), 'literal-mention');
  assert.equal(bindingOf(P, '{"nothing":"here"}', {}), 'unbound');
});

test('T5: verdict ordering; failures are unknown, never absences', async () => {
  const { verdictFromHits } = await import(TOOL);
  const trace = { repository: { full_name: 'a/b' }, path: 'crates/parsers/tests/x.json', class: 'trace-fixture' };
  const idl = { repository: { full_name: 'a/b' }, path: 'idl/x.json', class: 'idl-candidate' };
  const code = { repository: { full_name: 'a/b' }, path: 'src/x.rs', class: 'reference-code' };
  const declared = { repo: 'a/b', path: 'idl/x.json', ok: true, shaped: true, binding: 'declared' };
  const unbound = { repo: 'a/b', path: 'idl/x.json', ok: true, shaped: true, binding: 'literal-mention' };
  assert.equal(verdictFromHits({ searchOk: false, hits: [idl] }).verdict, 'unknown');
  assert.equal(verdictFromHits({ incomplete: true, hits: [idl] }).verdict, 'unknown');
  assert.equal(verdictFromHits({ premiseFound: false }).verdict, 'foreign-parser-not-found');
  assert.equal(verdictFromHits({ hits: [] }).verdict, 'upstream-no-index-hit');
  assert.equal(verdictFromHits({ hits: [idl], verifications: [{ ok: false }] }).verdict, 'unknown');
  assert.equal(verdictFromHits({ hits: [idl, code], verifications: [declared] }).verdict, 'upstream-interface-published');
  assert.equal(verdictFromHits({ hits: [idl, code], verifications: [unbound] }).verdict, 'upstream-interface-unbound');
  assert.equal(verdictFromHits({ hits: [code], verifications: [] }).verdict, 'upstream-reference-only');
  assert.equal(verdictFromHits({ hits: [trace], verifications: [] }).verdict, 'unknown');
});

test('T6: one unknown program withholds the whole verdict', async () => {
  const { summarizeRows } = await import(TOOL);
  const ok = { verdict: 'upstream-reference-only', payloads: 2 };
  const bad = { verdict: 'unknown', payloads: 4 };
  const all = summarizeRows([ok, ok, ok]);
  assert.equal(all.verdict, 'measured');
  const withBad = summarizeRows([ok, bad]);
  assert.equal(withBad.verdict, 'no-verdict');
  assert.equal(withBad.unknown, 1);
});

test('T7: license gate — null unlicensed, NOASSERTION undetermined, GPL copyleft, MIT permissive', async () => {
  const { licenseGate } = await import(TOOL);
  const g1 = licenseGate([{ repo: 'a', spdxId: null }]);
  assert.equal(g1.repos[0].state, 'unlicensed');
  assert.equal(g1.commitAllowed, false);
  const g0 = licenseGate([{ repo: 'z', spdxId: 'NOASSERTION' }]);
  assert.equal(g0.repos[0].state, 'undetermined', 'a non-determinable license is NOT permissive');
  assert.equal(g0.commitAllowed, false);
  const g2 = licenseGate([{ repo: 'b', spdxId: 'GPL-3.0' }]);
  assert.equal(g2.repos[0].state, 'copyleft');
  assert.equal(g2.commitAllowed, false);
  const g3 = licenseGate([{ repo: 'c', spdxId: 'MIT' }, { repo: 'd', spdxId: 'Apache-2.0' }]);
  assert.equal(g3.commitAllowed, true);
  const g4 = licenseGate([{ repo: 'c', spdxId: 'MIT' }, { repo: 'd', spdxId: 'GPL-3.0' }]);
  assert.equal(g4.commitAllowed, false);
  const g5 = licenseGate([{ repo: 'c', spdxId: 'MIT' }, { repo: 'd', spdxId: 'NOASSERTION' }]);
  assert.equal(g5.commitAllowed, false);
});

test('T8: the dialect pin is DERIVED from the foreign parsers, not guessed', { skip: !FOREIGN_REPO && 'foreign repo required' }, async () => {
  const { citedUpstreams } = await import(TOOL);
  const manifest = citedUpstreams('MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms', FOREIGN_REPO, ['crates/parsers/src/dex/manifest.rs']);
  assert.ok(manifest.includes('CKS-Systems/manifest'), 'manifest.rs cites CKS-Systems/manifest');
  const solend = citedUpstreams('So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo', FOREIGN_REPO, ['crates/parsers/src/lending/solend/parser.rs']);
  assert.ok(solend.includes('solendprotocol/solana-program-library'), 'solend parser cites solendprotocol/... library');
  const saber = citedUpstreams('SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ', FOREIGN_REPO, ['crates/parsers/src/amm/saber.rs']);
  assert.ok(saber.includes('saber-hq/stable-swap'), 'saber.rs cites saber-hq/stable-swap');
  // a parser with no github citation yields no pin — no guess may be invented
  const saros = citedUpstreams('SSwapUtytfBdBn1b9NUGG6foMVPtcWgpRU32HToDUZr', FOREIGN_REPO, ['crates/parsers/src/amm/saros.rs']);
  assert.deepEqual(saros, [], 'saros.rs cites no upstream repo, so no pin may be invented');
  // a non-existent file yields no pin either
  assert.deepEqual(citedUpstreams('x', FOREIGN_REPO, ['no/such/file.rs']), []);
});

test('T9 (G, both trees): the committed classified sweep still pins gap 65', async () => {
  const sweep = JSON.parse(await readFile(CLASSIFIED_SWEEP, 'utf8'));
  assert.equal(sweep.summary.noInterface, 65);
  const dp = sweep.summary.byProgram;
  const sum32 = Object.entries(dp)
    .filter(([p]) => ['So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo','SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ','MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms','SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy','SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY','FarmqiPv5eAj3j1GMdMCMUGXqPUvmquZtMy86QH6rzhG','EhhTKczWMGQt46ynNeRX1WfeagwwJd7ufHvCDjRxjo5Q','PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY','SSwapUtytfBdBn1b9NUGG6foMVPtcWgpRU32HToDUZr'].includes(p))
    .reduce((n, [, v]) => n + v.noInterface, 0);
  assert.equal(sum32, 32, 'the 9 dedicated-parser programs must hold exactly 32 gap payloads');
});

test('T10: the committed upstream artifact is measured, complete, content-verified', async () => {
  const artifact = JSON.parse(await readFile(ARTIFACT, 'utf8'));
  assert.equal(artifact.tool, 'measure-dedicated-parser-upstream');
  assert.equal(artifact.summary.verdict, 'measured', 'a committed artifact must not carry no-verdict');
  assert.equal(artifact.control.matches, 1, 'positive control must have resolved');
  assert.equal(artifact.rows.length, 9);
  assert.equal(artifact.rows.reduce((n, r) => n + r.payloads, 0), 32);
  assert.equal(artifact.summary.byVerdict.unknown ?? 0, 0, 'a measured artifact has no unknown programs');
  assert.equal(artifact.licenseGate?.commitAllowed, false, 'some pinned upstream repo must block the commit (measured)');
  for (const row of artifact.rows) {
    assert.ok(row.dialectPin, 'the dialect pin must be recorded');
    assert.ok(Array.isArray(row.dialectPin.citedRepos), 'citedRepos must be an array');
    assert.ok(Array.isArray(row.dialectPin.licenses), 'license states must be recorded per cited repo');
    // every published/unbound finding is content-verified
    if (row.verdict === 'upstream-interface-published' || row.verdict === 'upstream-interface-unbound') {
      assert.ok(row.evidence, `${row.program} claims an interface without evidence`);
      const v = row.verifications.find((x) => x.repo === row.evidence.repo && x.path === row.evidence.path);
      assert.ok(v, 'evidence must be one of the content-verified candidates');
      assert.equal(v.ok, true, 'stale-index guard: the file must contain the literal');
      assert.equal(v.shaped, true, 'the file must be IDL-shaped');
      assert.ok(['declared', 'unbound', 'literal-mention'].includes(v.binding), `binding must be real, got ${v.binding}`);
      const l = row.dialectPin.licenses.find((x) => x.repo === row.evidence.repo);
      if (l) assert.notEqual(l.state, 'permissive', 'a committed interface would need its license measured as permissive first');
    }
  }
});
