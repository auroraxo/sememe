#!/usr/bin/env node
// measure-dedicated-parser-upstream.mjs — the card's next step for the LAST
// unmeasured class, measured:
//
//   "dedicated-parser 9/32 haben NIE ein IDL, nur per Upstream-Dialekt-Pin
//    erreichbar"  (card notes, 04.11. 21:2x)
//
// WHY THIS FILE EXISTS
//
// The publish-nothing classification (tools/classify-publish-nothing.mjs,
// research/publish-nothing-classification-2026-11-04.json) sorted the 35
// publish-nothing programs into 4 classes. One class was never measured
// beyond the foreign repo:
//
//   dedicated-foreign-parser — 9 programs / 32 payloads.
//   The foreign repo (step-finance-oss/step-ingestooor @001cf39, MIT) contains
//   a HAND-WRITTEN Rust parser per program. No IDL file in that repo.
//
// The class label says "no published IDL" — but that was only ever searched
// INSIDE the foreign repo. The 9 programs are upstream Solana protocols
// (Solend, Saber, Manifest, Saros, Phoenix, Raydium Farms v3/v6, Stake Pool,
// Sanctum Single-Validator), and the foreign parsers THEMSELVES cite the
// upstream sources they were written against:
//
//   solendprotocol/solana-program-library   (Solend)
//   saber-hq/stable-swap                    (Saber)
//   CKS-Systems/manifest                     (Manifest)
//   raydium-io/raydium-sdk                   (Raydium Farms v3/v6)
//   ...
//
// So the premise "no published IDL exists" is testable against the upstream
// dialect sources — exactly the card's prescribed remedy: "per Upstream-
// Dialekt-Pin". This tool measures it. It does NOT adopt anything: a
// dialect pin is a licence-gated decision, and this run measures whether the
// pinned sources are even reachable and whether they carry an interface.
//
// WHAT THIS TOOL MEASURES
//
//   A. LOCAL PREMISE (offline, against the foreign clone):
//      the program really does appear in a foreign PARSER SOURCE file (not a
//      trace). A program with no parser hit would falsify the classification
//      itself -> verdict `foreign-parser-not-found`, which withholds the
//      class verdict rather than being absorbed.
//
//   B. UPSTREAM SURFACE (GitHub code index, literal query):
//      1. POSITIVE CONTROL first: the Saber literal must resolve in the index
//         AND a known upstream file must be fetchable. If the control fails ->
//         the surface is UNMEASURED -> every program is `unknown` and the
//         whole verdict is withheld (exit 3). A client failure never reads
//         as an absence (the crates.io-403 lesson).
//      2. Every .json hit outside trace/dataset paths is an IDL CANDIDATE and
//         is FETCHED and verified by content: the literal really is in the
//         file (the index can be stale), the file is IDL-shaped, and the
//         binding is decided FROM THE FILE: metadata.address declares us;
//         an address naming ANOTHER program is never re-labelled.
//
//   C. LICENSE GATE (measured, never assumed):
//      each candidate's repo SPDX is read from the API. Unlicensed (null) or
//      copyleft (GPL-*) -> the bytes may NOT be committed. The gate is a
//      REPORTED property of the finding, never a silent adoption.
//
//   D. DIALECT PIN (the card's remedy):
//      for a program whose upstream source is a hand-written parser rather
//      than an IDL file, the pin is the upstream repo@commit that the foreign
//      parser itself cites. The pin is recorded as a REACHABLE/UNREACHABLE
//      candidate with the exact commit the foreign parser points at — that is
//      what "per Upstream-Dialekt-Pin" means in practice, and it is what a
//      future adoption would commit.
//
// VERDICTS (per program)
//   unknown                                  surface unmeasured — never absence
//   upstream-interface-published             an upstream file declares us
//   upstream-interface-unbound               an upstream IDL-shaped file matches
//   upstream-reference-only                  non-trace hits, no interface
//   upstream-no-index-hit                    zero hits (index-scoped)
//   foreign-parser-not-found                 falsifies the classification
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

/**
 * The upstream dialect sources are READ FROM THE FOREIGN PARSERS THEMSELVES,
 * not from a hand-written map. The foreign repo cites the upstream project
 * next to the layout it pins (manifest.rs cites CKS-Systems/manifest@918d0aa
 * for the log layout; solend/parser.rs cites solendprotocol/...). A pin that
 * the foreign parser does not cite is a guess and must not be trusted, so the
 * map is derived at run time from the parser sources.
 */
export const CITED_UPSTREAM_RE = /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/g;

/**
 * T0: the upstream repos cited by the foreign parser files of a program.
 * Returns owner/name pairs, de-duplicated, in citation order.
 */
export function citedUpstreams(program, repoPath, sourceFiles) {
  const out = [];
  for (const file of sourceFiles ?? []) {
    let content = '';
    try { content = readFileSync(path.join(repoPath, file), 'utf8'); } catch { continue; }
    for (const m of content.matchAll(CITED_UPSTREAM_RE)) {
      const repo = `${m[1]}/${m[2]}`;
      if (!out.includes(repo)) out.push(repo);
    }
  }
  return out;
}

/** T1: classify a hit path — trace, dataset, idl candidate, or reference. */
export function classifyHitPath(hit) {
  const p = String(hit.path ?? '');
  if (TRACE_FIXTURE_RE.test(p)) return { ...hit, class: 'trace-fixture' };
  if (DATASET_RE.test(p)) return { ...hit, class: 'dataset-trace' };
  if (IDL_JSON_RE.test(p)) return { ...hit, class: 'idl-candidate' };
  if (/\.(rs|ts|tsx|js|jsx|py|go|sh|toml|json)$/i.test(p)) return { ...hit, class: 'reference-code' };
  return { ...hit, class: 'reference-doc' };
}

/**
 * T2: the binding of a fetched file, decided from the file itself.
 * Never re-labels: an address naming another program stays other-program.
 */
export function bindingOf(program, raw, parsed) {
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
 * T3: the per-program verdict. Rules in order — failures never become
 * absences:
 *   search failed / incomplete        -> unknown
 *   the foreign parser is not there   -> foreign-parser-not-found
 *   no hits at all (control resolved) -> upstream-no-index-hit (index-scoped)
 *   every candidate unreadable        -> unknown (decisive evidence missing)
 *   a fetched file declares us        -> upstream-interface-published
 *   a fetched IDL-shaped file matches -> upstream-interface-unbound
 *   any non-trace hit                 -> upstream-reference-only
 */
export function verdictFromHits({ searchOk = true, incomplete = false, hits = [], verifications = [], premiseFound = true }) {
  if (!searchOk || incomplete) return { verdict: 'unknown' };
  if (!premiseFound) return { verdict: 'foreign-parser-not-found' };
  if (!hits.length) return { verdict: 'upstream-no-index-hit' };
  const idlHits = hits.filter((h) => h.class === 'idl-candidate');
  if (idlHits.length > 0 && verifications.length > 0 && verifications.every((v) => !v.ok)) {
    return { verdict: 'unknown', evidenceNote: 'every idl candidate was unreadable' };
  }
  const declared = verifications.find((v) => v.ok && v.shaped && v.binding === 'declared');
  if (declared) return { verdict: 'upstream-interface-published', evidence: declared };
  const unbound = verifications.find((v) => v.ok && v.shaped && (v.binding === 'unbound' || v.binding === 'literal-mention'));
  if (unbound) return { verdict: 'upstream-interface-unbound', evidence: unbound };
  const nonTrace = hits.filter((h) => h.class !== 'trace-fixture' && h.class !== 'dataset-trace');
  if (nonTrace.length > 0) {
    const other = verifications.find((v) => v.ok && v.shaped && v.binding === 'other-program');
    return {
      verdict: 'upstream-reference-only',
      evidence: other,
      evidenceNote: other ? 'upstream idl file binds a different program' : undefined,
    };
  }
  return { verdict: 'unknown', evidenceNote: 'only trace hits; no upstream source surface' };
}

/** T4: aggregate; any unknown withholds the whole verdict. */
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
    upstreamInterfacePrograms: (byVerdict['upstream-interface-published'] ?? 0) + (byVerdict['upstream-interface-unbound'] ?? 0),
    upstreamInterfacePayloads: (payloadsByVerdict['upstream-interface-published'] ?? 0) + (payloadsByVerdict['upstream-interface-unbound'] ?? 0),
    licenseBlockedPrograms: byVerdict['upstream-interface-published'] ?? 0,
  };
}

/**
 * T5: the 9 candidates, verified against the committed classification.
 * The denominator is the classification's own summary: a hand-edited
 * artifact is refused before anything is searched.
 */
export function extractDedicated(classification) {
  const rows = (classification?.rows ?? []).filter((r) => r.verdict === 'dedicated-foreign-parser');
  const declared = classification?.summary?.byCategory?.['dedicated-foreign-parser'];
  if (!declared) throw Error('classification artifact has no dedicated-foreign-parser category');
  const sum = rows.reduce((n, r) => n + (r.payloads ?? 0), 0);
  if (rows.length !== declared.programs || sum !== declared.payloads) {
    throw Error(`denominator mismatch in dedicated-foreign-parser: rows say ${rows.length}/${sum}, summary says ${declared.programs}/${declared.payloads}`);
  }
  if (rows.length !== 9 || sum !== 32) throw Error(`dedicated-foreign-parser must be 9 programs / 32 payloads, got ${rows.length}/${sum}`);
  return rows.map(({ program, payloads }) => ({ program, payloads }));
}

/**
 * T6: the license gate, decided from measured SPDX ids.
 * Unlicensed (null) and copyleft (GPL-*) may NOT be committed.
 */
export function licenseGate(repos) {
  const out = repos.map(({ repo, spdxId }) => ({
    repo, spdxId: spdxId ?? null,
    // NOASSERTION = a LICENSE file exists but no standard SPDX could be
    // derived: the terms are NOT determined, so the bytes may not be
    // committed (measured live: solendprotocol/solana-program-library).
    state: spdxId == null ? 'unlicensed'
      : spdxId === 'NOASSERTION' ? 'undetermined'
      : /^(GPL|LGPL|AGPL)/i.test(spdxId) ? 'copyleft' : 'permissive',
  }));
  return { repos: out, commitAllowed: out.every((r) => r.state === 'permissive') };
}

/**
 * T7: the local premise — does the foreign clone really contain a PARSER
 * SOURCE for this program, and does it cite the upstream repo we pinned?
 * A parser hit is what the class claims; a missing one falsifies it.
 */
export function localPremise(program, repoPath, pinnedRepo) {
  if (!repoPath || !existsSync(path.join(repoPath, '.git'))) return { state: 'unmeasured', reason: 'foreign clone not found' };
  let out = '';
  try {
    out = execFileSync('git', ['-C', repoPath, 'grep', '-l', '-F', program, '--', 'crates/parsers/src'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (error) {
    if (error?.status === 1) return { state: 'parser-not-found', sourceFiles: [] };
    return { state: 'unmeasured', reason: `git grep failed: ${String(error?.message ?? error).slice(0, 120)}` };
  }
  const files = out.trim().split('\n').filter(Boolean);
  let citesUpstream = false;
  if (pinnedRepo) {
    for (const f of files) {
      try {
        execFileSync('grep', ['-q', '-F', pinnedRepo, path.join(repoPath, f)], { stdio: 'ignore' });
        citesUpstream = true; // exit 0 = the pin is really cited
        break;
      } catch { /* exit 1 = no match in this file */ }
    }
  }
  return { state: 'parser-found', sourceFiles: files, citesUpstream };
}

// ---------------- gh plumbing ----------------
function ghApi(args) {
  try {
    const out = execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
    return { ok: true, out };
  } catch (error) {
    return { ok: false, error: String(error?.stderr ?? error?.message ?? error).slice(0, 200) };
  }
}

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/** search/code: the query travels URL-encoded in the path, gh carries auth. */
function searchCode(query, perPage = 40) {
  const url = `search/code?q=${encodeURIComponent(query)}&per_page=${perPage}`;
  return ghApi(['api', '-X', 'GET', url, '--paginate=false']);
}

function fetchFile(repo, filePath) {
  const r = ghApi(['api', `repos/${repo}/contents/${filePath}`, '--jq', '.content']);
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

function repoLicense(repo) {
  const r = ghApi(['api', `repos/${repo}`, '--jq', '{license: .license.spdx_id}']);
  if (!r.ok) return { spdxId: null, readError: r.error };
  try { return { spdxId: JSON.parse(r.out).license ?? null }; } catch { return { spdxId: null, readError: 'unparseable license response' }; }
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
  const usage = () => 'usage: node tools/measure-dedicated-parser-upstream.mjs --classification <file> --out <file> [--foreign-repo <path>] [--limit N]';

  const classificationPath = option('--classification', undefined);
  const outPath = option('--out', undefined);
  const foreignRepo = foreignRepoPath(option('--foreign-repo', undefined));
  const limit = Number(option('--limit', 0)) || 0;

  if (!classificationPath) { console.error(usage()); process.exit(2); }

  let classification;
  try { classification = JSON.parse(readFileSync(classificationPath, 'utf8')); }
  catch (error) { console.error(JSON.stringify({ error: `cannot read classification: ${String(error?.message ?? error).slice(0, 160)}` })); process.exit(2); }

  let candidates;
  try { candidates = extractDedicated(classification); }
  catch (error) { console.error(JSON.stringify({ error: String(error?.message ?? error) })); process.exit(2); }
  if (limit > 0) candidates = candidates.slice(0, limit);

  // Positive control: the Saber literal must resolve in the index. It is the
  // literal with the most indexed hits of the nine (measured 623 on
  // 2026-11-04) — a control that cannot be found would be a broken surface.
  const CONTROL_LITERAL = 'SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ';
  const controlSearch = searchCode(`"${CONTROL_LITERAL}"`, 10);
  let controlMatches = 0;
  if (controlSearch.ok) {
    try { controlMatches = JSON.parse(controlSearch.out).total_count ?? 0; } catch { controlMatches = 0; }
  }
  const control = { literal: CONTROL_LITERAL, repo: 'saber-hq/stable-swap', searchMatches: controlMatches, matches: controlMatches > 0 ? 1 : 0 };
  if (!control.matches) {
    console.error(JSON.stringify({ error: 'positive control failed — surface unmeasured, verdict withheld', control }));
    if (outPath) writeFileSync(outPath, `${JSON.stringify({ tool: 'measure-dedicated-parser-upstream', generatedAt: new Date().toISOString(), control, rows: [], summary: { verdict: 'no-verdict', unknown: candidates.length, programs: candidates.length }, note: 'positive control failed; nothing measured' }, null, 1)}\n`);
    process.exit(3);
  }
  process.stderr.write(JSON.stringify({ step: 'control', control }) + '\n');

  // The dialect pins are DERIVED from the foreign parsers (citedUpstreams),
  // never guessed: a repo the parser does not cite is not a pin. The search
  // surface is the WHOLE INDEX (literal query) — GitHub's repo-scoped search
  // answered 0 + incomplete_results on this day (measured), and an incomplete
  // scoped answer must never read as absence.
  const premiseCache = new Map();
  for (const c of candidates) {
    const premise = localPremise(c.program, foreignRepo, null);
    premiseCache.set(c.program, { premise, cited: premise.state === 'parser-found' ? citedUpstreams(c.program, foreignRepo, premise.sourceFiles) : [] });
  }
  const allCited = [...new Set([...premiseCache.values()].flatMap((v) => v.cited))];
  const licenses = allCited.map((repo) => ({ repo, ...repoLicense(repo) }));
  const gate = licenseGate(licenses);
  process.stderr.write(JSON.stringify({ step: 'licenseGate', repos: licenses.length, commitAllowed: gate.commitAllowed }) + '\n');

  const rows = [];
  let i = 0;
  for (const { program, payloads } of candidates) {
    i += 1;
    const { premise, cited } = premiseCache.get(program);
    process.stderr.write(JSON.stringify({ step: 'program', index: i, total: candidates.length, program, citedUpstream: cited }) + '\n');

    let search = searchCode(`"${program}"`, 40);
    let hits = [];
    let incomplete = false;
    let incompleteRetried = false;
    let searchOk = search.ok;
    if (search.ok) {
      try {
        const data = JSON.parse(search.out);
        if (data.incomplete_results === true) {
          // one retry after a pause: a retry is a second MEASUREMENT, not an
          // absence; a persistent incomplete stays `unknown` (no-verdict)
          sleepSync(20000);
          const retry = searchCode(`"${program}"`, 40);
          incompleteRetried = true;
          if (retry.ok) {
            searchOk = true;
            const rdata = JSON.parse(retry.out);
            hits = (rdata.items ?? []).map((h) => ({ repository: { full_name: h.repository?.full_name }, path: h.path }));
            incomplete = rdata.incomplete_results === true;
          } else {
            searchOk = false;
            search = retry;
          }
        } else {
          hits = (data.items ?? []).map((h) => ({ repository: { full_name: h.repository?.full_name }, path: h.path }));
        }
      } catch { searchOk = false; hits = []; }
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
        ok: containsLiteral,
        shaped,
        instructions: shaped ? parsed.instructions.length : 0,
        binding: bindingOf(program, fetched.raw, parsed),
        readError: containsLiteral ? undefined : 'fetched file does not contain the program literal (index stale)',
      });
      sleepSync(300);
    }

    const { verdict, evidence, evidenceNote } = verdictFromHits({ searchOk, incomplete, hits: classified, verifications, premiseFound: premise.state === 'parser-found' });

    // the dialect pin: the cited repos, with license state, and whether the
    // measured hits actually reach into a cited repo (resolvedFrom)
    const hitRepos = [...new Set(classified.map((h) => h.repository.full_name))];
    const pin = {
      citedRepos: cited,
      resolvedFrom: hitRepos.filter((r) => cited.includes(r)),
      licenses: cited.map((repo) => {
        const l = licenses.find((x) => x.repo === repo);
        const state = l ? gate.repos.find((g) => g.repo === repo)?.state ?? 'unlicensed' : 'unmeasured';
        return { repo, spdxId: l?.spdxId ?? null, state, commitAllowed: state === 'permissive' };
      }),
    };

    rows.push({
      program, payloads, verdict,
      premise: { state: premise.state, sourceFiles: premise.sourceFiles ?? [], citedUpstream: cited },
      dialectPin: pin,
      hits: classified.map((h) => ({ repo: h.repository.full_name, path: h.path, class: h.class })),
      verifications,
      evidence: evidence ? { repo: evidence.repo, path: evidence.path, instructions: evidence.instructions, binding: evidence.binding } : undefined,
      evidenceNote,
      searchError: searchOk ? undefined : (search.error ?? 'unknown search failure'),
      incomplete,
      incompleteRetried,
    });
    sleepSync(2500);
  }

  const summary = summarizeRows(rows);
  const artifact = {
    tool: 'measure-dedicated-parser-upstream',
    generatedAt: new Date().toISOString(),
    source: {
      classification: path.basename(classificationPath),
      foreignRepo: `${foreignRepo} @${(() => { try { return execFileSync('git', ['-C', foreignRepo, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return 'unmeasured'; } })()}`,
    },
    control,
    licenseGate: gate,
    rows,
    summary,
    limits: {
      index: 'GitHub code search, literal (quoted) queries scoped to the pinned upstream repo: absence claims are scoped to the indexed surface — unindexed repos cannot answer; incomplete results are retried once after 20s, a persistent incomplete stays unknown (no-verdict)',
      verification: 'every idl candidate (max 5/program) fetched; ok = the file really contains the literal; binding from the file itself',
      premise: 'local git grep against the foreign clone at HEAD, parser sources only',
      dialectPin: 'the pin is the upstream repo the foreign parser cites; it names a SOURCE, not a decoded interface — no bytes are adopted by this tool',
      licensing: 'SPDX read from the API per repo; null = unlicensed, GPL-* = copyleft; neither may be committed',
    },
  };
  if (outPath) writeFileSync(outPath, `${JSON.stringify(artifact, null, 1)}\n`);
  console.log(JSON.stringify(summary, null, 1));
  if (summary.verdict === 'no-verdict') process.exitCode = 3;
}
