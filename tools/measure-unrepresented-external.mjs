#!/usr/bin/env node
// measure-unrepresented-external.mjs — the card's next step, measured:
//   "unrepresented 16 (28 Payloads) pruefen, ob ihre Quelle ganz ausserhalb
//    des Fremd-Repos liegt"
//
// The publish-nothing classification (tools/classify-publish-nothing.mjs) put
// 16 programs / 28 payloads into `unrepresented-source-gap` — no IDL and no
// dedicated parser in the FOREIGN repo. This run's git-grep premise check
// (step-ingestooor @001cf39, HEAD) shows all 16 appear in that repo ONLY
// inside crates/parsers/tests/** transaction traces. So the class never
// measured the world OUTSIDE that repo: "no source anywhere" was neither true
// nor false there, only unmeasured.
//
// WHAT THIS TOOL MEASURES
// For each of the 16 programs, two halves of the card's question:
//
//   A. LOCAL PREMISE (offline, git grep against the foreign clone): is the
//      program's appearance in the foreign repo really trace-only? A hit in
//      parser source would FALSIFY the committed classification — verdict
//      `foreign-repo-source-found`, which the artifact's own pinning test
//      rejects, so the falsification goes red instead of being absorbed.
//
//   B. EXTERNAL SURFACE (GitHub code index, literal query):
//      1. POSITIVE CONTROL first (bitquery/solana-idl-lib solfi/solfi.json
//         declares SoLFiHG9Tfgt...): control fails -> nothing measured,
//         verdict withheld (exit 3), rows empty.
//      2. Hits classified by PATH: crates/parsers/tests/** and CSV/SQL
//         datasets are traces; a .json outside them is an IDL candidate;
//         code and docs are references.
//      3. Every IDL candidate (capped 5/program) is FETCHED and verified by
//         content: the literal is really in the file (the index can be
//         stale), it is IDL-shaped (an instructions array), and the binding
//         comes from the file itself: metadata.address declares; an address
//         naming ANOTHER program is never re-labelled (bitquery's
//         manifest/manifest.json declares MNFSTqtC..., not wMNFSTkir...).
//      4. Verdict per program; a failed search, incomplete results, or an
//         unreadable decisive candidate -> `unknown` -> the WHOLE summary
//         is no-verdict (exit 3). A failure never reads as absence.
//         Zero hits on a surface whose control resolved is
//         `no-external-index-hit` — measured, and scoped to the index.
//
// Exit codes: 0 measured, 2 usage/IO, 3 no-verdict.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const TRACE_FIXTURE_RE = /(^|\/)(crates\/parsers\/tests|tests?\/(fixtures?|data)|fixtures?|test-data|testdata|__tests__)\//;
const DATASET_RE = /\.(csv|tsv|parquet)$/i;
const IDL_JSON_RE = /\.json$/i;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_IDL_CANDIDATES = 5;

/** T3: a hit is a trace, a dataset, an IDL candidate, or a code/doc reference. */
export function classifyHitPath(hit) {
  const p = String(hit.path ?? '');
  if (TRACE_FIXTURE_RE.test(p)) return { ...hit, class: 'trace-fixture' };
  if (DATASET_RE.test(p)) return { ...hit, class: 'dataset-trace' };
  if (IDL_JSON_RE.test(p)) return { ...hit, class: 'idl-candidate' };
  if (/\.(rs|ts|tsx|js|jsx|py|go|sh|toml|json)$/i.test(p)) return { ...hit, class: 'reference-code' };
  return { ...hit, class: 'reference-doc' };
}

/**
 * T4: the binding of a fetched file, decided from the file itself.
 * Never re-labels: an address naming another program stays other-program.
 */
export function bindingOf(program, raw, parsed) {
  // A structural declaration (metadata.address) outranks a bare literal:
  // prose that merely mentions the program id is not an interface binding.
  const meta = parsed?.metadata;
  const declared = meta && typeof meta === 'object' && typeof meta.address === 'string' && BASE58_RE.test(meta.address)
    ? meta.address : null;
  if (declared === program) return 'declared';
  if (declared && declared !== program) return 'other-program';
  const m = String(raw).match(/[1-9A-HJ-NP-Za-km-z]{43,44}/);
  if (m && m[0] !== program) return 'other-program';
  return String(raw).includes(program) ? 'literal-mention' : 'unbound';
}

/**
 * T5: the per-program verdict from classified hits + verified candidates.
 * Rules, in order — failures never become absences:
 *   search failed / incomplete        -> unknown
 *   no hits at all (control resolved) -> no-external-index-hit (index-scoped)
 *   every candidate unreadable        -> unknown (decisive evidence missing)
 *   a fetched file declares us        -> external-interface-published
 *   a fetched IDL-shaped file matches  -> external-interface-unbound
 *   any non-trace hit                  -> external-reference-only
 *   only traces                        -> trace-only-no-external-reference
 */
export function verdictFromHits({ searchOk = true, incomplete = false, hits = [], verifications = [] }) {
  if (!searchOk || incomplete) return { verdict: 'unknown' };
  if (!hits.length) return { verdict: 'no-external-index-hit' };
  const idlHits = hits.filter((h) => h.class === 'idl-candidate');
  if (idlHits.length > 0 && verifications.length > 0 && verifications.every((v) => !v.ok)) {
    return { verdict: 'unknown', evidenceNote: 'every idl candidate was unreadable' };
  }
  const declared = verifications.find((v) => v.ok && v.shaped && v.binding === 'declared');
  if (declared) return { verdict: 'external-interface-published', evidence: declared };
  const unbound = verifications.find((v) => v.ok && v.shaped && (v.binding === 'unbound' || v.binding === 'literal-mention'));
  if (unbound) return { verdict: 'external-interface-unbound', evidence: unbound };
  const nonTrace = hits.filter((h) => h.class !== 'trace-fixture' && h.class !== 'dataset-trace');
  if (nonTrace.length > 0) {
    const other = verifications.find((v) => v.ok && v.shaped && v.binding === 'other-program');
    const failed = verifications.some((v) => !v.ok);
    return {
      verdict: 'external-reference-only',
      evidence: other,
      evidenceNote: other ? 'idl file binds a different program'
        : failed ? 'a candidate file could not be read' : undefined,
    };
  }
  return { verdict: 'trace-only-no-external-reference' };
}

/** T6: aggregate; any unknown withholds the whole verdict. */
export function summarizeRows(rows) {
  const byVerdict = {};
  const payloadsByVerdict = {};
  for (const row of rows) {
    byVerdict[row.verdict] = (byVerdict[row.verdict] ?? 0) + 1;
    payloadsByVerdict[row.verdict] = (payloadsByVerdict[row.verdict] ?? 0) + (row.payloads ?? 0);
  }
  const unknown = byVerdict.unknown ?? 0;
  return {
    programs: rows.length,
    payloads: rows.reduce((sum, row) => sum + (row.payloads ?? 0), 0),
    byVerdict, payloadsByVerdict, unknown,
    verdict: unknown > 0 ? 'no-verdict' : 'measured',
    externalInterfacePrograms: (byVerdict['external-interface-published'] ?? 0) + (byVerdict['external-interface-unbound'] ?? 0),
    externalInterfacePayloads: (payloadsByVerdict['external-interface-published'] ?? 0) + (payloadsByVerdict['external-interface-unbound'] ?? 0),
    foreignRepoSourceFound: byVerdict['foreign-repo-source-found'] ?? 0,
  };
}

/** T2: the 16 candidates, verified against the committed classification. */
export function extractUnrepresented(classification) {
  const rows = (classification?.rows ?? []).filter((r) => r.verdict === 'unrepresented-source-gap');
  const declared = classification?.summary?.byCategory?.['unrepresented-source-gap'];
  if (!declared) throw Error('classification artifact has no unrepresented-source-gap category');
  const sum = rows.reduce((n, r) => n + (r.payloads ?? 0), 0);
  if (rows.length !== declared.programs || sum !== declared.payloads) {
    throw Error(`denominator mismatch in unrepresented-source-gap: rows say ${rows.length}/${sum}, summary says ${declared.programs}/${declared.payloads}`);
  }
  if (sum !== 28) throw Error(`unrepresented payloads must sum to 28, got ${sum}`);
  return rows.map(({ program, payloads }) => ({ program, payloads }));
}

/**
 * A. LOCAL PREMISE: where does the program appear in the foreign clone?
 * git grep exit 1 = no matches (trace-only would be false too — a program
 * from the classification that appears NOWHERE in the foreign repo is a
 * finding worth naming, so it gets its own state).
 */
export function localPremise(program, repoPath) {
  if (!repoPath || !existsSync(path.join(repoPath, '.git'))) return { state: 'unmeasured', reason: 'foreign clone not found' };
  let out = '';
  try {
    out = execFileSync('git', ['-C', repoPath, 'grep', '-l', '-F', program, 'HEAD'],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000 });
  } catch (error) {
    if (error?.status === 1) return { state: 'absent-from-foreign-repo', files: [] };
    return { state: 'unmeasured', reason: String(error?.message ?? error).slice(0, 160) };
  }
  const files = out.trim().split('\n').filter(Boolean).map((f) => f.replace(/^HEAD:/, ''));
  const sourceFiles = files.filter((f) => !f.startsWith('crates/parsers/tests/'));
  if (sourceFiles.length > 0) return { state: 'source-found', files, sourceFiles };
  return { state: 'trace-only', files };
}

const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const RETRYABLE = /rate limit|secondary rate|abuse|HTTP \/5\d\d|HTTP 5\d\d|HTTP 429|timed out|timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|socket hang up|network/i;

function ghApi(args, { tries = 3, retryDelayMs = 4000 } = {}) {
  let lastMsg = '';
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      const out = execFileSync('gh', ['api', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60000 });
      return { ok: true, out };
    } catch (error) {
      lastMsg = String(error?.message ?? error);
      if (attempt < tries && RETRYABLE.test(lastMsg)) {
        sleepSync(/rate limit/i.test(lastMsg) ? 65000 : retryDelayMs * attempt);
        continue;
      }
      return { ok: false, error: lastMsg.split('\n')[0].slice(0, 200) };
    }
  }
  return { ok: false, error: lastMsg.split('\n')[0].slice(0, 200) };
}

/** search/code: the query travels URL-encoded in the path, gh carries auth. */
function searchCode(query, perPage = 40) {
  const url = `search/code?q=${encodeURIComponent(query)}&per_page=${perPage}`;
  return ghApi([url]);
}

function fetchFile(repo, filePath) {
  const r = ghApi([`repos/${repo}/contents/${filePath}`, '--jq', '.content']);
  if (!r.ok) return r;
  try {
    let content = r.out.trim();
    try { content = JSON.parse(content); } catch { /* gh --jq can print raw */ }
    const raw = Buffer.from(String(content).replaceAll('\n', ''), 'base64').toString('utf8');
    return { ok: true, raw };
  } catch (error) {
    return { ok: false, error: `content decode failed: ${String(error?.message ?? error).slice(0, 120)}` };
  }
}

function foreignRepoPath(explicit) {
  return explicit
    ?? process.env.SEMEME_STEP_INGESTOOR_PATH
    ?? (process.env.GITHUB_WORKSPACE ? path.join(process.env.GITHUB_WORKSPACE, 'step-ingestooor') : path.join(os.homedir(), 'github_repos', 'step-ingestooor'));
}

// ---------------- main ----------------
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
  const usage = () => 'usage: node tools/measure-unrepresented-external.mjs --classification <file> --out <file> [--foreign-repo <path>] [--limit N]';

  const classificationPath = option('--classification', undefined);
  const outPath = option('--out', undefined);
  const foreignRepo = foreignRepoPath(option('--foreign-repo', undefined));
  const limit = Number(option('--limit', 0)) || 0;
  if (!classificationPath) {
    console.error(usage());
    process.exit(2);
  }

  let classification;
  try {
    classification = JSON.parse(readFileSync(classificationPath, 'utf8'));
  } catch (error) {
    console.error(JSON.stringify({ error: `cannot read classification: ${String(error?.message ?? error).slice(0, 160)}` }));
    process.exit(2);
  }

  let candidates;
  try {
    candidates = extractUnrepresented(classification);
  } catch (error) {
    console.error(JSON.stringify({ error: String(error?.message ?? error) }));
    process.exit(2);
  }
  if (limit > 0) candidates = candidates.slice(0, limit);

  const CONTROL_LITERAL = 'SoLFiHG9TfgtdUXUjWAxi3LtvYuFyDLVhBWxdMZxyCe';
  const CONTROL_REPO = 'bitquery/solana-idl-lib';
  const CONTROL_PATH = 'solfi/solfi.json';

  // Positive control, part 1: the literal resolves in the index.
  const controlSearch = searchCode(`"${CONTROL_LITERAL}" repo:${CONTROL_REPO}`, 10);
  let controlMatches = 0;
  if (controlSearch.ok) {
    try { controlMatches = JSON.parse(controlSearch.out).total_count ?? 0; } catch { controlMatches = 0; }
  }
  // Positive control, part 2: the file is fetchable and declares the program.
  const controlFile = fetchFile(CONTROL_REPO, CONTROL_PATH);
  let controlFileOk = false;
  if (controlFile.ok) {
    try {
      const parsed = JSON.parse(controlFile.raw);
      controlFileOk = parsed?.metadata?.address === CONTROL_LITERAL && Array.isArray(parsed.instructions) && parsed.instructions.length > 0;
    } catch { controlFileOk = false; }
  }
  const control = { literal: CONTROL_LITERAL, repo: CONTROL_REPO, path: CONTROL_PATH, searchMatches: controlMatches, fileOk: controlFileOk, matches: controlMatches > 0 && controlFileOk ? 1 : 0 };
  if (!control.matches) {
    console.error(JSON.stringify({ error: 'positive control failed — surface unmeasured, verdict withheld', control }));
    if (outPath) writeFileSync(outPath, `${JSON.stringify({ tool: 'measure-unrepresented-external', generatedAt: new Date().toISOString(), control, rows: [], summary: { verdict: 'no-verdict', unknown: candidates.length, programs: candidates.length }, note: 'positive control failed; nothing measured' }, null, 1)}\n`);
    process.exit(3);
  }
  process.stderr.write(JSON.stringify({ step: 'control', control }) + '\n');

  const rows = [];
  let i = 0;
  for (const { program, payloads } of candidates) {
    i += 1;
    process.stderr.write(JSON.stringify({ step: 'program', index: i, total: candidates.length, program }) + '\n');

    // A. local premise (offline)
    const premise = localPremise(program, foreignRepo);

    // B. external surface
    const search = searchCode(`"${program}"`, 40);
    let hits = [];
    let incomplete = false;
    let searchOk = search.ok;
    if (search.ok) {
      try {
        const data = JSON.parse(search.out);
        hits = (data.items ?? []).map((h) => ({ repository: { full_name: h.repository?.full_name }, path: h.path }));
        if (data.incomplete_results === true) incomplete = true;
      } catch {
        searchOk = false;
        hits = [];
      }
    }
    const classified = hits.map(classifyHitPath);
    const idlCandidates = classified.filter((h) => h.class === 'idl-candidate').slice(0, MAX_IDL_CANDIDATES);
    const verifications = [];
    for (const hit of idlCandidates) {
      const fetched = fetchFile(hit.repository.full_name, hit.path);
      if (!fetched.ok) {
        verifications.push({ repo: hit.repository.full_name, path: hit.path, ok: false, error: fetched.error });
        continue;
      }
      let parsed = null;
      try { parsed = JSON.parse(fetched.raw); } catch { /* verified unshaped below */ }
      const shaped = !!(parsed && Array.isArray(parsed.instructions) && parsed.instructions.length > 0);
      const containsLiteral = fetched.raw.includes(program);
      verifications.push({
        repo: hit.repository.full_name, path: hit.path,
        ok: containsLiteral, // stale-index guard: the file must really contain the literal
        shaped,
        instructions: shaped ? parsed.instructions.length : 0,
        binding: bindingOf(program, fetched.raw, parsed),
        readError: containsLiteral ? undefined : 'fetched file does not contain the program literal (index stale)',
      });
      sleepSync(400);
    }

    // A falsifying premise overrides: the committed classification said
    // "no IDL and no dedicated parser in the foreign repo" — a source file
    // hit contradicts it and must not be absorbed into an external verdict.
    let { verdict, evidence, evidenceNote } = verdictFromHits({ searchOk, incomplete, hits: classified, verifications });
    if (premise.state === 'source-found') {
      verdict = 'foreign-repo-source-found';
      evidenceNote = `foreign repo contains the program outside traces: ${premise.sourceFiles.slice(0, 3).join(', ')}`;
    }

    rows.push({
      program, payloads, verdict, premise,
      hits: classified.map((h) => ({ repo: h.repository.full_name, path: h.path, class: h.class })),
      verifications,
      evidence: evidence ? { repo: evidence.repo, path: evidence.path, instructions: evidence.instructions, binding: evidence.binding } : undefined,
      evidenceNote,
      searchError: searchOk ? undefined : search.error,
      incomplete,
    });
    sleepSync(2500); // search/code pacing: stay under the secondary rate limit
  }

  const summary = summarizeRows(rows);
  const artifact = {
    tool: 'measure-unrepresented-external',
    generatedAt: new Date().toISOString(),
    source: {
      classification: path.basename(classificationPath),
      foreignRepo: `${foreignRepo} @${(() => { try { return execFileSync('git', ['-C', foreignRepo, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return 'unmeasured'; } })()}`,
    },
    control,
    rows,
    summary,
    limits: {
      index: 'GitHub code search, literal (quoted) queries: absence claims are scoped to the indexed surface — unindexed repos cannot answer',
      verification: `every idl candidate (max ${MAX_IDL_CANDIDATES}/program) fetched; ok = the file really contains the literal; binding from the file itself`,
      premise: 'local git grep against the foreign clone at HEAD; trace-only is verified, not assumed',
      indexHits: 'code/doc hits are index evidence only; only .json candidates are content-verified',
    },
  };
  if (outPath) writeFileSync(outPath, `${JSON.stringify(artifact, null, 1)}\n`);
  console.log(JSON.stringify(summary, null, 1));
  if (summary.verdict === 'no-verdict') process.exitCode = 3;
}
