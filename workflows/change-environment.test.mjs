import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as workspace from './change-workspace.mjs';
const exec = promisify(execFile);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ideation-environment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => exec('git', ['-C', root, ...args]);
  await git('init'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'commit.gpgsign', 'false');
  await writeFile(join(root, '.gitignore'), 'node_modules/\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { 'fixture-dep': '1.0.0' } }));
  await writeFile(join(root, 'bun.lock'), 'locked fixture');
  await mkdir(join(root, 'node_modules/fixture-dep'), { recursive: true });
  await writeFile(join(root, 'node_modules/fixture-dep/index.js'), 'module.exports = 42;');
  await git('add', '.'); await git('commit', '-m', 'fixture');
  return { root, ...(await workspace.createWorkspace(root, 'environment')) };
}
test('new worktree can run with existing locked dependencies without installing or sharing writable files', async t => {
  const f = await fixture(t);
  await assert.rejects(access(join(f.workspace, 'node_modules/fixture-dep')));
  const before = await workspace.sourceRevision(f.workspace);
  await workspace.prepareDependencies(f.root, f.workspace);
  const result = await exec(process.execPath, ['-e', "console.log(require('fixture-dep'))"], { cwd: f.workspace });
  assert.equal(result.stdout.trim(), '42');
  assert.equal(await workspace.sourceRevision(f.workspace), before);
  await writeFile(join(f.workspace, 'node_modules/fixture-dep/index.js'), 'module.exports = 7;');
  assert.equal(await readFile(join(f.root, 'node_modules/fixture-dep/index.js'), 'utf8'), 'module.exports = 42;');
});
test('pnpm package-local dependency links are copied and repaired even when the root snapshot already exists', async t => {
  const f = await fixture(t);
  const git = (...args) => exec('git', ['-C', f.root, ...args]);
  await writeFile(join(f.root, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*'] }));
  await mkdir(join(f.root, 'packages/app/node_modules'), { recursive: true });
  await writeFile(join(f.root, 'packages/app/package.json'), JSON.stringify({ name: 'app', dependencies: { 'fixture-dep': '1.0.0' } }));
  await rm(join(f.root, 'node_modules/fixture-dep'), { recursive: true });
  await mkdir(join(f.root, 'node_modules/.pnpm/fixture-dep@1.0.0/node_modules/fixture-dep'), { recursive: true });
  await writeFile(join(f.root, 'node_modules/.pnpm/fixture-dep@1.0.0/node_modules/fixture-dep/index.js'), 'module.exports = 42;');
  await symlink('../../../node_modules/.pnpm/fixture-dep@1.0.0/node_modules/fixture-dep', join(f.root, 'packages/app/node_modules/fixture-dep'));
  await git('add', 'package.json', 'packages/app/package.json'); await git('commit', '-m', 'workspace fixture');
  const w = await workspace.createWorkspace(f.root, 'monorepo');
  for (let attempt = 0; attempt < 2; attempt++) {
    await workspace.prepareDependencies(f.root, w.workspace);
    const result = await exec(process.execPath, ['-e', "console.log(require('fixture-dep'))"], { cwd: join(w.workspace, 'packages/app') });
    assert.equal(result.stdout.trim(), '42');
    await rm(join(w.workspace, 'packages/app/node_modules'), { recursive: true });
  }
});

test('dependency snapshots refuse changed manifests/locks rather than silently using another environment', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'bun.lock'), 'different dependency graph');
  await assert.rejects(workspace.prepareDependencies(f.root, f.workspace), /dependencies|lock/i);
  await assert.rejects(access(join(f.workspace, 'node_modules')));
});
