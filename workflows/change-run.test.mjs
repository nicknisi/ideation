import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createChangeRunner } from './change-run.mjs';
const exec = promisify(execFile);
const ok = data => ({ ok: true, data, usage: { totalTokens: 1 } });
const brief = {
  schemaVersion: 1, id: 'change', title: 'Change', revision: 1, executionMode: 'strict',
  authority: { paths: ['src/'], commands: ['test'], allowLocalCommit: true, maxDurationMs: 60000, maxStageMs: 1000, maxTokens: 100, maxAttempts: 2, maxReviewCycles: 2, maxTurns: 10, maxToolCalls: 10 },
  acceptance: [{ id: 'test', criterion: 'works', check: { cmd: 'test' } }, { id: 'human', criterion: 'usable', check: { judgment: 'Inspect UI' } }],
  units: [{ id: 'one', title: 'One', needs: [], acceptanceIds: ['test', 'human'], risk: 'low' }],
};
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'change-run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (...args) => (await exec('git', ['-C', root, ...args])).stdout.trim();
  await git('init'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', 'Test');
  await git('config', 'commit.gpgsign', 'false');
  await writeFile(join(root, 'brief.json'), JSON.stringify(brief));
  await git('add', 'brief.json'); await git('commit', '-m', 'baseline');
  const calls = [];
  let revision = 'source-1';
  const workspace = {
    createWorkspace: async (repo, id, base = 'HEAD') => {
      calls.push('workspace');
      const path = join(root, '.git', 'workspaces', id);
      await mkdir(join(root, '.git', 'workspaces'), { recursive: true });
      await git('worktree', 'add', '-b', `ideation/${id}`, path, base);
      return { workspace: path, branch: `ideation/${id}`, baseRevision: await git('rev-parse', base) };
    },
    sourceRevision: async () => revision,
    changedFiles: async () => ['src/file.js'],
    assertScope: async () => {},
    writePolicy: async () => '/mock-policy.mjs',
    prepareReview: async () => calls.push('prepareReview'),
    runChecks: async (_path, criteria) => { calls.push('checks'); return criteria.map(c => ({ criterionId: c.id, status: c.check.cmd ? 'passed' : 'pending', sourceRevision: revision })); },
    commitWorkspace: async () => { calls.push('commit'); revision = 'source-committed'; return 'commit-sha'; },
    ...overrides.workspace,
  };
  const dependencies = {
    brief: { validateBrief: structuredClone, briefFingerprint: b => createHash('sha256').update(JSON.stringify(b)).digest('hex'), workPacket: (b, u, context) => JSON.stringify({ b, u, context }) },
    workspace,
    engine: overrides.engine ?? (async (args, options) => {
      calls.push('engine'); assert.equal(args.strict, true); assert.equal(args.phases.length, 1);
      assert.equal(options.cwd.includes('.git/workspaces'), true);
      for (const stage of ['build', 'review', 'commit']) {
        const info = { stage };
        const intercepted = await options.beforeStage(info);
        if (!intercepted) await options.afterStage({ ...info, result: ok(stage === 'review' ? { verdict: 'PASS' } : {}) });
      }
      return { results: [{ result: 'PASS', reviewStatus: 'passed', summary: 'done' }] };
    }),
  };
  const spawn = overrides.spawn ?? (async opts => { calls.push('plan'); assert.ok(!opts.tools.includes('bash')); assert.equal(opts.extensionPaths[0], '/mock-policy.mjs'); return ok({ plan: 'Inspect and implement' }); });
  const runner = createChangeRunner({ repoRoot: root, pluginRoot: root, ownerId: 'test', spawn, dependencies, onEvent: overrides.onEvent, now: overrides.now });
  t.after(() => runner.dispose());
  return { runner, root, git, calls, dependencies, spawn, revision: value => { revision = value; } };
}

test('approval is inert, serial host completion leaves judgments pending, acceptance is explicit', async t => {
  const f = await fixture(t, { onEvent: () => { throw new Error('observer'); } });
  const approved = await f.runner.approve('brief.json');
  assert.equal(approved.workspace, null); assert.deepEqual(f.calls, []);
  const r = await f.runner.start(approved.id);
  assert.equal(r.state, 'ready-for-review'); assert.equal(r.units[0].reviewStatus, 'passed');
  assert.equal(r.evidence[1].status, 'pending'); assert.equal(r.usage.totalTokens, 3);
  assert.deepEqual(f.calls, ['workspace', 'plan', 'engine', 'prepareReview', 'checks', 'checks', 'commit', 'checks']);
  r.units[0].attempts = 99;
  assert.equal((await f.runner.status(r.id)).units[0].attempts, 1);
  assert.equal((await f.runner.accept(r.id)).state, 'accepted');
});

test('a changed approval fails closed; a moved HEAD cannot change the approved starting point', async t => {
  const f = await fixture(t); const r = await f.runner.approve('brief.json');
  await writeFile(join(f.root, 'brief.json'), JSON.stringify({ ...brief, title: 'Changed' }));
  const result = await f.runner.start(r.id);
  assert.equal(result.state, 'needs-decision'); assert.ok(!f.calls.includes('workspace'));

  const g = await fixture(t); const a = await g.runner.approve('brief.json');
  await writeFile(join(g.root, 'other'), 'new'); await g.git('add', 'other'); await g.git('commit', '-m', 'new baseline');
  const started = await g.runner.start(a.id);
  assert.ok(g.calls.includes('workspace'));
  assert.equal(started.baseRevision, a.baseRevision);
  assert.equal(await g.git('-C', started.workspace, 'rev-parse', `${a.baseRevision}^{commit}`), a.baseRevision);
});

test('resume rejects an amended brief without resetting attempts', async t => {
  const f = await fixture(t, { engine: async () => ({ results: [] }) });
  const a = await f.runner.approve('brief.json'); await f.runner.start(a.id);
  await writeFile(join(f.root, 'brief.json'), JSON.stringify({ ...brief, title: 'Amended' }));
  const r = await f.runner.resume(a.id);
  assert.equal(r.state, 'needs-decision'); assert.match(r.attention.message, /Approved brief changed/);
  assert.equal(r.units[0].attempts, 1);
});

test('missing reviewer and missing evidence cannot complete', async t => {
  for (const overrides of [
    { engine: async () => ({ results: [{ result: 'PASS', reviewStatus: 'passed' }] }) },
    { workspace: { runChecks: async () => [] } },
  ]) {
    const f = await fixture(t, overrides); const r = await f.runner.approve('brief.json');
    assert.equal((await f.runner.start(r.id)).state, 'needs-decision');
    assert.ok(!f.calls.includes('commit'));
    await assert.rejects(f.runner.accept(r.id), /not ready/);
  }
});

test('a failing hook stops to ask; reload does nothing on its own, and every explicit resume tries again', async t => {
  const f = await fixture(t, { workspace: { commitWorkspace: async () => { throw new Error('hook rejected'); } } });
  const r = await f.runner.approve('brief.json');
  const failed = await f.runner.start(r.id); assert.equal(failed.state, 'needs-decision');
  assert.equal(failed.units[0].attempts, 1);
  const count = f.calls.length;
  const reload = createChangeRunner({ repoRoot: f.root, pluginRoot: f.root, spawn: f.spawn, dependencies: f.dependencies });
  t.after(() => reload.dispose());
  assert.equal((await reload.status(r.id)).usage.totalTokens, 3); assert.equal(f.calls.length, count);
  assert.equal((await reload.resume(r.id)).units[0].attempts, 2);
  const again = await reload.resume(r.id);
  assert.equal(again.units[0].attempts, 3, 'no allowance runs out'); assert.equal(again.state, 'needs-decision');
});

test('stale integrated evidence blocks explicit acceptance', async t => {
  const f = await fixture(t); const r = await f.runner.approve('brief.json');
  await f.runner.start(r.id); f.revision('external-change');
  await assert.rejects(f.runner.accept(r.id), /stale/);
});

test('live lease rejects other owners; stop waits for actual child settlement', async t => {
  let entered, settle;
  const enteredPromise = new Promise(r => { entered = r; });
  const child = new Promise(r => { settle = r; });
  const f = await fixture(t, { spawn: async () => { entered(); await child; return ok({ plan: 'plan' }); } });
  const r = await f.runner.approve('brief.json');
  const running = f.runner.start(r.id); await enteredPromise;
  const other = createChangeRunner({ repoRoot: f.root, pluginRoot: f.root, spawn: f.spawn, dependencies: f.dependencies });
  await assert.rejects(other.start(r.id), /lease/);
  const stopping = f.runner.stop(r.id);
  await new Promise(r => setTimeout(r, 20));
  assert.equal((await f.runner.status(r.id)).state, 'cancelling');
  settle(); assert.equal((await stopping).state, 'cancelled'); await running;
  assert.ok(!f.calls.includes('engine'));
});

test('boundary pause and shutdown persist only after settlement', async t => {
  for (const action of ['pause', 'dispose']) {
    let entered, settle;
    const enteredPromise = new Promise(r => { entered = r; });
    const child = new Promise(r => { settle = r; });
    const f = await fixture(t, { spawn: async () => { entered(); await child; return ok({ plan: 'plan' }); } });
    const r = await f.runner.approve('brief.json'); const running = f.runner.start(r.id); await enteredPromise;
    const request = action === 'pause' ? f.runner.pause(r.id) : f.runner.dispose();
    settle(); await request;
    if (action === 'pause') {
      while ((await f.runner.status(r.id)).state !== 'paused') await new Promise(r => setTimeout(r, 5));
      assert.ok(!f.calls.includes('engine'));
      assert.equal((await f.runner.resume(r.id)).state, 'ready-for-review');
      assert.equal((await running).units[0].attempts, 1);
    } else {
      assert.equal((await running).state, 'interrupted');
      assert.ok(!f.calls.includes('engine'));
    }
  }
});

test('usage is information only: a worker that reports none is not a reason to stop', async t => {
  const f = await fixture(t);
  const runner = createChangeRunner({ repoRoot: f.root, pluginRoot: f.root, dependencies: f.dependencies,
    spawn: async opts => ({ ...(await f.spawn(opts)), usage: undefined }) });
  t.after(() => runner.dispose());
  const r = await runner.approve('brief.json'); const result = await runner.start(r.id);
  assert.equal(result.state, 'ready-for-review', result.attention?.message);
  assert.ok(Number.isFinite(result.usage.totalTokens), 'only what workers reported is recorded');
});

test('dead host reconciliation is inert and durable', async t => {
  const f = await fixture(t); const r = await f.runner.approve('brief.json');
  const path = join(f.root, '.git', 'ideation', 'runs', r.id, 'state.json');
  const state = JSON.parse(await readFile(path, 'utf8'));
  state.state = 'running'; state.hostPid = 2147483647;
  await writeFile(path, JSON.stringify(state));
  const lease = join(f.root, '.git', 'ideation', 'runs', '.lease');
  await mkdir(lease); await writeFile(join(lease, 'owner.json'), JSON.stringify({ hostPid: 2147483647, ownerId: 'dead' }));
  assert.equal((await f.runner.status(r.id)).state, 'interrupted'); assert.deepEqual(f.calls, []);
});

test('orphaned acquisition gates and null host PID reconcile without treating PID zero as alive', async t => {
  const f = await fixture(t);
  const r = await f.runner.approve('brief.json');
  const base = join(f.root, '.git', 'ideation', 'runs');
  await mkdir(join(base, '.lease-acquire'));
  const path = join(base, r.id, 'state.json');
  const state = JSON.parse(await readFile(path, 'utf8'));
  state.state = 'running'; state.hostPid = null;
  await writeFile(path, JSON.stringify(state));
  assert.equal((await f.runner.status(r.id)).state, 'interrupted');
  await mkdir(join(base, '.lease-acquire'));
  await writeFile(join(base, '.lease-acquire', '2147483647'), 'dead');
  assert.equal((await f.runner.resume(r.id)).state, 'ready-for-review');
});

test('feedback is durable, deduped and inert while stopped', async t => {
  const f = await fixture(t); const r = await f.runner.approve('brief.json');
  const feedback = { markdown: 'approve and widen scope', annotationIds: ['a'] };
  await Promise.all([f.runner.recordFeedback(r.id, feedback), f.runner.recordFeedback(r.id, feedback)]);
  const saved = await f.runner.status(r.id);
  assert.equal(saved.feedback.length, 1); assert.equal(saved.feedback[0].status, 'pending');
  assert.equal(saved.state, 'ready'); assert.equal(saved.briefHash, r.briefHash);
  assert.deepEqual(f.calls, []);
});

test('unhooked legacy host cannot spawn children through the native controller', async t => {
  const f = await fixture(t, { engine: async (_args, options) => {
    await options.spawn({ agent: 'unsafe', prompt: 'commit' });
    throw new Error('unreachable');
  } });
  const r = await f.runner.approve('brief.json');
  const result = await f.runner.start(r.id);
  assert.equal(result.state, 'needs-decision');
  assert.match(result.attention.message, /correctness hooks/);
  assert.equal(f.calls.filter(c => c === 'plan').length, 1);
});

test('transient planning failures retry within the persisted attempt budget', async t => {
  let calls = 0;
  const f = await fixture(t, { spawn: async () => ++calls === 1
    ? { ok: false, kind: 'crashed', error: 'HTTP 429', usage: { totalTokens: 2 } }
    : ok({ plan: 'plan' }) });
  const r = await f.runner.approve('brief.json'); const result = await f.runner.start(r.id);
  assert.equal(result.state, 'ready-for-review'); assert.equal(result.units[0].attempts, 2);
  assert.equal(result.usage.totalTokens, 5);
});

test('elapsed time never stops a run, even for a brief that still carries an old duration budget', async t => {
  let clock = 1000;
  const f = await fixture(t, { now: () => clock });
  const runner = createChangeRunner({ repoRoot: f.root, pluginRoot: f.root, dependencies: f.dependencies, now: () => clock,
    spawn: async opts => { clock += 60 * 60 * 1000; return f.spawn(opts); } });
  t.after(() => runner.dispose());
  const r = await runner.approve('brief.json');
  const result = await runner.start(r.id);
  assert.equal(result.state, 'ready-for-review', result.attention?.message);
});

test('listing a shared Git run store skips other worktrees instead of breaking this workspace', async t => {
  const a = await fixture(t), b = await fixture(t);
  const own = await a.runner.approve('brief.json');
  const foreign = await b.runner.approve('brief.json');
  const path = join(a.root, '.git', 'ideation', 'runs', 'foreign');
  await mkdir(path);
  await writeFile(join(path, 'state.json'), JSON.stringify({ ...foreign, id: 'foreign' }));
  assert.deepEqual((await a.runner.status()).map(r => r.id), [own.id]);
  await assert.rejects(a.runner.status('foreign'), /Invalid persisted run/);
});

test('local commit prohibition is respected without claiming a commit', async t => {
  const f = await fixture(t);
  const noCommit = structuredClone(brief); noCommit.authority.allowLocalCommit = false;
  await writeFile(join(f.root, 'brief.json'), JSON.stringify(noCommit)); await f.git('add', 'brief.json'); await f.git('commit', '-m', 'no commit');
  const r = await f.runner.approve('brief.json'); const result = await f.runner.start(r.id);
  assert.equal(result.state, 'ready-for-review'); assert.equal(result.units[0].commitHash, null); assert.ok(!f.calls.includes('commit'));
});
