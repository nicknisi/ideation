// plan-goal: the one /goal owner, for 0.x contracts and approved plans.
// Run: node --test scripts/plan-goal.test.mjs   (from the repo root)

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildGoal, goalFor, goalFromContract, goalFromPlan } from './plan-goal.mjs';
import { writeRunContract } from './plan-data.ts';
import { migrateFolder } from './plan-migrate.mjs';
import { committablePhases, readContract } from './verify.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'scripts', 'plan-goal.mjs');
const ORCHESTRATION = join(ROOT, 'test-fixtures', 'orchestration', 'contract-data.json');
const PLAN = join(ROOT, 'test-fixtures', 'plan', 'plan.json');

/** A scratch project directory, removed after the test. */
function scratch(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'plan-goal-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}
function planFolder(t) {
  const cwd = scratch(t);
  const folder = join(cwd, 'docs', 'ideation', 'send-retry');
  mkdirSync(folder, { recursive: true });
  cpSync(PLAN, join(folder, 'plan.json'));
  return { cwd, folder };
}
const cli = (args, cwd) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout: 30_000 });

test('a 0.x contract keeps the goal contract-gen printed, verify.mjs owning the commit count', t => {
  const cwd = scratch(t);
  const data = JSON.parse(readFileSync(ORCHESTRATION, 'utf8'));
  const goal = goalFromContract(data, { dataPath: join(cwd, 'docs/ideation/orchestration/contract-data.json'), cwd });
  assert.equal(goal, [
    '/goal Drive the Orchestration Fixture contract (orchestration) to completion with /ideation:autopilot.',
    '',
    '1. Run `/ideation:autopilot docs/ideation/orchestration/contract.md`.',
    '2. It dispatches a BACKGROUND workflow. Wait for the completion notification — never start a second autopilot run while one is in flight.',
    "3. Then run the ideation plugin's `scripts/verify.mjs` against `docs/ideation/orchestration/contract-data.json` and leave its VERIFY line in the conversation. Resolve the plugin's install directory first — `${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs` is a placeholder, not a shell variable, and bash will not expand it. That line is the only evidence this goal is judged on.",
    '4. If anything failed, fix the spec or the implementation and go back to step 1. Autopilot skips phases that already have commits.',
    '',
    `Done when the most recent VERIFY line reads fail=0 and commits=${committablePhases(data).length}/${committablePhases(data).length} — or when two consecutive VERIFY lines are identical and still failing, in which case name the failing checks and stop, because a contract whose checks have rotted must not trap the run.`,
  ].join('\n'));
});

test('inside the plugin repo the verify step is a runnable relative command', () => {
  const goal = buildGoal({ kind: 'plan', title: 'T', slug: 't', run: 'r', verify: 'docs/ideation/t', commits: 2, verifyBin: 'scripts/verify.mjs', branch: 'ideation/t' });
  assert.match(goal, /^3\. Then run `node scripts\/verify\.mjs docs\/ideation\/t` and leave its VERIFY line/m);
  assert.match(goal, /^1\. Run `\/ideation:autopilot r`\. All commits belong on branch ideation\/t — switch to it before any run\.$/m);
  assert.match(goal, /never edit the plan, the run contract or the packets/);
  assert.match(goal, /commits=2\/2 /);
});

test('a plan has no goal until it is approved, and none once it changes after approval', t => {
  const { cwd, folder } = planFolder(t);
  assert.throws(() => goalFromPlan(folder, { cwd }), /has no run-contract\.json: the plan is not approved/);
  writeRunContract(folder, 'abc123');
  const goal = goalFromPlan(folder, { cwd });
  const units = committablePhases(readContract(folder).data).length;
  assert.equal(goal.split('\n')[0], '/goal Drive the Failed sends retry on their own plan (send-retry) to completion with /ideation:autopilot.');
  assert.match(goal, /^1\. Run `\/ideation:autopilot docs\/ideation\/send-retry\/run-contract\.json`\. All commits belong on branch ideation\/send-retry/m);
  assert.match(goal, /`scripts\/verify\.mjs` against `docs\/ideation\/send-retry`/);
  assert.match(goal, new RegExp(`fail=0 and commits=${units}/${units} `));
  assert.equal(goalFor(folder, { cwd }), goal, 'a folder resolves to its approved plan');
  assert.equal(goalFor(join(folder, 'run-contract.json'), { cwd }), goal);

  const plan = JSON.parse(readFileSync(join(folder, 'plan.json'), 'utf8'));
  plan.mustHold.push('A new invariant nobody approved.');
  writeFileSync(join(folder, 'plan.json'), JSON.stringify(plan));
  assert.throws(() => goalFromPlan(folder, { cwd }), /no longer matches plan\.json \(v2\): the plan changed after approval/);
});

test('a migrated 0.x folder runs its contract-data.json, as 0.x did', t => {
  const cwd = scratch(t);
  const folder = join(cwd, 'docs', 'ideation', 'orchestration');
  mkdirSync(folder, { recursive: true });
  cpSync(ORCHESTRATION, join(folder, 'contract-data.json'));
  const before = goalFor(folder, { cwd });
  assert.equal(migrateFolder(folder).written, true);
  assert.equal(goalFor(folder, { cwd }), before);
  assert.match(before, /\/ideation:autopilot docs\/ideation\/orchestration\/contract\.md/);
  rmSync(join(folder, 'contract-data.json'));
  assert.throws(() => goalFor(folder, { cwd }), /migrated from contract-data\.json, which is gone/);
});

test('the CLI prints the goal, refuses an unverifiable contract, and writes nothing', t => {
  const { cwd, folder } = planFolder(t);
  const refused = cli([folder], cwd);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /^plan-goal: .*the plan is not approved/m);
  writeRunContract(folder, 'abc123');
  const listing = readdirSync(folder).sort();
  const ok = cli(['docs/ideation/send-retry'], cwd);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), goalFromPlan(folder, { cwd }));
  assert.deepEqual(readdirSync(folder).sort(), listing, 'printing a goal writes nothing');

  const prose = join(cwd, 'prose');
  mkdirSync(prose);
  const data = JSON.parse(readFileSync(ORCHESTRATION, 'utf8'));
  data.successCriteria = [{ criterion: 'Server answers', check: { cmd: 'start the server & then curl it', expect: 'ok' } }];
  writeFileSync(join(prose, 'contract-data.json'), JSON.stringify(data));
  const bad = cli([join(prose, 'contract-data.json')], cwd);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Refusing to print a \/goal: 1 unrunnable check/);
  assert.equal(cli([], cwd).status, 2);
});
