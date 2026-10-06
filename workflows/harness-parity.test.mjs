// Harness parity: one approved plan through both harnesses' hand-offs.
//
//   Pi:          ideation_change prepare with plan: <folder> (the extension, with
//                stubbed Pi services), then unit commits as the change runner's
//                host makes them, in a workspace from change-workspace.
//   Claude Code: node scripts/plan-data.ts run-contract <folder>, then what
//                autopilot and execute-spec read (plan-data.ts manifest and the
//                unit-<id>.md packets), then unit commits as the engine's agent
//                commit stage is told to make them.
//
// Both must freeze the same run contract, hand out the same packets, and reach
// the same VERIFY line. Nothing here calls a model or opens a browser; every
// spawned process has a timeout, and the scratch repositories are removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { briefFingerprint, workPacket } from './change-brief.mjs';
import { unitCommitMessage } from './change-run.mjs';
import { commitWorkspace, createWorkspace, sourceRevision } from './change-workspace.mjs';
import { PACKET_PLAN, packetFile } from '../scripts/plan-data.ts';
import { unitTrailer } from '../scripts/verify.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLAN = join(ROOT, 'test-fixtures', 'plan', 'plan.json');
const FOLDER = 'docs/ideation/send-retry';
const TIMEOUT = 60_000;

// The extension with Pi's packages stubbed, as in change-extension.test.mjs.
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@nicknisi/pi-shared') return { url: 'data:text/javascript,export const createSubagentRuntime=()=>{throw new Error("unexpected runtime")}', shortCircuit: true };
  if (specifier === 'typebox') return { url: 'data:text/javascript,export const Type=new Proxy({}, {get:(_,k)=>(...args)=>({kind:k,args})})', shortCircuit: true };
  return next(specifier, context);
} });
const { registerChange } = await import('../extensions/change.ts');
hooks.deregister();

function run(cmd, args, cwd, env = process.env) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: TIMEOUT, env });
  assert.equal(r.error, undefined, `${cmd} ${args.join(' ')}: ${r.error?.message}`);
  return r;
}
const git = (cwd, ...args) => {
  const r = run('git', args, cwd);
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A scratch repository holding the plan fixture, committed. */
function repo(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `parity-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'parity@example.invalid');
  git(dir, 'config', 'user.name', 'Parity');
  git(dir, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, FOLDER), { recursive: true });
  writeFileSync(join(dir, FOLDER, 'plan.json'), readFileSync(PLAN));
  writeFileSync(join(dir, 'README.md'), 'parity\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'chore: plan');
  return dir;
}

/** What a unit's build leaves in src/: the same in both harnesses, so the checks agree. */
const UNIT_WORK = {
  worker: { 'src/retry.mjs': 'export const limit = 3;\n', 'src/retry.test.mjs': "import test from 'node:test';\ntest('retries', () => {});\n" },
  'outbox-label': { 'src/label.mjs': "export const GAVE_UP = 'Gave up after 3 tries';\n" },
};
const build = (dir, unitId) => {
  for (const [path, body] of Object.entries(UNIT_WORK[unitId])) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return Object.keys(UNIT_WORK[unitId]);
};

/** verify.mjs's VERIFY line for the plan folder, run as a CLI from `cwd`. */
function verify(cwd) {
  // A check that is itself `node --test` must not inherit this runner's child context.
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const r = run(process.execPath, [join(ROOT, 'scripts', 'verify.mjs'), FOLDER], cwd, env);
  return { code: r.status, line: r.stdout.match(/^VERIFY .*$/m)?.[0], out: r.stdout + r.stderr };
}

/** Pi: the extension prepares the plan, as the ideation skill tells the model to. */
async function piPrepare(t, root) {
  const handlers = {}, tools = {}, execs = [];
  const runner = { status: async () => [], dispose: async () => {} };
  const pi = {
    on: (n, f) => { handlers[n] = f; }, registerCommand() {}, registerTool: v => { tools[v.name] = v; },
    events: { emit() {} }, appendEntry() {}, sendUserMessage() {}, sendMessage() {},
    exec: async (cmd, args) => {
      execs.push([cmd, ...(args ?? [])]);
      return { code: 0, stdout: args?.includes('--show-toplevel') ? root : args?.includes('--git-common-dir') ? join(root, '.git') : '', stderr: '' };
    },
  };
  registerChange(pi, {
    createChangeRunner: () => runner,
    createSubagentRuntime: () => ({ spawn: async () => { throw new Error('no model calls'); } }),
    loadTui: async () => ({ visibleWidth: s => String(s).length, truncateToWidth: s => String(s), hyperlink: s => s }),
  });
  t.after(async () => { await handlers.session_shutdown?.(); });
  const ctx = { cwd: root, hasUI: false, model: { provider: 'p', id: 'm' },
    sessionManager: { getSessionId: () => 'session', getBranch: () => [] },
    ui: { confirm: async () => true, notify() {}, setStatus() {}, setWidget() {} } };
  const res = await tools.ideation_change.execute('', { action: 'prepare', plan: FOLDER }, null, null, ctx);
  assert.equal(res.details.approved, false, 'preparing never approves');
  assert.deepEqual(execs.filter(([cmd]) => cmd === 'open' || cmd === 'xdg-open'), [], 'nothing opened a page');
  return { brief: JSON.parse(readFileSync(res.details.briefPath, 'utf8')), fingerprint: res.details.briefHash };
}

test('one plan through both harnesses: the same run contract, the same packets, the same VERIFY line', async t => {
  // --- Pi ------------------------------------------------------------------
  const piRepo = repo(t, 'pi');
  const pi = await piPrepare(t, piRepo);
  // The change runner works in an isolated workspace and commits each unit,
  // once reviewed and checked, with its host commit message.
  const { workspace } = await createWorkspace(piRepo, 'parity');
  for (const unit of pi.brief.units) {
    build(workspace, unit.id);
    const hash = await commitWorkspace(workspace, pi.brief.authority.paths, {
      message: unitCommitMessage(pi.brief, unit), sourceRevision: await sourceRevision(workspace), timeoutMs: TIMEOUT,
    });
    assert.match(hash, /^[0-9a-f]{40}$/);
  }

  // --- Claude Code ------------------------------------------------------------
  const ccRepo = repo(t, 'cc');
  const plandata = (...args) => {
    const r = run(process.execPath, [join(ROOT, 'scripts', 'plan-data.ts'), ...args], ccRepo);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  plandata('run-contract', FOLDER); // run only after the terminal approval
  const cc = JSON.parse(readFileSync(join(ccRepo, FOLDER, 'run-contract.json'), 'utf8'));
  // Autopilot's input, used verbatim as the engine's args.
  const manifest = JSON.parse(plandata('manifest', FOLDER));
  assert.equal(manifest.packet, true);
  assert.equal(manifest.hostCommits, false);
  assert.equal(manifest.strict, true);
  assert.deepEqual(manifest.completedPhases, []);
  // The engine's agent commit stage stages the unit's files by name and ends the
  // message with the phase's trailer (execute-spec's Commit step does the same).
  for (const phase of manifest.phases) {
    const unit = cc.brief.units.find(u => u.title === phase.title);
    git(ccRepo, 'add', '--', ...build(ccRepo, unit.id));
    git(ccRepo, 'commit', '-q', '-m', `feat(${unit.id}): ${unit.title.toLowerCase()}\n\n${phase.trailer}`);
  }
  assert.deepEqual(JSON.parse(plandata('manifest', FOLDER)).completedPhases, manifest.phases.map(p => p.title), 'resume reads the same trailers');

  // --- 1. The run contract ------------------------------------------------------
  assert.deepEqual(pi.brief, cc.brief);
  assert.equal(pi.fingerprint, cc.fingerprint);
  assert.equal(briefFingerprint(pi.brief), cc.fingerprint);

  // --- 2. The unit packets ------------------------------------------------------
  // Claude Code's packets are what execute-spec and the engine read; Pi's change
  // runner writes workPacket(brief, unit, { plan, sourceRevision }) for the
  // approved brief. With the same plan text and source revision, they are the
  // same bytes.
  for (const [i, unit] of cc.brief.units.entries()) {
    const phase = manifest.phases[i];
    assert.equal(phase.specPath, `${FOLDER}/${packetFile(unit.id)}`);
    const packet = readFileSync(join(ccRepo, phase.specPath), 'utf8');
    const sourceRev = packet.match(/^Source revision: (.+)$/m)[1];
    assert.equal(sourceRev, git(ccRepo, 'rev-parse', 'HEAD~2'), 'written at the approved checkout');
    const piUnit = pi.brief.units.find(u => u.id === unit.id);
    assert.equal(packet, workPacket(pi.brief, piUnit, { plan: PACKET_PLAN, sourceRevision: sourceRev }), `${unit.id} packet`);
    assert.equal(phase.trailer, unitTrailer(pi.brief.id, piUnit.id));
  }

  // --- 3. The VERIFY line -------------------------------------------------------
  const piVerify = verify(workspace);
  const ccVerify = verify(ccRepo);
  t.diagnostic(`Pi:          ${piVerify.line}`);
  t.diagnostic(`Claude Code: ${ccVerify.line}`);
  assert.equal(piVerify.line, 'VERIFY send-retry: commits=2/2 pass=1 fail=0 judgment=1', piVerify.out);
  assert.equal(ccVerify.line, piVerify.line, ccVerify.out);
  assert.equal(piVerify.code, 0);
  assert.equal(ccVerify.code, 0);
  // Each harness's commits carry exactly the trailers the other's would.
  const trailers = (cwd, range) => git(cwd, 'log', '--format=%B', range).split('\n').filter(l => l.startsWith('Ideation-Unit: ')).sort();
  assert.deepEqual(trailers(workspace, 'main..HEAD'), trailers(ccRepo, 'HEAD~2..HEAD'));
});
