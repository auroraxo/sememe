// Which differences between two decoded argument trees are LAYOUT differences?
//
// Why this file exists (measured 2026-11-09): two verified copies of the same
// program can spell the same field differently — the on-chain copy of
// meteora-damm-v1 says `lpMint`, its published copy says `lp_mint`. The union
// reported that as a LAYOUT DRIFT and listed the fields one by one, so a
// reader was told "the two copies disagree about the data" about a field that
// both copies decoded to the SAME value.
//
// The measurement (tools/measure-drift-naming.mjs, research/drift-naming-2026-11-09.json)
// over every program in the repo that holds two verified copies:
//
//   pump.fun          88 instruction drift rows, 6 account drift rows: all real differences
//   meteora-damm-v1  643 instruction drift rows on the pre-fix tree, ALL of them
//                    NOTHING BUT spelling differences (`inAmount` vs `in_amount`,
//                    `claimFee` vs `claim_fee`) that raw JSON equality turned
//                    into `layout_drift`
//   meteora-damm-v1   11 account drift rows, every row hitting the 20-path cap (220 paths);
//                     33 REAL differences were crowded out by spelling paths
//
// The rule this file applies is the one the declared-layout report already
// states in the README: NAMING STYLE IS NOT A LAYOUT DIFFERENCE. Fields are
// paired by normalised spelling (`_padding0` and `padding0` are the same
// field; `totalAmount` and `total_amount` are the same field), and only a
// difference in the VALUE or in the SHAPE of a paired field is a difference
// in the data.
//
// Two things this file does NOT do:
//
//   * it does not change WHICH source won — arbitration is by bytes, and this
//     file only describes what the disagreement was;
//   * it does not hide the spelling difference — it is reported, in its own
//     list, under `spellingOnly`. The reader learns that the two copies call
//     the same field different things; they just do not get told the two
//     copies disagree about the data when they do not.
//
// A field only one side declares is still a real difference and is still
// reported: pairing by name does not make a missing field present.

/** The bound on how many differences one report lists. */
export const MAX_DRIFT_PATHS = 20;

/**
 * Normalise a field name so that spelling styles pair up:
 * leading underscores are dropped and `snake_case` becomes `camelCase`.
 * `totalAmount` / `total_amount` / `_total_amount` all normalise to
 * `totalAmount`.
 */
export function normaliseFieldName(name) {
  return String(name)
    .replace(/^_+/, '')
    .replace(/_+([a-z0-9])/g, (m, c) => c.toUpperCase());
}

/** Pair two sides' keys by normalised spelling, in declaration order. */
function pairKeys(a, b) {
  const group = (obj) => {
    const map = new Map();
    for (const key of Object.keys(obj)) {
      const nk = normaliseFieldName(key);
      if (!map.has(nk)) map.set(nk, []);
      map.get(nk).push(key);
    }
    return map;
  };
  const aMap = group(a);
  const bMap = group(b);
  const pairs = [];
  const seen = new Set();
  for (const nk of [...aMap.keys(), ...bMap.keys()]) {
    if (seen.has(nk)) continue;
    seen.add(nk);
    const aKeys = aMap.get(nk) ?? [];
    const bKeys = bMap.get(nk) ?? [];
    const n = Math.min(aKeys.length, bKeys.length);
    for (let i = 0; i < n; i += 1) pairs.push({ a: aKeys[i], b: bKeys[i], paired: true });
    for (let i = n; i < aKeys.length; i += 1) pairs.push({ a: aKeys[i], b: null, paired: false });
    for (let i = n; i < bKeys.length; i += 1) pairs.push({ a: null, b: bKeys[i], paired: false });
  }
  return pairs;
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Compare two decoded argument trees.
 *
 * @returns {{
 *   paths: string[],
 *   truncated: boolean,
 *   differs: boolean,
 *   spellingOnly: Array<{ path: string, primary: string, secondary: string }>,
 *   details: Array<Record<string, unknown>>,
 * }}
 *   `paths` are the REAL differences (value or shape), named in the primary's
 *   spelling where the field exists on both sides; `spellingOnly` are the
 *   fields both sides declare under different names. `differs` is the verdict
 *   input: true only when `paths` is non-empty, so a spelling difference can
 *   never make the union say the two copies disagree about the data.
 */
export function diffArgsByNormalisedName(primaryArgs, secondaryArgs, { max = MAX_DRIFT_PATHS } = {}) {
  const paths = [];
  const details = [];
  const spellingOnly = [];
  let truncated = false;

  const push = (path, detail) => {
    if (paths.length >= max) { truncated = true; return; }
    paths.push(path);
    details.push(detail);
  };

  const compareArrays = (a, b, path) => {
    const n = Math.min(a.length, b.length);
    let differing = 0;
    for (let i = 0; i < n; i += 1) {
      if (!sameValue(a[i], b[i])) differing += 1;
    }
    const extra = Math.abs(a.length - b.length);
    if (differing === 0 && extra === 0) return;
    push(path || '(root)', {
      path: path || '(root)',
      kind: 'array',
      primaryLength: a.length,
      secondaryLength: b.length,
      differingElements: differing + extra,
    });
  };

  const walk = (a, b, path) => {
    if (truncated) return;
    if (Array.isArray(a) || Array.isArray(b)) {
      if (Array.isArray(a) && Array.isArray(b)) { compareArrays(a, b, path); return; }
      push(path || '(root)', { path: path || '(root)', kind: 'shape' });
      return;
    }
    if (!isPlainObject(a) || !isPlainObject(b)) {
      if (!sameValue(a, b)) {
        push(path || '(root)', { path: path || '(root)', kind: 'value', primary: a, secondary: b });
      }
      return;
    }
    for (const { a: aKey, b: bKey, paired } of pairKeys(a, b)) {
      if (truncated) return;
      const display = aKey ?? bKey;
      const childPath = path ? `${path}.${display}` : display;
      if (!paired) {
        push(childPath, { path: childPath, kind: 'missing', side: aKey === null ? 'secondary' : 'primary' });
        continue;
      }
      if (aKey !== bKey) {
        // Same field, different spelling. It is still reported as a naming
        // difference; it only counts as a difference in the DATA when the
        // values behind the two names are not the same.
        spellingOnly.push({ path: childPath, primary: aKey, secondary: bKey });
        if (sameValue(a[aKey], b[bKey])) continue;
      }
      walk(a[aKey], b[bKey], childPath);
    }
  };

  walk(primaryArgs, secondaryArgs, '');

  return {
    paths,
    truncated,
    differs: paths.length > 0,
    spellingOnly,
    details,
  };
}
