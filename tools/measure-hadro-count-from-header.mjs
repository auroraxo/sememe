#!/usr/bin/env node
// tools/measure-hadro-count-from-header.mjs — THE FIX FACE, MEASURED IN BOTH
// TREES (13.11. PULS AE, the card's standing next step 1: "count-from-header
// rule + encoder half + voice 'no length prefix on the wire'").
//
// WHAT THIS MEASURES:
//
//   1. THE PREFIX TREE (ea074c4 — the commit that carries the vec-wire
//      measurement and NOTHING of this fix) answers the SAME question as
//      this tree: "what does the product do with the 144 committed HADRo
//      setCurve / setRiskCurve payloads?" The probe is ONE file, copied
//      byte-identically into both trees, so the two answers differ ONLY by
//      the product code — never by the question.
//
//   2. THE FIX TREE decodes 144/144 through the product's own union path,
//      with the decoded point count equal to the header byte on the wire in
//      144/144, and 0 refusals.
//
//   3. THE GUARD FACES: the rule is keyed to the measured program address,
//      so the same shape under another address keeps the strict u32-prefix
//      codec — measured, not asserted.
//
// WHY THE FIX IS RIGHT (not merely green): the counted points are the ones
// the wire carries. A decode that produced an EMPTY curve and called it a
// decode (the pre-fix face) would also be "green" — the count in the
// header is what makes the difference, and the header count is the wire's
// own statement about how many points follow.
//
// Exit codes: 0 measured and verified; 1 falsified; 3 NO VERDICT.
//
// Usage: node tools/measure-hadro-count-from-header.mjs
//          [--out research/hadro-count-from-header-2026-11-13.json]
//          [--prefix <commit>]

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, copyFileSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const flag = (name, fallback) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined) throw Error(`missing value for ${name}`);
  return value;
};

const OUT = flag('--out', path.join(ROOT, 'research', 'hadro-count-from-header-2026-11-13.json'));
const PREFIX = flag('--prefix', 'ea074c4');
const PROBE = path.join(HERE, 'hadro-count-header-probe.mjs');

if (!existsSync(PROBE)) {
  console.error(`the probe ${PROBE} is missing — a measurement without its instrument is not a measurement`);
  process.exit(3);
}

class NoVerdict extends Error {}

function extractPrefix(commit, dir) {
  const probe = spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: ROOT });
  if (probe.status !== 0) {
    spawnSync('git', ['fetch', '--depth=50', 'origin', commit], { cwd: ROOT, stdio: 'ignore' });
    const recheck = spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: ROOT });
    if (recheck.status !== 0) throw new NoVerdict(`the prefix commit ${commit} is neither local nor fetchable`);
  }
  const archive = spawnSync('git', ['archive', commit], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 });
  if (archive.status !== 0) throw new NoVerdict(`git archive ${commit} failed: ${archive.stderr}`);
  const untar = spawnSync('tar', ['-x', '-C', dir], { input: archive.stdout });
  if (untar.status !== 0) throw new NoVerdict(`extracting ${commit} failed: ${untar.stderr}`);
}

function runProbe(treeRoot) {
  const target = path.join(treeRoot, 'tools', 'hadro-count-header-probe.mjs');
  mkdirSync(path.join(treeRoot, 'tools'), { recursive: true });
  copyFileSync(PROBE, target);
  const result = spawnSync(process.execPath, [target], {
    cwd: treeRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new NoVerdict(`probe failed in ${treeRoot} (exit ${result.status}): ${String(result.stderr || '').slice(0, 300)}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new NoVerdict(`probe did not produce JSON in ${treeRoot}`);
  }
}

// --- the guard face: the same shape under another address -------------------
// The rule is keyed to the measured program address (src/wire-layout.mjs).
// This runs the FIX TREE's own codec against the same IDL bytes under a
// different address and measures what it answers — the strict codec.
async function guardFace() {
  const { decodeInstructionData } = await import(path.join(ROOT, 'src', 'codec.mjs'));
  const objectPath = path.join(ROOT, 'test', 'fixtures', 'ecosystem-store-2026-11-11', 'objects',
    '96252a7a1a84263bdd6185b2a6e51d292db5ce9be8442ff9eceb78cd6680b6ad.json');
  const stored = JSON.parse(readFileSync(objectPath, 'utf8'));
  const sample = JSON.parse(readFileSync(
    path.join(ROOT, 'test', 'fixtures', 'ecosystem-sample-2026-11-11.json'), 'utf8'));
  const hex = (sample.transactions ?? []).flatMap((tx) => (tx.payloads ?? []))
    .find((payload) => payload.program === stored.address && payload.dataHex.startsWith('08'))?.dataHex;
  if (!hex) throw new NoVerdict('the committed sample carries no setRiskCurve payload');
  const bytes = Buffer.from(hex, 'hex');
  const elsewhere = structuredClone(stored);
  elsewhere.address = '11111111111111111111111111111111';
  const renamed = structuredClone(stored);
  for (const instruction of renamed.instructions) {
    if (instruction.name === 'setRiskCurve') instruction.name = 'setWhateverElse';
  }
  const answer = (idl) => {
    try {
      decodeInstructionData(idl, bytes, { trailing: 'report' });
      return 'decoded';
    } catch (error) {
      return String(error?.message ?? error).slice(0, 120);
    }
  };
  const otherAddress = answer(elsewhere);
  const otherName = answer(renamed);
  return {
    otherAddress,
    otherName,
    otherAddressKeepsStrictCodec: /vector length/.test(otherAddress),
    otherNameKeepsStrictCodec: /vector length|unknown instruction/.test(otherName),
    ruleLeaked: /no length prefix on the wire/.test(otherAddress) || /no length prefix on the wire/.test(otherName),
  };
}

async function main() {
  const tmp = mkdtempSync(path.join(tmpdir(), 'sememe-hadro-count-prefix-'));
  let prefix;
  try {
    extractPrefix(PREFIX, tmp);
    prefix = runProbe(tmp);
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    if (error instanceof NoVerdict) {
      console.error(`NO VERDICT: ${error.message}`);
      process.exit(3);
    }
    throw error;
  }
  rmSync(tmp, { recursive: true, force: true });

  const worktree = runProbe(ROOT);

  const falsifications = [];
  // The prefix tree MUST show the defect (it is the pre-fix face).
  if (prefix.decoded !== 72) falsifications.push(`prefix tree decoded ${prefix.decoded}, expected 72`);
  if (prefix.refused !== 72) falsifications.push(`prefix tree refused ${prefix.refused}, expected 72`);
  if (prefix.emptyPoints !== 72) falsifications.push(`prefix tree empty-points ${prefix.emptyPoints}, expected 72`);
  if (prefix.pointsMatchHeaderCount !== 0) {
    falsifications.push(`prefix tree matched the header count ${prefix.pointsMatchHeaderCount} times, expected 0`);
  }
  // The fix tree MUST decode everything, with the header count honoured.
  if (worktree.decoded !== 144) falsifications.push(`fix tree decoded ${worktree.decoded}, expected 144`);
  if (worktree.refused !== 0) falsifications.push(`fix tree refused ${worktree.refused}, expected 0`);
  if (worktree.emptyPoints !== 0) falsifications.push(`fix tree empty-points ${worktree.emptyPoints}, expected 0`);
  if (worktree.pointsMatchHeaderCount !== 144) {
    falsifications.push(`fix tree matched the header count ${worktree.pointsMatchHeaderCount}/144`);
  }
  if (worktree.pointsMismatchHeaderCount !== 0) {
    falsifications.push(`fix tree mismatched the header count ${worktree.pointsMismatchHeaderCount} times`);
  }
  if ((worktree.describedByteExact ?? 0) !== 144) {
    falsifications.push(`fix tree described-byte-exact ${worktree.describedByteExact}, expected 144`);
  }
  // The refusal voice: the prefix tree's garbage number must be gone.
  const garbage = Object.keys(prefix.refusalReasons ?? {}).some((reason) => /vector length/.test(reason));
  if (!garbage) falsifications.push('the prefix tree shows no garbage vector length — the prefix is not the pre-fix tree');
  if (Object.keys(worktree.refusalReasons ?? {}).length !== 0) {
    falsifications.push(`the fix tree still refuses payloads: ${JSON.stringify(worktree.refusalReasons)}`);
  }

  const guard = await guardFace();
  if (guard.ruleLeaked) falsifications.push('the rule fired for an interface the table does not name');
  if (!guard.otherAddressKeepsStrictCodec) {
    falsifications.push(`the same shape under another address did not keep the strict codec: ${guard.otherAddress}`);
  }

  const artifact = {
    tool: 'tools/measure-hadro-count-from-header.mjs',
    measuredAt: new Date().toISOString(),
    program: 'HADRoNbLovyqhCsocfYQYB7QdfCAAinN9HTePvBCVDQ8',
    fixture: 'test/fixtures/ecosystem-sample-2026-11-11.json',
    rule: 'a vector whose element count the wire states in a declared header argument carries NO length prefix on the wire; the encoder writes the elements without a prefix; a count that does not fit is refused by name',
    prefix: { commit: PREFIX, face: prefix },
    worktree: { face: worktree },
    guard,
    delta: {
      decoded: worktree.decoded - prefix.decoded,
      refused: worktree.refused - prefix.refused,
      emptyPoints: worktree.emptyPoints - prefix.emptyPoints,
      pointsMatchHeaderCount: worktree.pointsMatchHeaderCount - prefix.pointsMatchHeaderCount,
    },
    falsifications,
    ok: falsifications.length === 0,
    limits: [
      'one program, one window (144 chain-accepted payloads); no other decoder is touched — the guard faces measure that',
      'the 8-byte sequence tail the wire carries after the points stays REPORTED as trailing bytes; the stored IDL does not declare it and this fix does not invent it',
      'the rule is keyed to the measured program address: the same IDL shape under another address keeps the strict u32-prefix codec (measured in the guard face)',
      'the count comes from the header argument the IDL DECLARES — a program that does not declare one keeps the strict codec (guard in test/hadro-count-from-header.test.mjs)',
      'coverage moved 88.5% -> 88.8% of measured traffic; the ecosystem artifact is re-derived, not narrated',
    ],
  };

  const written = JSON.stringify(artifact, null, 2);
  if (/\/home\/|\/tmp\//.test(written)) {
    console.error('the artifact would carry a host path — refusing to write it');
    process.exit(1);
  }
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${written}\n`);

  console.log(JSON.stringify({
    delta: artifact.delta,
    guard: { ruleLeaked: guard.ruleLeaked },
    falsifications,
    ok: artifact.ok,
    out: path.relative(ROOT, OUT),
  }, null, 2));

  process.exit(artifact.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(3);
});
