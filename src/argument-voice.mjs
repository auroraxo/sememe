// src/argument-voice.mjs — ONE classification place for the arguments a
// caller FORGOT or got WRONG.
//
// WHY THIS FILE EXISTS (measured 2026-11-18, this tree at 55a5114 = the
// published sememe@0.4.37; the same faces were observed verbatim on the
// published package):
//
// Every other input sememe touches had learned to refuse by name — the flag
// (src/cli-surface.mjs), the file (src/file-input.mjs), the store directory
// (src/store-input.mjs), the damage inside it (src/store-damage.mjs), the
// lock gate (src/lock-voice.mjs), the answers (src/store-answer.mjs), the
// endpoint (src/acquire-voice.mjs). The ARGUMENT the caller forgot was the
// one input class still answering as bare prose:
//
//   sememe decode
//     -> {"error":"decode needs a program id"} exit 1
//   sememe decode <program>
//     -> {"error":"decode needs an instruction payload"} exit 1
//   sememe decode --trailing bogus <program> <payload>
//     -> {"error":"--trailing must be \"report\" or \"error\""} exit 1
//   sememe pull
//     -> {"error":"pull needs a program id"} exit 1
//
// Three measurable faults in one answer:
//
//   1. NO NAME. A script cannot branch on "you called me wrong" — there is
//      no code, only prose.
//   2. NO REPAIR. The sentence says what is missing but never what to run;
//      the other six classifiers all carry a `fix:` line.
//   3. THE WRONG CHANNEL. A forgotten argument is not "the work failed". It
//      shared exit 1 with a real refusal (a drifted store, a tampered
//      receipt), so a CI script could not tell "you called me wrong" from
//      "the store drifted" without parsing prose. The product already
//      reserves exit 2 for an invocation that cannot be what the caller
//      meant (src/cli-surface.mjs refuses an unknown flag, a flag given
//      twice and a flag without a value there) — this is that same class.
//
// THE CONTRACT:
//
//   missing   the required argument was not given
//   invalid   the argument WAS given, and its value is not one the command
//             accepts
//   conflict  the arguments contradict each other
//
//   Each becomes a named code that says WHICH argument it is (the subject),
//   a sentence that keeps the command's OWN wording, and a REPAIR line — the
//   command the caller should run. The sentence stays verbatim in front:
//   several tests and the README quote it ("decode needs a program id"),
//   and the code is appended in parentheses, exactly as src/file-input.mjs
//   does.
//
//   THE CHANNEL: every face here is a caller mistake about the INVOCATION:
//   nothing was read, nothing was written, no RPC was contacted. They take
//   the usage channel (exit 2), the channel the product already reserves
//   for an invocation that cannot be what the caller meant. A refusal about
//   the WORK (a drifted store, a damaged receipt, a transaction that does
//   not conform) keeps exit 1 — this file does not move it.
//
// WHAT IS NOT HERE (measured, not assumed):
//
//   * a flag this command does not accept, a flag given twice, a flag
//     without a value — src/cli-surface.mjs already refuses those by name
//     (exit 2, plain text, the closest supported flag).
//   * a surplus positional argument — src/cli-surface.mjs already refuses
//     it by name.
//   * `conform --only <not-a-program-id>` — the conformance gate already
//     names that refusal (`filter-is-not-a-program-id`) and its channel is
//     pinned by test/conformance-filter-domain.test.mjs (exit 1). It is
//     measured as a CONTROL by tools/measure-argument-voice.mjs, not
//     changed here.
//   * the vendored-program refusals ("… publishes no interface to pull",
//     "… is not a token program sememe pins") — those are statements about
//     the PROGRAM, not about the invocation, and they name their subject
//     and the command to use instead.
//
// The codes are DATA, not code paths, so the table can be read and pinned:
// a command cannot grow an argument without appearing here.

/** A refusal about the SHAPE of the invocation, not about what it produced. */
export class ArgumentRefusal extends Error {
  constructor(message, { code, fix, exitCode = 2, argument }) {
    super(message);
    this.name = 'ArgumentRefusal';
    this.code = code;
    this.fix = fix;
    this.exitCode = exitCode;
    this.argument = argument;
  }
}

/**
 * The argument faces of the CLI: one row per argument a command can be
 * called wrong about.
 *
 *   code      the product's name for this fault. It says WHICH argument it
 *             is, so a script can branch on the argument and not on the
 *             command.
 *   message   the command's OWN sentence, verbatim, with the code appended
 *             in parentheses — the sentences other tools quote keep their
 *             place.
 *   fix       the repair the operator can act on: the command to run.
 */
export const ARGUMENT_FACES = {
  'pull:program-id': {
    code: 'pull-program-id-missing',
    kind: 'missing',
    message: 'pull needs a program id',
    fix: 'pass the program id as the first argument: sememe pull <program-id>',
  },
  'gap:program-id': {
    code: 'gap-program-id-missing',
    kind: 'missing',
    message: 'gap needs a program id',
    fix: 'pass the program id as the first argument: sememe gap <program-id>',
  },
  'adopt:program-id': {
    code: 'adopt-program-id-missing',
    kind: 'missing',
    message: 'adopt needs a program id',
    fix: 'pass the program id as the first argument: sememe adopt <program-id> <interface-file>',
  },
  'adopt:interface-file': {
    code: 'adopt-interface-file-missing',
    kind: 'missing',
    message: 'adopt needs the interface file to store',
    fix: 'pass the interface file as the second argument: sememe adopt <program-id> <interface-file>',
  },
  'decode:program-id': {
    code: 'decode-program-id-missing',
    kind: 'missing',
    message: 'decode needs a program id',
    fix: 'pass the program id as the first argument: sememe decode <program-id> <payload>',
  },
  'decode:payload': {
    code: 'decode-payload-missing',
    kind: 'missing',
    message: 'decode needs an instruction payload',
    fix: 'pass the instruction payload as the second argument: sememe decode <program-id> <payload>',
  },
  'decode:trailing': {
    code: 'decode-trailing-invalid',
    kind: 'invalid',
    message: '--trailing must be "report" or "error"',
    fix: 'pass --trailing report or --trailing error',
  },
  'decode:absent': {
    code: 'decode-absent-invalid',
    kind: 'invalid',
    message: '--absent must be "error", "report" or "verified"',
    fix: 'pass --absent error, --absent report or --absent verified',
  },
  'decode-native:trailing': {
    code: 'decode-native-trailing-invalid',
    kind: 'invalid',
    message: '--trailing must be "report" or "error"',
    fix: 'pass --trailing report or --trailing error',
  },
  'decode-token:trailing': {
    code: 'decode-token-trailing-invalid',
    kind: 'invalid',
    message: '--trailing must be "report" or "error"',
    fix: 'pass --trailing report or --trailing error',
  },
  'decode-raydium:trailing': {
    code: 'decode-raydium-trailing-invalid',
    kind: 'invalid',
    message: '--trailing must be "report" or "error"',
    fix: 'pass --trailing report or --trailing error',
  },
  'decode-ata:trailing': {
    code: 'decode-ata-trailing-invalid',
    kind: 'invalid',
    message: '--trailing must be "report" or "error"',
    fix: 'pass --trailing report or --trailing error',
  },
  'conform:transaction-file': {
    code: 'conform-transaction-file-missing',
    kind: 'missing',
    message: 'conform needs a transaction JSON file',
    fix: 'pass the transaction JSON file as the first argument: sememe conform <transaction-file>',
  },
  'decode-native:program-id': {
    code: 'decode-native-program-id-missing',
    kind: 'missing',
    message: 'decode-native needs a program id',
    fix: 'pass the program id as the first argument: sememe decode-native <program-id> <payload>',
  },
  'decode-native:payload': {
    code: 'decode-native-payload-missing',
    kind: 'missing',
    message: 'decode-native needs an instruction payload',
    fix: 'pass the instruction payload as the second argument: sememe decode-native <program-id> <payload>',
  },
  'decode-token:program-id': {
    code: 'decode-token-program-id-missing',
    kind: 'missing',
    message: 'decode-token needs a program id',
    fix: 'pass the program id as the first argument: sememe decode-token <program-id> <payload>',
  },
  'decode-token:payload': {
    code: 'decode-token-payload-missing',
    kind: 'missing',
    message: 'decode-token needs an instruction payload',
    fix: 'pass the instruction payload as the second argument: sememe decode-token <program-id> <payload>',
  },
  'decode-raydium:program-id': {
    code: 'decode-raydium-program-id-missing',
    kind: 'missing',
    message: 'decode-raydium needs a program id',
    fix: 'pass the program id as the first argument: sememe decode-raydium <program-id> <payload>',
  },
  'decode-raydium:payload': {
    code: 'decode-raydium-payload-missing',
    kind: 'missing',
    message: 'decode-raydium needs an instruction payload',
    fix: 'pass the instruction payload as the second argument: sememe decode-raydium <program-id> <payload>',
  },
  'decode-ata:program-id': {
    code: 'decode-ata-program-id-missing',
    kind: 'missing',
    message: 'decode-ata needs a program id',
    fix: 'pass the program id as the first argument: sememe decode-ata <program-id> <payload>',
  },
  'decode-ata:payload': {
    code: 'decode-ata-payload-missing',
    kind: 'missing',
    message: 'decode-ata needs an instruction payload',
    fix: 'pass the instruction payload as the second argument, or --empty for the empty-input Create fallback: sememe decode-ata <program-id> <payload>',
  },
  'decode-ata:payload-conflict': {
    code: 'decode-ata-payload-conflict',
    kind: 'conflict',
    message: 'decode-ata: give a payload or --empty, not both',
    fix: 'pass the payload OR --empty, not both',
  },
  'account:program-id': {
    code: 'account-program-id-missing',
    kind: 'missing',
    message: 'account needs a program id',
    fix: 'pass the program id as the first argument: sememe account <program-id> <account-data>',
  },
  'account:account-data': {
    code: 'account-account-data-missing',
    kind: 'missing',
    message: 'account needs the account data (base64 or hex)',
    fix: 'pass the account data as the second argument: sememe account <program-id> <account-data>',
  },
  'account:trailing': {
    code: 'account-trailing-invalid',
    kind: 'invalid',
    message: '--trailing must be "report" or "error"',
    fix: 'pass --trailing report or --trailing error',
  },
  'verify:mode': {
    code: 'verify-mode-invalid',
    kind: 'invalid',
    message: '--mode must be "error" or "warn"',
    fix: 'pass --mode error or --mode warn',
  },
};

/** True for a code this module minted. Used by the CLI to tell a NAMED
 *  argument refusal from an ordinary error, without matching on prose. */
export function isArgumentCode(code) {
  return typeof code === 'string'
    && /^[a-z][a-z0-9-]*-(missing|invalid|conflict)$/.test(code);
}

/**
 * Mint the refusal for one argument face.
 *
 * The message keeps the command's own sentence and appends the code in
 * parentheses — the same shape src/file-input.mjs uses, so a reader (and a
 * leak detector) sees one pattern across the product's refusals.
 */
export function argumentRefusal(faceKey) {
  const face = ARGUMENT_FACES[faceKey];
  if (!face) {
    throw new Error(`unknown argument face "${faceKey}" — the face must be declared in ARGUMENT_FACES`);
  }
  const error = new ArgumentRefusal(`${face.message} (${face.code})`, {
    code: face.code,
    fix: `fix: ${face.fix}`,
    exitCode: 2,
    argument: faceKey,
  });
  error.kind = face.kind;
  return error;
}
