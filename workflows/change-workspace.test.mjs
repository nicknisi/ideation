import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, chmod, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as api from './change-workspace.mjs';
import { validateBrief } from './change-brief.mjs';
test('brief and runtime share protected manifests, case handling and host-only paths', async t => {
  const root = await fixture(t);
  const brief = paths => ({ schemaVersion: 1, id: 'test', title: 'Test', revision: 1,
    why: 'Test', change: { before: 'old', after: 'new' }, mustHold: ['safe'],
    acceptance: [{ id: 'a', criterion: 'Good', check: { judgment: 'Inspect' } }],
    units: [{ id: 'u', title: 'Unit', goal: 'Work', risk: 'low', acceptanceIds: ['a'] }],
    authority: { paths, commands: [] } });
  const names = ['requirements.txt', 'requirements-dev.txt', 'composer.json', 'composer.lock',
    'Pipfile', 'Pipfile.lock', 'build.gradle', 'build.gradle.kts', 'settings.gradle.kts',
    'lib.gemspec', 'Gemfile.lock', 'mix.exs', 'mix.lock', 'deno.json', 'deno.jsonc',
    'deno.lock', 'package.json', 'Cargo.toml', 'pyproject.toml', 'uv.lock', 'pom.xml',
    'go.mod', 'pubspec.yaml', 'Package.swift', '.gitignore', '.gitattributes', '.gitmodules',
    '.git/config', '.pi/settings.json', '.ideation-state', 'docs/ideation/.native/run/spec.md'];
  for (const name of names) for (const p of [name, name.toUpperCase(), `nested/${name}`]) {
    // Host artifact exclusion applies only at the root, not arbitrary nested docs.
    if (p.startsWith('nested/docs/')) continue;
    assert.equal(api.isProtectedPath(p), true, p);
    assert.throws(() => validateBrief(brief([p])), /protected/i, p);
    assert.equal((await api.checkToolPolicy(root, { paths: ['.'], commands: [] },
      { toolName: 'write', input: { path: p } })).block, true, p);
  }
  for (const p of ['requirements-dev.txt', 'composer.json', '.gitignore', '.gitattributes']) {
    await writeFile(join(root, p), 'changed');
    await assert.rejects(api.assertScope(root, ['.']), /protected/i);
    await rm(join(root, p));
  }
  assert.deepEqual(validateBrief(brief(['src/', '.'])).authority.paths, ['src/', '.']);
});

test('ignored build/test outputs are not evidence or review input; tracked ignored files still are', async t => {
  const root = await fixture(t);
  await writeFile(join(root, '.gitignore'), 'dist/\ncoverage/\nnode_modules/\nsrc/a.txt\n');
  await git(root, 'add', '.gitignore'); await git(root, 'commit', '-m', 'ignore outputs');
  const before = await api.sourceRevision(root);
  const [result] = await api.runChecks(root, [{ id: 'build', check: {
    cmd: 'mkdir -p dist coverage node_modules/pkg; echo build > dist/out; echo test > coverage/out; echo dep > node_modules/pkg/index.js',
  } }]);
  assert.equal(result.status, 'passed');
  assert.equal(await api.sourceRevision(root), before);
  assert.deepEqual(await api.changedFiles(root), []);
  await api.prepareReview(root, ['src/']);
  assert.equal(await git(root, 'diff', 'HEAD'), '');
  await mkdir(join(root, 'src/new dir/deeper'), { recursive: true });
  await writeFile(join(root, 'src/new dir/deeper/file.txt'), 'new source');
  await rm(join(root, 'src/a.txt'));
  assert.deepEqual(await api.changedFiles(root), ['src/a.txt', 'src/new dir/deeper/file.txt']);
  assert.notEqual(await api.sourceRevision(root), before);
  await api.prepareReview(root, ['src/']);
  assert.match(await git(root, 'diff', 'HEAD'), /new source/);
  assert.equal(await git(root, 'diff', '--cached'), '');
  const sha = await api.commitWorkspace(root, ['src/'], { message: 'replace source', sourceRevision: await api.sourceRevision(root) });
  assert.equal(sha, await git(root, 'rev-parse', 'HEAD'));
  assert.deepEqual(await api.changedFiles(root), []);
  assert.equal(await git(root, 'ls-files', 'dist', 'coverage', 'node_modules'), '');
});

test('post-commit source mutation leaves actual HEAD and unstaged evidence on failed run branch', async t => {
  const root = await fixture(t), w = await api.createWorkspace(root, 'hook-failure');
  const hook = join(root, '.git/hooks/post-commit');
  await writeFile(hook, '#!/bin/sh\necho after > src/a.txt\n'); await chmod(hook, 0o755);
  await writeFile(join(w.workspace, 'src/a.txt'), 'approved\n');
  await assert.rejects(api.commitWorkspace(w.workspace, ['src/'], {
    message: 'approved', sourceRevision: await api.sourceRevision(w.workspace),
  }), asyncError => /actual HEAD:/.test(asyncError.message));
  assert.notEqual(await git(w.workspace, 'rev-parse', 'HEAD'), w.baseRevision);
  assert.equal(await git(root, 'rev-parse', 'HEAD'), w.baseRevision);
  assert.equal(await git(w.workspace, 'branch', '--show-current'), w.branch);
  assert.equal(await git(w.workspace, 'show', 'HEAD:src/a.txt'), 'approved');
  assert.equal(await readFile(join(w.workspace, 'src/a.txt'), 'utf8'), 'after\n');
  assert.deepEqual(await api.changedFiles(w.workspace), ['src/a.txt']);
});

const exec = promisify(execFile);
const git = async (cwd, ...args) => (await exec('git', args, { cwd })).stdout.trim();
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'change-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true })); // Only test-owned temporary data.
  await git(root, 'init');
  await git(root, 'config', 'user.email', 'test@example.invalid');
  await git(root, 'config', 'user.name', 'Test');
  // Fixtures must not invoke the user's external signing agent.
  await git(root, 'config', 'commit.gpgsign', 'false');
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/a.txt'), 'baseline\n');
  await writeFile(join(root, 'package.json'), '{}\n');
  await git(root, 'add', '.'); await git(root, 'commit', '-m', 'baseline');
  return root;
}
test('dedicated worktree uses common gitdir and leaves dirty original untouched; collisions preserve data', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'src/a.txt'), 'dirty\n');
  await writeFile(join(root, 'mine'), 'untracked');
  const before = await git(root, 'status', '--porcelain');
  const w = await api.createWorkspace(root, 'first');
  assert.match(w.workspace, /\.git\/ideation\/workspaces\/first$/);
  assert.equal(await readFile(join(w.workspace, 'src/a.txt'), 'utf8'), 'baseline\n');
  assert.equal(await git(w.workspace, 'branch', '--show-current'), 'ideation/first');
  const second = await api.createWorkspace(w.workspace, 'second');
  assert.equal(second.workspace, join(await realpath(root), '.git/ideation/workspaces/second'));
  await assert.rejects(api.createWorkspace(root, 'first'));
  await assert.rejects(api.createWorkspace(root, '../bad'));
  assert.equal(await git(root, 'status', '--porcelain'), before);
  assert.equal(await readFile(join(root, 'mine'), 'utf8'), 'untracked');
});
test('fingerprint covers tracked and untracked content, excluding generated packets', async t => {
  const root = await fixture(t), before = await api.sourceRevision(root);
  await mkdir(join(root, 'docs/ideation/.native/run'), { recursive: true });
  await writeFile(join(root, 'docs/ideation/.native/run/spec.md'), 'packet');
  await writeFile(join(root, '.ideation-policy-test'), 'host');
  assert.equal(await api.sourceRevision(root), before);
  await writeFile(join(root, 'new file'), 'one');
  const first = await api.sourceRevision(root);
  assert.notEqual(first, before);
  await writeFile(join(root, 'new file'), 'two');
  assert.notEqual(await api.sourceRevision(root), first);
  await writeFile(join(root, 'src/a.txt'), 'modified');
  assert.deepEqual(await api.changedFiles(root), ['new file', 'src/a.txt']);
});
test('scope rejects rename old side, traversal, prefix confusion, protected paths and symlink aliases', async t => {
  const root = await fixture(t);
  await git(root, 'mv', 'src/a.txt', 'src/renamed file.txt');
  assert.deepEqual(await api.changedFiles(root), ['src/a.txt', 'src/renamed file.txt']);
  await assert.rejects(api.assertScope(root, ['src/renamed file.txt']), /scope/);
  await api.assertScope(root, ['src/']);
  for (const p of ['../src/', '/src/', 'src/../', 'src//', '.git/', 'package.json']) await assert.rejects(api.assertScope(root, [p]));
  await symlink(join(root, 'package.json'), join(root, 'src/link'));
  await assert.rejects(api.assertScope(root, ['.']), /Symlink/);
  await assert.rejects(api.assertScope(root, ['sr']), /scope/);
});
test('policy uses Pi path/command, exact commands and immutable outside-workspace generated code', async t => {
  const root = await fixture(t), w = await api.createWorkspace(root, 'policy');
  const authority = { paths: ['src/'], commands: ['node --test'] };
  const event = (toolName, input) => ({ toolName, input });
  assert.equal(await api.checkToolPolicy(w.workspace, authority, event('write', { path: 'src/new' })), undefined);
  for (const path of ['../bad', '.git/config', 'package.json', '@src/new', 'src/../../bad']) assert.equal((await api.checkToolPolicy(w.workspace, authority, event('edit', { path }))).block, true);
  assert.equal(await api.checkToolPolicy(w.workspace, authority, event('bash', { command: 'node --test' })), undefined);
  for (const command of ['node --test; echo bad', 'git add .', 'git diff HEAD && pwd', ' node --test']) assert.equal((await api.checkToolPolicy(w.workspace, authority, event('bash', { command }))).block, true);
  const path = await api.writePolicy(join(root, '.git/ideation/runs/policy'), w.workspace, authority, root);
  let handler;
  await (await import(pathToFileURL(path))).default({ on: (name, fn) => { assert.equal(name, 'tool_call'); handler = fn; } });
  authority.paths.push('.');
  assert.equal((await handler(event('write', { path: 'other' }))).block, true);
  await assert.rejects(api.writePolicy(join(w.workspace, 'bad-policy'), w.workspace, authority, root), /outside/);
  const broad = await api.writePolicy(join(root, '.git/ideation/runs/broad'), w.workspace, { paths: ['.'], commands: [] }, root);
  await (await import(pathToFileURL(broad))).default({ on: (_name, fn) => { handler = fn; } });
  for (const path of ['requirements-dev.txt', 'COMPOSER.JSON', '.gitignore', '.gitattributes', 'node_modules/dependency/index.js', '.venv/lib/dependency.py', 'docs/ideation/.native/run/spec.md']) {
    assert.equal((await handler(event('edit', { path }))).block, true, path);
  }
});
test('checks produce bounded real evidence and invalidate all objective evidence on mutation', async t => {
  const root = await fixture(t);
  const results = await api.runChecks(root, [
    { id: 'yes', check: { cmd: 'printf ok', expect: 'ok' } },
    { id: 'no', check: { cmd: 'exit 3' } },
    { id: 'human', check: { judgment: 'looks good' } },
    { id: 'large', check: { cmd: `node -e 'process.stdout.write("x".repeat(100000))'` } },
  ], { timeoutMs: 1000 });
  assert.deepEqual(results.map(r => r.status), ['passed', 'failed', 'pending', 'passed']);
  assert.equal(results[0].output, 'ok'); assert.ok(results[3].output.length <= 8192);
  const mutated = await api.runChecks(root, [{ id: 'before', check: { cmd: 'true' } }, { id: 'mutate', check: { cmd: 'echo changed > src/a.txt' } }], { timeoutMs: 1000 });
  assert.ok(mutated.every(r => r.status === 'failed' && r.output.includes('mutated')));
});
test('timeout and cancellation settle and kill process-group descendants, including redirected backgrounds', async t => {
  const root = await fixture(t);
  for (const mode of ['timeout', 'abort', 'background']) {
    const pidfile = join(root, '.ideation-policy-pid');
    const controller = new AbortController();
    const cmd = `node -e 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)' >/dev/null 2>&1 & echo $! > '${pidfile}'; ${mode === 'background' ? 'exit 0' : 'wait'}`;
    const timer = mode === 'abort' ? setTimeout(() => controller.abort(), 120) : undefined;
    const start = Date.now();
    const [result] = await api.runChecks(root, [{ id: mode, check: { cmd } }], { timeoutMs: 200, signal: controller.signal });
    clearTimeout(timer);
    assert.ok(Date.now() - start < 2000);
    assert.equal(result.status, 'failed');
    const pid = Number(await readFile(pidfile, 'utf8'));
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      try { process.kill(pid, 0); await new Promise(r => setTimeout(r, 25)); } catch (e) { if (e.code === 'ESRCH') alive = false; else throw e; }
    }
    assert.equal(alive, false, `lingering ${mode} child ${pid}`);
  }
});
test('commit preparation cannot hang on a clean filter after cancellation', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'src/a.txt'), 'pending\n');
  const revision = await api.sourceRevision(root);
  const marker = join(root, '.git/filter-started');
  const filter = join(root, '.git/slow-clean');
  await writeFile(filter, `#!/bin/sh\necho $$ > '${marker}'\nsleep 30\ncat\n`);
  await chmod(filter, 0o755);
  await git(root, 'config', 'filter.slow.clean', filter);
  await writeFile(join(root, '.git/info/attributes'), 'src/*.txt filter=slow\n');
  const controller = new AbortController();
  const startedAt = Date.now();
  const rejected = assert.rejects(api.commitWorkspace(root, ['src/'], { message: 'must not hang', sourceRevision: revision, signal: controller.signal, timeoutMs: 5000 }), /Cancelled|aborted/i);
  let started = false;
  for (let i = 0; i < 150 && !started; i++) { started = Boolean(await readFile(marker).catch(() => null)); if (!started) await new Promise(r => setTimeout(r, 10)); }
  controller.abort();
  await rejected;
  assert.ok(started, 'the real Git filter was entered');
  assert.ok(Date.now() - startedAt < 4000, 'abort applies to Git preparation, not only git commit');
});

test('stop and timeout bound commit hooks without bypassing signing or losing local changes', async t => {
  const root = await fixture(t);
  const hooks = join(root, '.git/hooks');
  await git(root, 'config', 'core.hooksPath', hooks);
  const marker = join(root, '.git/hook-started');
  await writeFile(join(hooks, 'pre-commit'), `#!/bin/sh\necho $$ > '${marker}'\nsleep 30\n`);
  await chmod(join(hooks, 'pre-commit'), 0o755);
  const head = await git(root, 'rev-parse', 'HEAD');
  await writeFile(join(root, 'src/a.txt'), 'pending\n');
  for (const mode of ['timeout', 'abort']) {
    await rm(marker, { force: true });
    const controller = new AbortController();
    const outcome = api.commitWorkspace(root, ['src/'], { message: 'scoped change', sourceRevision: await api.sourceRevision(root), signal: controller.signal, timeoutMs: mode === 'timeout' ? 1500 : 5000 });
    const rejected = assert.rejects(outcome, /commit did not finish|aborted/i);
    if (mode === 'abort') {
      let started = false;
      for (let i = 0; i < 100 && !started; i++) { started = Boolean(await readFile(marker).catch(() => null)); if (!started) await new Promise(r => setTimeout(r, 10)); }
      controller.abort();
      assert.ok(started, 'hook must actually be running before cancellation');
    }
    await rejected;
    assert.equal(await git(root, 'rev-parse', 'HEAD'), head);
    assert.equal(await readFile(join(root, 'src/a.txt'), 'utf8'), 'pending\n');
  }
});

test('review shows new files without staging contents; commit is scoped and source bound', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'src/new file'), 'new content\n');
  await api.prepareReview(root, ['src/']);
  assert.match(await git(root, 'diff', 'HEAD'), /new content/);
  assert.equal(await git(root, 'diff', '--cached'), '');
  const revision = await api.sourceRevision(root);
  await assert.rejects(api.commitWorkspace(root, ['src/'], { message: 'change', sourceRevision: 'stale' }), /Stale/);
  const sha = await api.commitWorkspace(root, ['src/'], { message: 'change', sourceRevision: revision });
  assert.equal(sha, await git(root, 'rev-parse', 'HEAD'));
  assert.deepEqual(await api.changedFiles(root), []);
  assert.equal(await api.commitWorkspace(root, ['src/'], { sourceRevision: await api.sourceRevision(root) }), null);
});
test('commit honors rejecting and source-mutating hooks without undoing user data', async t => {
  const root = await fixture(t), hook = join(root, '.git/hooks/pre-commit');
  await writeFile(join(root, 'src/a.txt'), 'new content');
  await writeFile(hook, '#!/bin/sh\nexit 1\n'); await chmod(hook, 0o755);
  const head = await git(root, 'rev-parse', 'HEAD');
  await assert.rejects(api.commitWorkspace(root, ['src/'], { message: 'change', sourceRevision: await api.sourceRevision(root) }));
  assert.equal(await git(root, 'rev-parse', 'HEAD'), head);
  await writeFile(hook, '#!/bin/sh\necho hook > src/a.txt\ngit add src/a.txt\n');
  let failure;
  await assert.rejects(api.commitWorkspace(root, ['src/'], { message: 'change', sourceRevision: await api.sourceRevision(root) }), e => { failure = e; return /hooks changed/.test(e.message); });
  const actual = await git(root, 'rev-parse', 'HEAD');
  assert.notEqual(actual, head); // Successful hook-mutated commit is deliberately retained.
  assert.equal(failure.commitHash, actual);
  assert.ok(failure.message.includes(actual));
  assert.equal(await git(root, 'show', 'HEAD:src/a.txt'), 'hook');
  assert.equal(await readFile(join(root, 'src/a.txt'), 'utf8'), 'hook\n');
});

test('uncommitted paths count a rename once and leave host-written paths out', async t => {
  const root = await fixture(t);
  await git(root, 'mv', 'src/a.txt', 'src/renamed.txt');
  await writeFile(join(root, 'loose.txt'), 'untracked');
  await mkdir(join(root, '.pi/artifacts'), { recursive: true });
  await writeFile(join(root, '.pi/artifacts/preview.html'), '<p>preview</p>');
  await mkdir(join(root, 'docs/ideation/demo'), { recursive: true });
  await writeFile(join(root, 'docs/ideation/demo/brief.json'), '{}');
  assert.deepEqual(await api.uncommittedPaths(root, { exclude: ['docs/ideation/demo/'] }), ['loose.txt', 'src/renamed.txt']);
  assert.deepEqual(await api.uncommittedPaths(root), ['docs/ideation/demo/brief.json', 'loose.txt', 'src/renamed.txt']);
});

test('a run\'s work exports as one patch (commits, edits, new files; no host packets) and applies all-or-nothing', async t => {
  const root = await fixture(t);
  const base = await git(root, 'rev-parse', 'HEAD');
  const { workspace } = await api.createWorkspace(root, 'leave-run');
  t.after(() => git(root, 'worktree', 'remove', '--force', workspace).catch(() => {}));
  await writeFile(join(workspace, 'src/a.txt'), 'committed by the run\n');
  await git(workspace, 'add', 'src/a.txt'); await git(workspace, 'commit', '-m', 'run commit');
  await writeFile(join(workspace, 'src/b.txt'), 'uncommitted new file\n');
  await mkdir(join(workspace, 'docs/ideation/.native/leave-run'), { recursive: true });
  await writeFile(join(workspace, 'docs/ideation/.native/leave-run/spec-phase-1.md'), 'host packet');
  const out = await api.workPatch(workspace, base);
  assert.deepEqual(out.files, ['src/a.txt', 'src/b.txt'], 'host packets never travel');
  const status = await git(workspace, 'status', '--porcelain');
  assert.match(status, /src\/b\.txt/, 'the worktree itself is untouched');

  assert.deepEqual(await api.applyWork(root, out.patch), { applied: true });
  assert.equal(await readFile(join(root, 'src/a.txt'), 'utf8'), 'committed by the run\n');
  assert.equal(await readFile(join(root, 'src/b.txt'), 'utf8'), 'uncommitted new file\n');
  assert.equal(await git(root, 'rev-parse', 'HEAD'), base, 'arrives as uncommitted changes, not commits');

  // A conflicting checkout gets nothing half-applied.
  await git(root, 'checkout', '--', 'src/a.txt'); await rm(join(root, 'src/b.txt'));
  await writeFile(join(root, 'src/a.txt'), 'your own edit\n');
  const refused = await api.applyWork(root, out.patch);
  assert.equal(refused.applied, false);
  assert.ok(refused.reason);
  assert.equal(await readFile(join(root, 'src/a.txt'), 'utf8'), 'your own edit\n');
  await assert.rejects(readFile(join(root, 'src/b.txt')), /ENOENT/);
});
