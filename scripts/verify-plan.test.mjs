// verify.mjs on plan data: a plan migrated from a 0.x contract must verify to
// the same VERIFY line as the contract it came from.
// Run: node --test scripts/verify-plan.test.mjs   (from the repo root)

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { migrateFolder } from './plan-migrate.mjs';
import { committablePhases, main, normalizeCriterion } from './verify.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONTRACTS = execFileSync('git', ['ls-files', '*contract-data.json'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);

/** Runs the CLI in-process from `cwd`, capturing stdout. */
function run(cwd, args) {
  const out = [];
  const { log } = console;
  const write = process.stdout.write.bind(process.stdout);
  const prev = process.cwd();
  console.log = (...a) => out.push(a.join(' '));
  process.stdout.write = s => (out.push(String(s)), true);
  process.chdir(cwd);
  try {
    return { code: main(args), out: out.join('\n') };
  } finally {
    console.log = log;
    process.stdout.write = write;
    process.chdir(prev);
  }
}
const verifyLine = out => out.match(/^VERIFY .*$/m)?.[0];

/**
 * A throwaway git repo holding `contractData` at `folder` (the fixture's own
 * repo-relative path, so its spec paths mean the same thing there) and one
 * commit whose body names the first committable spec path. Only the JSON is
 * copied: the fixtures' cmd checks then run against a repo with nothing in it,
 * fail or pass fast, and can touch nothing here.
 */
function scratchRepo(t, folder, contractData) {
  const repo = mkdtempSync(join(tmpdir(), 'verify-plan-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Verify Plan Test');
  git('config', 'commit.gpgsign', 'false');
  const dir = join(repo, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'contract-data.json'), JSON.stringify(contractData));
  const first = committablePhases(contractData)[0]?.specPath ?? 'no phases';
  git('add', '-A');
  git('commit', '-q', '-m', `feat: a phase\n\nPhase 1 of ${first}`);
  return { repo, dir };
}

for (const file of CONTRACTS) {
  test(`${file}: the migrated plan verifies to the 0.x VERIFY line`, t => {
    const contractData = JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
    const { repo, dir } = scratchRepo(t, dirname(file), contractData);
    const legacy = run(repo, [join(dir, 'contract-data.json')]);
    assert.equal(migrateFolder(dir).written, true);
    const plan = run(repo, [join(dir, 'plan.json')]);

    const line = verifyLine(legacy.out);
    assert.ok(line, legacy.out);
    assert.equal(verifyLine(plan.out), line);
    assert.equal(plan.code, legacy.code);
    const phases = committablePhases(contractData).length;
    assert.match(line, new RegExp(`commits=${phases ? 1 : 0}/${phases} `));
    t.diagnostic(line);
  });
}

test('gate and spec-less phases stay out of the plan commit denominator', t => {
  const contractData = {
    ...JSON.parse(readFileSync(join(ROOT, 'test-fixtures/orchestration/contract-data.json'), 'utf8')),
    successCriteria: [{ criterion: 'ok', check: { cmd: 'true', expect: 'exits 0' } }],
    execution: { strategy: 'Sequential', phases: [
      { title: 'Build', specPath: 'docs/ideation/g/spec-phase-1.md', risk: 'low' },
      { title: 'Review', kind: 'gate', specPath: 'docs/ideation/g/gate.md', prereqs: ['Build'] },
      { title: 'Undecided', prereqs: ['Review'] },
    ] },
  };
  const { repo, dir } = scratchRepo(t, 'docs/ideation/g', contractData);
  migrateFolder(dir);
  for (const path of [join(dir, 'contract-data.json'), join(dir, 'plan.json')]) {
    const { code, out } = run(repo, [path]);
    assert.equal(verifyLine(out), 'VERIFY orchestration: commits=1/1 pass=1 fail=0 judgment=0');
    assert.equal(code, 0);
  }
});

test('legacy plain-string checks normalize identically through both paths', t => {
  const successCriteria = [
    'A plain-string criterion',
    { criterion: 'Passes', check: 'true — exits 0' },
    { criterion: 'Bare command', check: 'true' },
    { criterion: 'Fails', check: 'false — exits 0' },
    { criterion: 'Looks right', check: 'judgment call: visual review' },
    { criterion: 'Unstated' },
  ];
  const contractData = { ...JSON.parse(readFileSync(join(ROOT, 'test-fixtures/orchestration/contract-data.json'), 'utf8')), successCriteria };
  const { repo, dir } = scratchRepo(t, 'test-fixtures/orchestration', contractData);
  const { plan } = migrateFolder(dir);
  assert.deepEqual(plan.checks.map(c => normalizeCriterion(c).check), successCriteria.map(c => normalizeCriterion(c).check ?? { judgment: normalizeCriterion(c).criterion }));
  const legacy = run(repo, [join(dir, 'contract-data.json')]);
  const fromPlan = run(repo, [join(dir, 'plan.json')]);
  assert.equal(verifyLine(fromPlan.out), verifyLine(legacy.out));
  assert.match(verifyLine(legacy.out), /pass=2 fail=1 judgment=3$/);
});

test('a folder verifies its plan.json, and says so', t => {
  const contractData = JSON.parse(readFileSync(join(ROOT, 'test-fixtures/open-questions/contract-data.json'), 'utf8'));
  const { repo, dir } = scratchRepo(t, 'test-fixtures/open-questions', contractData);
  const before = run(repo, [dir, '--list']).out;
  assert.match(before, /^verify: using contract-data\.json$/m);
  assert.match(before, /source\s+\S*test-fixtures\/open-questions\/contract-data\.json$/m);

  migrateFolder(dir);
  for (const flag of ['--list', '--advise']) {
    assert.match(run(repo, [dir, flag]).out, /^verify: using plan\.json \(contract-data\.json also present\)$/m);
  }
  const listed = run(repo, [dir, '--list']).out;
  assert.match(listed, /source\s+\S*test-fixtures\/open-questions\/plan\.json$/m);
  assert.match(listed, /^LIST open-questions: 1 criteria \(1 cmd, 0 judgment\), 0 phase commits to check$/m);

  rmSync(join(dir, 'contract-data.json'));
  assert.match(run(repo, [dir, '--list']).out, /^verify: using plan\.json$/m);
});

test('a contract-data.json path prints no precedence note', t => {
  const contractData = JSON.parse(readFileSync(join(ROOT, 'test-fixtures/open-questions/contract-data.json'), 'utf8'));
  const { repo, dir } = scratchRepo(t, 'test-fixtures/open-questions', contractData);
  migrateFolder(dir);
  assert.doesNotMatch(run(repo, [join(dir, 'contract-data.json'), '--list']).out, /^verify: /m);
});

test('a native plan has no spec paths, so commits=0/0', t => {
  const { repo, dir } = scratchRepo(t, 'docs/ideation/send-retry', {});
  rmSync(join(dir, 'contract-data.json'));
  const plan = JSON.parse(readFileSync(join(ROOT, 'test-fixtures/plan/plan.json'), 'utf8'));
  plan.checks[0].check = { cmd: 'true', expect: 'exits 0' };
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
  const { code, out } = run(repo, [dir]);
  assert.equal(verifyLine(out), 'VERIFY send-retry: commits=0/0 pass=1 fail=0 judgment=1');
  assert.doesNotMatch(out, /commit is not counted|none is readable/);
  assert.equal(code, 0);
  assert.match(run(repo, [dir, '--advise']).out, /^RUNMODE send-retry: run-spec/m);
});

test('a migrated plan without its 0.x source beside it says why no commit is counted', t => {
  const contractData = JSON.parse(readFileSync(join(ROOT, 'test-fixtures/orchestration/contract-data.json'), 'utf8'));
  const { repo, dir } = scratchRepo(t, 'test-fixtures/orchestration', contractData);
  migrateFolder(dir);

  // One phase renamed: its unit no longer matches, and only that unit drops out.
  contractData.execution.phases[0].title = 'Renamed';
  writeFileSync(join(dir, 'contract-data.json'), JSON.stringify(contractData));
  const renamed = run(repo, [join(dir, 'plan.json')]).out;
  assert.match(renamed, /^verify: unit "phase-1-root" matches no phase in contract-data\.json; its commit is not counted$/m);
  assert.match(verifyLine(renamed), /commits=0\/3 /);

  rmSync(join(dir, 'contract-data.json'));
  const missing = run(repo, [join(dir, 'plan.json')]).out;
  assert.match(missing, /^verify: plan supersedes contract-data\.json, but none is readable beside it; no unit commit is counted$/m);
  assert.match(verifyLine(missing), /commits=0\/0 /);
});
