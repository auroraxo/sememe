// Zero-RPC guard, installed as a MODULE SIDE EFFECT so that import ORDER
// decides when it takes effect: a module that imports this FIRST installs the
// guard before any later module body runs.
//
// The claim "this harvest cost zero RPC calls" must be enforceable, not
// asserted. `globalFetchAttempts` counts every attempted call; the guard
// rejects immediately and records the call, so a failing run shows exactly
// which path reached for the network, and a passing run proves none did
// (asserted by tools/e2e-reeflog-harvest.mjs).

export const guard = {
  attempts: [],
};

const realFetch = globalThis.fetch;

globalThis.fetch = function guardedFetch(url, init) {
  guard.attempts.push(String(url));
  return Promise.reject(new Error(
    `zero-RPC guard: network access attempted (${String(url)}) — `
    + 'this tool claims to read only the local reeflog journal',
  ));
};

/** Restore the real fetch (tests that need real network restore before use). */
export function unguard() {
  globalThis.fetch = realFetch;
}
