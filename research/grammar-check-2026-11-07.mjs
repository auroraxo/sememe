// Validate the candidate receipt-name grammar against EVERY receipt name that
// exists in the repo: fixtures, tool outputs, test-built stores. A stray
// classifier that mislabels a REAL receipt would create a new green lie
// (receipt skipped => program "missing"/silently absent), so this must be 0.
import { readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const RX = /^[^-]+-\d+-.+-[a-f0-9]{64}\.json$/;
let n = 0; const bad = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(p); continue; }
    if (!entry.name.endsWith('.json')) continue;
    if (path.basename(path.dirname(p)) !== 'receipts') continue;
    n++;
    if (!RX.test(entry.name)) bad.push(p);
  }
}

for (const root of ['test/fixtures', 'research', 'test']) {
  if (existsSync(root)) walk(root);
}
console.log(`receipt-named .json files checked: ${n}`);
console.log(`unmatched by grammar: ${bad.length}`);
for (const b of bad) console.log('  NOMATCH', b);

// Short/synthetic program ids used in tests (would still pass [^-]+ but let's see)
const seen = new Map();
if (existsSync('test/fixtures')) {
  walk2('test/fixtures');
}
function walk2(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk2(p); continue; }
    if (!entry.name.endsWith('.json')) continue;
    if (path.basename(path.dirname(p)) !== 'receipts') continue;
    const m = /^([^-]+)-(\d+)-/.exec(entry.name);
    if (m) seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
  }
}
console.log('program ids seen in receipt names:');
for (const [id, count] of seen) console.log(`  len=${id.length} count=${count} ${id}`);
void statSync;
