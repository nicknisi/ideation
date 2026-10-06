import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateBrief, briefFingerprint, workPacket } from './change-brief.mjs';
const fixture = JSON.parse(readFileSync(new URL('../test-fixtures/native-change/brief.json', import.meta.url), 'utf8'));
const fresh = () => structuredClone(fixture);

test('normalizes defaults into an independent clone; preserves exact command strings', () => {
  const raw = fresh();
  delete raw.units[0].needs; delete raw.decisions; delete raw.outOfScope; delete raw.delegated;
  const b = validateBrief(raw);
  assert.equal(b.executionMode, 'strict');
  assert.deepEqual(b.units[0].needs, []);
  assert.deepEqual(b.decisions, []);
  assert.equal(b.authority.maxDurationMs, 1800000);
  assert.equal(b.authority.maxStageMs, 300000);
  assert.equal(b.authority.maxTokens, 200000);
  assert.equal(b.authority.maxAttempts, 2);
  assert.equal(b.authority.maxReviewCycles, 3);
  assert.equal(b.authority.maxTurns, 40);
  assert.equal(b.authority.maxToolCalls, 200);
  assert.equal(b.authority.allowLocalCommit, true);
  b.mustHold.push('changed'); assert.equal(raw.mustHold.length, 2);
  raw.acceptance[0].check.cmd = ' node --test scripts/change-render.test.mjs ';
  raw.authority.commands = [raw.acceptance[0].check.cmd];
  assert.equal(validateBrief(raw).acceptance[0].check.cmd, raw.authority.commands[0]);
});

const invalid = [
  ['unknown root', b => { b.extra = 1; }],
  ['schema', b => { b.schemaVersion = 2; }],
  ['id', b => { b.id = '../brief'; }],
  ['title', b => { b.title = ' '; }],
  ['revision', b => { b.revision = 0; }],
  ['why', b => { b.why = null; }],
  ['change unknown', b => { b.change.extra = true; }],
  ['empty invariants', b => { b.mustHold = []; }],
  ['non-string invariant', b => { b.mustHold = [123]; }],
  ['decision unknown', b => { b.decisions[0].accepted = true; }],
  ['decision rejected type', b => { b.decisions[0].rejected = []; }],
  ['empty criteria', b => { b.acceptance = []; }],
  ['criterion unknown', b => { b.acceptance[0].status = 'passed'; }],
  ['duplicate criteria', b => { b.acceptance[1].id = b.acceptance[0].id; }],
  ['check string', b => { b.acceptance[0].check = 'node test.js'; }],
  ['mixed check', b => { b.acceptance[0].check.judgment = 'look'; }],
  ['empty check', b => { b.acceptance[0].check = {}; }],
  ['unknown check', b => { b.acceptance[0].check.approved = true; }],
  ['bad shell', b => { b.acceptance[0].check.cmd = 'if'; }],
  ['background shell', b => { b.acceptance[0].check.cmd = 'node a.js &'; }],
  ['command not authorized', b => { b.authority.commands = []; }],
  ['not exact command', b => { b.authority.commands[0] += ' '; }],
  ['empty units', b => { b.units = []; }],
  ['unknown unit', b => { b.units[0].files = []; }],
  ['duplicate units', b => { b.units.push(structuredClone(b.units[0])); }],
  ['risk', b => { b.units[0].risk = 'urgent'; }],
  ['high risk needs design', b => { b.units[0].risk = 'high'; }],
  ['dangling need', b => { b.units[0].needs = ['absent']; }],
  ['self-cycle', b => { b.units[0].needs = ['render']; }],
  ['unknown criterion', b => { b.units[0].acceptanceIds = ['absent']; }],
  ['unassociated criterion', b => { b.units[0].acceptanceIds.pop(); }],
  ['duplicate ref', b => { b.units[0].acceptanceIds.push('readability'); }],
  ['empty refs', b => { b.units[0].acceptanceIds = []; }],
  ['execution mode', b => { b.executionMode = 'YOLO'; }],
  ['null execution mode', b => { b.executionMode = null; }],
  ['null optional array', b => { b.delegated = null; }],
  ['null decisions', b => { b.decisions = null; }],
  ['null needs', b => { b.units[0].needs = null; }],
  ['authority unknown', b => { b.authority.push = true; }],
  ['commit boolean', b => { b.authority.allowLocalCommit = 'true'; }],
  ['duration minimum', b => { b.authority.maxDurationMs = 999; }],
  ['duration maximum', b => { b.authority.maxDurationMs = 86400001; }],
  ['stage exceeds duration', b => { b.authority.maxStageMs = 1800001; }],
  ['zero stage', b => { b.authority.maxStageMs = 0; }],
  ['negative tokens', b => { b.authority.maxTokens = -1; }],
  ['fractional attempts', b => { b.authority.maxAttempts = 1.5; }],
  ['too many attempts', b => { b.authority.maxAttempts = 4; }],
  ['too many reviews', b => { b.authority.maxReviewCycles = 4; }],
  ['too many turns', b => { b.authority.maxTurns = 101; }],
  ['too many tools', b => { b.authority.maxToolCalls = 1001; }],
  ['unsafe integer', b => { b.authority.maxTokens = Infinity; }],
  ['null budget', b => { b.authority.maxTokens = null; }],
];
for (const [name, mutate] of invalid) test(`rejects ${name}`, () => { const b = fresh(); mutate(b); assert.throws(() => validateBrief(b), TypeError); });
for (const p of ['../src/', '/tmp/a', 'C:/tmp/a', 'C:\\tmp\\a', './src/', 'src/../a', 'src//a', 'src\\a', 'src/./a', '.git/config', '.pi/', '.ideation-policy.mjs', 'docs/ideation/.native/run/', 'package.json', 'sub/pnpm-lock.yaml', 'src/\nfile']) {
  test(`rejects unsafe path ${JSON.stringify(p)}`, () => { const b = fresh(); b.authority.paths = [p]; assert.throws(() => validateBrief(b)); });
}
test('accepts exact files, directory prefixes and ordinary-project wildcard', () => {
  const b = fresh(); b.authority.paths = ['.', 'src/', 'src/a file.mjs'];
  assert.deepEqual(validateBrief(b).authority.paths, b.authority.paths);
});
test('validates multi-unit DAGs, cycles and duplicate edges', () => {
  const b = fresh();
  b.units.push({ ...structuredClone(b.units[0]), id: 'follow-up', needs: ['render'], risk: 'high', design: 'Inspect current behavior, implement a compatible change, test failure paths and review the diff.' });
  assert.equal(validateBrief(b).units.length, 2);
  b.units[0].needs = ['follow-up']; assert.throws(() => validateBrief(b), /cycle/);
  b.units[0].needs = []; b.units[1].needs.push('render'); assert.throws(() => validateBrief(b), /duplicate/);
});
test('fingerprints are stable across property order and explicit defaults, sensitive to scope and revision', () => {
  const b = fresh();
  const hash = briefFingerprint(b);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(briefFingerprint(Object.fromEntries(Object.entries(b).reverse())), hash);
  assert.equal(briefFingerprint(validateBrief(b)), hash);
  for (const mutate of [b => b.revision++, b => b.authority.paths.push('other/'), b => b.change.after += '!', b => b.mustHold.reverse()]) {
    const changed = fresh(); mutate(changed); assert.notEqual(briefFingerprint(changed), hash);
  }
});
test('standalone JIT packet uses existing executor headings and complete shared constraints', () => {
  const b = fresh();
  b.acceptance.push({ id: 'later', criterion: 'Later check', check: { judgment: 'Later review' } });
  b.units.push({ ...b.units[0], id: 'later', acceptanceIds: ['later'], needs: ['render'] });
  const packet = workPacket(b, { id: 'render', goal: 'DO NOT TRUST STALE UNIT' }, { plan: 'Read the current renderer, implement escaping, then run the exact check.', sourceRevision: 'source-123' });
  for (const heading of ['Technical Approach','File Changes','Implementation Details','Testing Requirements','Validation Commands','Decisions Considered and Rejected']) assert.ok(packet.includes(`## ${heading}`));
  for (const text of [...b.mustHold, ...b.outOfScope, ...b.delegated, b.change.before, b.change.after, b.why, b.authority.commands[0], 'source-123', briefFingerprint(b), 'Human judgment pending', 'Host owns staging']) assert.ok(packet.includes(text), text);
  assert.ok(!packet.includes('Later check'));
  assert.ok(!packet.includes('DO NOT TRUST STALE UNIT'));
  assert.throws(() => workPacket(b, 'missing', { plan: 'x', sourceRevision: 'x' }));
  assert.throws(() => workPacket(b, 'render'));
});
test('packet fences cannot be terminated by command content', () => {
  const b = fresh(); b.acceptance[0].check.cmd = "printf '%s' '```'"; b.authority.commands = [b.acceptance[0].check.cmd];
  const packet = workPacket(b, 'render', { plan: 'Implement.', sourceRevision: 'abc' });
  assert.ok(packet.includes("````sh\nprintf '%s' '```'\n````"));
});

test('shell syntax results are cached: invalid commands still fail every time, valid briefs re-validate cheaply', () => {
  const bad = fresh();
  bad.acceptance[0].check = { cmd: 'if then fi (' };
  for (let i = 0; i < 2; i++) assert.throws(() => validateBrief(bad), /not valid shell/);
  const b = fresh();
  validateBrief(b);
  const start = performance.now();
  for (let i = 0; i < 50; i++) briefFingerprint(b);
  assert.ok(performance.now() - start < 1000, 'repeat fingerprints do not spawn a shell per command');
});
