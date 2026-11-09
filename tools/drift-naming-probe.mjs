#!/usr/bin/env node
// tools/drift-naming-probe.mjs — SCORE BOTH TREES AGAINST GROUND TRUTH
//
// This file is deliberately a PROBE: it is byte-copied into any tree of this
// repository (the current one, or one extracted from git history with
// `git archive`) and answers the SAME question in both, so only the src/
// under test can change the answer.
//
// THE QUESTION, per program, over the committed fixtures (no network):
//
//   Two verified copies of one program decode the SAME bytes. Do they
//   DISAGREE ABOUT THE DATA, or do they merely SPELL the same data
//   differently (`inAmount` vs `in_amount`)?
//
// THE ORACLE IS IN THIS FILE and imports NOTHING from the union layer:
//
//   * it decodes both copies directly with src/codec.mjs + src/discriminators.mjs
//     (byte-identical between the trees being compared — verified when this
//     probe was written);
//   * it pairs the two argument trees by a normalisation implemented HERE,
//     not in src/drift.mjs, and classifies the row as
//       namingOnly   — same names after pairing, same values: NOT a drift
//       realDiff     — a value, a shape, or a one-sided field differs: IS a drift
//       undecidable  — one side refused: no verdict about agreement
//
// WHAT IS COUNTED, per half (instructions / accounts), per program:
//
//   verdictCounts                 what the TREE said
//   oracle.namingOnly / realDiff  what the ORACLE says (independent)
//   unjustifiedDriftRows          tree said `layout_drift`, oracle says naming-only
//                                (a green-alarm: a disagreement about nothing)
//   hiddenRealDiffRows            tree said `agree`, oracle says real difference
//                                (the green lie the fix must not introduce)
//   reportedPaths / spellingOnly  what the tree's report shows
//   truncatedRows                 rows whose path list hit the cap
//
// A fix is CORRECT if and only if, in the fixed tree:
//   unjustifiedDriftRows == 0  AND  hiddenRealDiffRows == 0.
// On the pre-fix tree unjustifiedDriftRows is expected to be large — that is
// the defect, measured rather than asserted.
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../src/canonical.mjs';
import { adopt } from '../src/adopt.mjs';
import { decodeUnionPayload, decodeUnionStoredAccount } from '../src/decode.mjs';
import { decodeData, toJsonSafe } from '../src/codec.mjs';
import { withDerivedDiscriminators } from '../src/discriminators.mjs';
import { decodeAccountData, withDerivedAccountDiscriminators, identifyAccount } from '../src/account.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

// The synthetic slot stands in for a real pull; it decides which receipt is
// "newest", nothing else. Recorded so the artifact says so.
const SLOT = 466833000;

const PROGRAMS = [
  {
    name: 'pump.fun',
    program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    onchain: 'pump-idl.json',
    published: 'pump-published-idl.json',
    harvest: 'harvest-pump-2026-10-30.json',
    accounts: 'accounts-pump-2026-11-08.json',
  },
  {
    name: 'meteora-vault',
    program: '24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi',
    onchain: 'meteora-vault-idl.json',
    published: 'meteora-vault-published-idl.json',
    harvest: 'harvest-meteora-vault-2026-10-29.json',
    accounts: 'accounts-meteora-vault-2026-11-08.json',
  },
  {
    name: 'meteora-damm-v1',
    program: 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB',
    onchain: 'meteora-damm-v1-idl.json',
    published: 'meteora-damm-v1-published-idl.json',
    harvest: 'harvest-meteora-damm-v1-2026-10-29.json',
    accounts: 'accounts-meteora-damm-v1-2026-11-08.json',
  },
  {
    name: 'openbook-v2',
    program: 'opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb',
    onchain: 'openbook-v2-idl.json',
    published: 'openbook-v2-published-idl.json',
    harvest: 'harvest-openbook-v2-2026-10-29.json',
    accounts: 'accounts-openbook-v2-2026-10-29.json',
  },
];

const load = async (name) => JSON.parse(await readFile(path.join(FIXTURES, name), 'utf8'));

async function buildStore(spec, onchain) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sememe-drift-probe-'));
  await mkdir(path.join(dir, 'objects'), { recursive: true });
  await mkdir(path.join(dir, 'receipts'), { recursive: true });
  const bytes = Buffer.from(canonicalJson(onchain) + '\n');
  const fp = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(dir, 'objects', `${fp}.json`), bytes);
  await writeFile(
    path.join(dir, 'receipts', `${spec.program}-${SLOT}-metadata-${fp}.json`),
    Buffer.from(canonicalJson({
      program: spec.program,
      source: 'metadata',
      slot: SLOT,
      fingerprint: `sha256:${fp}`,
      instructionCount: (onchain.instructions ?? []).length,
    }) + '\n'),
  );
  await adopt(spec.program, path.join(FIXTURES, spec.published), dir, {
    source: 'published',
    origin: spec.published,
  });
  return dir;
}

// ---------------------------------------------------------------------------
// THE ORACLE — independent of the union layer under test.
// ---------------------------------------------------------------------------

/** Normalise a field name: drop leading underscores, snake_case -> camelCase.
 * Implemented here on purpose: the probe must not import the rule it judges. */
const normalise = (key) => String(key)
  .replace(/^_+/, '')
  .replace(/_+([a-z0-9])/g, (m, c) => c.toUpperCase());

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// `decodeData` returns 64/128-bit integers as BigInt (src/codec.mjs); toJsonSafe
// renders them to decimal strings before any comparison. Instrument error found
// while writing this probe: JSON.stringify threw on the first BigInt and every
// such row was silently counted `undecidable` — a truth that fails open.
const sameValue = (a, b) => JSON.stringify(toJsonSafe(a)) === JSON.stringify(toJsonSafe(b));

/**
 * Classify one pair of decoded trees, and NAME the real differences.
 *
 * @returns {{ verdict: 'namingOnly' | 'realDiff', realPaths: string[] }}
 *   `realPaths` are the fields whose VALUE or SHAPE differs, or that only one
 *   side declares — the differences a drift report must name. A report that
 *   does not name them hides them behind the path cap.
 */
function classify(primaryArgs, secondaryArgs) {
  const realPaths = [];
  const walk = (a, b, path) => {
    if (Array.isArray(a) && Array.isArray(b)) {
      // The array is named as ONE field, the way a drift report names it:
      // `padding.padding0`, not `padding.padding0[0]`. Element granularity
      // would make the oracle and the report disagree about granularity
      // rather than about content — a comparison artefact, not a finding.
      const differs = a.length !== b.length
        || a.some((value, i) => !sameValue(value, b[i]));
      if (differs) realPaths.push(path || '(root)');
      return;
    }
    if (!isPlainObject(a) || !isPlainObject(b)) {
      if (!sameValue(a, b)) realPaths.push(path || '(root)');
      return;
    }
    const group = (obj) => {
      const map = new Map();
      for (const key of Object.keys(obj)) {
        const nk = normalise(key);
        if (!map.has(nk)) map.set(nk, []);
        map.get(nk).push(key);
      }
      return map;
    };
    const aMap = group(a);
    const bMap = group(b);
    for (const nk of new Set([...aMap.keys(), ...bMap.keys()])) {
      const aKeys = aMap.get(nk) ?? [];
      const bKeys = bMap.get(nk) ?? [];
      // A field only one side declares is a real difference: naming
      // normalisation must not make a missing field present.
      const shared = Math.min(aKeys.length, bKeys.length);
      if (aKeys.length !== bKeys.length) {
        for (const key of aKeys.slice(shared)) realPaths.push(path ? `${path}.${key}` : key);
        for (const key of bKeys.slice(shared)) realPaths.push(path ? `${path}.${key}` : key);
        continue;
      }
      for (let i = 0; i < shared; i += 1) {
        walk(a[aKeys[i]], b[bKeys[i]], path ? `${path}.${aKeys[i]}` : aKeys[i]);
      }
    }
  };
  walk(primaryArgs, secondaryArgs, '');
  return { verdict: realPaths.length > 0 ? 'realDiff' : 'namingOnly', realPaths };
}

/** Decode both copies directly. Returns null when a side refuses. */
function oracleInstruction(dir, onchainIdl, publishedIdl, bytes) {
  try {
    const a = withDerivedDiscriminators(onchainIdl).idl;
    const b = withDerivedDiscriminators(publishedIdl).idl;
    const da = decodeData(a, bytes, { trailing: 'report' });
    const db = decodeData(b, bytes, { trailing: 'report' });
    if (da.kind !== db.kind) return { verdict: 'undecidable', realPaths: [] };
    // One instruction under two naming conventions (`claimFee` vs `claim_fee`)
    // is the same rule the normaliser applies to field names — decided HERE,
    // with this file's own normaliser, so the oracle stays independent of the
    // union layer it is judging.
    if (da.instruction !== db.instruction && normalise(da.instruction) !== normalise(db.instruction)) {
      return { verdict: 'undecidable', realPaths: [] };
    }
    return classify(da.args, db.args);
  } catch {
    return { verdict: 'undecidable', realPaths: [] };
  }
}

function oracleAccount(onchainIdl, publishedIdl, bytes) {
  try {
    const a = withDerivedAccountDiscriminators(onchainIdl).idl;
    const b = withDerivedAccountDiscriminators(publishedIdl).idl;
    const na = identifyAccount(a, bytes);
    const nb = identifyAccount(b, bytes);
    if (!na || !nb || na.name !== nb.name) return { verdict: 'undecidable', realPaths: [] };
    const da = decodeAccountData(a, bytes, na.name, { trailing: 'report' });
    const db = decodeAccountData(b, bytes, nb.name, { trailing: 'report' });
    return classify(da.args, db.args);
  } catch {
    return { verdict: 'undecidable', realPaths: [] };
  }
}

// ---------------------------------------------------------------------------
// SCORING
// ---------------------------------------------------------------------------

/** The path list of a drift report, whichever shape this tree produces. */
function pathsOf(report) {
  if (!report) return { paths: [], truncated: false, spellingOnly: null };
  // The account union puts the path list directly on `drift.paths`; the
  // instruction union nests it under `drift.paths.paths`. Both shapes are read
  // here so ONE probe answers for both trees.
  const list = Array.isArray(report.paths) ? report.paths : (report.paths?.paths ?? []);
  const spelling = report.spellingOnly ?? report.paths?.spellingOnly ?? null;
  const truncated = report.truncated ?? report.paths?.truncated ?? false;
  return { paths: list, truncated, spellingOnly: spelling };
}

const bump = (obj, key) => { obj[key] = (obj[key] ?? 0) + 1; };

const emptyHalf = (inputKey, input) => ({
  [inputKey]: input,
  decoded: 0,
  refused: 0,
  verdictCounts: {},
  driftRows: 0,
  reportedPaths: 0,
  spellingOnly: 0,
  truncatedRows: 0,
  oracle: { namingOnly: 0, realDiff: 0, undecidable: 0 },
  unjustifiedDriftRows: 0,
  hiddenRealDiffRows: 0,
  realPathsCrowdedOut: 0,
  realPathsNamed: 0,
  realPathsUnnamed: 0,
  realPathExamples: [],
  driftRowsNamingNoField: 0,
  agreeRowsNamingFieldDifferences: 0,
  agreeRowSpellingOnly: 0,
});

const out = {
  tool: 'drift-naming-probe',
  tree: process.env.SEMEME_TREE_LABEL ?? 'current',
  oracle: 'pairing by normalised spelling, implemented in this probe; decodes via src/codec.mjs + src/discriminators.mjs + src/account.mjs (byte-identical across the compared trees)',
  programs: [],
};

for (const spec of PROGRAMS) {
  const onchain = await load(spec.onchain);
  const published = await load(spec.published);
  const harvest = await load(spec.harvest);
  const accounts = await load(spec.accounts);
  const dir = await buildStore(spec, onchain);

  // ---- instructions ------------------------------------------------------
  const payloads = (harvest.transactions ?? []).flatMap((tx) => (tx.payloads ?? [])
    .map((p) => ({ dataHex: p.dataHex })));
  const instr = emptyHalf('payloads', payloads.length);
  for (const payload of payloads) {
    const oracle = oracleInstruction(dir, onchain, published, Buffer.from(payload.dataHex, 'hex'));
    bump(instr.oracle, oracle.verdict);
    let result;
    try {
      result = await decodeUnionPayload(dir, spec.program, payload.dataHex);
    } catch {
      instr.refused += 1;
      continue;
    }
    instr.decoded += 1;
    const verdict = result.view.verdict;
    bump(instr.verdictCounts, verdict);
    if (verdict === 'layout_drift') {
      instr.driftRows += 1;
      const { paths, truncated, spellingOnly } = pathsOf(result.view.drift);
      if (paths.length === 0) instr.driftRowsNamingNoField += 1;
      instr.reportedPaths += paths.length;
      if (truncated) instr.truncatedRows += 1;
      if (Array.isArray(spellingOnly)) instr.spellingOnly += spellingOnly.length;
      if (oracle.verdict === 'namingOnly') instr.unjustifiedDriftRows += 1;
      for (const rp of oracle.realPaths) {
        if (paths.includes(rp)) instr.realPathsNamed += 1;
        else if (truncated) instr.realPathsCrowdedOut += 1;
        else { instr.realPathsUnnamed += 1; if (instr.realPathExamples.length < 6) instr.realPathExamples.push({ oracle: rp, reported: paths.slice(0, 8) }); }
      }
    } else if (verdict === 'agree') {
      if (oracle.verdict === 'realDiff') instr.hiddenRealDiffRows += 1;
      // The fix does not throw the naming difference away: on `agree` rows it
      // reports it under `view.naming.spellingOnly`. Counting that proves the
      // difference is still VISIBLE, not hidden behind the verdict.
      const naming = result.view.naming;
      if (Array.isArray(naming?.spellingOnly)) {
        instr.agreeRowsNamingFieldDifferences += 1;
        instr.agreeRowSpellingOnly += naming.spellingOnly.length;
      }
    }
  }

  // ---- accounts ----------------------------------------------------------
  const acc = emptyHalf('accounts', (accounts.accounts ?? []).length);
  for (const account of (accounts.accounts ?? [])) {
    const bytes = Buffer.from(account.dataBase64, 'base64');
    const oracle = oracleAccount(onchain, published, bytes);
    bump(acc.oracle, oracle.verdict);
    let result;
    try {
      result = await decodeUnionStoredAccount(dir, spec.program, account.dataBase64);
    } catch {
      acc.refused += 1;
      continue;
    }
    acc.decoded += 1;
    const verdict = result.view.verdict;
    bump(acc.verdictCounts, verdict);
    if (verdict === 'layout_drift') {
      acc.driftRows += 1;
      const { paths, truncated, spellingOnly } = pathsOf(result.view.drift);
      if (paths.length === 0) acc.driftRowsNamingNoField += 1;
      acc.reportedPaths += paths.length;
      if (truncated) acc.truncatedRows += 1;
      if (Array.isArray(spellingOnly)) acc.spellingOnly += spellingOnly.length;
      if (oracle.verdict === 'namingOnly') acc.unjustifiedDriftRows += 1;
      for (const rp of oracle.realPaths) {
        if (paths.includes(rp)) acc.realPathsNamed += 1;
        else if (truncated) acc.realPathsCrowdedOut += 1;
        else { acc.realPathsUnnamed += 1; if (acc.realPathExamples.length < 6) acc.realPathExamples.push({ oracle: rp, reported: paths.slice(0, 8) }); }
      }
    } else if (verdict === 'agree') {
      if (oracle.verdict === 'realDiff') acc.hiddenRealDiffRows += 1;
      const naming = result.view.naming;
      if (Array.isArray(naming?.spellingOnly)) {
        acc.agreeRowsNamingFieldDifferences += 1;
        acc.agreeRowSpellingOnly += naming.spellingOnly.length;
      }
    }
  }

  out.programs.push({ name: spec.name, program: spec.program, instructions: instr, accounts: acc });
  await rm(dir, { recursive: true, force: true });
}

const sum = (half, fn) => out.programs.reduce((n, p) => n + fn(p[half]), 0);
out.totals = {
  instructionPayloads: sum('instructions', (h) => h.payloads),
  instructionDriftRows: sum('instructions', (h) => h.driftRows),
  instructionUnjustifiedDriftRows: sum('instructions', (h) => h.unjustifiedDriftRows),
  instructionHiddenRealDiffRows: sum('instructions', (h) => h.hiddenRealDiffRows),
  instructionReportedPaths: sum('instructions', (h) => h.reportedPaths),
  instructionSpellingOnly: sum('instructions', (h) => h.spellingOnly),
  instructionOracleNamingOnly: sum('instructions', (h) => h.oracle.namingOnly),
  instructionOracleRealDiff: sum('instructions', (h) => h.oracle.realDiff),
  accountRows: sum('accounts', (h) => h.decoded),
  accountDriftRows: sum('accounts', (h) => h.driftRows),
  accountUnjustifiedDriftRows: sum('accounts', (h) => h.unjustifiedDriftRows),
  accountHiddenRealDiffRows: sum('accounts', (h) => h.hiddenRealDiffRows),
  accountReportedPaths: sum('accounts', (h) => h.reportedPaths),
  accountSpellingOnly: sum('accounts', (h) => h.spellingOnly),
  accountOracleNamingOnly: sum('accounts', (h) => h.oracle.namingOnly),
  accountOracleRealDiff: sum('accounts', (h) => h.oracle.realDiff),
  accountRealPathsCrowdedOut: sum('accounts', (h) => h.realPathsCrowdedOut),
  accountRealPathsNamed: sum('accounts', (h) => h.realPathsNamed),
  accountRealPathsUnnamed: sum('accounts', (h) => h.realPathsUnnamed),
  instructionRealPathsCrowdedOut: sum('instructions', (h) => h.realPathsCrowdedOut),
  instructionRealPathsNamed: sum('instructions', (h) => h.realPathsNamed),
  instructionRealPathsUnnamed: sum('instructions', (h) => h.realPathsUnnamed),
  instructionAgreeRowsNamingFieldDifferences: sum('instructions', (h) => h.agreeRowsNamingFieldDifferences),
  instructionAgreeRowSpellingOnly: sum('instructions', (h) => h.agreeRowSpellingOnly),
  accountAgreeRowsNamingFieldDifferences: sum('accounts', (h) => h.agreeRowsNamingFieldDifferences),
  accountAgreeRowSpellingOnly: sum('accounts', (h) => h.agreeRowSpellingOnly),
};

process.stdout.write(JSON.stringify(out, null, 1));
