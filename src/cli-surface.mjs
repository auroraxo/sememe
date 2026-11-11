// The CLI's DECLARED surface: which flags each command accepts and how many
// positional arguments it consumes.
//
// Why this file exists (measured 2026-11-06, on the working tree at 641b895):
//
// The CLI parsed flags by SEARCHING the argument list for a name and taking
// whatever came next. A flag the command does not know was therefore not an
// error — it was silently discarded, and so was every extra positional
// argument. The consequences were measured on the real CLI:
//
//   sememe lock --store <valid> --o out.lock
//     -> exit 0, a lock written to ./sememe.lock, NOT to out.lock.
//        The caller asked for a file at one path and got a file at another,
//        with a success exit code.
//   sememe decode <prog> <payload> --stro ./store
//     -> exit 1, "no sememe store at /home/<user>/.sememe": the typo'd
//        --store was dropped and the DEFAULT store was used instead.
//   sememe verify --store <valid> --lock <valid> --mod warn
//     -> --mod dropped; verify ran in its default error mode.
//   sememe native-provenance --store <dir>
//     -> "--store is not a native program sememe pins": the flag's VALUE was
//        read as the program id.
//   sememe decode --store <valid> <prog> <payload>
//     -> "no sememe store at /home/<user>/.sememe": with a flag in the
//        program slot, the STORE PATH was read as the payload and the
//        program id as the store.
//   sememe pull <prog> --stor <dir>
//     -> the typo was dropped and the pull RAN against the default store:
//        a write the caller never asked for.
//   sememe decode <prog> <payload> --store A --store B
//     -> A was used, B was silently ignored.
//
// A parser error here is a silent change of WHAT gets read, signed, pinned or
// written. The rule this file implements is the one the repository already
// applies to stores, receipts and locks: an unrecognized input is REFUSED BY
// NAME, never tolerated.
//
// Two deliberate properties:
//
//   - The check runs BEFORE any command does work. No store is read, no file
//     is written, no RPC is contacted, no key is touched. A refusal must not
//     have a side effect.
//   - The refusal NAMES THE REPAIR: the offending flag, the closest supported
//     flag (measured by edit distance), and the full supported list. "unknown
//     flag" alone is a verdict, not a repair.
//
// The table is DATA, not code paths, so it can be read and pinned. The CLI
// dispatch reads it; nothing else may add a flag to a command without adding
// it here, which is exactly the drift this file exists to make visible.

/** A refusal about the SHAPE of the invocation, not about what it produced. */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.code = 'usage';
  }
}

/**
 * The per-command surface.
 *
 *   flags        the flags the command accepts; 'value' takes the next token,
 *                'boolean' stands alone
 *   positionals  how many positional arguments the command consumes, either a
 *                fixed count or [min, max] for an optional one
 *   positionalNames  the names used in the refusal message
 *   extraMessage a command-specific refusal for a surplus positional argument
 *                (lock/verify have their own wording, and it has been the
 *                product's wording since the lock shipped)
 */
export const COMMAND_SPECS = {
  'absent-help': { flags: {}, positionals: 0 },
  pull: {
    flags: { '--store': 'value', '--rpc': 'value' },
    positionals: 1,
    positionalNames: ['program id'],
  },
  gap: {
    flags: { '--rpc': 'value' },
    positionals: 1,
    positionalNames: ['program id'],
  },
  lock: {
    flags: { '--store': 'value', '--out': 'value' },
    positionals: 0,
    extraMessage: (extras) => `lock takes no program id — it snapshots the whole store; got "${extras[0]}"`,
  },
  verify: {
    flags: { '--store': 'value', '--lock': 'value', '--mode': 'value' },
    positionals: 0,
    extraMessage: (extras) => `verify takes no program id — it checks the whole lock; got "${extras[0]}"`,
  },
  adopt: {
    flags: { '--store': 'value', '--source': 'value', '--origin': 'value' },
    positionals: 2,
    positionalNames: ['program id', 'interface file'],
  },
  decode: {
    flags: { '--store': 'value', '--trailing': 'value', '--absent': 'value', '--union': 'boolean' },
    positionals: 2,
    positionalNames: ['program id', 'payload'],
  },
  conform: {
    flags: { '--store': 'value', '--only': 'value' },
    positionals: 1,
    positionalNames: ['transaction file'],
  },
  'decode-native': {
    flags: { '--trailing': 'value' },
    positionals: 2,
    positionalNames: ['program id', 'payload'],
  },
  'native-provenance': {
    flags: {},
    positionals: [0, 1],
    positionalNames: ['program id'],
  },
  'decode-token': {
    flags: { '--trailing': 'value' },
    positionals: 2,
    positionalNames: ['program id', 'payload'],
  },
  'token-provenance': {
    flags: {},
    positionals: [0, 1],
    positionalNames: ['program id'],
  },
  'raydium-provenance': {
    flags: {},
    positionals: [0, 1],
    positionalNames: ['program id'],
  },
  'decode-raydium': {
    flags: { '--trailing': 'value' },
    positionals: 2,
    positionalNames: ['program id', 'payload'],
  },
  'decode-ata': {
    flags: { '--trailing': 'value', '--empty': 'boolean' },
    positionals: [1, 2],
    positionalNames: ['program id', 'payload'],
  },
  'ata-provenance': {
    flags: {},
    positionals: [0, 1],
    positionalNames: ['program id'],
  },
  account: {
    flags: { '--store': 'value', '--name': 'value', '--trailing': 'value', '--union': 'boolean' },
    positionals: 2,
    positionalNames: ['program id', 'account data'],
  },
};

/** The command names this CLI knows, in the order the usage text lists them. */
export const COMMAND_NAMES = Object.keys(COMMAND_SPECS);

/** Levenshtein distance — enough to suggest a flag, not a spellchecker. */
export function editDistance(a, b) {
  const s = String(a);
  const t = String(b);
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    const cur = [i];
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[t.length];
}

/**
 * The closest supported flag, when one is close enough to be a plausible
 * typo. "Close enough" is measured, not guessed: within two edits, or within
 * a quarter of the flag's own length.
 *
 * The quarter rule matters: the flag `--absent-help` is three edits away from
 * the flag `--absent`, but it is not a typo of it — it is a COMMAND name with a
 * prefix — so a distance of three must NOT produce a suggestion. Two edits is
 * the line.
 */
export function closestFlag(flag, supported) {
  const target = String(flag);
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of supported) {
    const distance = editDistance(target, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  if (best === null) return null;
  const limit = Math.max(2, Math.floor(target.length / 4));
  return bestDistance <= limit ? best : null;
}

/**
 * The refusal for a flag the command does not accept.
 *
 * The supported list appears exactly ONCE. Measured on the published
 * v0.4.7 install 2026-11-07 (a defect found by running the README examples
 * verbatim against the packed tarball, not by a unit test): the first
 * version printed the list in the no-suggestion clause AND again at the end,
 * so `decode … --rpc` printed the same four flags twice in one line.
 */
export function unknownFlagMessage(command, flag, supported) {
  const suggestion = closestFlag(flag, supported);
  if (suggestion) {
    return `sememe ${command}: unknown flag "${flag}" — did you mean "${suggestion}"? supported flags: ${supported.join(', ')}`;
  }
  if (!supported.length) {
    return `sememe ${command}: unknown flag "${flag}" — this command accepts no flags`;
  }
  return `sememe ${command}: unknown flag "${flag}" — supported flags: ${supported.join(', ')}`;
}

/** The refusal for a surplus positional argument. */
export function extraPositionalMessage(command, extras, spec) {
  if (typeof spec?.extraMessage === 'function') return spec.extraMessage(extras);
  const expected = Array.isArray(spec?.positionals) ? spec.positionals[1] : spec?.positionals;
  const names = (spec?.positionalNames ?? []).join(', ');
  return `sememe ${command} takes ${expected} positional argument${expected === 1 ? '' : 's'}`
    + `${names ? ` (${names})` : ''}; got ${expected + extras.length} — extra: ${extras.map((e) => JSON.stringify(e)).join(', ')}`;
}

/**
 * Parse one command's arguments against its spec.
 *
 * Returns { flags, positionals }. Throws UsageError for anything the command
 * does not declare. The order of the checks is the point:
 *
 *   1. every flag is checked FIRST, before any value is consumed — so a
 *      typo'd flag is refused as a typo, not silently reinterpreted as
 *      something else;
 *   2. a flag that needs a value but has none is refused naming the flag;
 *   3. a flag given twice is refused: the second value would otherwise be
 *      silently dropped, and the caller would believe the LAST one won
 *      (it does not — the FIRST one wins, which is the worse surprise);
 *   4. only then is the positional count checked.
 *
 * A command this CLI does not know is NOT an error here: the caller prints
 * the usage text for it, which is the product's existing behaviour.
 */
export function parseCommandArgs(command, tokens) {
  const spec = COMMAND_SPECS[command];
  if (!spec) return { flags: {}, positionals: [] };
  const supported = Object.keys(spec.flags);
  const flags = {};
  const positionals = [];
  const list = Array.isArray(tokens) ? tokens : [];

  for (let i = 0; i < list.length; i++) {
    const token = list[i];
    if (typeof token !== 'string' || !token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const kind = spec.flags[token];
    if (!kind) throw new UsageError(unknownFlagMessage(command, token, supported));
    if (Object.prototype.hasOwnProperty.call(flags, token)) {
      throw new UsageError(`sememe ${command}: flag "${token}" given more than once — pass it once`);
    }
    if (kind === 'boolean') {
      flags[token] = true;
      continue;
    }
    const value = list[i + 1];
    if (value === undefined || (typeof value === 'string' && value.startsWith('--'))) {
      throw new UsageError(`sememe ${command}: missing value for ${token}`);
    }
    flags[token] = value;
    i++;
  }

  const [min, max] = Array.isArray(spec.positionals)
    ? spec.positionals
    : [spec.positionals, spec.positionals];
  if (positionals.length > max) {
    throw new UsageError(extraPositionalMessage(command, positionals.slice(max), spec));
  }
  if (positionals.length < min) {
    // Too FEW positionals is the command's own business: every command
    // already refuses with its own wording ("decode needs a program id"),
    // and that wording is pinned by other tests. Only the surplus case is
    // decided here.
    return { flags, positionals };
  }
  return { flags, positionals };
}
