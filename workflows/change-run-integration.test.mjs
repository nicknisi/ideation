import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createChangeRunner } from './change-run.mjs';
const exec = promisify(execFile);
const ok = data => ({ ok: true, data, usage: { totalTokens: 1 } });
const waitFor = async fn => {
  for (let n = 0; n < 500; n++) { if (await fn()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Timed out waiting for boundary');
};
async function fixture(t, { noop = false, lie = false, multi = false, maxAttempts = 1, block, reviewFail = false, reviewBlocking = 0, checkFail = false, scoutHold = false, fixWorks = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'native-integrated-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (cwd, ...args) => (await exec('git', ['-C', cwd, ...args])).stdout.trim();
  await git(root, 'init'); await git(root, 'config', 'user.email', 'test@example.invalid'); await git(root, 'config', 'user.name', 'Test');
  await git(root, 'config', 'commit.gpgsign', 'false');
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'value'), noop ? 'done' : 'before');
  const cmd = "test \"$(cat src/value)\" = done";
  const brief = { schemaVersion: 1, id: 'native', title: 'Native', revision: 1, why: 'Exercise real pipeline',
    change: { before: 'before', after: 'done' }, mustHold: ['Stay scoped'],
    acceptance: [{ id: 'works', criterion: 'Value is done', check: { cmd } }],
    units: [{ id: 'one', title: 'One', goal: 'Set value', risk: 'low', needs: [], acceptanceIds: ['works'] },
      ...(multi ? [{ id: 'two', title: 'Two', goal: 'Confirm integrated value', risk: 'low', needs: ['one'], acceptanceIds: ['works'] }] : [])],
    authority: { paths: ['src/'], commands: [cmd], maxAttempts, maxDurationMs: 60000, maxStageMs: 10000 } };
  await writeFile(join(root, 'brief.json'), JSON.stringify(brief));
  await git(root, 'add', '.'); await git(root, 'commit', '-m', 'baseline');
  const stages = [], prompts = [];
  const spawn = async opts => {
    stages.push(opts.agent); prompts.push([opts.agent, opts.prompt]);
    assert.ok(opts.cwd); assert.ok(opts.outputSchema); assert.equal(opts.extensionPaths.length, 1);
    await block?.(opts);
    if (opts.agent.startsWith('plan:')) return ok({ plan: 'Read and implement the unit within scope' });
    if (opts.agent.startsWith('scout:')) return ok(scoutHold ? { verdict: 'HOLD', notReadyGates: ['success-criteria'], contextMap: 'src/value is the target' } : { verdict: 'GO', contextMap: 'src/value is the target' });
    if (opts.agent.startsWith('build:')) {
      assert.doesNotMatch(opts.prompt, /\/ideation:execute-spec|write verbatim|git add -N/);
      if (!noop) await writeFile(join(opts.cwd, 'src', 'value'), checkFail ? 'broken' : 'done');
      return ok({ result: noop || lie ? 'NO-OP' : 'BUILT', summary: 'Value is done', filesChanged: noop ? [] : ['src/value'], validation: 'PASS' });
    }
    if (opts.agent.startsWith('review:')) {
      assert.equal(await readFile(join(opts.cwd, 'src', 'value'), 'utf8'), 'done');
      await git(opts.cwd, 'diff', 'HEAD');
      return ok({ verdict: reviewFail ? 'FAIL' : 'PASS', blocking: reviewBlocking, findings: reviewBlocking ? ['high/logic src/value:1 — blocking finding'] : [], summary: 'Independently inspected src/value: it satisfies the packet, including when unchanged.' });
    }
    if (opts.agent.startsWith('fix:')) {
      if (!fixWorks) return ok({ result: 'FAIL', summary: 'Cannot resolve finding' });
      await writeFile(join(opts.cwd, 'src', 'value'), 'done');
      return ok({ result: 'FIXED', summary: 'Set the value the check expects', carried: [] });
    }
    throw new Error(`Unexpected child stage ${opts.agent}`);
  };
  const config = { repoRoot: root, pluginRoot: resolve('.'), spawn };
  const runner = createChangeRunner(config);
  t.after(() => runner.dispose());
  return { root, runner, config, stages, prompts, git };
}

test('real engine + brief + workspace: host commit, durable review receipt, checks and immutable acceptance', async t => {
  const f = await fixture(t);
  const approved = await f.runner.approve('brief.json');
  const r = await f.runner.start(approved.id);
  assert.equal(r.state, 'ready-for-review', r.attention?.message);
  assert.equal(r.units[0].reviewEvidence.result.verdict, 'PASS');
  assert.equal(r.units[0].outcome, 'COMMITTED');
  assert.equal(await f.git(r.workspace, 'rev-parse', 'HEAD'), r.units[0].commitHash);
  assert.equal(r.evidence[0].status, 'passed');
  assert.equal(r.evidence[0].sourceRevision, r.sourceRevision);
  assert.equal(await f.git(f.root, 'show', 'HEAD:src/value'), 'before');
  await rename(join(f.root, 'brief.json'), join(f.root, 'moved.json'));
  assert.equal((await f.runner.accept(r.id)).state, 'accepted');
});

for (const lie of [false, true]) test(`native NO-OP is independently reviewed and host verified (changed=${lie})`, async t => {
  const f = await fixture(t, { noop: !lie, lie });
  const a = await f.runner.approve('brief.json'); const r = await f.runner.start(a.id);
  assert.equal(r.state, 'ready-for-review', r.attention?.message);
  assert.ok(f.stages.includes('review:One#1'));
  assert.equal(r.units[0].outcome, lie ? 'COMMITTED' : 'NO-OP');
  assert.equal(Boolean(r.units[0].commitHash), lie);
  if (!lie) assert.equal(await f.git(r.workspace, 'rev-parse', 'HEAD'), r.baseRevision);
  assert.equal((await f.runner.accept(r.id)).state, 'accepted');
});

for (const failure of ['reviewFail', 'checkFail']) test(`real ${failure} cannot commit or complete`, async t => {
  const f = await fixture(t, { [failure]: true });
  const a = await f.runner.approve('brief.json'); const r = await f.runner.start(a.id);
  assert.equal(r.state, 'needs-decision');
  assert.equal(r.units[0].commitHash, null);
  assert.equal(await f.git(r.workspace, 'rev-parse', 'HEAD'), r.baseRevision);
  await assert.rejects(f.runner.accept(r.id), /not ready/);
});

test('a reviewer cannot pass with explicit blocking findings', async t => {
  const f = await fixture(t, { reviewBlocking: 1 });
  const a = await f.runner.approve('brief.json'); const r = await f.runner.start(a.id);
  assert.equal(r.state, 'needs-decision');
  assert.equal(r.units[0].reviewStatus, 'failed');
  assert.equal(r.units[0].commitHash, null);
  assert.equal(await f.git(r.workspace, 'rev-parse', 'HEAD'), r.baseRevision);
});

test('a blocked run can be set aside without deleting its work or resetting authority', async t => {
  const f = await fixture(t, { checkFail: true });
  const a = await f.runner.approve('brief.json'); const stopped = await f.runner.start(a.id);
  assert.equal(stopped.state, 'needs-decision');
  const cancelled = await f.runner.stop(a.id);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.units[0].attempts, stopped.units[0].attempts);
  assert.equal(await readFile(join(cancelled.workspace, 'src/value'), 'utf8'), 'broken');
  assert.equal((await f.runner.stop(a.id)).state, 'cancelled');
});

test('real multiunit execution preserves ordered commits and checks integrated source', async t => {
  const f = await fixture(t, { multi: true });
  const a = await f.runner.approve('brief.json'); const r = await f.runner.start(a.id);
  assert.equal(r.state, 'ready-for-review', r.attention?.message);
  assert.deepEqual(r.units.map(u => u.outcome), ['COMMITTED', 'NO-OP']);
  assert.ok(f.stages.indexOf('review:One#1') < f.stages.indexOf('plan:two'));
  assert.equal(r.evidence[0].sourceRevision, r.sourceRevision);
});

test('pause after last authorized spawn waits and resumes the SAME live attempt; feedback has no authority', async t => {
  let entered, unblock;
  const started = new Promise(r => { entered = r; });
  const gate = new Promise(r => { unblock = r; });
  const f = await fixture(t, { block: async opts => { if (opts.agent.startsWith('build:')) { entered(); await gate; } } });
  const a = await f.runner.approve('brief.json'); const running = f.runner.start(a.id);
  await started; await f.runner.pause(a.id); unblock();
  await waitFor(async () => (await f.runner.status(a.id)).state === 'paused');
  const feedback = { id: 'annotation-1', markdown: 'Please expand authority', annotationIds: ['a'] };
  await Promise.all([f.runner.recordFeedback(a.id, feedback), f.runner.recordFeedback(a.id, feedback)]);
  const paused = await f.runner.status(a.id);
  assert.equal(paused.feedback.length, 1); assert.equal(paused.state, 'paused');
  assert.equal(paused.units[0].attempts, 1); assert.equal(paused.briefHash, a.briefHash);
  const r = await f.runner.resume(a.id); await running;
  assert.equal(r.state, 'ready-for-review', r.attention?.message);
  assert.equal(r.units[0].attempts, 1); assert.equal(f.stages.filter(x => x.startsWith('build:')).length, 1);
});

test('shutdown persists interruption source lineage; resume picks the same run back up', async t => {
  let entered, unblock;
  const started = new Promise(r => { entered = r; }); const gate = new Promise(r => { unblock = r; });
  const f = await fixture(t, { block: async opts => { if (opts.agent.startsWith('build:')) { entered(); await gate; } } });
  const a = await f.runner.approve('brief.json'); const running = f.runner.start(a.id);
  await started; const stopping = f.runner.dispose(); unblock(); await stopping;
  const interrupted = await running;
  assert.equal(interrupted.state, 'interrupted'); assert.equal(interrupted.interruptions.length, 1);
  assert.equal(interrupted.interruptions[0].units[0].attempt, 1);
  const reload = createChangeRunner(f.config); t.after(() => reload.dispose());
  const r = await reload.resume(a.id);
  assert.equal(r.state, 'ready-for-review', r.attention?.message);
  assert.equal(r.units[0].attempts, 2); assert.equal(f.stages.filter(x => x.startsWith('build:')).length, 2);
});

test('status detects stale live source and acceptance rechecks confirmation identity', async t => {
  const f = await fixture(t);
  const a = await f.runner.approve('brief.json'); const r = await f.runner.start(a.id);
  await assert.rejects(f.runner.accept(r.id, { expectedSequence: r.sequence - 1 }), /changed since acceptance/);
  await writeFile(join(r.workspace, 'src/value'), 'manually changed');
  const viewed = await f.runner.status(r.id);
  assert.equal(viewed.evidenceFresh, false);
  assert.equal(viewed.attention.reason, 'stale-evidence');
  await assert.rejects(f.runner.accept(r.id), /stale/);
});

test('uncommitted work never blocks approval; by default the run starts from the last commit and leaves it alone', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, '.pi/artifacts'), { recursive: true });
  await writeFile(join(f.root, '.pi/artifacts/preview.html'), '<h1>Local preview</h1>');
  await writeFile(join(f.root, 'src', 'value'), 'work in progress');
  await writeFile(join(f.root, 'untracked-source.js'), 'export const x = 1;');
  const before = await f.git(f.root, 'status', '--porcelain', '--untracked-files=all');
  const source = await f.runner.uncommitted();
  assert.deepEqual(source.paths, ['src/value', 'untracked-source.js'], 'artifact previews are host-written, not your work');
  assert.equal(source.head, await f.git(f.root, 'rev-parse', 'HEAD'));
  const a = await f.runner.approve('brief.json');
  assert.equal(a.state, 'ready');
  assert.equal(a.baseRevision, source.head);
  assert.deepEqual(a.includedChanges, []);
  const r = await f.runner.start(a.id);
  assert.equal(r.state, 'ready-for-review', r.attention?.message);
  assert.equal(await f.git(r.workspace, 'show', `${r.baseRevision}:src/value`), 'before');
  assert.equal(await readFile(join(f.root, 'src', 'value'), 'utf8'), 'work in progress');
  assert.equal(await f.git(f.root, 'status', '--porcelain', '--untracked-files=all'), before);
});

test('including uncommitted work snapshots it privately: files, index and HEAD untouched', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'extra'), { recursive: true });
  await writeFile(join(f.root, 'extra', 'new.txt'), 'untracked idea');
  await writeFile(join(f.root, 'staged.txt'), 'staged idea');
  await f.git(f.root, 'add', 'staged.txt');
  await mkdir(join(f.root, 'docs/ideation/native'), { recursive: true });
  await writeFile(join(f.root, 'docs/ideation/native/brief.json'), '{}');
  await mkdir(join(f.root, '.pi/artifacts'), { recursive: true });
  await writeFile(join(f.root, '.pi/artifacts/preview.html'), '<h1>Local preview</h1>');
  const head = await f.git(f.root, 'rev-parse', 'HEAD');
  const status = await f.git(f.root, 'status', '--porcelain', '--untracked-files=all');
  const staged = await f.git(f.root, 'diff', '--cached', '--name-only');
  const exclude = ['docs/ideation/native/'];
  assert.deepEqual((await f.runner.uncommitted({ exclude })).paths, ['extra/new.txt', 'staged.txt']);
  const a = await f.runner.approve('brief.json', { includeUncommitted: true, exclude });
  assert.deepEqual(a.includedChanges, ['extra/new.txt', 'staged.txt']);
  assert.equal(a.approvedHead, head);
  assert.notEqual(a.baseRevision, head);
  assert.equal(await f.git(f.root, 'rev-parse', `${a.baseRevision}^`), head);
  assert.equal(await f.git(f.root, 'rev-parse', `refs/ideation/${a.id}/base`), a.baseRevision);
  assert.equal(await f.git(f.root, 'show', `${a.baseRevision}:extra/new.txt`), 'untracked idea');
  assert.equal(await f.git(f.root, 'show', `${a.baseRevision}:staged.txt`), 'staged idea');
  for (const skipped of ['docs/ideation/native/brief.json', '.pi/artifacts/preview.html'])
    await assert.rejects(f.git(f.root, 'cat-file', '-e', `${a.baseRevision}:${skipped}`));
  assert.equal(await f.git(f.root, 'rev-parse', 'HEAD'), head);
  assert.equal(await f.git(f.root, 'status', '--porcelain', '--untracked-files=all'), status);
  assert.equal(await f.git(f.root, 'diff', '--cached', '--name-only'), staged);
  // The included work is the starting point, so it is not counted against the approved paths.
  const r = await f.runner.start(a.id);
  assert.equal(r.state, 'ready-for-review', r.attention?.message);
  assert.equal(await readFile(join(r.workspace, 'extra', 'new.txt'), 'utf8'), 'untracked idea');
});

test('including uncommitted work when there is none starts from the last commit', async t => {
  const f = await fixture(t);
  const a = await f.runner.approve('brief.json', { includeUncommitted: true });
  assert.equal(a.baseRevision, await f.git(f.root, 'rev-parse', 'HEAD'));
  assert.deepEqual(a.includedChanges, []);
});

test('the run is built from its approved starting point even after HEAD moves', async t => {
  const f = await fixture(t);
  const a = await f.runner.approve('brief.json');
  await writeFile(join(f.root, 'later.txt'), 'committed after approval');
  await f.git(f.root, 'add', 'later.txt'); await f.git(f.root, 'commit', '-m', 'later');
  const r = await f.runner.start(a.id);
  assert.equal(r.state, 'ready-for-review', r.attention?.message);
  await assert.rejects(f.git(r.workspace, 'cat-file', '-e', 'HEAD:later.txt'));
});

test('leaving ideation brings the work into the checkout, keeps its exact state, and the run never resurfaces', async t => {
  const f = await fixture(t);
  const a = await f.runner.approve('brief.json');
  const r = await f.runner.start(a.id);
  assert.equal(r.state, 'ready-for-review', r.attention?.message);
  assert.deepEqual((await f.runner.work(r.id)).files, ['src/value']);
  const out = await f.runner.leave(r.id, { apply: true });
  assert.equal(out.applied, true);
  assert.equal(await readFile(join(f.root, 'src', 'value'), 'utf8'), 'done');
  assert.equal(await f.git(f.root, 'show', `refs/ideation/${r.id}/exit:src/value`), 'done', 'the exact final state is kept');
  assert.equal(out.workspaceRemoved, true);
  const after = await f.runner.status(r.id);
  assert.equal(after.state, 'cancelled');
  assert.equal(after.exit.applied, true);
  const { chooseRun } = await import('./change-ui.mjs');
  assert.equal(chooseRun(await f.runner.status(), after.repoRoot, 'anyone'), undefined, 'a left run is never picked again');
});

test('leaving without bringing the work keeps it on its branch and worktree', async t => {
  const f = await fixture(t);
  const a = await f.runner.approve('brief.json');
  const r = await f.runner.start(a.id);
  const out = await f.runner.leave(r.id, { apply: false });
  assert.equal(out.applied, false);
  assert.equal(await readFile(join(f.root, 'src', 'value'), 'utf8'), 'before', 'your checkout is untouched');
  assert.equal(await readFile(join(r.workspace, 'src', 'value'), 'utf8'), 'done');
  assert.equal(await f.git(f.root, 'rev-parse', '--verify', `refs/heads/${r.branch}`) !== '', true);
});

test('a failing check goes back to the fixer with its output, and the run carries on to review', async t => {
  const f = await fixture(t, { checkFail: true, fixWorks: true });
  const a = await f.runner.approve('brief.json');
  const r = await f.runner.start(a.id);
  assert.equal(r.state, 'ready-for-review', r.attention?.message);
  assert.equal(r.units[0].attempts, 1, 'fixed inside the first attempt');
  const fix = f.prompts.find(([agent]) => agent.startsWith('fix:'));
  assert.ok(fix, 'the fixer ran'); assert.match(fix[1], /Check \\?"works\\?" failed/);
  assert.ok(f.stages.indexOf('review:One#2') > f.stages.findIndex(s => s.startsWith('fix:')), 'the real reviewer runs once the checks pass');
});

test('a scout HOLD does not stop an approved run', async t => {
  const f = await fixture(t, { scoutHold: true });
  const a = await f.runner.approve('brief.json');
  const r = await f.runner.start(a.id);
  assert.equal(r.state, 'ready-for-review', r.attention?.message);
  assert.ok(f.stages.some(s => s.startsWith('build:')));
});

test('a retry is told what failed; a run that cannot make progress says so plainly', async t => {
  const f = await fixture(t, { checkFail: true });
  const a = await f.runner.approve('brief.json');
  const r = await f.runner.start(a.id);
  assert.equal(r.state, 'needs-decision');
  const plans = f.prompts.filter(([agent]) => agent.startsWith('plan:'));
  assert.ok(plans.length >= 2, 'it tried again');
  assert.doesNotMatch(plans[0][1], /previous attempt/);
  assert.match(plans[1][1], /The previous attempt at this unit did not pass/);
  assert.match(plans[1][1], /test "\$\(cat src\/value\)" = done/);
  assert.match(r.attention.message, /the check “works” kept failing the same way\. Resume to keep trying, or choose Leave ideation/);
});
