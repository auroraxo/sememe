// classified-sweep-report.test.mjs — the post-classification sweep is PINNED, not guessed.
//
// Denominator: the committed research artifact
//   research/step-ingestooor-full-sweep-classified-2026-11-04.json
// measured against the 156-fixture foreign set (step-ingestooor @001cf39, MIT)
// after adopting the 7 first-party IDLs identified in the classification.
//
// Falsification ladder:
//   T1: offline and complete (0 network attempts, status pass, all 156 fixtures read)
//   T2: exact deltas from shank sweep:
//       - decoded: 703 -> 724 (+21 payloads decoded)
//       - gap: 87 -> 65 (-22 payloads, 7 programs exit the gap set)
//       - byteExactFull: 696 -> 716 (+20 full byte-exact)
//       - byteExactDescribed: 7 -> 8 (+1 described byte-exact: titan swap)
//       - decodeErrors: 16 -> 17 (the titan Venue variant 40 refusal is NAMED)
//       - disagreements: 0 (still diff-free)
//   T3: exactly the 7 planned programs moved in byProgram; no other row shifted
//   T4: every moved program's numbers match the live decode verdict
//   T5: the remaining 28 gap programs sum to exactly 65 payloads
//   G1: false-positive guard: a tampered headline is caught against byProgram sum

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const CLASSIFIED_REPORT = path.join(ROOT, 'research', 'step-ingestooor-full-sweep-classified-2026-11-04.json');
const SHANK_REPORT = path.join(ROOT, 'research', 'step-ingestooor-full-sweep-shank-2026-11-04.json');

const ADOPTED_PROGRAMS = [
  'FL3X2pRsQ9zHENpZSKDRREtccwJuei8yg9fwDu9UN69Q', // Lulo: 7 payloads -> 7 decoded
  'NXFiKimQN3QSL3CDhCXddyVmLfrai8HK36bHKaAzK7g', // NX Lending: 4 -> 4 decoded
  'sSo1iU21jBrU9VaJ8PJib1MtorefUV4fzC9GURa2KNn', // Solayer Restake: 3 -> 3 decoded
  'endoLNCKTqDn8gSVnN2hDdpgACUPWHZTwoYnnMybpAT', // Solayer AVS: 2 -> 2 decoded
  'RopsJ74nrtcsk9iND8CFFNjn5mxf1tFzF3RhMPJ3CdV', // Reward Options: 1 -> 1 decoded
  'T1TANpTeScyeqVzzgNViGDNrkQ6qHz9KrSBS4aNXvGT', // Titan: 4 payloads -> 3 decoded, 1 refused (Venue variant 40)
  'Stk5NCWomVN3itaFjLu382u9ibb5jMSHEsh6CuhaGjB', // Step Staking: 1 -> 1 decoded
];

test('T1: the classified sweep report is offline, complete, and un-tampered', async () => {
  assert.ok(existsSync(CLASSIFIED_REPORT), 'classified sweep report must be committed');
  const report = JSON.parse(await readFile(CLASSIFIED_REPORT, 'utf8'));
  const shank = JSON.parse(await readFile(SHANK_REPORT, 'utf8'));

  assert.equal(report.networkAttempts, 0);
  assert.equal(report.status, 'pass');
  assert.equal(report.summary.fixturesTotal, 156);
  assert.equal(report.summary.fixturesUnreadable, 0);
  assert.equal(report.summary.payloadsChecked, shank.summary.payloadsChecked);
  assert.equal(report.summary.missingBytes, shank.summary.missingBytes);
});

test('T2: deltas from the shank sweep match the measured ground truth', async () => {
  const report = JSON.parse(await readFile(CLASSIFIED_REPORT, 'utf8'));
  const shank = JSON.parse(await readFile(SHANK_REPORT, 'utf8'));
  const s = report.summary;
  const base = shank.summary;

  assert.equal(base.decoded, 703);
  assert.equal(s.decoded, 724, 'decoded: 703 -> 724 (+21 payloads decoded)');
  assert.equal(base.noInterface, 87);
  assert.equal(s.noInterface, 65, 'gap: 87 -> 65 (22 payloads resolved: 21 decoded + 1 named refusal)');
  assert.equal(base.byteExactFull, 696);
  assert.equal(s.byteExactFull, 716, 'byte-exact: 696 -> 716 (+20 full byte-exact)');
  assert.equal(base.byteExactDescribed, 7);
  assert.equal(s.byteExactDescribed, 8, 'byte-exact described: 7 -> 8 (+1 Titan swap described exact)');
  assert.equal(s.byteExactRate, 100);
  assert.equal(base.decodeErrors, 16);
  assert.equal(s.decodeErrors, 17, 'decodeErrors: 16 -> 17 (Titan Venue variant 40 refusal is NAMED)');
  assert.equal(s.disagreements, 0, 'still diff-free');
});

test('T3: exactly the 7 adopted programs moved in byProgram', async () => {
  const report = JSON.parse(await readFile(CLASSIFIED_REPORT, 'utf8'));
  const shank = JSON.parse(await readFile(SHANK_REPORT, 'utf8'));
  const bpA = shank.summary.byProgram;
  const bpB = report.summary.byProgram;

  const moved = Object.keys(bpA)
    .filter((p) => JSON.stringify(bpA[p]) !== JSON.stringify(bpB[p]))
    .sort();
  assert.deepEqual(moved, [...ADOPTED_PROGRAMS].sort(), 'exactly the 7 adopted programs must move');
});

test('T4: moved programs match their live decode numbers', async () => {
  const report = JSON.parse(await readFile(CLASSIFIED_REPORT, 'utf8'));
  const bp = report.summary.byProgram;

  assert.deepEqual(bp['FL3X2pRsQ9zHENpZSKDRREtccwJuei8yg9fwDu9UN69Q'],
    { payloads: 7, decoded: 7, decodeErrors: 0, disagreements: 0, noInterface: 0 });
  assert.deepEqual(bp['NXFiKimQN3QSL3CDhCXddyVmLfrai8HK36bHKaAzK7g'],
    { payloads: 4, decoded: 4, decodeErrors: 0, disagreements: 0, noInterface: 0 });
  assert.deepEqual(bp['sSo1iU21jBrU9VaJ8PJib1MtorefUV4fzC9GURa2KNn'],
    { payloads: 3, decoded: 3, decodeErrors: 0, disagreements: 0, noInterface: 0 });
  assert.deepEqual(bp['endoLNCKTqDn8gSVnN2hDdpgACUPWHZTwoYnnMybpAT'],
    { payloads: 2, decoded: 2, decodeErrors: 0, disagreements: 0, noInterface: 0 });
  assert.deepEqual(bp['RopsJ74nrtcsk9iND8CFFNjn5mxf1tFzF3RhMPJ3CdV'],
    { payloads: 1, decoded: 1, decodeErrors: 0, disagreements: 0, noInterface: 0 });
  assert.deepEqual(bp['T1TANpTeScyeqVzzgNViGDNrkQ6qHz9KrSBS4aNXvGT'],
    { payloads: 4, decoded: 3, decodeErrors: 1, disagreements: 0, noInterface: 0 },
    'Titan: 3 decoded, 1 refusal (Venue variant 40)');
  assert.deepEqual(bp['Stk5NCWomVN3itaFjLu382u9ibb5jMSHEsh6CuhaGjB'],
    { payloads: 1, decoded: 1, decodeErrors: 0, disagreements: 0, noInterface: 0 });
});

test('T5: remaining 28 gap programs sum to exactly 65 payloads', async () => {
  const report = JSON.parse(await readFile(CLASSIFIED_REPORT, 'utf8'));
  const ni = report.summary.noInterfacePrograms;
  assert.equal(Object.keys(ni).length, 28, 'exactly 28 programs remain in the gap set');
  const sum = Object.values(ni).reduce((a, b) => a + b, 0);
  assert.equal(sum, 65, 'sum must equal 65');
  assert.equal(report.summary.noInterface, 65);
});

test('G1 false-positive guard: headline tampering is caught', async () => {
  const report = JSON.parse(await readFile(CLASSIFIED_REPORT, 'utf8'));
  const s = report.summary;
  const tampered = { ...report, summary: { ...s, decoded: s.decoded + 1 } };
  const derived = Object.values(tampered.summary.byProgram).reduce((n, r) => n + r.decoded, 0);
  assert.notEqual(derived, tampered.summary.decoded, 'the hand-edited headline must disagree with byProgram');
  assert.equal(s.decoded, Object.values(s.byProgram).reduce((n, r) => n + r.decoded, 0));
});
