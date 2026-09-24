import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat, readlink, realpath, cp, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve, relative, join, isAbsolute, dirname } from 'node:path';

const gitControls = new AsyncLocalStorage();
/** timeoutMs: Infinity means no deadline; the signal still cancels. */
export function withGitControl({ signal, timeoutMs = 30000 }, action) {
  signal?.throwIfAborted();
  if (Number.isNaN(timeoutMs) || timeoutMs <= 0) throw new Error('Git operation budget exhausted');
  return gitControls.run({ signal, deadline: Date.now() + timeoutMs }, action);
}
export async function gitText(cwd, args, { literal = true, env = {} } = {}) {
  const control = gitControls.getStore();
  control?.signal?.throwIfAborted();
  const timeoutMs = control ? control.deadline - Date.now() : 30000;
  if (timeoutMs <= 0) throw new Error('Git operation budget exhausted');
  const result = await runProcess(cwd, 'git', [...(literal ? ['--literal-pathspecs'] : []), ...args], {
    signal: control?.signal, timeoutMs, maxOutput: 64 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...env },
  });
  if (!result.ok) throw new Error(`Git ${args[0]} did not finish: ${result.reason || ''}\n${result.output.slice(-8192)}`);
  return result.stdout;
}
const git = (cwd, ...args) => gitText(cwd, args);
const split = text => text.split('\0').filter(Boolean);
const generated = p => p === 'docs/ideation/.native' || p.startsWith('docs/ideation/.native/') || p.split('/').some(s => s.startsWith('.ideation-policy'));
// One case-insensitive boundary shared by brief validation and child policy.
// Keep this module self-contained: writePolicy copies it outside the child tree.
export const isProtectedPath = p => generated(p.toLowerCase()) || p.split('/').some(s =>
  /^\.(git|pi|gitignore|gitattributes|gitmodules|venv)$/i.test(s) || /^node_modules$/i.test(s) || /^\.ideation/i.test(s) ||
  /^(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-(lock\.yaml|workspace\.yaml)|bun\.lockb?|deno\.(jsonc?|lock)|Cargo\.(toml|lock)|pyproject\.toml|poetry\.lock|uv\.lock|pdm\.lock|requirements.*\.txt|Pipfile(\.lock)?|setup\.(py|cfg)|Gemfile(\.lock)?|gems\.rb|gems\.locked|.*\.gemspec|composer\.(json|lock)|go\.(mod|sum|work|work\.sum)|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle\.(properties|lockfile)|libs\.versions\.toml|pom\.xml|build\.sbt|mix\.(exs|lock)|rebar\.(config|lock)|pubspec\.(yaml|lock)|Package\.(swift|resolved)|.*\.(csproj|fsproj|vbproj)|packages\.lock\.json|Directory\.Packages\.props)$/i.test(s));
function validPath(p, directory = false) {
  if (typeof p !== 'string' || !p || isAbsolute(p) || /[\\\0]/.test(p) || /^[A-Za-z]:/.test(p)) throw new Error('Invalid scope path');
  const parts = (directory && p.endsWith('/') ? p.slice(0, -1) : p).split('/');
  if (parts.some(s => !s || s === '.' || s === '..')) throw new Error(`Invalid scope path: ${p}`);
}
function scopes(paths) {
  if (!Array.isArray(paths) || !paths.length) throw new Error('Missing scope paths');
  for (const p of paths) if (p !== '.') { validPath(p, true); if (isProtectedPath(p)) throw new Error(`Protected scope: ${p}`); }
}
const allowed = (p, paths) => !isProtectedPath(p) && paths.some(s => s === '.' || (s.endsWith('/') ? p.startsWith(s) : p === s));
async function safePath(workspace, p, paths) {
  validPath(p);
  if (!allowed(p, paths)) throw new Error(`Outside scope or protected path: ${p}`);
  const root = await realpath(workspace);
  let current = root;
  // Fail closed on all symlinks, including internal aliases into protected files.
  for (const part of p.split('/')) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error(`Symlink path denied: ${p}`); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

// Paths the host itself writes into a checkout. They are never "your" work.
const hostWritten = (p, exclude) => p.startsWith('.pi/artifacts/') ||
  exclude.some(e => { const dir = e.replace(/\/+$/, ''); return p === dir || p.startsWith(`${dir}/`); });

/** Uncommitted work in a checkout — tracked edits, staged changes and untracked
 * files — minus paths the host writes itself. Reading it never changes it. */
export async function uncommittedPaths(repoRoot, { exclude = [] } = {}) {
  const tokens = split(await git(repoRoot, 'status', '--porcelain', '-z', '--untracked-files=all'));
  const paths = [];
  for (let i = 0; i < tokens.length; i++) {
    paths.push(tokens[i].slice(3));
    if (/^[RC]/.test(tokens[i])) i++; // a rename/copy is followed by its original path
  }
  return [...new Set(paths)].filter(p => !hostWritten(p, exclude)).sort();
}

/** A commit of the checkout exactly as it is now, built in a private index, so
 * the user's files, index and HEAD are never touched. Returns null when there
 * is nothing beyond HEAD to include. `ref` keeps it alive until a branch does. */
export async function snapshotWorkingTree(repoRoot, { ref, exclude = [], message }) {
  const common = resolve(repoRoot, (await git(repoRoot, 'rev-parse', '--git-common-dir')).trim());
  const index = join(common, 'ideation', `snapshot-${randomUUID()}.index`);
  await mkdir(dirname(index), { recursive: true });
  const env = { GIT_INDEX_FILE: index };
  try {
    await gitText(repoRoot, ['read-tree', 'HEAD'], { env });
    await gitText(repoRoot, ['add', '-A', '--', '.'], { env });
    // Host-written paths keep HEAD's version (committed copies are not deleted).
    // Naming them to `add` instead would fail wherever they are gitignored.
    await gitText(repoRoot, ['reset', '-q', 'HEAD', '--', '.pi/artifacts', ...exclude.map(e => e.replace(/\/+$/, ''))], { env });
    const tree = (await gitText(repoRoot, ['write-tree'], { env })).trim();
    const head = (await git(repoRoot, 'rev-parse', 'HEAD')).trim();
    if (tree === (await git(repoRoot, 'rev-parse', 'HEAD^{tree}')).trim()) return null;
    // Honour a signing policy: this commit ends up in the run branch's history.
    const signed = (await git(repoRoot, 'config', '--bool', 'commit.gpgsign').catch(() => '')).trim() === 'true';
    const commit = (await git(repoRoot, 'commit-tree', ...(signed ? ['-S'] : []), tree, '-p', head, '-m', message)).trim();
    await git(repoRoot, 'update-ref', ref, commit);
    return commit;
  } finally {
    await rm(index, { force: true });
  }
}

export async function createWorkspace(repoRoot, runId, base = 'HEAD') {
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,150}$/.test(runId)) throw new Error('Invalid run ID');
  const common = resolve(repoRoot, (await git(repoRoot, 'rev-parse', '--git-common-dir')).trim());
  const baseRevision = (await git(repoRoot, 'rev-parse', '--verify', `${base}^{commit}`)).trim();
  const workspace = join(await realpath(common), 'ideation', 'workspaces', runId);
  const branch = `ideation/${runId}`;
  await mkdir(dirname(workspace), { recursive: true });
  await git(repoRoot, 'worktree', 'add', '-b', branch, workspace, baseRevision);
  return { workspace, branch, baseRevision };
}

/** Reuse the approved checkout's installed environment without executing an
 * unapproved install command. A private reflink/copy avoids a writable symlink
 * back into the user's checkout. Never copy across a manifest/lock mismatch.
 */
export async function prepareDependencies(repoRoot, workspace, { signal } = {}) {
  signal?.throwIfAborted();
  // Use the approved worktree's manifests, not new packages added elsewhere
  // since approval. pnpm package-local links need the same relative layout.
  const manifests = split(await git(workspace, 'ls-files', '-z')).filter(p => p === 'package.json' || p.endsWith('/package.json'));
  const directories = [...new Set(['.', ...manifests.filter(p => !p.split('/').includes('node_modules')).map(p => dirname(p))])];
  for (const directory of directories) {
    signal?.throwIfAborted();
    await preparePackageDependencies(join(repoRoot, directory), join(workspace, directory), signal);
  }
}
async function preparePackageDependencies(repoRoot, workspace, signal) {
  const target = join(workspace, 'node_modules');
  if (await lstat(target).catch(() => null)) return;
  const source = join(repoRoot, 'node_modules');
  if (!await lstat(source).catch(() => null)) return;
  const files = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'bun.lock', 'bun.lockb', 'yarn.lock'];
  const bytes = p => readFile(p).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  for (const file of files) {
    const [original, approved] = await Promise.all([bytes(join(repoRoot, file)), bytes(join(workspace, file))]);
    if ((original === null) !== (approved === null) || (original && !original.equals(approved))) throw new Error(`Cannot prepare dependencies: ${file} differs from the approved source. Restore the matching installed environment before resuming.`);
  }
  // Require an existing ignore rule; do not edit the repository's ignore policy.
  // check-ignore rejects --literal-pathspecs; this path is a fixed host constant.
  try { await gitText(workspace, ['check-ignore', '--quiet', 'node_modules/'], { literal: false }); }
  catch { throw new Error('Dependencies need setup: node_modules is not ignored in the approved checkout. No install or source changes were made.'); }
  const temporary = join(dirname(workspace), `.dependencies-${randomUUID()}`);
  try {
    signal?.throwIfAborted();
    await cp(await realpath(source), temporary, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE,
      filter: () => { signal?.throwIfAborted(); return true; } });
    signal?.throwIfAborted();
    await rename(temporary, target);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function changedFiles(workspace) {
  // --no-renames represents both sides of every rename as delete + add.
  const tracked = split(await git(workspace, 'diff', '--name-only', '--no-renames', '-z', 'HEAD'));
  // Ignored generated/test outputs (including node_modules) are not source
  // evidence. Tracked files remain evidence even when an ignore rule matches.
  // Children cannot edit .gitignore/.gitattributes to conceal source changes.
  const untracked = split(await git(workspace, 'ls-files', '--others', '--exclude-standard', '-z'));
  const staged = split(await git(workspace, 'diff', '--cached', '--name-only', '--no-renames', '-z', 'HEAD'));
  return [...new Set([...tracked, ...staged, ...untracked])].filter(p => !generated(p)).sort();
}

export async function sourceRevision(workspace) {
  const hash = createHash('sha256');
  const add = value => { const b = Buffer.from(value); hash.update(`${b.length}:`); hash.update(b); };
  add((await git(workspace, 'rev-parse', 'HEAD')).trim());
  // Include index state, even if staged changes were subsequently undone on disk.
  for (const mode of [[], ['--cached']]) {
    const names = split(await git(workspace, 'diff', ...mode, '--name-only', '--no-renames', '-z', 'HEAD')).filter(p => !generated(p)).sort();
    for (const p of names) { add(p); add(await git(workspace, 'diff', ...mode, '--binary', '--no-ext-diff', '--no-textconv', 'HEAD', '--', p)); }
  }
  for (const p of (await changedFiles(workspace))) {
    add(p);
    try {
      const stat = await lstat(join(workspace, p));
      add(String(stat.mode));
      if (stat.isSymbolicLink()) add(await readlink(join(workspace, p)));
      else if (stat.isFile()) add(await readFile(join(workspace, p)));
      else throw new Error(`Unsupported source file: ${p}`);
    } catch (e) { if (e.code === 'ENOENT') add('deleted'); else throw e; }
  }
  return hash.digest('hex');
}

export async function assertScope(workspace, paths) {
  scopes(paths);
  for (const p of await changedFiles(workspace)) await safePath(workspace, p, paths);
  // Host packets may be present, but must never have been staged by a child.
  for (const p of split(await git(workspace, 'diff', '--cached', '--name-only', '-z', 'HEAD'))) {
    if (generated(p)) throw new Error(`Protected staged packet: ${p}`);
  }
}

// Approved commands/test scripts are trusted code, NOT an OS sandbox. Process
// groups contain ordinary descendants, not hostile code that calls setsid().
async function runProcess(workspace, executable, args, { signal, timeoutMs, env, maxOutput = 8192 }) {
  if (signal?.aborted) return { ok: false, output: 'Cancelled', stdout: '', durationMs: 0 };
  const start = Date.now();
  return new Promise(resolveResult => {
    const child = spawn(executable, args, { cwd: workspace, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = Buffer.alloc(0), stdout = Buffer.alloc(0), bytes = 0, reason = '', escalation, killed = false;
    const kill = sig => {
      if (!child.pid || killed) return;
      try { if (process.platform !== 'win32') process.kill(-child.pid, sig); else child.kill(sig); }
      catch (e) { if (e.code !== 'ESRCH') reason ||= `Process-group cancellation failed: ${e.message}`; }
      if (sig === 'SIGKILL') killed = true;
    };
    const cancel = why => { if (reason) return; reason = why; kill('SIGTERM'); escalation = setTimeout(() => kill('SIGKILL'), 75); };
    const abort = () => cancel('Cancelled');
    // No deadline unless one is given (setTimeout would fire at once for Infinity).
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0 ? setTimeout(() => cancel('Timed out'), timeoutMs) : undefined;
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const collect = chunk => { bytes += chunk.length; output = Buffer.concat([output, chunk]).subarray(-maxOutput); if (maxOutput > 8192 && bytes > maxOutput) cancel('Output limit exceeded'); };
    child.stdout.on('data', chunk => { stdout = Buffer.concat([stdout, chunk]).subarray(-maxOutput); collect(chunk); }); child.stderr.on('data', collect);
    child.on('error', e => { reason = e.message; });
    // Even a shell exiting zero must not leave redirected background children.
    child.on('exit', () => {
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, 0); reason ||= 'Command left background processes'; }
        catch (e) { if (!['ESRCH', 'EPERM'].includes(e.code)) reason ||= e.message; }
      }
      kill('SIGKILL');
    });
    child.on('close', code => {
      clearTimeout(timer); clearTimeout(escalation); signal?.removeEventListener('abort', abort);
      kill('SIGKILL');
      // Allow the kernel to reap descendants before evidence is inspected.
      setTimeout(() => resolveResult({ ok: code === 0 && !reason, output: `${reason ? `${reason}\n` : ''}${output.toString('utf8')}`.slice(-maxOutput), stdout: stdout.toString('utf8'), reason, durationMs: Date.now() - start }), reason || executable === '/bin/sh' ? 25 : 0);
    });
  });
}

const command = (workspace, cmd, options) => runProcess(workspace, '/bin/sh', ['-c', cmd], options);

/** Checks run until they finish or the run is stopped: there is no time limit by default. */
export async function runChecks(workspace, criteria, { signal, timeoutMs = Infinity } = {}) {
  if (Number.isNaN(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid check timeout');
  const revision = await sourceRevision(workspace), evidence = [];
  let mutated = false;
  for (const c of criteria) {
    const item = { criterionId: c.id, status: 'pending', sourceRevision: revision };
    if (typeof c.check?.cmd === 'string') {
      item.command = c.check.cmd;
      if (c.check.expect !== undefined) item.expected = c.check.expect;
      const result = mutated ? { ok: false, output: 'Source mutated by checks', durationMs: 0 } : await command(workspace, c.check.cmd, { signal, timeoutMs });
      mutated ||= await sourceRevision(workspace) !== revision;
      Object.assign(item, { status: result.ok && !mutated ? 'passed' : 'failed', output: result.output, durationMs: result.durationMs });
    }
    evidence.push(item);
  }
  if (await sourceRevision(workspace) !== revision) mutated = true;
  if (mutated) for (const item of evidence) if (item.command !== undefined) { item.status = 'failed'; item.output = `Source mutated by checks\n${item.output ?? ''}`.slice(0, 8192); }
  return evidence;
}

export function prepareReview(workspace, paths, options = {}) {
  return withGitControl(options, () => prepareReviewControlled(workspace, paths));
}
async function prepareReviewControlled(workspace, paths) {
  await assertScope(workspace, paths);
  const fresh = split(await git(workspace, 'ls-files', '--others', '--exclude-standard', '-z')).filter(p => !generated(p));
  for (const p of fresh) await git(workspace, 'add', '-N', '--', p);
}

export function commitWorkspace(workspace, paths, options = {}) {
  // Commit hooks may run a whole test suite; there is no deadline, only the stop signal.
  return withGitControl({ timeoutMs: Infinity, ...options }, () => commitWorkspaceControlled(workspace, paths, options));
}
async function commitWorkspaceControlled(workspace, paths, { message, specPath, sourceRevision: expected, signal, timeoutMs = Infinity } = {}) {
  signal?.throwIfAborted();
  if (Number.isNaN(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid commit timeout');
  if (!expected || expected !== await sourceRevision(workspace)) throw new Error('Stale source revision');
  await assertScope(workspace, paths);
  const files = await changedFiles(workspace);
  if (!files.length) return null;
  if (typeof message !== 'string' || !message.trim()) throw new Error('Commit message required');
  // specPath is provenance only; never stage host-generated packets.
  void specPath;
  for (const p of files) await git(workspace, 'add', '--', p);
  const tree = (await git(workspace, 'write-tree')).trim();
  signal?.throwIfAborted();
  try { await git(workspace, 'commit', '-m', message); }
  catch (e) { throw new Error(`Local commit did not finish: ${e.message}. Signing and hooks were not bypassed; inspect the workspace before retrying.`); }
  const sha = (await git(workspace, 'rev-parse', 'HEAD')).trim();
  if ((await git(workspace, 'rev-parse', 'HEAD^{tree}')).trim() !== tree || (await changedFiles(workspace)).length) {
    // Do not reset: preserve the actual hook-produced commit and working tree
    // on the failed run branch for inspection, without blessing stale evidence.
    const error = new Error(`Commit hooks changed source; evidence is stale; actual HEAD: ${sha}`);
    error.commitHash = sha;
    throw error;
  }
  await assertScope(workspace, paths);
  return sha;
}

export async function checkToolPolicy(workspace, authority, event) {
  try {
    scopes(authority.paths);
    if (event.toolName === 'write' || event.toolName === 'edit') {
      const raw = event.input?.path;
      if (typeof raw !== 'string' || raw.startsWith('@') || raw.startsWith('~')) throw new Error('Invalid tool path');
      const p = isAbsolute(raw) ? relative(resolve(workspace), raw) : raw;
      await safePath(workspace, p, authority.paths);
    } else if (event.toolName === 'bash') {
      const commands = [...(authority.commands ?? []), 'git diff HEAD', 'git status --short', 'git log -5 --oneline'];
      if (!commands.includes(event.input?.command)) throw new Error('Command is not exactly approved');
    } else if (!['read', 'grep', 'find', 'ls'].includes(event.toolName)) throw new Error('Unapproved tool');
  } catch (e) { return { block: true, reason: e.message }; }
}

export async function childPolicy(pi, workspace, authority) {
  const snapshot = structuredClone(authority);
  pi.on('tool_call', event => checkToolPolicy(workspace, snapshot, event));
}

export async function writePolicy(runDir, workspace, authority, pluginRoot) {
  void pluginRoot;
  const root = await realpath(workspace);
  await mkdir(runDir, { recursive: true });
  const dir = await realpath(runDir);
  const rel = relative(root, dir);
  if (!rel || (!rel.startsWith('../') && !isAbsolute(rel))) throw new Error('Policy must be outside editable workspace');
  scopes(authority.paths);
  // Copy implementation too: importing an editable workspace module would let
  // the child rewrite its own gate before the next stage loads the extension.
  const suffix = randomUUID();
  const implementation = join(dir, `policy-host-${suffix}.mjs`);
  await writeFile(implementation, await readFile(new URL(import.meta.url)), { flag: 'wx', mode: 0o400 });
  const path = join(dir, `child-policy-${suffix}.mjs`);
  await writeFile(path, `import { childPolicy } from './policy-host-${suffix}.mjs';\nexport default pi => childPolicy(pi, ${JSON.stringify(root)}, ${JSON.stringify(authority)});\n`, { flag: 'wx', mode: 0o400 });
  return path;
}
