#!/usr/bin/env node
// measure-pfee-second-source.mjs — the card's next acquisition step, measured
// end to end, AFTER the step as written was falsified:
//
//   node tools/measure-pfee-second-source.mjs \
//     --source <idl/pump_fees.json as read at the pinned commit> \
//     --out research/pfee-second-source-2026-11-12.json
//
// WHY THIS FILE EXISTS
//
// The card (2026-11-12) names next step (1): adopt needsmorergb/charlie-protocol-v1's
// _idl_pfeeUxB6.json (MIT) and close pfeeU's 459/464 refusals — "could be
// real source lag". Measured 2026-11-12 (this host, before any write):
//
//   1. the candidate copy is BYTE-IDENTICAL to the on-chain pull the committed
//      store already holds — same canonical fingerprint
//      9c1ef6ed66df5d72f4491d12e9781436f8037a6e20499d1681485591b8644a26,
//      29 instructions, same discriminator per name. Adopting it adds a
//      receipt and closes NOTHING. The card's premise fails.
//   2. all 459 refusals are ONE face: unknown instruction discriminator
//      9aed8a5ca202a2bb, every payload 57 bytes. It is absent from BOTH copies.
//   3. a live pull at slot 468428470 (newer than the capture's 468262003)
//      returns the SAME fingerprint — the on-chain interface still lags.
//   4. the source that actually carries the instruction is FIRST-PARTY:
//      pump-fun/pump-public-docs, idl/pump_fees.json (31 instructions,
//      get_fees_with_quote_mint with discriminator 9aed8a5ca202a2bb — the
//      same repo/commit the pump.fun face already pins). The name→bytes
//      binding is NOT trusted from the file: it matches Anchor's own rule,
//      sha256("global:get_fees_with_quote_mint")[0..8] = 9aed8a5ca202a2bb,
//      computed here independently (sanity-checked against get_fees, which
//      both copies already store).
//
// METHOD (the two-store shape tools/measure-pump-second-source.mjs proved):
//
//   baseline: the committed store, untouched — must reproduce the ecosystem
//             artifact's own pfeeU face (5 decoded / 459 refused / 5 byte-exact),
//             else NO VERDICT;
//   union:    a THROWAWAY copy of the committed store + `sememe adopt` of the
//             pinned first-party copy through the product's one write path
//             (src/adopt.mjs: content-addressed, receipt `slot: null`,
//             origin declared — it can never displace the on-chain pull).
//
// LICENSING: pump-fun/pump-public-docs ships NO LICENSE file (spdx null,
// measured via the API 2026-11-12). Its bytes therefore must NOT be vendored
// into this MIT repository or the npm package. The caller names a --source
// file read at the pinned commit; it is fetched outside this repo by the
// test or the operator, verified against the pinned canonical fingerprint
// BEFORE any write, and adopted only into the throwaway copy that gets deleted.
//
// Exit codes: 0 measured, 2 usage/IO, 3 NO VERDICT.

import { existsSync, readFileSync, readdirSync, rmSync, cpSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { adopt } from '../src/adopt.mjs';
import { decodeUnionPayload } from '../src/decode.mjs';
import { canonicalJson } from '../src/canonical.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const PFEE = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
const PIN = {
  program: PFEE,
  repo: 'pump-fun/pump-public-docs',
  commit: '639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22',
  file: 'idl/pump_fees.json',
  // sha256 of the canonical form of the published copy (adopt fingerprints
  // canonicalJson, not the pretty-printed upstream file). Measured 2026-11-12.
  canonicalFingerprint: 'd85238f1557e8951dcfc3e06341c248ee7e642c11017fbbee80702718c2f88ca',
  license: null, // unlicensed repo — bytes stay OUT of this repository
  origin: 'pump-fun/pump-public-docs@639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22:idl/pump_fees.json',
};
const FACE = '9aed8a5ca202a2bb'; // the single unknown discriminator, lowercase hex

// Anchor's own rule, computed independently of any file: name -> bytes.
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const globalDisc = (name) => sha256('global:' + name).slice(0, 16);

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};

async function measureStore(storeDir, rows) {
  let decoded = 0; let refused = 0; let byteExact = 0; let describedExact = 0;
  let adoptedAnswered = 0; let pulledAnswered = 0;
  const refusals = {}; const names = {};
  for (const row of rows) {
    try {
      const out = await decodeUnionPayload(storeDir, PFEE, row.hex, { absent: 'verified' });
      decoded += 1;
      if (out.roundTripByteExact === true) byteExact += 1;
      if (out.describedRoundTripByteExact === true) describedExact += 1;
      const slot = out.idl?.slot;
      if (slot === null || slot === undefined) adoptedAnswered += 1; else pulledAnswered += 1;
      names[out.name] = (names[out.name] ?? 0) + 1;
    } catch (error) {
      refused += 1;
      const key = String(error?.message ?? error).slice(0, 110);
      refusals[key] = (refusals[key] ?? 0) + 1;
    }
  }
  return { decoded, refused, byteExact, describedExact, adoptedAnswered, pulledAnswered, refusals, names };
}

async function main() {
  const samplePath = path.resolve(ROOT, opt('--sample', 'test/fixtures/ecosystem-sample-2026-11-11.json'));
  const storeDir = path.resolve(ROOT, opt('--store', 'test/fixtures/ecosystem-store-2026-11-11'));
  const sourceArg = opt('--source', null);
  const outPath = opt('--out', null);
  if (!sourceArg) {
    process.stderr.write('usage: measure-pfee-second-source.mjs --source <pump_fees.json at the pinned commit> [--out artifact.json]\n(unlicensed bytes are not vendored — read them from the pin, e.g. the GitHub contents API)\n');
    process.exit(2);
  }
  const sourcePath = path.resolve(sourceArg);
  if (!existsSync(sourcePath)) {
    process.stderr.write(`NO VERDICT: pinned source file missing: ${sourcePath}\n`);
    process.exit(3);
  }

  // 0. Pin check BEFORE any write, and NAME->BYTES binding checked HERE with
  //    Anchor's rule — not trusted from the file or from any repo.
  const raw = readFileSync(sourcePath, 'utf8');
  const idl = JSON.parse(raw);
  const canonicalFingerprint = createHash('sha256')
    .update(Buffer.from(canonicalJson(idl) + '\n'))
    .digest('hex');
  if (canonicalFingerprint !== PIN.canonicalFingerprint) {
    process.stderr.write(`NO VERDICT: pfeeU-pin-hash-mismatch: pinned ${PIN.canonicalFingerprint}, `
      + `hashed now ${canonicalFingerprint} — refusing to measure bytes nobody reviewed\n`);
    process.exit(3);
  }
  if (idl.address !== PFEE) {
    process.stderr.write(`NO VERDICT: the copy declares another program: ${idl.address}\n`);
    process.exit(3);
  }
  const faceIx = (idl.instructions || []).find((i) => i.name === 'get_fees_with_quote_mint');
  if (!faceIx || !Array.isArray(faceIx.discriminator)) {
    process.stderr.write('NO VERDICT: the copy carries no get_fees_with_quote_mint with a stored discriminator\n');
    process.exit(3);
  }
  const faceHex = faceIx.discriminator.map((b) => b.toString(16).padStart(2, '0')).join('');
  if (faceHex !== FACE || globalDisc('get_fees_with_quote_mint') !== FACE) {
    process.stderr.write(`NO VERDICT: face-discriminator-disagreement: file says ${faceHex}, `
      + `anchor sighash says ${globalDisc('get_fees_with_quote_mint')}, the wire face is ${FACE}\n`);
    process.exit(3);
  }
  // sanity: the rule must agree with an instruction BOTH copies already store
  const shared = (idl.instructions || []).find((i) => i.name === 'get_fees');
  const sharedHex = (shared?.discriminator || []).map((b) => b.toString(16).padStart(2, '0')).join('');
  if (sharedHex !== globalDisc('get_fees')) {
    process.stderr.write(`NO VERDICT: sighash sanity fails on get_fees (file ${sharedHex}, rule ${globalDisc('get_fees')})\n`);
    process.exit(3);
  }

  const sample = JSON.parse(await readFile(samplePath, 'utf8'));
  const rows = [];
  for (const tx of sample.transactions) {
    for (const p of tx.payloads ?? []) {
      if (p.program === PFEE) rows.push({ hex: p.dataHex, failed: tx.failed === true });
    }
  }
  if (rows.length === 0) {
    process.stderr.write('NO VERDICT: the sample carries no pfeeU payloads\n');
    process.exit(3);
  }

  // 1. Baseline: the committed store MUST reproduce the artifact's pfeeU face.
  const coverage = JSON.parse(await readFile(path.resolve(ROOT, 'research/ecosystem-coverage-2026-11-11.json'), 'utf8'));
  const entry = (coverage.programs ?? []).find((p) => p.program === PFEE);
  const baseline = await measureStore(storeDir, rows);
  if (!entry
    || baseline.decoded !== entry.decoded
    || baseline.refused !== entry.refused
    || baseline.byteExact !== entry.byteExact) {
    process.stderr.write(`NO VERDICT: baseline does not reproduce the committed artifact `
      + `(measured ${baseline.decoded}/${baseline.refused}/${baseline.byteExact} vs artifact `
      + `${entry?.decoded}/${entry?.refused}/${entry?.byteExact})\n`);
    process.exit(3);
  }

  // 2. Union: throwaway copy of the committed store + adopt through the
  //    product's one write path.
  const committedBefore = readdirSync(path.join(storeDir, 'receipts')).sort().join('\n')
    + '::' + readdirSync(path.join(storeDir, 'objects')).sort().join('\n');
  const workStore = path.join(ROOT, 'research', '.pfee-second-source-store');
  rmSync(workStore, { recursive: true, force: true, retryDelay: 200, maxRetries: 3 });
  cpSync(storeDir, workStore, { recursive: true });
  let receipt;
  try {
    receipt = await adopt(PFEE, sourcePath, workStore, { source: 'published', origin: PIN.origin });
  } catch (error) {
    rmSync(workStore, { recursive: true, force: true, retryDelay: 200, maxRetries: 3 });
    process.stderr.write(`NO VERDICT: adopt refused: ${String(error?.message ?? error).slice(0, 160)}\n`);
    process.exit(3);
  }
  let union;
  try {
    union = await measureStore(workStore, rows);
  } finally {
    rmSync(workStore, { recursive: true, force: true, retryDelay: 200, maxRetries: 3 });
  }

  // 3. The committed store must be byte-untouched (licensing rule).
  const committedAfter = readdirSync(path.join(storeDir, 'receipts')).sort().join('\n')
    + '::' + readdirSync(path.join(storeDir, 'objects')).sort().join('\n');
  const committedStoreModified = committedBefore !== committedAfter;
  if (committedStoreModified) {
    process.stderr.write('NO VERDICT: the committed store changed — foreign bytes must never land in the repo\n');
    process.exit(3);
  }

  // 4. The 5 baseline decodes must keep their names in the union (adoption
  //    must not rewrite answers that were already right — the pump lesson).
  const renamed = Object.entries(baseline.names).filter(([n, c]) => (union.names[n] ?? 0) < c);

  const output = {
    generatedAt: new Date().toISOString(),
    program: PFEE,
    name: 'pump.fun fees (pump_fees)',
    finding: 'pfeeU\'s 459 refusals are one instruction (get_fees_with_quote_mint, discriminator 9aed8a5ca202a2bb) that the on-chain IDL account does not list even at slot 468428470; the MIT candidate the card named is byte-identical to the stored pull and closes nothing; the FIRST-PARTY published copy closes all 459 on the same committed bytes',
    cardPremiseFalsified: {
      candidate: 'needsmorergb/charlie-protocol-v1:_idl_pfeeUxB6.json@eb85241573842170151f59a4cb7e377294cdd3f8 (MIT)',
      evidence: 'canonical fingerprint 9c1ef6ed66df5d72f4491d12e9781436f8037a6e20499d1681485591b8644a26 equals the stored on-chain pull\'s fingerprint — same bytes, 29 instructions, zero new discriminators',
    },
    chainLag: {
      storedSlot: 468262003,
      livePull: { slot: 468428470, fingerprint: 'sha256:9c1ef6ed66df5d72f4491d12e9781436f8037a6e20499d1681485591b8644a26', unchanged: true },
      note: 'a fresh pull at a newer slot returned the same bytes — the lag is live on chain, not stale in the store',
    },
    nameBinding: {
      instruction: 'get_fees_with_quote_mint',
      faceDiscriminator: FACE,
      rule: 'sha256("global:" + name)[0..8] (anchor-lang), computed independently here',
      fileAgrees: faceHex === FACE,
      ruleAgrees: globalDisc('get_fees_with_quote_mint') === FACE,
      sanityOnStoredPair: `get_fees -> ${globalDisc('get_fees')} agrees with both copies`,
    },
    pin: {
      repo: PIN.repo,
      commit: PIN.commit,
      file: PIN.file,
      canonicalFingerprint: `sha256:${PIN.canonicalFingerprint}`,
      license: PIN.license,
      licenseNote: 'no LICENSE file in the repo at the pinned commit — the bytes stay OUT of this repository and the npm package; they were adopted into a throwaway store copy that the tool deletes',
      origin: PIN.origin,
    },
    sample: path.relative(ROOT, samplePath),
    store: path.relative(ROOT, storeDir),
    committedStoreModified,
    measured: {
      payloads: rows.length,
      failedTransactions: rows.filter((r) => r.failed).length,
      baseline: {
        decoded: baseline.decoded, refused: baseline.refused,
        byteExact: baseline.byteExact, describedExact: baseline.describedExact,
        coveredPct: Number((100 * baseline.decoded / rows.length).toFixed(1)),
        refusalReasons: baseline.refusals,
      },
      union: {
        decoded: union.decoded, refused: union.refused,
        byteExact: union.byteExact, describedExact: union.describedExact,
        coveredPct: Number((100 * union.decoded / rows.length).toFixed(1)),
        adoptedAnswered: union.adoptedAnswered,
        pulledAnswered: union.pulledAnswered,
      },
      delta: {
        decoded: union.decoded - baseline.decoded,
        refusalsClosed: baseline.refused - union.refused,
        reAssignedToAdopted: baseline.decoded - union.pulledAnswered,
      },
      baselineNamesKept: renamed.length === 0,
      renames: renamed,
      receipt: { fingerprint: receipt.fingerprint, instructionCount: receipt.instructionCount, slot: receipt.slot },
      unionNames: union.names,
      unionRefusals: union.refusals,
    },
    limits: [
      'one committed window: the 464 pfeeU payloads of the 11-11 ecosystem capture, not the whole ecosystem',
      'origin declared, not verified: the pin binds the canonical bytes to a commit nobody signed; the byte evidence is the re-encode',
      'the adopted copy sits at slot null and never displaces the on-chain pull (src/adopt.mjs ordering rule)',
      'licensing: pump-public-docs ships no LICENSE file, so it is not vendored — the measurement reproduces it from the pin at run time',
      'the on-chain account still lags (same bytes at slot 468428470): until the deployer publishes, only the first-party copy explains this instruction',
    ],
  };
  const json = `${JSON.stringify(output, null, 1)}\n`;
  if (outPath) {
    const out = path.resolve(outPath);
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, json);
  } else {
    process.stdout.write(json);
  }
  process.stderr.write(`pfee-second-source: baseline ${baseline.decoded}/${rows.length} `
    + `-> union ${union.decoded}/${rows.length} (+${union.decoded - baseline.decoded} decoded, `
    + `${baseline.refused - union.refused} refusals closed)\n`);
  if (union.decoded !== rows.length || union.refused !== 0) {
    process.stderr.write(`union still refuses faces: ${JSON.stringify(union.refusals).slice(0, 300)}\n`);
    process.exit(3);
  }
  if (renamed.length > 0) {
    process.stderr.write(`NO VERDICT: baseline answers were rewritten: ${JSON.stringify(renamed)}\n`);
    process.exit(3);
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`FAILED: ${String(error?.message ?? error).slice(0, 200)}\n`);
  process.exit(2);
}
