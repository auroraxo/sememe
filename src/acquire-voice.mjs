// src/acquire-voice.mjs — the ONE place the acquisition surface's refusals
// are minted: everything `sememe pull` says when the program id, the RPC URL
// or the ENDPOINT THE CALLER NAMED with --rpc cannot deliver the work.
//
// WHY THIS FILE EXISTS (measured 2026-11-17, this host, pre-fix tree
// af0a8d2, and reproduced against the PUBLISHED sememe@0.4.36):
//
// Every other classifier in the product closed its surface — the caller's
// file (src/file-input.mjs), the caller's store path (src/store-input.mjs),
// damage the reader finds (src/store-damage.mjs), the lock gate
// (src/lock-voice.mjs), the answers (src/store-answer.mjs). The ONE surface
// never classified is the network. On pre-fix af0a8d2, NINE distinct
// failures of `sememe pull` reached the operator as bare prose:
//
//   {"error":"RPC unavailable: HTTP 429"}               <- rate limit
//   {"error":"RPC unavailable: HTTP 500"}               <- outage
//   {"error":"RPC unavailable: fetch failed"}           <- undici's words
//   {"error":"RPC unavailable: Unexpected token 'o',…"} <- the parser's words
//   {"error":"RPC unavailable: RPC error -32005"}       <- the endpoint's own
//                                                          message DROPPED
//   {"error":"Non-base58 character"}                    <- web3.js's words
//
// The same three faults the other classifiers ended:
//   1. NO NAME — a script cannot tell "retry later" (429/500/unreachable)
//      from "you are using this wrong" (http:// URL, bad program id) from
//      "this endpoint is not a Solana JSON-RPC endpoint" (garbage body).
//   2. NO SUBJECT — WHICH endpoint failed and WHAT it actually said.
//   3. THE WRONG VOCABULARY — undici, the JSON parser and web3.js quoted
//      verbatim; the JSON-RPC error object's own `message` thrown away,
//      only its numeric code kept.
//
// THE CONTRACT (this module is the ONE mint place):
//   V1  every refusal carries a PRODUCT CODE: rpc-* for the endpoint, the
//       URL and the transport; program-id-* for the caller's argument.
//   V2  every refusal carries a repair (`fix:` prefix) — the house rule.
//   V3  the CHANNEL follows what actually ran:
//         exit 2 — the invocation cannot be what the caller meant and NO
//                  request was made (non-https URL, non-program-id). The
//                  usage/IO channel, exactly like store-input's path faces;
//         exit 1 — sememe DID dispatch the request and the answer failed
//                  (HTTP status, garbage body, JSON-RPC error, transport,
//                  missing slot). The work channel, exactly as these faces
//                  answered before they were named — the channel does not
//                  move for them, only the name is added.
//   V4  the kernel's and third parties' words are INPUT, never output:
//       ECONNREFUSED/ENOENT and "fetch failed"/"Non-base58 character" are
//       classified into product prose; the raw code travels only as the
//       STRUCTURED `cause` field, for scripts, not in the sentence.
//   V5  the endpoint's OWN words (a JSON-RPC error `message`) are the
//       SUBJECT of one refusal — they are quoted, not dropped: what the
//       endpoint said is exactly what the operator needs.
//   V6  `answer: true` never rides on a refusal here; a repair never rides
//       on an answer. (The chain's absence is not minted here — see
//       src/pull.mjs's `no verified on-chain IDL`, which keeps its own
//       sentence and is measured out of this surface's scope.)
//
// Pinned by test/acquire-voice.test.mjs (red on the pre-fix tree), by the
// committed artifact research/acquire-voice-2026-11-17.json (produced by
// tools/measure-acquire-voice.mjs), and — after the release — on the
// channel a stranger installs (tools/measure-acquire-voice-published.mjs).

/** Codes this module mints. Used by the CLI-free gate to tell a NAMED
 *  acquisition refusal from an ordinary error without matching prose. */
export function isAcquireCode(code) {
  return typeof code === 'string' && /^(?:rpc|program-id)-/.test(code);
}

/** The endpoint did not answer — and each cause has its OWN product
 *  sentence, because a DNS failure, a refused connection, a rejected TLS
 *  handshake and a timeout have different repairs for the operator. The
 *  raw code is kept as structured input (V4), never in the sentence. */
// Fragments, not sentences: the refusal template already names the subject
// ("the endpoint <url> …"), so these must not repeat it.
const TRANSPORT_REASONS = {
  ECONNREFUSED: 'refused the connection',
  ENOTFOUND: "its host name does not resolve",
  EAI_AGAIN: "its host name could not be resolved right now",
  ETIMEDOUT: 'did not answer within the connection timeout',
  ECONNRESET: 'dropped the connection',
  EPIPE: 'closed the connection while sememe was writing',
  TimeoutError: 'did not answer within the request timeout',
  AbortError: 'did not answer within the request timeout',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'presented a self-signed certificate that is not trusted here',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'presented a certificate that could not be verified',
  CERT_HAS_EXPIRED: 'presented an expired certificate',
  ERR_TLS_CERT_ALTNAME_INVALID: 'presented a certificate that does not match its host',
  SELF_SIGNED_CERT_IN_CHAIN: 'presented a certificate chain with an untrusted certificate',
};

function transportReason(cause) {
  if (TRANSPORT_REASONS[cause]) return TRANSPORT_REASONS[cause];
  return 'could not be reached';
}

/** The raw cause as structured INPUT: the code when the transport gives one
 *  (ECONNREFUSED, ENOTFOUND, CERT_HAS_EXPIRED, …), else the transport's own
 *  short words ("bad port"), else the error class. Never the sentence. */
export function transportCause(error) {
  const cause = error?.cause;
  return String(cause?.code ?? cause?.message ?? error?.name ?? 'unknown').slice(0, 60);
}

function refuse({ code, subject, reason, repair, exitCode = 1, cause }) {
  const error = new Error(`sememe pull: ${subject ? `${subject} ` : ''}${reason} (${code})`);
  error.code = code;
  error.fix = `fix: ${repair}`;
  error.exitCode = exitCode;
  if (cause !== undefined) error.cause = cause;
  return error;
}

/** The caller's program id argument (exit 2: no request was made). */
export function programIdRefusal(input, reason, code = 'program-id-invalid') {
  return refuse({
    code,
    subject: `program id ${JSON.stringify(String(input).slice(0, 80))}`,
    reason,
    repair: "pass the program's canonical base58 address (32 bytes), e.g. sememe pull whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc --store <dir>",
    exitCode: 2,
  });
}

/** The caller's --rpc URL is not https (exit 2: no request was made).
 *  The sentence keeps `HTTPS RPC URL required` verbatim — quoted by
 *  test/pull.test.mjs — and names the URL and the code behind it. */
export function httpsRefusal(rpcUrl) {
  return refuse({
    code: 'rpc-not-https',
    subject: '',
    reason: `HTTPS RPC URL required: ${JSON.stringify(String(rpcUrl).slice(0, 200))} is not an https endpoint`,
    repair: 'pass an https:// endpoint with --rpc, e.g. --rpc https://api.mainnet-beta.solana.com',
    exitCode: 2,
  });
}

/** An answer arrived from the endpoint and it failed the work (exit 1 —
 *  the channel these faces already answered on; see V3). `failure` is the
 *  structured record src/acquire.mjs attaches to every failed probe. */
export function rpcRefusal(rpcUrl, failure) {
  const url = JSON.stringify(String(rpcUrl).slice(0, 200));
  switch (failure?.kind) {
    case 'http':
      if (failure.status === 429) {
        return refuse({
          code: 'rpc-rate-limited',
          subject: `the endpoint ${url}`,
          reason: `answered HTTP 429 and is rate limiting sememe${failure.retryAfter ? ` (retry-after ${failure.retryAfter}s)` : ''}`,
          repair: 'wait for the rate-limit window to pass, or pass --rpc <another https endpoint> and run the pull again',
        });
      }
      if (failure.status === 401 || failure.status === 403) {
        return refuse({
          code: 'rpc-forbidden',
          subject: `the endpoint ${url}`,
          reason: `answered HTTP ${failure.status} and refuses this client`,
          repair: 'use an endpoint that serves getMultipleAccounts without credentials, e.g. --rpc https://api.mainnet-beta.solana.com',
        });
      }
      if (failure.status >= 500) {
        return refuse({
          code: 'rpc-endpoint-failed',
          subject: `the endpoint ${url}`,
          reason: `answered HTTP ${failure.status} — the endpoint itself failed`,
          repair: 'retry later, or pass --rpc <another https endpoint> and run the pull again',
        });
      }
      return refuse({
        code: 'rpc-http-error',
        subject: `the endpoint ${url}`,
        reason: `answered HTTP ${failure.status}`,
        repair: 'check the --rpc URL — a Solana JSON-RPC endpoint answers getMultipleAccounts with 200',
      });
    case 'rpc-error':
      return refuse({
        code: 'rpc-error-response',
        subject: `the endpoint ${url}`,
        reason: `answered a JSON-RPC error instead of accounts (code ${failure.rpcCode ?? 'unknown'}): ${failure.rpcMessage ?? 'no message'}`,
        repair: 'retry later, or pass --rpc <another https endpoint> — this endpoint refused the request itself',
      });
    case 'body':
      return refuse({
        code: 'rpc-bad-body',
        subject: `the endpoint ${url}`,
        reason: 'answered HTTP 200 with a body that is not JSON',
        repair: 'check the --rpc URL — this does not look like a JSON-RPC endpoint',
      });
    case 'shape':
      return refuse({
        code: 'rpc-malformed-response',
        subject: `the endpoint ${url}`,
        reason: failure.detail ?? 'answered JSON without the account entries sememe asked for',
        repair: 'retry, or pass --rpc <another https endpoint> — this one speaks JSON but not getMultipleAccounts',
      });
    case 'no-slot':
      return refuse({
        code: 'rpc-malformed-response',
        subject: `the endpoint ${url}`,
        reason: 'answered without the slot the receipt must be pinned to',
        repair: 'retry, or pass --rpc <another https endpoint> — sememe never stores a receipt without provenance',
      });
    // (shape/no-slot fragments start with "answered …" on purpose: the
    // template's subject already names the endpoint.)
    case 'transport':
    default:
      // V4: the sentence speaks ONLY product prose — the raw cause
      // (ECONNREFUSED, ENOTFOUND, "bad port") travels as the structured
      // `cause` field for scripts, never inside the operator's sentence.
      return refuse({
        code: 'rpc-unreachable',
        subject: `the endpoint ${url}`,
        reason: transportReason(failure.cause),
        repair: 'check the --rpc URL and your network, or pass --rpc <another https endpoint>',
        cause: failure.cause ?? 'unknown',
      });
  }
}
