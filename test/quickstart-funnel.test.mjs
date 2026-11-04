// The README quickstart is the product's entire stranger funnel: the one
// copy-paste command a foreign developer is asked to run before adopting
// sememe. That makes the quickstart section a CONTRACT, not prose:
//
//   T1  the first fenced bash block of the quickstart runs verbatim, from a
//       plain checkout, with no npm install, and passes;
//   T2  the output the README documents is byte-identical to the output the
//       tool actually prints on this tree (measured drift on 2026-11-05: the
//       documented line was the 2026-11-04 schema and lacked the counters the
//       tool prints since the rpc-response/flat ingest work — a stranger
//       comparing her terminal to the README saw two different products);
//   T3  the multi-program numbers quoted in prose are the numbers the tool
//       measures on this tree;
//   T4  a hand-edited README example goes red — the pin is not decorative.
//
// The test executes ONLY tokens from an allowlist (the tool path, --flags,
// test/fixtures paths and numbers), so a hand-edited README can never make
// this suite run something else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function quickstartSection() {
  const md = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const start = md.indexOf('## Quickstart');
  assert.ok(start >= 0, 'README must keep a "## Quickstart" section');
  const next = md.indexOf('\n## ', start + 5);
  return md.slice(start, next === -1 ? md.length : next);
}

function firstBashCommand(section) {
  const fence = section.indexOf('```bash');
  assert.ok(fence >= 0, 'quickstart must carry a bash block');
  const body = section.slice(fence + 7, section.indexOf('```', fence + 7));
  // Join shell line continuations: the quickstart command spans several
  // lines with trailing backslashes.
  const joined = body.replace(/\\\s*\n\s*/g, ' ');
  const lines = joined.split('\n').map((line) => line.trim()).filter(Boolean);
  assert.equal(lines.length, 2, `quickstart bash block must stay 2 commands (clone + run), found ${lines.length}`);
  assert.match(lines[0], /^git clone https:\/\/github\.com\/auroraxo\/sememe && cd sememe$/);
  return lines[1];
}

/** Run the given tokens with the allowlist enforced. Returns stdout (memoized). */
const stdoutCache = new Map();
function runQuickstart(tokens) {
  const key = tokens.join(' ');
  if (stdoutCache.has(key)) return stdoutCache.get(key);
  assert.ok(Array.isArray(tokens) && tokens[0] === 'node' && tokens[1] === 'tools/stranger-decode.mjs',
    `quickstart must run tools/stranger-decode.mjs, found ${tokens?.slice(0, 2)}`);
  const allowedFlags = new Set(['--store', '--harvest', '--sample', '--rpc-response', '--fixtures-dir', '--limit', '--absent', '--out']);
  for (let i = 2; i < tokens.length; i += 1) {
    const token = tokens[i];
    const ok = token.startsWith('--') ? allowedFlags.has(token) : /^[A-Za-z0-9._/-]+$/.test(token);
    assert.ok(ok, `quickstart token outside the allowlist: ${JSON.stringify(token)}`);
  }
  const stdout = execFileSync('node', ['tools/stranger-decode.mjs', ...tokens.slice(2)], {
    cwd: ROOT, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
  });
  stdoutCache.set(key, stdout);
  return stdout;
}

function tokenize(commandLine) {
  return commandLine.replace(/\\\s*/g, ' ').split(/\s+/).filter(Boolean);
}

test('T1: the README quickstart command runs verbatim from this checkout and passes', () => {
  const command = firstBashCommand(quickstartSection());
  const stdout = runQuickstart(tokenize(command));
  const summary = JSON.parse(stdout);
  assert.equal(summary.status, 'pass');
  assert.equal(summary.decoded, summary.payloadsChecked);
  assert.equal(summary.decodeErrors, 0);
  assert.equal(summary.disagreements, 0);
  assert.equal(summary.networkAttempts, 0);
});

test('T2: the documented quickstart output line is byte-identical to the tool stdout', () => {
  const section = quickstartSection();
  const documented = section.match(/\{"status":"pass".*?\}/);
  assert.ok(documented, 'quickstart must document one exact output line');
  const command = firstBashCommand(section);
  const stdout = runQuickstart(tokenize(command));
  assert.equal(stdout.trim(), documented[0].trim(),
    'README quickstart output drifted from what the tool prints — update the documented line to the real stdout');
});

test('T3: the documented multi-program numbers are the numbers this tree measures', () => {
  const section = quickstartSection();
  const quoted = section.match(/([\d,]+) checked transactions, ([\d,]+) payloads, ([\d,]+) decoded/);
  assert.ok(quoted, 'quickstart prose must quote the multi-program run numbers');
  const fences = [...section.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1].replace(/\\\s*\n\s*/g, ' ').trim());
  const sampleFence = fences.find((f) => f.includes('--sample'));
  assert.ok(sampleFence, 'quickstart must contain the --sample command in a bash fence');
  const summary = JSON.parse(runQuickstart(tokenize(sampleFence)));
  const clean = (s) => Number(String(s).replace(/,/g, ''));
  assert.equal(summary.transactionsChecked, clean(quoted[1]));
  assert.equal(summary.payloadsChecked, clean(quoted[2]));
  assert.equal(summary.decoded, clean(quoted[3]));
  assert.equal(summary.decodeErrors, 0);
  assert.equal(summary.disagreements, 0);
});

test('T4: a hand-edited documented output line goes red (guard is not decorative)', () => {
  const section = quickstartSection();
  const documented = section.match(/\{"status":"pass".*?\}/);
  assert.ok(documented, 'documented line present');
  const real = documented[0];
  const tampered = real.replace(/"decoded":(\d+)/, (_, n) => `"decoded":${Number(n) + 1}`);
  assert.notEqual(tampered, real);
  const command = firstBashCommand(section);
  const stdout = runQuickstart(tokenize(command)).trim();
  assert.notEqual(stdout, tampered, 'the tool must not agree with a hand-edited README');
  assert.equal(stdout, real, 'and it must still agree with the true documented line');
});
