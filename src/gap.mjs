// `sememe gap <program>` — why is there no interface here? Asked BEFORE pull.
//
// WHY THIS FILE EXISTS
//
// The full foreign sweep (research/step-ingestooor-full-sweep-2026-11-04.json)
// ended with 306 no-interface payloads across 70 programs, and the reflex is to
// call them all "acquisition gaps ... next derivation candidates". That label
// conflates two problems that need OPPOSITE fixes:
//
//   - a program that PUBLISHES an on-chain IDL at one of the two addresses
//     sememe can read is a NEVER-PULLED gap: `sememe pull` closes it, no
//     derivation exists to do;
//   - a program with neither address answering publishes nothing: pulling it
//     forever cannot help (it needs `sememe adopt` of a first-party published
//     copy, or a pinned upstream derivation, or a vendored wire table).
//
// Measured 2026-11-04 against live mainnet over all 70 gap programs:
// 34 publish an IDL (177 payloads) — including Jupiter DCA, which the card had
// listed as a derivation candidate — and 36 publish nothing (129 payloads),
// among them the largest single gap (L2TExM, 42 payloads, Lighthouse).
//
// WHY IT IS A TOOL AND NOT A PARAGRAPH
//
// 1. An RPC failure is NEVER recorded as "publishes nothing". The crates.io
//    403 incident (signerd, 2026-11-03) is the standing example: a client
//    failure that reads like an absence. Unknown rows are counted separately
//    and the verdict is withheld (`no-verdict`) so a partial probe cannot be
//    quoted as a complete one.
// 2. A program sememe answers WITHOUT an IDL (System, ComputeBudget, SPL Token,
//    Token-2022, Raydium AMM v4) is `vendored`, not a gap: telling a reader to
//    pull it would send them after a receipt that can never exist.
// 3. An account that EXISTS but cannot be decoded is `present-undecodable`, its
//    own verdict, never folded into "publishes nothing": an unusable interface
//    is a different finding from an absent one.
// 4. Payload counts come from the committed sweep report, and its
//    `noInterface` headline must equal the sum of the per-program counts —
//    a hand-edited artifact is refused before it can be probed.
//
// This file lives in src/ so the shipped CLI can offer it: tools/ is not part
// of the published package (see "files" in package.json), and a consumer who
// hits `no stored IDL for program X` must be able to ask WHY from the same
// install they run `sememe decode` from. The acquisition dependency
// (@solana/web3.js, via ./acquire.mjs) is loaded lazily by the caller exactly
// like `pull`, so the decode-only install path stays dependency-free.

import { addresses, inspect, rpcAccounts } from './acquire.mjs';
import { isNativeProgram } from './native.mjs';
import { isTokenProgram } from './token.mjs';
import { isRaydiumProgram } from './raydium.mjs';

const VENDORED = 'vendored';

/** Programs sememe answers with a pinned wire table, so there is no IDL to fetch. */
export function vendoredProgram(program) {
  if (isNativeProgram(program)) return 'native';
  if (isTokenProgram(program)) return 'token';
  if (isRaydiumProgram(program)) return 'raydium';
  return null;
}

/**
 * Classify ONE gap program from its two probe accounts (metadata, anchor).
 *
 * Every path returns a verdict; nothing throws on bad data, so a caller can
 * aggregate instead of losing a whole run to one malformed account.
 */
export function classify(program, accounts, hints = {}) {
  const vendored = vendoredProgram(program);
  if (vendored) return { program, verdict: VENDORED, kind: vendored };
  const c = hints.canonical ?? inspect(accounts?.[0], 'metadata', program);
  const l = hints.legacy ?? inspect(accounts?.[1], 'anchor', program);
  const usable = c.state === 'usable' ? 'metadata' : l.state === 'usable' ? 'anchor' : null;
  if (usable) {
    const chosen = usable === 'metadata' ? c : l;
    return {
      program, verdict: 'pullable', source: usable,
      instructions: chosen.instructions,
      decodableStoredOnly: chosen.decodableStoredOnly,
      canonical: c.state, legacy: l.state,
    };
  }
  if (c.state === 'missing' && l.state === 'missing') {
    return { program, verdict: 'no-interface-published', canonical: c.state, legacy: l.state };
  }
  return {
    program, verdict: 'present-undecodable',
    canonical: c.state, legacy: l.state,
    error: c.state === 'undecodable' ? c.error : l.state === 'undecodable' ? l.error : undefined,
  };
}

const chunk = (items, size) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/**
 * Probe a list of `{ program, payloads }` entries against the chain.
 *
 * 25 programs per request = 50 keys; the public endpoint rejects larger
 * getMultipleAccounts batches (-32602), measured while building this.
 */
export async function probeGap(programs, options = {}) {
  const {
    url = 'https://api.mainnet-beta.solana.com',
    fetcher = fetch,
    batchSize = 25,
    tries = 3,
  } = options;
  if (!Array.isArray(programs) || !programs.length) throw Error('programs required');
  const rows = [];
  let slot = null;
  for (const group of chunk(programs, batchSize)) {
    const locations = await Promise.all(group.map(async ({ program }) => addresses(program)));
    const keys = locations.flatMap(({ metadata, anchor }) => [metadata, anchor]);
    const response = await rpcAccounts(url, keys, fetcher, tries);
    if (response.error) {
      // The whole batch is UNKNOWN — and unknown must never become absence.
      for (const { program, payloads } of group) {
        rows.push({ program, payloads, verdict: 'unknown', error: response.error });
      }
      continue;
    }
    slot = response.slot ?? slot;
    group.forEach(({ program, payloads }, index) => {
      const accounts = [response.accounts[2 * index], response.accounts[2 * index + 1]];
      rows.push({ program, payloads, slot, ...classify(program, accounts) });
    });
  }
  return { rows, summary: summarize(rows), slot };
}

export function summarize(rows) {
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
    byVerdict, payloadsByVerdict,
    unknown,
    // Withhold the verdict when any probe failed: a partial probe is not a
    // statement about the rows it failed on, and must not be quoted as one.
    verdict: unknown > 0 ? 'no-verdict' : 'measured',
    pullablePrograms: byVerdict.pullable ?? 0,
    pullablePayloads: payloadsByVerdict.pullable ?? 0,
    publishesNothingPrograms: byVerdict['no-interface-published'] ?? 0,
    publishesNothingPayloads: payloadsByVerdict['no-interface-published'] ?? 0,
    undecodablePrograms: byVerdict['present-undecodable'] ?? 0,
    vendoredPrograms: byVerdict[VENDORED] ?? 0,
    knownPrograms: rows.length - unknown,
  };
}

/**
 * Turn a committed sweep report's `noInterfaceByProgram` map into the entries
 * probeGap takes. The report is the denominator: its headline must equal the
 * sum of the per-program counts, or the artifact has been hand-edited.
 */
export function programsFromReport(report) {
  const perProgram = report?.noInterfaceByProgram;
  if (!perProgram || typeof perProgram !== 'object' || Array.isArray(perProgram)) {
    throw Error('report has no noInterfaceByProgram map');
  }
  const programs = Object.entries(perProgram).map(([program, payloads]) => ({ program, payloads }));
  if (!programs.length) throw Error('report has no gap programs');
  const sum = programs.reduce((total, { payloads }) => total + payloads, 0);
  if (sum !== report.noInterface) {
    throw Error(`gap counts sum to ${sum} but report.noInterface says ${report.noInterface} — hand-edited artifact`);
  }
  return programs;
}

/** The `next` line for one verdict — the fix that actually applies. */
export function nextStep(row, program) {
  switch (row.verdict) {
    case 'pullable':
      return `sememe pull ${program}`;
    case 'no-interface-published':
      return 'this program publishes no on-chain interface at either address — pulling it can never succeed. '
        + 'Use sememe adopt <program> <file> with a first-party published copy, or a pinned upstream derivation.';
    case 'present-undecodable':
      return 'an interface account exists but its schema is unusable — pull it to inspect; decode will refuse by name';
    case VENDORED:
      return 'answered by the pinned wire table shipped with sememe; there is no IDL to store';
    default:
      return 'the RPC did not answer — absence is NOT established; retry before believing anything about the chain';
  }
}
