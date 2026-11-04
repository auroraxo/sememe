// classify-publish-nothing.test.mjs — the 35 publish-nothing programs classified.
//
// The card's next step:
//   "die 35 verbleibenden publish-nothing-Programme nach demselben Muster
//    klassifizieren (First-Party-Datei im fremden Repo? eigener Dialekt?) —
//    NICHT die Deckungszahl polieren; die Adoptionsschwelle (ein fremder
//    Lauf) bleibt das Gate."
//
// Denominator: the committed shank sweep artifact
//   research/step-ingestooor-full-sweep-shank-2026-11-04.json
// (87 payloads across 35 programs, verified).
//
// Ladder (run against pre-tree: T1..T5 red, G1 guard green on both):
//   T1: tool exists and enforces CLI contract (exit 2 on missing args)
//   T2: candidates come from the shank report, verified against its headline;
//       a hand-edited headline or program count is refused before scanning
//   T3: the 4-way classification partitions the 35 programs without remainder;
//       every program is assigned exactly one verdict
//   T4: first-party foreign IDLs are verified: they declare the matching address
//       and valid instruction array
//   T5: the committed research artifact agrees with the live measurement
//   G1: false-positive guard: the SHANK sweep report keeps its headline (87 gap)

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'classify-publish-nothing.mjs');
const SHANK_REPORT = path.join(ROOT, 'research', 'step-ingestooor-full-sweep-shank-2026-11-04.json');
const CLASSIFIED_ARTIFACT = path.join(ROOT, 'research', 'publish-nothing-classification-2026-11-04.json');

const FOREIGN_REPO = process.env.SEMEME_STEP_INGESTOOR_PATH
  ?? (process.env.GITHUB_WORKSPACE
    ? path.join(process.env.GITHUB_WORKSPACE, 'step-ingestooor')
    : path.join(os.homedir(), 'github_repos', 'step-ingestooor'));
const hasForeignRepo = existsSync(path.join(FOREIGN_REPO, 'crates', 'idl-gens', 'idls'));

function runTool(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [TOOL, ...args], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }));
  });
}

test('T1: tool exists and enforces CLI contract', async () => {
  const { code, stderr } = await runTool([]);
  assert.equal(code, 2, 'usage refusal expected');
  assert.match(stderr, /--sweep/, 'must mention --sweep');
});

test('T2: candidate extraction verifies against the denominator', async () => {
  const { extractCandidates } = await import(TOOL);
  const shank = JSON.parse(await readFile(SHANK_REPORT, 'utf8'));
  const candidates = extractCandidates(shank);
  assert.equal(candidates.length, 35, 'exactly 35 programs in the publish-nothing set');
  assert.equal(candidates.reduce((sum, c) => sum + c.payloads, 0), 87, 'sum of payloads must equal 87');

  // Tamper detection: altered payload sum is refused
  const tampered = JSON.parse(JSON.stringify(shank));
  tampered.summary.noInterface = 88;
  assert.throws(() => extractCandidates(tampered), /hand-edited/);
});

test('T3: 4-way classification partitions the 35 programs without remainder', { skip: !hasForeignRepo && 'foreign repo required' }, async () => {
  const { classifyAll } = await import(TOOL);
  const shank = JSON.parse(await readFile(SHANK_REPORT, 'utf8'));
  const { rows, summary } = await classifyAll(shank, { foreignRepo: FOREIGN_REPO });

  assert.equal(rows.length, 35, 'all 35 programs classified');
  assert.equal(summary.programs, 35);
  assert.equal(summary.payloads, 87);

  // Partition check: sum of counts across all 4 categories must equal total
  const catSum = summary.byCategory['first-party-foreign-idl'].programs
    + summary.byCategory['dedicated-foreign-parser'].programs
    + summary.byCategory['core-runtime-program'].programs
    + summary.byCategory['unrepresented-source-gap'].programs;
  assert.equal(catSum, 35, 'every program belongs to exactly one category');

  const payloadSum = summary.byCategory['first-party-foreign-idl'].payloads
    + summary.byCategory['dedicated-foreign-parser'].payloads
    + summary.byCategory['core-runtime-program'].payloads
    + summary.byCategory['unrepresented-source-gap'].payloads;
  assert.equal(payloadSum, 87, 'every payload belongs to exactly one category');

  // Ground truths measured 2026-11-04:
  assert.equal(summary.byCategory['first-party-foreign-idl'].programs, 7, '7 programs have first-party IDL in the foreign repo');
  assert.equal(summary.byCategory['first-party-foreign-idl'].payloads, 22, '22 payloads behind first-party IDLs');
  assert.equal(summary.byCategory['dedicated-foreign-parser'].programs, 9, '9 programs have a dedicated parser in crates/parsers/src/');
  assert.equal(summary.byCategory['dedicated-foreign-parser'].payloads, 32, '32 payloads behind dedicated parsers (Solend 10, Saber 5, etc.)');
  assert.equal(summary.byCategory['core-runtime-program'].programs, 3, '3 programs are core runtime (Stake, Ed25519SigVerify, noop)');
  assert.equal(summary.byCategory['core-runtime-program'].payloads, 5, '5 payloads behind core runtime programs');
  assert.equal(summary.byCategory['unrepresented-source-gap'].programs, 16, '16 programs have neither IDL nor dedicated parser in the foreign repo');
  assert.equal(summary.byCategory['unrepresented-source-gap'].payloads, 28, '28 payloads in unrepresented gaps');
});

test('T4: first-party foreign IDLs declare their matching program address', { skip: !hasForeignRepo && 'foreign repo required' }, async () => {
  const { FIRST_PARTY_MAP } = await import(TOOL);
  assert.equal(Object.keys(FIRST_PARTY_MAP).length, 7);
  for (const [program, filename] of Object.entries(FIRST_PARTY_MAP)) {
    const full = path.join(FOREIGN_REPO, 'crates', 'idl-gens', 'idls', filename);
    assert.ok(existsSync(full), `${filename} must exist`);
    const idl = JSON.parse(await readFile(full, 'utf8'));
    assert.equal(idl.address, program, `${filename} must declare program address ${program}`);
    assert.ok(Array.isArray(idl.instructions) && idl.instructions.length > 0, `${filename} must have instructions`);
  }
});

test('T5: the committed classification artifact agrees with the live measurement', async () => {
  assert.ok(existsSync(CLASSIFIED_ARTIFACT), 'classification artifact must be committed');
  const artifact = JSON.parse(await readFile(CLASSIFIED_ARTIFACT, 'utf8'));
  assert.equal(artifact.tool, 'classify-publish-nothing');
  assert.equal(artifact.summary.programs, 35);
  assert.equal(artifact.summary.payloads, 87);
  assert.equal(artifact.summary.byCategory['first-party-foreign-idl'].programs, 7);
  assert.equal(artifact.summary.byCategory['first-party-foreign-idl'].payloads, 22);
  assert.equal(artifact.summary.byCategory['dedicated-foreign-parser'].programs, 9);
  assert.equal(artifact.summary.byCategory['dedicated-foreign-parser'].payloads, 32);
  assert.equal(artifact.summary.byCategory['core-runtime-program'].programs, 3);
  assert.equal(artifact.summary.byCategory['core-runtime-program'].payloads, 5);
  assert.equal(artifact.summary.byCategory['unrepresented-source-gap'].programs, 16);
  assert.equal(artifact.summary.byCategory['unrepresented-source-gap'].payloads, 28);
});

test('G1 false-positive guard: the SHANK sweep report keeps its headline (87 gap)', async () => {
  const shank = JSON.parse(await readFile(SHANK_REPORT, 'utf8'));
  assert.equal(shank.summary.noInterface, 87);
  assert.equal(shank.summary.decoded, 703);
  assert.equal(shank.summary.byteExactFull, 696);
  assert.equal(shank.summary.disagreements, 0);
  assert.equal(shank.summary.decodeErrors, 16);
});
