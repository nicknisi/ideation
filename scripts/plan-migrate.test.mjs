import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBrief } from '../workflows/change-brief.mjs';
import { GATE_KEYS, MAX_CLAIMS, MAX_DEPTH } from '../schemas/plan.ts';
import { toRunContract, validate } from './plan-data.ts';
import { normalizeCriterion } from './verify.mjs';
import { CARRIED, DROPPED, migrate, migrateFolder, readFolder } from './plan-migrate.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// Found at test time, so a newly committed contract or brief is covered without editing this file.
const committed = pattern => execFileSync('git', ['ls-files', pattern], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
const CONTRACTS = committed('*contract-data.json');
const BRIEFS = committed('*brief.json');
const readJson = path => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
const orchestration = () => readJson('test-fixtures/orchestration/contract-data.json');

/** Every leaf of a JSON value as [path, value]; array items share the path `[]`. */
function* leaves(value, path) {
  if (Array.isArray(value)) for (const v of value) yield* leaves(v, `${path}[]`);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) yield* leaves(v, `${path}.${k}`);
  else yield [path, value];
}
const isDropped = path => DROPPED.some(d => path === d.path || path.startsWith(`${d.path}.`) || path.startsWith(`${d.path}[`));
/** Every string and key in the plan. */
const planText = v => Array.isArray(v) ? v.flatMap(planText)
  : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...planText(x)])
  : typeof v === 'string' ? [v] : [];
// Converted, not copied, so their text isn't in the plan; each has its own assertion below.
const CONVERTED = new Set(['contractData.gates.dimensions[].status', 'contractData.successCriteria[].check']);

/** Fails naming every input field that is neither carried nor dropped, and every carried string the plan lost. */
function assertCovered(inputs, plan) {
  const text = new Set(planText(plan));
  const unaccounted = [], lost = [];
  for (const [root, value] of Object.entries(inputs).filter(([, v]) => v !== undefined)) {
    for (const [path, v] of leaves(value, root)) {
      if (isDropped(path)) continue;
      if (!Object.hasOwn(CARRIED, path)) unaccounted.push(path);
      else if (typeof v === 'string' && !CONVERTED.has(path) && !text.has(v)) lost.push(`${path}: ${JSON.stringify(v)}`);
    }
  }
  assert.deepEqual([...new Set(unaccounted)], [], 'fields neither carried nor in the drop table');
  assert.deepEqual(lost, [], 'carried fields missing from the plan');
}

/** Bytes and mtime of every file under dir. */
function snapshot(dir) {
  return Object.fromEntries(readdirSync(dir, { recursive: true })
    .filter(name => statSync(join(dir, name)).isFile())
    .map(name => [name, { bytes: readFileSync(join(dir, name)), mtimeMs: statSync(join(dir, name)).mtimeMs }]));
}
function tempCopy(t, folder) {
  const dir = mkdtempSync(join(tmpdir(), 'plan-migrate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (folder) cpSync(join(ROOT, folder), dir, { recursive: true });
  return dir;
}

/** Converting a folder (a temp copy, never the repo's) only adds plan.json, and that holds migrate's plan. */
function assertOnlyAddsPlan(t, folder) {
  const dir = tempCopy(t, folder);
  const before = snapshot(dir);
  assert.equal(before['plan.json'], undefined);
  const { path, plan, written } = migrateFolder(dir);
  assert.equal(written, true);
  const after = snapshot(dir);
  assert.deepEqual(Object.keys(after).sort(), [...Object.keys(before), 'plan.json'].sort());
  for (const name of Object.keys(before)) assert.deepEqual(after[name], before[name], `${name} changed`);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), plan);
  assert.deepEqual(plan, migrate(readFolder(join(ROOT, folder))));
}

test('the committed inputs are found', () => {
  assert.ok(CONTRACTS.length >= 3, `found ${CONTRACTS.join(', ')}`);
  assert.ok(BRIEFS.includes('test-fixtures/plan-migrate/brief-only/brief.json'), `found ${BRIEFS.join(', ')}`);
});

test('no field is both carried and dropped, and every drop has a reason', () => {
  for (const d of DROPPED) {
    assert.ok(d.reason.trim().length > 20, `${d.path}: reason`);
    assert.ok(!Object.keys(CARRIED).some(p => p === d.path || p.startsWith(`${d.path}.`) || p.startsWith(`${d.path}[`)), `${d.path} is also carried`);
  }
});

for (const file of CONTRACTS) {
  const folder = dirname(file);
  const contractData = readJson(file);

  test(`${file}: converts to a valid plan that carries or drops every field`, () => {
    const plan = migrate({ contractData });
    assert.equal(validate(plan), plan);
    assert.equal(plan.supersedes, contractData.supersedes ?? 'contract-data.json');
    assert.equal(plan.version, 1);
    for (const g of contractData.gates.dimensions) assert.equal(plan.gates[g.key].ready, g.status === 'ready', g.key);
    assert.deepEqual(plan.checks.map(c => c.criterion), contractData.successCriteria.map(c => normalizeCriterion(c).criterion));
    assert.deepEqual(plan.openQuestions, contractData.openQuestions ?? []);
    assertCovered({ contractData }, plan);
  });

  test(`${file}: converting twice gives the same plan and leaves the input alone`, () => {
    const input = readJson(file);
    assert.deepEqual(migrate({ contractData: input }), migrate({ contractData: input }));
    assert.deepEqual(input, contractData);
  });

  test(`${file}: converting the folder only adds plan.json`, t => assertOnlyAddsPlan(t, folder));

  test(`${file}: the converted plan is refused a run contract until revised`, () => {
    const plan = migrate({ contractData });
    const notReady = GATE_KEYS.filter(k => !plan.gates[k].ready);
    // Open gates refuse first; with every gate ready, the empty change (and mustHold, authority) does.
    const reason = notReady.length ? `plan ${plan.id} v1 is not approvable: gates not ready: ${notReady.join(', ')}` : 'change.before: expected nonempty string';
    assert.throws(() => toRunContract(plan), { message: reason });
  });
}

for (const file of BRIEFS) {
  const folder = dirname(file);
  const brief = readJson(file);

  test(`${file}: converts 1:1, and its run contract is the brief apart from what the plan doesn't carry`, () => {
    const inputs = readFolder(join(ROOT, folder));
    const plan = migrate(inputs);
    assert.equal(validate(plan), plan);
    assert.equal(plan.supersedes, 'brief.json');
    assertCovered(inputs, plan);
    const { brief: out } = toRunContract(plan);
    assert.deepEqual(validateBrief(out), out);
    const { delegated, executionMode, ...carried } = brief;
    assert.deepEqual(out, validateBrief(carried));
    assert.deepEqual(out.decisions, brief.decisions);
  });

  test(`${file}: converting the folder only adds plan.json`, t => assertOnlyAddsPlan(t, folder));
}

test('brief decisions round-trip exactly, with and without a rejected alternative', () => {
  const brief = readJson('test-fixtures/plan-migrate/brief-only/brief.json');
  assert.ok(brief.decisions.some(d => d.rejected) && brief.decisions.some(d => !d.rejected));
  const plan = migrate({ brief });
  const [holder] = plan.claims;
  assert.deepEqual(holder.children.map(c => c.decision), [
    { id: 'decision-1', options: [{ value: 'chosen', label: 'Retry three times, five minutes apart' }, { value: 'rejected', label: 'Exponential backoff' }],
      recommended: 'chosen', reason: 'Covers a brief outage without hiding a real failure.', required: true, state: 'answered', answer: 'chosen', rejected: [{ value: 'rejected' }] },
    { id: 'decision-2', options: [{ value: 'chosen', label: 'Keep the attempt count on the outbox row' }],
      recommended: 'chosen', reason: 'The worker and the outbox then read the same number.', required: true, state: 'answered', answer: 'chosen', rejected: [] },
  ]);
  assert.deepEqual(toRunContract(plan).brief.decisions, brief.decisions);
});

test('a legacy plain-string check is normalized exactly as verify.mjs does it', () => {
  const criteria = [
    'A plain-string criterion',
    { criterion: 'Unit tests pass', check: 'npx vitest run — exits 0' },
    { criterion: 'Lint passes', check: 'npm run lint' },
    { criterion: 'The page reads well', check: 'judgment call: visual review of the page' },
    { criterion: 'Nobody said how' },
  ];
  const plan = migrate({ contractData: { ...orchestration(), successCriteria: criteria } });
  assert.deepEqual(plan.checks, [
    { id: 'criterion-1', criterion: 'A plain-string criterion', check: { judgment: 'A plain-string criterion' } },
    { id: 'criterion-2', criterion: 'Unit tests pass', check: { cmd: 'npx vitest run', expect: 'exits 0' } },
    { id: 'criterion-3', criterion: 'Lint passes', check: { cmd: 'npm run lint' } },
    { id: 'criterion-4', criterion: 'The page reads well', check: { judgment: 'visual review of the page' } },
    { id: 'criterion-5', criterion: 'Nobody said how', check: { judgment: 'Nobody said how' } },
  ]);
  // The same split verify.mjs makes; the plan only omits an empty expect, which it can't hold.
  for (const [i, raw] of criteria.entries()) {
    const check = normalizeCriterion(raw).check;
    if (check) assert.deepEqual(plan.checks[i].check, check.expect === '' ? { cmd: check.cmd } : check);
  }
});

test('more goals and decisions than fit on a level are grouped, and the groups say so', () => {
  const goals = Array.from({ length: 7 }, (_, i) => `Goal ${i + 1} is visible`);
  const decisions = Array.from({ length: 12 }, (_, i) => ({ decision: `Choice ${i + 1}`, reason: `Because ${i + 1}` }));
  const plan = migrate({ contractData: { ...orchestration(), goals, decisions } });
  validate(plan);
  assert.deepEqual(plan.claims.map(c => c.text), [
    'Goals 1–5 of 7, grouped to fit at most 5 claims on a level.',
    'Goals 6–7 of 7, grouped to fit at most 5 claims on a level.',
    'contract-data.json recorded 12 decisions, not yet placed on the claims they change.',
  ]);
  const flat = cs => cs.flatMap(c => [c, ...flat(c.children ?? [])]);
  const all = flat(plan.claims);
  assert.deepEqual(all.filter(c => goals.includes(c.text)).map(c => c.text), goals);
  assert.deepEqual(all.filter(c => c.decision).map(c => c.decision.options[0].label), decisions.map(d => d.decision));
  assert.ok(all.every(c => c.exhibit.sketch && /^Converted from 0\.x contract-data\.json; it has no exhibit yet\.$/.test(c.exhibit.body) && !c.exhibit.src));
  // Beyond MAX_CLAIMS ** (MAX_DEPTH - 1) decisions there is no honest place left: refuse.
  const tooMany = Array.from({ length: MAX_CLAIMS ** (MAX_DEPTH - 1) + 1 }, (_, i) => ({ decision: `Choice ${i}`, reason: 'r' }));
  assert.throws(() => migrate({ contractData: { ...orchestration(), decisions: tooMany } }), /^RangeError: 26 decisions do not fit in 2 levels of at most 5 claims/);
});

test('the pre-gate confidence schema (0.14) is refused with a clear message', t => {
  const { gates, ...old } = orchestration();
  const contractData = { ...old, confidence: { score: 82, dimensions: [{ key: 'problem', score: 18, max: 20 }] } };
  const message = 'contract-data.json uses the pre-gate `confidence` schema (0.14), which cannot be converted; regenerate it via ideation to produce the `gates` schema.';
  assert.throws(() => migrate({ contractData }), { message });
  const dir = tempCopy(t);
  writeFileSync(join(dir, 'contract-data.json'), JSON.stringify(contractData));
  assert.throws(() => migrateFolder(dir), { message });
  assert.deepEqual(readdirSync(dir), ['contract-data.json']);
});

test('migrateFolder never overwrites an existing plan.json', t => {
  const dir = tempCopy(t, 'test-fixtures/orchestration');
  const existing = readFileSync(join(ROOT, 'test-fixtures/plan/plan.json'));
  writeFileSync(join(dir, 'plan.json'), existing);
  const before = snapshot(dir);
  const { plan, written } = migrateFolder(dir);
  assert.equal(written, false);
  assert.deepEqual(plan, JSON.parse(existing));
  assert.deepEqual(snapshot(dir), before);
});

test('a folder with both contract-data.json and brief.json is refused, naming both', t => {
  const dir = tempCopy(t, 'test-fixtures/orchestration');
  cpSync(join(ROOT, 'test-fixtures/plan-migrate/brief-only/brief.json'), join(dir, 'brief.json'));
  assert.throws(() => migrateFolder(dir), /both contract-data\.json and brief\.json/);
  assert.equal(existsSync(join(dir, 'plan.json')), false);
  assert.throws(() => migrate({}), /nothing to convert: expected contract-data\.json or brief\.json/);
});

test('the CLI prints the plan with --dry-run and writes it without', t => {
  const dir = tempCopy(t, 'test-fixtures/open-questions');
  const cli = (...args) => execFileSync(process.execPath, [join(ROOT, 'scripts/plan-migrate.mjs'), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  assert.deepEqual(JSON.parse(cli(dir, '--dry-run')), migrate(readFolder(dir)));
  assert.equal(existsSync(join(dir, 'plan.json')), false);
  assert.equal(cli(dir), `wrote ${join(dir, 'plan.json')}\n`);
  assert.equal(cli(dir), `${join(dir, 'plan.json')} already exists; left as is\n`);
});
