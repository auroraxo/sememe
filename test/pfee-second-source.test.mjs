// Pins for the pfeeU second-source measurement (12.11., PULS):
//   research/pfee-second-source-2026-11-12.json
//
// WHAT THE MEASUREMENT FOUND (the point of pinning it):
//
//   research/ecosystem-coverage-2026-11-11.json reports pfeeU decoded 5/464
//   (1.1%), 459 refused — and the card named "adopt
//   needsmorergb/charlie-protocol-v1's MIT copy" as the closing step. BOTH
//   halves of that premise are now measured and wrong:
//
//   1. The candidate copy is byte-identical to the on-chain pull the store
//      already holds (same canonical fingerprint
//      9c1ef6ed66df5d72f4491d12e9781436f8037a6e20499d1681485591b8644a26,
//      29 instructions, same discriminator per name) — adopting it adds a
//      receipt and closes NOTHING. Falsified offline against committed
//      bytes: the candidate fetched at its pinned commit
//      eb85241573842170151f59a4cb7e377294cdd3f8 hashes equal to the stored
//      object. No card should send anyone to adopt it again.
//   2. All 459 refusals are ONE instruction face — unknown discriminator
//      9aed8a5ca202a2bb, every payload 57 bytes — and the on-chain interface
//      still lags: a live pull at slot 468428470 (capture: 468262003)
//      returned the same fingerprint. The source that carries the
//      instruction is first-party: pump-fun/pump-public-docs
//      idl/pump_fees.json (31 instructions, get_fees_with_quote_mint).
//
//   The name→bytes binding is NOT taken from the published file or from any
//   third-party pin: Anchor's own rule computed here independently —
//   sha256("global:get_fees_with_quote_mint")[0..8] — produces exactly
//   9aed8a5ca202a2bb, sanity-checked against get_fees, whose discriminator
//   both copies already store. The measurement itself then closes the loop
//   on real bytes: union (throwaway copy + one `adopt` through
//   src/adopt.mjs) decodes 464/464, 0 refusals, 464/464 byte-exact, the 5
//   baseline answers keep their names, and the committed store stays
//   byte-untouched (readdir before/after, `committedStoreModified: false`).
//
//   Licensing: pump-fun/pump-public-docs ships NO LICENSE file, so its bytes
//   are NOT vendored into this MIT repository. The first test fetches them
//   from the pinned commit at run time into a temp dir; without the GitHub
//   API the remaining invariants still pin everything that is derivable
//   offline from the committed artifact (the artifact records the canonical
//   fingerprint, so the re-fetch could not drift silently).
//
// THE INVARIANTS below pin the committed numbers; the falsification half
// lives in the tool (NO VERDICT when the baseline stops reproducing the
// ecosystem artifact, when adoption rewrites a baseline answer, when the
// committed store gains a file, or when the pin hash or the name→bytes
// binding disagrees).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, rm, mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');
const TOOL = path.join(ROOT, 'tools', 'measure-pfee-second-source.mjs');
const ARTIFACT = path.join(ROOT, 'research', 'pfee-second-source-2026-11-12.json');
const COVERAGE = path.join(ROOT, 'research', 'ecosystem-coverage-2026-11-11.json');
const PFEE = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
const COMMIT = '639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22';
const CANDIDATE_COMMIT = 'eb85241573842170151f59a4cb7e377294cdd3f8';
const STORED_FINGERPRINT = '9c1ef6ed66df5d72f4491d12e9781436f8037a6e20499d1681485591b8644a26';

const artifact = JSON.parse(await readFile(ARTIFACT, 'utf8'));
const m = artifact.measured;

async function ghAuthed() {
  try { await run('gh', ['auth', 'status'], { timeout: 15000 }); return true; }
  catch { return false; }
}

test('the committed store still holds the stale on-chain copy the measurement measured', () => {
  const receipt = JSON.parse(readFileSync(
    path.join(ROOT, 'test/fixtures/ecosystem-store-2026-11-11/receipts',
      `${PFEE}-468262003-anchor-${STORED_FINGERPRINT}.json`), 'utf8'));
  assert.equal(receipt.fingerprint, `sha256:${STORED_FINGERPRINT}`);
  assert.equal(receipt.instructionCount, 29);
});

test('the ecosystem artifact\'s pfeeU face is the measurement\'s own baseline (no hand-edited numbers)', () => {
  const coverage = JSON.parse(readFileSync(COVERAGE, 'utf8'));
  const entry = coverage.programs.find((p) => p.program === PFEE);
  assert.equal(m.baseline.decoded, entry.decoded);
  assert.equal(m.baseline.refused, entry.refused);
  assert.equal(m.baseline.byteExact, entry.byteExact);
  assert.equal(m.payloads, entry.payloads);
});

test('all 459 baseline refusals are the one get_fees_with_quote_mint face', () => {
  const reasons = Object.entries(m.baseline.refusalReasons);
  assert.equal(m.baseline.refused, 459);
  assert.equal(reasons.length, 1);
  // the tool slices refusal keys at 110 chars (same convention as the pump
  // tool) — the full 8-byte face is pinned by the name-binding test below;
  // the UNION having 0 refusals of it is the closing evidence.
  assert.match(reasons[0][0], /unknown instruction discriminator 9aed8a5ca/);
  assert.match(reasons[0][0], /anchor @slot 468262003/);
  assert.equal(reasons[0][1], 459);
});

test('the union closes every refusal and stays byte-exact on the same committed bytes', () => {
  assert.equal(m.union.decoded, 464);
  assert.equal(m.union.refused, 0);
  assert.equal(m.union.byteExact, 464);
  assert.equal(m.delta.refusalsClosed, 459);
  assert.equal(m.delta.decoded, 459);
  assert.equal(m.baselineNamesKept, true);
  assert.deepEqual(m.renames, []);
  assert.equal(m.union.adoptedAnswered, 459);
  assert.equal(m.union.pulledAnswered, 5);
});

test('the adopted receipt can never displace the on-chain pull (slot null)', () => {
  assert.equal(m.receipt.slot, null);
  assert.equal(artifact.committedStoreModified, false);
});

test('the name-to-bytes binding is Anchor\'s rule, not a repo\'s word', () => {
  const face = createHash('sha256').update('global:get_fees_with_quote_mint').digest();
  const hex = Buffer.from(face.subarray(0, 8)).toString('hex');
  assert.equal(hex, '9aed8a5ca202a2bb');
  assert.equal(artifact.nameBinding.faceDiscriminator, hex);
  assert.equal(artifact.nameBinding.fileAgrees, true);
  assert.equal(artifact.nameBinding.ruleAgrees, true);
});

test('the artifact names the falsified card premise with its measured evidence', () => {
  assert.equal(artifact.cardPremiseFalsified.evidence.includes(STORED_FINGERPRINT), true);
  assert.equal(artifact.chainLag.livePull.unchanged, true);
  assert.equal(artifact.chainLag.livePull.fingerprint, `sha256:${STORED_FINGERPRINT}`);
  assert.ok(artifact.chainLag.livePull.slot > artifact.chainLag.storedSlot);
});

test('no host path leaks into the committed artifact', () => {
  assert.equal(JSON.stringify(artifact).includes('/home/'), false);
  assert.equal(JSON.stringify(artifact).includes('/tmp/'), false);
});

test('the committed bytes still close the face through the product path (re-measure from the pinned commit)', async (t) => {
  if (!(await ghAuthed())) {
    t.skip('gh not authenticated; the license gate needs a live fetch of the unlicensed bytes');
    return;
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'sememe-pfee-'));
  const out = path.join(dir, 'fresh.json');
  try {
    const res = await run('gh', ['api',
      `repos/pump-fun/pump-public-docs/contents/idl/pump_fees.json?ref=${COMMIT}`,
      '-H', 'Accept: application/vnd.github.raw'], { timeout: 60000, maxBuffer: 8 << 20 });
    await writeFile(path.join(dir, 'pump_fees.json'), res.stdout);
    await run(process.execPath, [TOOL, '--source', path.join(dir, 'pump_fees.json'), '--out', out],
      { cwd: ROOT, timeout: 300000 });
    const produced = JSON.parse(await readFile(out, 'utf8'));
    const strip = (r) => { const c = { ...r }; delete c.generatedAt; return c; };
    assert.deepEqual(strip(produced), strip(artifact),
      'the committed artifact is not what the tool derives — re-run the tool and commit its output');
  } finally {
    await rm(dir, { recursive: true, force: true, retryDelay: 200, maxRetries: 3 });
  }
});

test('the MIT candidate the card named is byte-identical to the stored pull (premise stays falsified)', async (t) => {
  if (!(await ghAuthed())) {
    t.skip('gh not authenticated; the falsification needs the candidate bytes at its pinned commit');
    return;
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'sememe-pfee-cand-'));
  try {
    const res = await run('gh', ['api',
      `repos/needsmorergb/charlie-protocol-v1/contents/_idl_pfeeUxB6.json?ref=${CANDIDATE_COMMIT}`,
      '-H', 'Accept: application/vnd.github.raw'], { timeout: 60000, maxBuffer: 8 << 20 });
    await writeFile(path.join(dir, 'candidate.json'), res.stdout);
    const { canonicalJson } = await import(path.join(ROOT, 'src', 'canonical.mjs'));
    const { createHash } = await import('node:crypto');
    const fingerprint = createHash('sha256')
      .update(Buffer.from(canonicalJson(JSON.parse(res.stdout)) + '\n'))
      .digest('hex');
    assert.equal(fingerprint, STORED_FINGERPRINT,
      'the candidate diverged from the stored pull — the premise may have changed; re-qualify before trusting this pin');
  } finally {
    await rm(dir, { recursive: true, force: true, retryDelay: 200, maxRetries: 3 });
  }
});
