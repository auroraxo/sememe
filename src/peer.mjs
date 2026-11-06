// The ONE optional peer the acquisition path needs, loaded so that its ABSENCE
// is a sentence instead of a Node loader stack trace.
//
// WHY THIS FILE EXISTS
//
// Measured 2026-11-06 from a bare install of the packed tarball (the bytes a
// `github:auroraxo/sememe#vX.Y.Z` install receives), with the peer absent:
//
//   import('sememe/pull') -> ERR_MODULE_NOT_FOUND: Cannot find package
//     '@solana/web3.js' imported from .../node_modules/sememe/src/pull.mjs
//   import('sememe/gap') -> the same, from .../src/acquire.mjs
//
// The CLI already refused in sememe's own voice ("pull needs @solana/web3.js:
// install it next to sememe (npm i @solana/web3.js@1.98.4)"), because
// bin/sememe.mjs catches the failed import and rewrites it. The LIBRARY
// surfaces did not: `sememe/pull` and `sememe/gap` are documented export
// subpaths, and a consumer who writes
//
//   import { pull } from 'sememe/pull';
//
// got a loader stack trace with an ERR_MODULE_NOT_FOUND code — no install
// command, no product-level name. The repo's own rule says a refusal names
// the fix; that rule was true for the CLI and false for the library.
//
// WHY A DYNAMIC IMPORT
//
// A static import of a missing package throws during module EVALUATION with
// the raw Node error — the very thing this file exists to prevent, and it
// cannot be intercepted from inside the module. A dynamic import CAN be
// caught, so the absence is rewritten here.
//
// WHY TOP-LEVEL AWAIT
//
// The refusal has to happen when the consumer imports the subpath, not when
// they call a function: `import { pull } from 'sememe/pull'` must not hand
// back a module whose exports only fail later. Top-level await makes the
// module's evaluation itself the refusal point, so the error reaches the
// consumer's import statement.
//
// The decode core must stay importable in a dependency-free repository
// (pinned by test/deps.test.mjs), and this file is NOT reachable from the
// package entry (`index.mjs`) — so a decoder-only consumer still installs
// zero packages. The peer import literal lives here, so the release-surface
// instrument, which derives the peer-needing commands from the import graph,
// still derives them from the tree.

export const PEER_PACKAGE = '@solana/web3.js';
export const PEER_INSTALL = 'npm i @solana/web3.js@1.98.4';

/** The refusal sememe raises when the optional peer is not installed. */
export class PeerDependencyMissingError extends Error {
  constructor(cause) {
    super(`the acquisition path needs ${PEER_PACKAGE}: install it next to sememe (${PEER_INSTALL})`);
    this.name = 'PeerDependencyMissingError';
    // Deliberately NOT 'ERR_MODULE_NOT_FOUND': a consumer that branches on
    // error codes must be able to tell "sememe refused" from "Node could not
    // resolve something".
    this.code = 'peer_dependency_missing';
    this.peer = PEER_PACKAGE;
    this.install = PEER_INSTALL;
    this.cause = cause;
  }
}

/**
 * Load the optional peer, or refuse with the sentence that fixes it.
 *
 * Only a genuine "the peer itself is not installed" is rewritten. Any other
 * failure (the peer is installed but broken, a network error inside it) is
 * rethrown unchanged: masking it as a missing peer would send a consumer to
 * install a package they already have.
 */
export async function loadPeer() {
  try {
    return await import('@solana/web3.js');
  } catch (error) {
    const code = error?.code;
    const message = String(error?.message ?? error);
    if (code === 'ERR_MODULE_NOT_FOUND' && message.includes(PEER_PACKAGE)) {
      throw new PeerDependencyMissingError(error);
    }
    throw error;
  }
}

const peer = await loadPeer();

// web3.js is CommonJS. Node's interop usually exposes the named exports
// directly, but the default export is the fallback; if neither carries
// PublicKey the peer is installed but unusable, which must NOT be reported
// as "install the peer".
export const PublicKey = peer?.PublicKey ?? peer?.default?.PublicKey;
if (typeof PublicKey !== 'function') {
  throw Error(`${PEER_PACKAGE} is installed but does not export PublicKey — the peer is broken, not missing`);
}
