#!/usr/bin/env node
// tools/measure-token-encoder-fallback.mjs — CAN THE ENCODER REPRODUCE THE
// NAMES THE TOKEN TABLE CLAIMS? Measured on both trees, same convention as
// tools/measure-hadro-count-from-header.mjs.
//
// THE DEFECT THIS MEASURES (found 2026-11-15 while taking over an interrupted
// pulse; pre-fix tree = commit e28c849 == tag v0.4.27 == npm latest):
//
//   Token-2022's processor tries its ONE-BYTE token table first and falls
//   through to `TokenMetadataInstruction::unpack`. src/token.mjs mirrors that
//   order on DECODE and advertises the five fallback names through
//   tokenNames() / isTokenName() (48 token + 5 metadata = 53 names), but the
//   ENCODER never learned the branch:
//
//     tokenNames(TOKEN_2022) contains 'Initialize'        -> true
//     isTokenName(TOKEN_2022, 'Initialize')               -> true
//     encodeTokenInstruction(TOKEN_2022, 'Initialize', …) -> unknown-variant
//
//   for ALL FIVE names (pre-fix: unknownVariantNames = 5). The product could
//   therefore NAME bytes it could not reproduce — reachable by any consumer
//   that re-encodes from the decoded name (tools/stranger-decode.mjs does it
//   as its second byte check) — while every round-trip test stayed green
//   because the fallback decoder computes roundTripByteExact with its OWN
//   encoder.
//
//   Second face, same wrap site: the wrapper passed error.message (already
//   "reason: detail") into a constructor that prefixes the reason again, so
//   a refusal printed "trailing-bytes: trailing-bytes: …" (pre-fix
//   reasonDoubled = true).
//
// METHOD: the byte-identical probe tools/token-encoder-fallback-probe.mjs is
// copied into BOTH trees — one extracted with `git archive <prefix>` (stable
// forever), one the working tree — so only src/ differs between the runs.
// The verdict is DERIVED from pinned expectations: the prefix tree must show
// every defect face, the fix tree must show none, and the guard faces must
// hold on both.
//
// Exit codes: 0 measured and verified; 3 NO VERDICT; 2 bad usage.

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PROBE = path.join(HERE, 'token-encoder-fallback-probe.mjs');

const PREFIX = 'e28c849'; // the tree tag v0.4.27 shipped: the pre-fix face

const flag = (name, fallback) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined) throw Error(`missing value for ${name}`);
  return value;
};

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
  const target = path.join(treeRoot, 'tools', 'token-encoder-fallback-probe.mjs');
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

function summary(face) {
  return {
    namesAdvertised: face.namesAdvertised,
    metadataNamesAdvertised: face.metadataNamesAdvertised,
    unknownVariantNames: face.unknownVariantNames,
    fixtureReencoded: `${face.fixture.reencoded}/${face.fixture.total}`,
    fixtureRefusals: face.fixture.refused,
    oracleReencoded: `${face.oracle.reencoded}/${face.oracle.total}`,
    oracleRefusals: face.oracle.refused,
    wrappedVoice: face.wrappedVoice,
    reasonDoubled: face.reasonDoubled,
    legacySPLToken: face.legacy,
  };
}

async function main() {
  const outPath = flag('--out', path.join(ROOT, 'research', `token-encoder-fallback-${new Date().toISOString().slice(0, 10)}.json`));

  const tmp = mkdtempSync(path.join(tmpdir(), 'sememe-encfb-prefix-'));
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
  // The prefix tree must SHOW the defect (it is the shipped pre-fix face).
  if (prefix.unknownVariantNames.length !== 5) {
    falsifications.push(`prefix refuses ${prefix.unknownVariantNames.length} advertised names, expected 5: ${prefix.unknownVariantNames.join(',')}`);
  }
  if (prefix.fixture.reencoded !== 0) {
    falsifications.push(`prefix re-encoded ${prefix.fixture.reencoded}/${prefix.fixture.total} fixture payloads, expected 0`);
  }
  if (prefix.oracle.reencoded !== 0) {
    falsifications.push(`prefix re-encoded ${prefix.oracle.reencoded}/${prefix.oracle.total} oracle payloads, expected 0`);
  }
  if (prefix.reasonDoubled !== true) {
    falsifications.push('prefix does not print the refusal reason twice — the prefix is not the pre-fix tree');
  }
  // The fix tree must show NONE of them.
  if (worktree.unknownVariantNames.length !== 0) {
    falsifications.push(`fix tree still refuses advertised names: ${worktree.unknownVariantNames.join(',')}`);
  }
  if (worktree.fixture.reencoded !== worktree.fixture.total) {
    falsifications.push(`fix tree re-encoded ${worktree.fixture.reencoded}/${worktree.fixture.total} fixture payloads`);
  }
  if (worktree.oracle.reencoded !== worktree.oracle.total) {
    falsifications.push(`fix tree re-encoded ${worktree.oracle.reencoded}/${worktree.oracle.total} oracle payloads`);
  }
  if (worktree.reasonDoubled !== false) {
    falsifications.push(`fix tree voice: ${worktree.wrappedVoice}`);
  }
  if (worktree.namesAdvertised !== 53 || worktree.metadataNamesAdvertised !== 5) {
    falsifications.push(`fix tree advertises ${worktree.namesAdvertised} names (${worktree.metadataNamesAdvertised} metadata), expected 53 (5)`);
  }
  // Guards: the fallback must not leak into legacy SPL Token on EITHER tree.
  for (const [tree, face] of [['prefix', prefix], ['fix', worktree]]) {
    const leaked = Object.entries(face.legacy).filter(([, outcome]) => outcome !== 'unknown-variant');
    if (leaked.length) falsifications.push(`${tree} tree encoded metadata names on legacy SPL Token: ${JSON.stringify(leaked)}`);
  }

  const artifact = {
    tool: 'tools/measure-token-encoder-fallback.mjs',
    measuredAt: new Date().toISOString(),
    question: 'can sememe encode every name its own token table advertises for Token-2022?',
    program: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    fixture: 'test/fixtures/ecosystem-sample-2026-11-11.json',
    oracle: 'research/token-metadata-oracle-2026-11-03.json',
    method: 'byte-identical probe copied into both trees; prefix extracted with git archive; only src/ differs',
    prefix: { commit: PREFIX, face: summary(prefix) },
    worktree: { face: summary(worktree) },
    verdict: falsifications.length === 0 ? 'encoder-reproduces-its-own-names' : 'falsified',
    falsifications,
    limits: [
      'measures the ENCODER against names the table advertises, not a live foreign consumer',
      'the five metadata names are the pinned upstream variant list; extension sub-instructions are still reported as trailing',
      'the metadata fallback is Token-2022 only; legacy SPL Token is a guard face here, not a claim',
      'a payload whose first byte IS a token variant never reaches the fallback (upstream dispatch order, unchanged)',
    ],
  };

  if (artifact.verdict === 'falsified') {
    console.error(`FALSIFIED:\n- ${artifact.falsifications.join('\n- ')}`);
    await writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
    console.error(`artifact written to ${path.relative(ROOT, outPath)}`);
    process.exit(1);
  }

  await writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`${artifact.verdict}: prefix ${JSON.stringify(summary(prefix).unknownVariantNames)} vs fix []`);
  console.log(`fixture ${artifact.prefix.face.fixtureReencoded} -> ${artifact.worktree.face.fixtureReencoded}, `
    + `oracle ${artifact.prefix.face.oracleReencoded} -> ${artifact.worktree.face.oracleReencoded}`);
  console.log(`artifact: ${path.relative(ROOT, outPath)}`);
}

main().catch((error) => {
  console.error(String(error?.stack ?? error).slice(0, 800));
  process.exit(3);
});
