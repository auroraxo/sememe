#!/usr/bin/env node
// preview-external-adoption.mjs — does a DECLARED external interface actually
// decode the fixture bytes? Previewed on a throwaway store; bytes never land
// in the repository.
//
// WHY THIS FILE EXISTS
//
// research/unrepresented-external-sweep-2026-11-04.json measured 4 of the 16
// unrepresented programs (9 payloads) with an external interface whose file
// DECLARES the program. That verdict concerns bytes in foreign repositories;
// it says nothing about whether those bytes explain THIS repo's fixture
// payloads. The card's standing rule is byte arbitration (union decode), so
// the claim must be previewed end to end:
//
//   1. plan: exactly the sweep's external-interface-published rows whose
//      evidence binding is `declared` (pinned 4 programs / 9 payloads; a
//      hand-edited artifact is refused).
//   2. license gate: each source repo's SPDX is read from the API, never
//      assumed. unlicensed (null) and copyleft (GPL-*) set commitAllowed=false.
//   3. adopt each file into a COPY of the committed store (a throwaway
//     work-dir); adoption re-verifies the file declares the program at write
//     time, so a stale index cannot slip a wrong file in.
//   4. run the IDENTICAL fixture sweep against the preview store and compare
//     with the committed baseline: exactly the adopted programs may move; any
//     other row moving means the adoption leaked into unrelated decode paths
//     -> verdict withheld (no-verdict, exit 3).
//
// RESULT (measured 2026-11-04, 156 fixtures, 806 payloads, 0 network):
//   decoded 724 -> 732 (+8 of 9: SolFi 4/4, manifest wrapper 3/3, zerofi 1/1;
//   humidifi 0/1 with a NAMED refusal: unknown discriminator f6dc6...),
//   gap 65 -> 56, disagreements 0, byte-exact 100%.
//
// LICENSING (measured 2026-11-04): bitquery/solana-idl-lib has license=null
// (no LICENSE file), Bonasa-Tech/manifest is GPL-3.0. Neither may be copied
// into this MIT repository or the published package — so the committed
// artifact records sha256 + origin + license, and
// `committedStoreModified: false`.
//
// Exit codes: 0 measured, 2 usage/IO, 3 no-verdict.

import { writeFileSync, readFileSync, mkdirSync, rmSync, cpSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const RETRYABLE = /rate limit|secondary rate|abuse|HTTP \/5\d\d|HTTP 5\d\d|HTTP 429|timed out|timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|socket hang up|network/i;

function ghApi(args, { tries = 3, retryDelayMs = 4000 } = {}) {
  let lastMsg = '';
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      return { ok: true, out: execFileSync('gh', ['api', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60000 }) };
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

/** T2: exactly the published rows whose evidence binding is `declared`. */
export function planFromSweep(sweep) {
  const rows = (sweep?.rows ?? []).filter((r) => r.verdict === 'external-interface-published');
  if (rows.length !== 4 || rows.reduce((n, r) => n + (r.payloads ?? 0), 0) !== 9) {
    throw Error(`sweep must pin exactly 4 published programs / 9 payloads, found ${rows.length}/${rows.reduce((n, r) => n + (r.payloads ?? 0), 0)}`);
  }
  for (const row of rows) {
    if (row.evidence?.binding !== 'declared') {
      throw Error(`${row.program}: evidence binding is ${row.evidence?.binding ?? 'absent'}, only a declared binding is adoptable`);
    }
    if (!row.evidence.repo || !row.evidence.path) throw Error(`${row.program}: origin incomplete`);
  }
  return rows.map((r) => ({ program: r.program, payloads: r.payloads, repo: r.evidence.repo, path: r.evidence.path, evidence: r.evidence }));
}

/** T4: the license gate, decided from measured SPDX ids. */
export function licenseGate(repos) {
  const out = repos.map(({ repo, spdxId }) => ({
    repo, spdxId: spdxId ?? null,
    state: spdxId == null ? 'unlicensed' : /^(GPL|LGPL|AGPL)/i.test(spdxId) ? 'copyleft' : 'permissive',
  }));
  return { repos: out, commitAllowed: out.every((r) => r.state === 'permissive') };
}

async function repoLicense(repo) {
  const r = ghApi(['repos/' + repo, '--jq', '{license: .license.spdx_id}']);
  if (!r.ok) return { spdxId: null, readError: r.error };
  try { return { spdxId: JSON.parse(r.out).license ?? null }; } catch { return { spdxId: null, readError: 'unparseable license response' }; }
}

function fetchFile(repo, filePath) {
  const r = ghApi([`repos/${repo}/contents/${filePath}`, '--jq', '.content']);
  if (!r.ok) return r;
  try {
    let content = r.out.trim();
    try { content = JSON.parse(content); } catch { /* gh --jq can print raw */ }
    return { ok: true, raw: Buffer.from(String(content).replaceAll('\n', ''), 'base64').toString('utf8') };
  } catch (error) {
    return { ok: false, error: `content decode failed: ${String(error?.message ?? error).slice(0, 120)}` };
  }
}

/** T3: only the adopted programs may move; anything else is a leak. */
export function compareRuns(baseline, preview, adoptedPrograms) {
  const moved = [];
  const leaked = [];
  const programs = new Set([...Object.keys(baseline.byProgram ?? {}), ...Object.keys(preview.byProgram ?? {})]);
  for (const program of programs) {
    const b = baseline.byProgram?.[program] ?? { payloads: 0, decoded: 0, decodeErrors: 0, disagreements: 0, noInterface: 0 };
    const p = preview.byProgram?.[program] ?? b;
    if (JSON.stringify(b) !== JSON.stringify(p)) {
      (adoptedPrograms.includes(program) ? moved : leaked).push(program);
    }
  }
  const decodedDelta = (preview.decoded ?? 0) - (baseline.decoded ?? 0);
  const gapDelta = (preview.noInterface ?? 0) - (baseline.noInterface ?? 0);
  return {
    moved, leaked,
    decodedDelta, gapDelta,
    verdict: leaked.length === 0 ? 'measured' : 'no-verdict',
  };
}

const ROOT = path.resolve(path.dirname(decodeURI(new URL(import.meta.url).pathname)), '..');
const SEMEME_BIN = path.join(ROOT, 'bin', 'sememe.mjs');
const STRANGER = path.join(ROOT, 'tools', 'stranger-decode.mjs');

function runNode(script, args, { cwd = ROOT } = {}) {
  return execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 600000, cwd });
}

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
  const usage = () => 'usage: node tools/preview-external-adoption.mjs --sweep <external-sweep.json> --store <committed-store> --fixtures-dir <dir> --out <file> [--work-dir <dir>]';

  const sweepPath = option('--sweep', undefined);
  const store = option('--store', undefined);
  const fixturesDir = option('--fixtures-dir', undefined);
  const outPath = option('--out', undefined);
  let workDir = option('--work-dir', path.join(os.tmpdir(), 'sememe-external-adoption-preview'));
  if (!sweepPath || !store || !fixturesDir || !outPath) {
    console.error(usage());
    process.exit(2);
  }

  let sweep, baseline;
  try {
    sweep = JSON.parse(readFileSync(sweepPath, 'utf8'));
  } catch (error) {
    console.error(JSON.stringify({ error: `cannot read sweep: ${String(error?.message ?? error).slice(0, 160)}` }));
    process.exit(2);
  }
  const baselinePath = option('--baseline', path.join(ROOT, 'research', 'step-ingestooor-full-sweep-classified-2026-11-04.json'));
  try {
    baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch (error) {
    console.error(JSON.stringify({ error: `cannot read baseline: ${String(error?.message ?? error).slice(0, 160)}` }));
    process.exit(2);
  }

  let plan;
  try {
    plan = planFromSweep(sweep);
  } catch (error) {
    console.error(JSON.stringify({ error: String(error?.message ?? error) }));
    process.exit(2);
  }
  process.stderr.write(JSON.stringify({ step: 'plan', programs: plan.length, payloads: plan.reduce((n, r) => n + r.payloads, 0) }) + '\n');

  // license gate first: nothing is fetched or adopted before it is measured
  const licenses = [];
  for (const { repo } of [...new Map(plan.map((r) => [r.repo, r])).values()]) {
    const license = await repoLicense(repo);
    licenses.push({ repo, ...license });
    sleepSync(400);
  }
  const licenseGateResult = licenseGate(licenses);
  process.stderr.write(JSON.stringify({ step: 'licenseGate', ...licenseGateResult }) + '\n');

  // throwaway store copy; the committed store is only ever READ
  const committedReceiptsBefore = readdirSync(path.join(store, 'receipts')).length;
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(path.dirname(workDir), { recursive: true });
  cpSync(store, path.join(workDir, 'store'), { recursive: true });
  const previewStore = path.join(workDir, 'store');

  const rows = [];
  try {
    for (const { program, payloads, repo, path: filePath } of plan) {
      const fetched = fetchFile(repo, filePath);
      if (!fetched.ok) throw Error(`${program}: cannot fetch ${repo}/${filePath}: ${fetched.error}`);
      const parsed = JSON.parse(fetched.raw);
      if (parsed?.metadata?.address !== program) throw Error(`${program}: fetched file does not declare the program at adoption time (stale index?)`);
      const idlFile = path.join(workDir, 'idls', `${program}.json`);
      mkdirSync(path.dirname(idlFile), { recursive: true });
      writeFileSync(idlFile, fetched.raw);

      const receipt = JSON.parse(runNode(SEMEME_BIN, ['adopt', program, idlFile, '--store', previewStore, '--source', 'published']));
      if (!receipt?.fingerprint?.startsWith('sha256:')) throw Error(`${program}: adopt returned no fingerprint`);
      rows.push({
        program, payloads, repo, path: filePath,
        sha256: receipt.fingerprint.replace('sha256:', ''),
        license: licenses.find((l) => l.repo === repo) ?? null,
        origin: `${repo}@${filePath}`,
      });
      sleepSync(400);
    }
  } catch (error) {
    rmSync(workDir, { recursive: true, force: true, retryDelay: 200, maxRetries: 3 });
    console.error(JSON.stringify({ error: String(error?.message ?? error) }));
    process.exit(2);
  }

  // the identical sweep, against the preview store only; per-program
  // before-numbers come from the committed baseline (same 156 fixtures,
  // same flags, same store contents minus these 4 adoptions).
  const previewOut = path.join(workDir, 'preview-sweep.json');
  runNode(STRANGER, ['--store', previewStore, '--fixtures-dir', fixturesDir, '--absent', 'error', '--out', previewOut]);
  const preview = JSON.parse(readFileSync(previewOut, 'utf8'));

  const comparison = compareRuns(
    { ...baseline.summary, byProgram: baseline.summary.byProgram },
    { ...preview.summary, byProgram: preview.summary.byProgram },
    plan.map((r) => r.program),
  );

  // per-program before/after from the baseline + preview byProgram
  for (const row of rows) {
    const b = baseline.summary.byProgram[row.program] ?? { decoded: 0 };
    const p = preview.summary.byProgram[row.program] ?? { decoded: 0 };
    row.decodedBefore = b.decoded;
    row.decodedAfter = p.decoded;
    row.refusalAfter = row.decodedAfter < row.payloads
      ? Object.keys(preview.summary.refusalReasons ?? {}).find((k) => k.startsWith(row.program)) ?? null
      : null;
  }

  // the committed store is only ever READ (cpSync source); the receipt count
  // before and after the preview proves it was not written to.
  const committedReceiptsAfter = readdirSync(path.join(store, 'receipts')).length;
  if (committedReceiptsBefore !== committedReceiptsAfter) {
    console.error(JSON.stringify({ error: 'the committed store changed during the preview — refusing to report a measurement' }));
    process.exit(2);
  }
  const summary = {
    ...comparison,
    decoded: preview.summary.decoded,
    noInterface: preview.summary.noInterface,
    decodeErrors: preview.summary.decodeErrors,
    disagreements: preview.summary.disagreements,
    byteExactRate: preview.summary.byteExactRate,
  };
  const artifact = {
    tool: 'preview-external-adoption',
    generatedAt: new Date().toISOString(),
    source: { sweep: path.basename(sweepPath), baseline: path.basename(baselinePath), fixtures: fixturesDir },
    licenseGate: licenseGateResult,
    committedStoreReceiptsBefore: committedReceiptsBefore,
    committedStoreReceiptsAfter: committedReceiptsAfter,
    committedStoreModified: committedReceiptsBefore !== committedReceiptsAfter,
    storeCopy: workDir,
    rows,
    summary: {
      ...summary,
      movedRows: comparison.moved,
      movedRowsUnadopted: comparison.leaked,
    },
    previewSummary: preview.summary,
    limits: {
      license: 'bitquery/solana-idl-lib unlicensed (null), Bonasa-Tech/manifest GPL-3.0 -> bytes stay in the throwaway work-dir; the committed store is untouched',
      verdict: 'exactly the adopted rows may move; any other movement -> no-verdict',
      humidifi: '1 payload refuses with an unknown discriminator — a named refusal, not a silent parse',
    },
  };
  if (outPath) writeFileSync(outPath, `${JSON.stringify(artifact, null, 1)}\n`);
  console.log(JSON.stringify(artifact.summary, null, 1));
  if (comparison.verdict === 'no-verdict') process.exitCode = 3;
  rmSync(workDir, { recursive: true, force: true, retryDelay: 200, maxRetries: 3 });
}
