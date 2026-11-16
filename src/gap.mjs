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
// 5. The verdict definition has always been store-relative ("pullable = an
//    interface exists on chain that this program's store simply does not have
//    yet") without the store ever being consulted — measured 2026-11-16 from a
//    stranger's install of sememe@0.4.29: a Whirlpool receipt the store held
//    was reported `pullable` + "sememe pull", and an adopted Lighthouse copy
//    the store already owned was reported `no-interface-published` + "use
//    sememe adopt-lighthouse". Two opposite worlds, one answer, and the answer
//    was "redo what you already did" in both. `probeGap({ storeDir })` reads
//    the store BEFORE any RPC (a store the reader refuses rejects without
//    spending a call) and folds it into the verdict as `stored`, keeping the
//    chain fact as `chainVerdict`. The store NEVER moves the chain verdict
//    when it does not hold the program, and the research harness passes no
//    storeDir: a sweep artifact measures THE CHAIN, so a private store cannot
//    move a published artifact.
//
// This file lives in src/ so the shipped CLI can offer it: tools/ is not part
// of the published package (see "files" in package.json), and a consumer who
// hits `no stored IDL for program X` must be able to ask WHY from the same
// install they run `sememe decode` from. The acquisition dependency
// (@solana/web3.js, via ./acquire.mjs) is loaded lazily by the caller exactly
// like `pull`, so the decode-only install path stays dependency-free.

import { addresses, inspect, rpcAccounts } from './acquire.mjs';
// Imported AFTER ./acquire.mjs on purpose: src/peer.mjs's refusal must stay the
// first thing a peer-less import of sememe/gap runs into (test/acquisition-peer-surface).
import { findStoredIdls } from './store-read.mjs';
import { LIGHTHOUSE_PROGRAM } from './lighthouse.mjs';
import { isNativeProgram } from './native.mjs';
import { isTokenProgram } from './token.mjs';
import { isRaydiumProgram } from './raydium.mjs';
import { isAtaProgram } from './ata.mjs';

const VENDORED = 'vendored';

/** Programs sememe answers with a pinned wire table, so there is no IDL to fetch. */
export function vendoredProgram(program) {
  if (isNativeProgram(program)) return 'native';
  if (isTokenProgram(program)) return 'token';
  if (isRaydiumProgram(program)) return 'raydium';
  if (isAtaProgram(program)) return 'ata';
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
 * What the LOCAL store answers for one program — the half of the gap question
 * the chain can never answer, and the reason this file now exists at all.
 *
 * Measured 2026-11-16 from a stranger's install of sememe@0.4.29: the usage
 * defined `pullable` as "an interface exists on chain that this program's
 * store simply does not have yet", but the store was never read — a pulled
 * Whirlpool receipt and an adopted Lighthouse copy both came back with the
 * advice to redo the acquisition the store already records.
 *
 * Three states, and only three — an absence is never folded into another
 * absence, and a store the reader REFUSES is not a state at all:
 *
 *   held      the store holds at least one verified receipt (re-hashed by
 *             src/store-read.mjs — a tampered object throws instead of
 *             returning something quieter)
 *   not-held  the store exists and simply has no receipt for this program
 *   no-store  there is no store directory at all (a stranger before first pull)
 *
 * Anything else — a tampered object, a receipt that names another program, an
 * unreadable file — propagates: `no stored IDL` must never be the report for
 * damage, the same rule src/lock.mjs follows ("a store the reader refuses
 * produces NO lock").
 */
export async function storeState(storeDir, program) {
  let found;
  try {
    found = await findStoredIdls(storeDir, program);
  } catch (error) {
    if (error?.code === 'no-sememe-store') return { state: 'no-store', dir: storeDir };
    if (error?.code === 'no-stored-idl') return { state: 'not-held', dir: storeDir };
    throw error;
  }
  const receipts = [...found.onChain, ...found.adopted].map((entry) => ({
    source: entry.idlMeta.source,
    slot: entry.idlMeta.slot ?? null,
    fingerprint: entry.idlMeta.fingerprint,
    origin: entry.idlMeta.origin ?? null,
    label: entry.label,
  }));
  return {
    state: 'held',
    dir: storeDir,
    onChain: found.onChain.length,
    adopted: found.adopted.length,
    receipts,
  };
}

/**
 * Fold the store's answer into one classified row.
 *
 * The store can only SUPPLY a verdict (when it holds a verified receipt),
 * never MASK one:
 *
 *   - no-store / not-held leave the chain verdict exactly as classified — a
 *     store that does not have the program is not evidence about the chain;
 *   - a failed RPC probe keeps `unknown` even when the store holds the
 *     program: the crates.io-403 rule is absolute, and exit 3 must keep
 *     signalling "the chain half is unmeasured". The local fact is still
 *     reported in `store` and named by nextStep, so nothing is hidden.
 *
 * When the verdict does change, the chain verdict survives as `chainVerdict`
 * — a `stored` row must never erase the fact it was built on.
 */
function withStore(row, store) {
  if (!store) return row;
  const merged = { ...row, store };
  if (store.state !== 'held' || row.verdict === 'unknown') return merged;
  merged.chainVerdict = row.verdict;
  merged.verdict = 'stored';
  return merged;
}

/**
 * Probe a list of `{ program, payloads }` entries against the chain.
 *
 * 25 programs per request = 50 keys; the public endpoint rejects larger
 * getMultipleAccounts batches (-32602), measured while building this.
 *
 * `storeDir` is OPTIONAL and off for the research harness on purpose: the
 * sweep artifacts measure THE CHAIN, so a private store must not be able to
 * move a published artifact. With it, the store is read FIRST — before any
 * RPC — so a store the reader refuses rejects the whole probe without
 * spending a call (test/gap-store.test.mjs T6).
 */
export async function probeGap(programs, options = {}) {
  const {
    url = 'https://api.mainnet-beta.solana.com',
    fetcher = fetch,
    batchSize = 25,
    tries = 3,
    storeDir = null,
  } = options;
  if (!Array.isArray(programs) || !programs.length) throw Error('programs required');
  // Read the local store BEFORE the chain: refusal must cost no RPC.
  const stores = storeDir
    ? new Map(await Promise.all(programs.map(async ({ program }) => [
      program, await storeState(storeDir, program),
    ])))
    : null;
  const rows = [];
  let slot = null;
  for (const group of chunk(programs, batchSize)) {
    const locations = await Promise.all(group.map(async ({ program }) => addresses(program)));
    const keys = locations.flatMap(({ metadata, anchor }) => [metadata, anchor]);
    const response = await rpcAccounts(url, keys, fetcher, tries);
    if (response.error) {
      // The whole batch is UNKNOWN — and unknown must never become absence.
      for (const { program, payloads } of group) {
        rows.push(withStore({ program, payloads, verdict: 'unknown', error: response.error }, stores?.get(program)));
      }
      continue;
    }
    slot = response.slot ?? slot;
    group.forEach(({ program, payloads }, index) => {
      const accounts = [response.accounts[2 * index], response.accounts[2 * index + 1]];
      rows.push(withStore({ program, payloads, slot, ...classify(program, accounts) }, stores?.get(program)));
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
    // `stored` is a LOCAL verdict (the store already holds the program) and is
    // counted separately from the chain verdicts below, because the harness
    // that produces the sweep artifacts never asks for it.
    storedPrograms: byVerdict.stored ?? 0,
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

/**
 * The `next` line for one verdict — the fix that actually applies.
 *
 * The store half comes FIRST, because a store that already holds the program
 * has no acquisition step left to recommend (measured 2026-11-16: the advice
 * used to send a stranger to pull a program it had pulled, and to adopt a
 * Lighthouse copy it already owned). Three rules:
 *
 *   - a held program is DECODED, never re-acquired — except when the chain
 *     publishes an on-chain interface the store does NOT hold: then the
 *     on-chain receipt is genuinely missing and the pull IS the step;
 *   - a failed probe stays the headline even when the store holds the
 *     program: the chain half is unmeasured, and the local half is named as
 *     the usable one;
 *   - the chain verdicts keep their own advice, unchanged.
 */
export function nextStep(row, program) {
  const store = row.store;
  if (row.verdict === 'stored' && store?.state === 'held') {
    const onChainMissing = store.onChain === 0 && row.chainVerdict === 'pullable';
    if (onChainMissing) {
      return `this program publishes an on-chain interface that your store does not hold yet `
        + `(the store holds only an adopted copy: ${describeReceipts(store)}) `
        + `-> run sememe pull ${program}`;
    }
    const chainNote = row.chainVerdict === 'no-interface-published'
      ? 'the chain publishes nothing at either address — the copy in your store is the interface'
      : `the chain publishes an interface too (chain verdict kept in chainVerdict: ${row.chainVerdict})`;
    return `your store already holds this program (${describeReceipts(store)}): ${chainNote}. `
      + `there is nothing to acquire -> decode it: sememe decode ${program} <payload> `
      + `(sememe decode --union ${program} <payload> reads both sources)`;
  }
  if (row.verdict === 'unknown') {
    const held = store?.state === 'held'
      ? ` Your store already holds this program (${describeReceipts(store)}), so you can decode it offline right now.`
      : '';
    return 'the RPC did not answer — absence is NOT established; retry before believing anything about the chain.'
      + held;
  }
  switch (row.verdict) {
    case 'pullable':
      return `sememe pull ${program}`;
    case 'no-interface-published':
      // Lighthouse is the one measured case where sememe SHIPS the verified
      // first-party copy (vendor/lighthouse, hash-pinned): the general advice
      // would send the user off to find a file the package already carries.
      if (program === LIGHTHOUSE_PROGRAM) {
        return 'this program publishes no on-chain interface at either address — pulling it can never succeed. '
          + 'sememe ships its first-party published copy (Jac0xb/lighthouse, MIT, hash-pinned): '
          + 'use sememe adopt-lighthouse --store <dir>, then sememe decode --union.';
      }
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

/**
 * Name what the store holds, in the reader's language: the source, the slot
 * when there is one, and the declared origin for an adopted copy (declared,
 * never verified — that is the receipt's own wording).
 */
function describeReceipts(store) {
  const parts = (store.receipts ?? []).map((receipt) => {
    const where = receipt.slot === null || receipt.slot === undefined
      ? 'no slot'
      : `slot ${receipt.slot}`;
    const origin = receipt.origin ? `, declared origin ${receipt.origin}` : '';
    return `${receipt.source} (${where}${origin})`;
  });
  return parts.length ? parts.join('; ') : 'no receipt';
}
