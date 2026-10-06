import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateBrief, briefFingerprint } from './change-brief.mjs';

// Native type stripping plus narrow dependency stubs: no Pi install, no model calls, no paid work.
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@nicknisi/pi-shared') return { url: 'data:text/javascript,export const createSubagentRuntime=()=>{throw new Error("unexpected runtime")}', shortCircuit: true };
  if (specifier === 'typebox') return { url: 'data:text/javascript,export const Type=new Proxy({}, {get:(_,k)=>(...args)=>({kind:k,args})})', shortCircuit: true };
  return next(specifier, context);
} });
const { registerChange } = await import('../extensions/change.ts');
hooks.deregister();

const rawBrief = { schemaVersion: 1, id: 'demo', title: 'Demo', revision: 1, why: 'why',
  change: { before: 'before', after: 'after' }, mustHold: ['invariant'],
  acceptance: [{ id: 'a', criterion: 'works', check: { cmd: 'node --test' } }],
  units: [{ id: 'u', title: 'unit', goal: 'goal', risk: 'low', needs: [], acceptanceIds: ['a'] }],
  authority: { paths: ['src/'], commands: ['node --test'] } };
const brief = validateBrief(rawBrief);
const hash = briefFingerprint(brief);

/** Wait for background work on wall-clock time, not a fixed number of event-loop turns. */
const until = async (ready, ms = 5000) => { const end = Date.now() + ms; while (!ready() && Date.now() < end) await new Promise(r => setTimeout(r, 5)); };
// A durable-looking run record the renderer and selection logic accept.
const makeRun = (state, over = {}) => ({ id: 'r', repoRoot: '__ROOT__', ownerId: 'session', brief, briefHash: hash,
  sequence: 1, updatedAt: Date.now(), state, units: [], evidence: [], usage: { totalTokens: 0 }, ...over });

/** Build a mocked Pi frontdoor bound to a scratch repository. The runner/runtime are injected;
 * the artifact consumer is the real module, driven through the mocked service discovery bus. */
// Width helpers with pi-tui's shape; CI runs without installing Pi packages.
const tuiStub = {
  visibleWidth: s => [...String(s).replace(/\x1b\[[0-9;]*m/g, '')].length,
  truncateToWidth: (s, w, e = '…') => { const plain = [...String(s).replace(/\x1b\[[0-9;]*m/g, '')]; return plain.length <= w ? String(s) : plain.slice(0, Math.max(0, w - 1)).join('') + e; },
  hyperlink: text => text,
};
async function harness(t, { runner, service, runtime, hasUI = true, model = { provider: 'provider', id: 'model' } } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ideation-ext-'));
  const handlers = {}, commands = {}, tools = {}, sent = [], messages = [], entries = [], notifications = [];
  // Shut the session down first: it settles pending docs/ideation writes.
  t.after(async () => { await handlers.session_shutdown?.(); await rm(root, { recursive: true, force: true }); });
  const pi = {
    on: (n, f) => handlers[n] = f,
    registerCommand: (n, v) => commands[n] = v,
    registerTool: v => tools[v.name] = v,
    events: { emit(channel, payload) { if (channel.startsWith('plugin-services:v1:discover:') && service) payload.offer({ id: 'nicknisi.artifacts', apiMajor: 1, api: service }); } },
    appendEntry: (...a) => entries.push(a),
    sendUserMessage: (...a) => sent.push(a),
    sendMessage: (...a) => messages.push(a),
    exec: async (_cmd, args) => ({ code: 0, stdout: args?.includes('--show-toplevel') ? root : args?.includes('--git-common-dir') ? join(root, '.git') : '', stderr: '' }),
  };
  registerChange(pi, {
    createChangeRunner: opts => { runner._opts = opts; return runner; },
    createSubagentRuntime: () => runtime ?? ({ spawn: async () => { throw new Error('no model calls'); } }),
    loadTui: async () => tuiStub,
  });
  const ctx = { cwd: root, hasUI, model, sessionManager: { getSessionId: () => 'session', getBranch: () => entries.map(([customType, data]) => ({ type: 'custom', customType, data })) },
    ui: { confirm: async () => true, notify: m => notifications.push(m), setStatus() {}, setWidget() {} } };
  return { root, pi, handlers, commands, tools, ctx, sent, messages, entries, notifications };
}

test('the single /ideation entry point offers the next useful action without asking for paths', async t => {
  let approvals = 0;
  const runner = { status: async () => [], approve: async () => { approvals++; }, dispose: async () => {} };
  const h = await harness(t, { runner });
  h.ctx.ui.select = async () => { throw new Error('No pointless one-option menu'); };
  h.ctx.ui.input = async () => { throw new Error('Planning starts in conversation, not another form'); };
  await h.commands.ideation.handler('', h.ctx);
  assert.match(h.sent[0][0], /Start from this conversation/);
  assert.equal(approvals, 0);
  await h.tools.ideation_change.execute('', { action: 'prepare', brief: rawBrief }, null, null, h.ctx);
  h.ctx.ui.select = async (_title, choices) => {
    assert.ok(choices.includes('Review the proposed contract'));
    assert.ok(choices.includes('Approve and start'));
    assert.ok(choices.includes('Revise the change'));
    return 'Revise the change';
  };
  h.ctx.ui.input = async () => 'Keep the current keyboard shortcuts';
  await h.commands.ideation.handler('', h.ctx);
  assert.match(h.sent.at(-1)[0], /Keep the current keyboard shortcuts/);
  assert.match(h.sent.at(-1)[0], /Do not approve or execute/);
  assert.equal(approvals, 0);
});

test('preparing opens one contract and revisions update that same draft instead of creating more tabs', async t => {
  const published = [];
  const service = { publish: async input => { published.push(input); return { slug: input.title, url: `http://localhost:7/${input.title}`, absPath: `/tmp/${input.title}` }; }, subscribe: async () => () => {}, answer: async () => ({ ok: true }) };
  const h = await harness(t, { runner: { status: async () => [], dispose: async () => {} }, service });
  const first = await h.tools.ideation_change.execute('', { action: 'prepare', brief: rawBrief }, null, null, h.ctx);
  const second = await h.tools.ideation_change.execute('', { action: 'prepare', brief: { ...rawBrief, revision: 2, why: 'Clearer intent' } }, null, null, h.ctx);
  assert.equal(published[0].open, true);
  assert.equal(published[1].open, false);
  assert.equal(first.details.url, second.details.url);
  assert.equal(first.details.previewId, second.details.previewId);
  assert.match(published[1].html, /Revision delta/);
  assert.equal(second.details.approved, false);
  assert.ok(h.tools.ideation_change.renderCall && h.tools.ideation_change.renderResult, 'human-friendly tool cards, not raw JSON dumps');
});

test('explicit UI approval denied never approves; headless and model cannot approve', async t => {
  const calls = [];
  const runner = { status: async () => [], approve: async () => { calls.push('approve'); return makeRun('ready'); }, dispose: async () => calls.push('dispose') };
  const h = await harness(t, { runner, hasUI: false });
  await writeFile(join(h.root, 'b.json'), JSON.stringify(brief));
  // Headless is refused explicitly.
  await assert.rejects(h.commands.ideation.handler('approve b.json', h.ctx), /headless/);
  // The model tool has no approval action at all.
  await assert.rejects(h.tools.ideation_change.execute('', { action: 'approve' }, null, null, h.ctx), /Unsupported model action/);
  // With a UI but a declined confirmation, the trusted approve API is never called.
  h.ctx.hasUI = true; h.ctx.ui.confirm = async () => false;
  await h.commands.ideation.handler('approve b.json', h.ctx);
  assert.equal(calls.includes('approve'), false);
});

test('approval shows/opens the full contract with hash before confirm; background returns before the run settles', async t => {
  const publishes = []; let confirmText, settleStart;
  const started = new Promise(r => settleStart = r);
  const service = { publish: async x => { publishes.push(x); return { slug: 'stable', url: 'http://localhost:7/stable', absPath: '/tmp/stable' }; },
    subscribe: async () => () => {}, answer: async () => ({ ok: true }) };
  const calls = [];
  const runner = {
    status: async id => id ? makeRun('ready', { repoRoot: root }) : [makeRun('ready', { repoRoot: root })],
    approve: async path => { calls.push(['approve', path]); await mkdir(join(root, '.git', 'ideation', 'runs', 'r'), { recursive: true }); return makeRun('ready', { repoRoot: root }); },
    start: async () => { calls.push('start'); await started; return makeRun('ready-for-review', { repoRoot: root }); },
    dispose: async () => calls.push('dispose'),
  };
  const h = await harness(t, { runner, service }); const root = h.root;
  t.after(() => settleStart());
  await writeFile(join(root, 'b.json'), JSON.stringify(brief));
  h.ctx.ui.confirm = async (_title, text) => { confirmText = text; return true; };
  await h.commands.ideation.handler('approve b.json', h.ctx);
  // The rendered contract was published (open) before confirmation and the prompt carries the hash + authority.
  assert.ok(publishes.some(p => p.open));
  assert.ok(confirmText.includes(hash.slice(0, 12)) && confirmText.includes('No time or token limit') && confirmText.includes('http://localhost:7/stable'));
  assert.ok(/Starting point: .*\nApprove those boundaries/.test(confirmText), 'the question comes last');
  assert.ok(publishes.some(p => p.html.includes(hash) && p.html.includes('src/') && p.html.includes('node --test')), 'complete authority and fingerprint remain in the contract');
  const visible = confirmText.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, '');
  assert.ok(visible.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 72)), 0) <= 16, 'confirmation must leave space for buttons');
  // Background start was requested but the run has NOT settled: the command already returned.
  assert.ok(calls.includes('start'));
  assert.equal((await runner.status('r')).state, 'ready');
  assert.ok(h.notifications.some(m => m.includes('Approval recorded')));
  // The immutable approval copy, not the working checkout, is what the trusted API receives.
  assert.match(calls.find(c => c[0] === 'approve')[1], /\.git\/ideation\/approvals\//);
});

test('a failed background worker leaves a persistent visible handoff instead of silent inactivity', async t => {
  let root;
  const stopped = () => makeRun('needs-decision', { repoRoot: root, attention: { reason: 'provider-client-version', message: 'The worker uses an outdated Anthropic client. Reload after updating Pi SDK dependencies.' } });
  const runner = { status: async id => id ? makeRun('ready', { repoRoot: root }) : [],
    approve: async () => { await mkdir(join(root, '.git/ideation/runs/r'), { recursive: true }); return makeRun('ready', { repoRoot: root }); },
    start: async () => stopped(), dispose: async () => {} };
  const h = await harness(t, { runner }); root = h.root;
  await writeFile(join(root, 'b.json'), JSON.stringify(brief));
  await h.commands.ideation.handler('approve b.json', h.ctx);
  await until(() => h.messages.length > 0);
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0][0].content, /Ideation needs attention/);
  assert.match(h.messages[0][0].content, /outdated Anthropic client/);
  assert.equal(h.messages[0][0].display, true);
  assert.equal(h.messages[0][1].triggerTurn, false, 'reporting failure does not restart or approve anything');
  await h.handlers.session_shutdown();
});

test('approving a different file opens that agreement, not an unrelated prepared draft', async t => {
  const published = [];
  const service = { publish: async input => { published.push(input); return { slug: input.title, url: `http://localhost:7/${input.title}`, absPath: `/tmp/${input.title}` }; }, subscribe: async () => () => {}, answer: async () => ({ ok: true }) };
  const h = await harness(t, { runner: { status: async () => [], dispose: async () => {} }, service });
  await h.tools.ideation_change.execute('', { action: 'prepare', brief: rawBrief }, null, null, h.ctx);
  await writeFile(join(h.root, 'different.json'), JSON.stringify({ ...rawBrief, id: 'different', title: 'Different agreement' }));
  h.ctx.ui.confirm = async (_title, text) => { assert.ok(published.at(-1).open); assert.match(published.at(-1).html, /Different agreement/); assert.match(text, /Different agreement/); return false; };
  await h.commands.ideation.handler('approve different.json', h.ctx);
});

test('live paused resume checks the original brief before unpausing', async t => {
  let root, unpause, state = 'ready', resumed = 0;
  const gate = new Promise(r => unpause = r);
  const runner = {
    status: async id => id ? makeRun(state, { repoRoot: root }) : state === 'ready' ? [] : [makeRun(state, { repoRoot: root })],
    approve: async () => { await mkdir(join(root, '.git/ideation/runs/r'), { recursive: true }); return makeRun('ready', { repoRoot: root }); },
    start: async () => { state = 'running'; await gate; return makeRun('cancelled', { repoRoot: root }); },
    pause: async () => { state = 'paused'; return makeRun('paused', { repoRoot: root, pauseRequested: true }); },
    resume: async () => { resumed++; unpause(); return makeRun('running', { repoRoot: root }); },
    dispose: async () => unpause(),
  };
  const h = await harness(t, { runner }); root = h.root;
  await writeFile(join(root, 'b.json'), JSON.stringify(brief));
  await h.commands.ideation.handler('approve b.json', h.ctx);
  while (state === 'ready') await new Promise(r => setImmediate(r));
  await h.commands.ideation.handler('pause', h.ctx);
  await writeFile(join(root, 'b.json'), JSON.stringify({ ...brief, title: 'Amended after approval' }));
  await assert.rejects(h.commands.ideation.handler('resume', h.ctx), /Original brief changed/);
  assert.equal(resumed, 0);
  await h.handlers.session_shutdown();
});

test('source changed during confirmation is rejected before any approval', async t => {
  const calls = [];
  const runner = { status: async () => [], approve: async () => { calls.push('approve'); return makeRun('ready'); }, dispose: async () => {} };
  const h = await harness(t, { runner });
  await writeFile(join(h.root, 'b.json'), JSON.stringify(brief));
  h.ctx.ui.confirm = async () => { await writeFile(join(h.root, 'b.json'), JSON.stringify({ ...rawBrief, title: 'Tampered' })); return true; };
  await assert.rejects(h.commands.ideation.handler('approve b.json', h.ctx), /changed during confirmation/);
  assert.equal(calls.includes('approve'), false);
});

test('resume of a paused live run unpauses the existing background instead of launching a second', async t => {
  const calls = []; let unpause, state = 'ready';
  const gate = new Promise(r => unpause = r);
  const runner = {
    status: async id => id ? makeRun(state, { repoRoot: root }) : [makeRun(state, { repoRoot: root })],
    approve: async () => { await mkdir(join(root, '.git', 'ideation', 'runs', 'r'), { recursive: true }); return makeRun('ready', { repoRoot: root }); },
    start: async () => { calls.push('start'); state = 'running'; await gate; state = 'ready-for-review'; return makeRun('ready-for-review', { repoRoot: root }); },
    pause: async () => { calls.push('pause'); state = 'paused'; return makeRun('paused', { repoRoot: root, pauseRequested: true }); },
    resume: async () => { calls.push('resume'); state = 'running'; unpause(); return makeRun('ready-for-review', { repoRoot: root }); },
    dispose: async () => calls.push('dispose'),
  };
  const h = await harness(t, { runner }); const root = h.root;
  t.after(() => unpause());
  await writeFile(join(root, 'b.json'), JSON.stringify(brief));
  await h.commands.ideation.handler('approve b.json', h.ctx);
  while (!calls.includes('start')) await new Promise(r => setImmediate(r));
  await h.commands.ideation.handler('pause', h.ctx);
  await h.commands.ideation.handler('resume', h.ctx);
  // Exactly one background worker: resume unpaused it in place rather than starting again.
  assert.equal(calls.filter(c => c === 'start').length, 1);
  assert.equal(calls.filter(c => c === 'resume').length, 1);
});

test('starting fresh copies the agreement into a new run, only with a new approval, keeping prior work', async t => {
  let root, created, approvals = 0, starts = 0, stops = 0;
  const old = makeRun('needs-decision', { id: 'older', units: [{ id: 'u', state: 'failed', attempts: 2 }], attention: { reason: 'execution', message: 'Check failed twice' } });
  const runner = {
    status: async id => id ? id === 'older' ? old : created : [old, ...(created ? [created] : [])],
    approve: async path => {
      approvals++; const b = validateBrief(JSON.parse(await readFile(path, 'utf8')));
      await mkdir(join(root, '.git/ideation/runs/r'), { recursive: true });
      created = makeRun('ready', { repoRoot: root, brief: b, briefHash: briefFingerprint(b) }); return created;
    },
    start: async () => { starts++; return created; },
    stop: async id => { assert.equal(id, 'older'); stops++; old.state = 'cancelled'; return old; },
    dispose: async () => {},
  };
  const h = await harness(t, { runner }); root = h.root; old.repoRoot = root;
  h.ctx.ui.confirm = async (title, text) => { assert.equal(title, 'Start a fresh run?'); assert.match(text, /starts over in a new worktree\. Previous work is kept/); return false; };
  await h.commands.ideation.handler('fresh older', h.ctx);
  assert.equal(approvals, 0); assert.equal(stops, 0); assert.equal(starts, 0);
  assert.equal(old.units[0].attempts, 2);
  h.ctx.ui.confirm = async () => true;
  await h.commands.ideation.handler('approve', h.ctx);
  await until(() => starts > 0);
  assert.equal(approvals, 1); assert.equal(starts, 1); assert.equal(stops, 1);
  assert.equal(created.brief.revision, old.brief.revision + 1);
  assert.deepEqual(created.brief.authority, old.brief.authority);
  assert.equal(old.units[0].attempts, 2, 'the old run was not reset');
  await h.handlers.session_shutdown();
});

test('a rejected resume of another run cannot change the active run’s approved model', async t => {
  let root, release, second;
  const gate = new Promise(r => release = r), completed = new Promise(r => second = r);
  const models = [];
  const runner = {
    status: async id => id ? makeRun(id === 'older' ? 'paused' : 'running', { id, repoRoot: root, pauseRequested: id === 'older' }) : [],
    approve: async () => { await mkdir(join(root, '.git/ideation/runs/r'), { recursive: true }); return makeRun('ready', { repoRoot: root }); },
    start: async () => { await runner._opts.spawn({ prompt: 'first' }); await gate; await runner._opts.spawn({ prompt: 'second' }); second(); return makeRun('ready-for-review', { repoRoot: root }); },
    dispose: async () => release(),
  };
  const h = await harness(t, { runner, runtime: { spawn: async opts => { models.push(opts.model); } } }); root = h.root;
  await writeFile(join(root, 'b.json'), JSON.stringify(brief));
  await mkdir(join(root, '.git/ideation/runs/older'), { recursive: true });
  await writeFile(join(root, '.git/ideation/runs/older/frontdoor.json'), JSON.stringify({ model: 'another/expensive-model', briefPath: join(root, 'b.json') }));
  await h.commands.ideation.handler('approve b.json', h.ctx);
  await until(() => models.length > 0);
  await assert.rejects(h.commands.ideation.handler('resume older', h.ctx), /already active/);
  release(); await completed;
  assert.deepEqual(models, ['provider/model', 'provider/model']);
  await h.handlers.session_shutdown();
});

test('stop awaits the actual asynchronous child settlement', async t => {
  let releaseStop; const stopping = new Promise(r => releaseStop = r);
  let root;
  const runner = {
    status: async id => id ? makeRun('running', { repoRoot: root }) : [makeRun('running', { repoRoot: root })],
    approve: async () => makeRun('ready', { repoRoot: root }), start: async () => makeRun('ready', { repoRoot: root }),
    stop: async () => { await stopping; return makeRun('cancelled', { repoRoot: root }); },
    dispose: async () => {},
  };
  const h = await harness(t, { runner }); root = h.root;
  const p = h.commands.ideation.handler('stop', h.ctx);
  let settled = false; p.then(() => settled = true);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(settled, false); // still waiting on the child
  releaseStop();
  await p; assert.equal(settled, true);
});

test('feedback: model tool records inbox only; the human service path persists then notifies once', async t => {
  let callback; const order = [];
  const service = { publish: async () => ({ slug: 'stable', url: 'http://localhost:1/stable', absPath: '/tmp/stable' }),
    subscribe: async x => { callback = x.onFeedback; return () => order.push('unsubscribe'); }, answer: async () => ({ ok: true }) };
  let root;
  const runner = { status: async id => id ? makeRun('running', { repoRoot: root }) : [makeRun('running', { repoRoot: root })], approve: async () => makeRun('ready', { repoRoot: root }),
    recordFeedback: async (id, f) => { assert.equal(id, 'r'); order.push(`persist:${f.markdown}`); }, dispose: async () => {} };
  const h = await harness(t, { runner, service }); root = h.root;
  // Model tool feedback: recorded, but never forwarded back to the coordinator.
  const res = await h.tools.ideation_change.execute('', { action: 'feedback', markdown: 'model note' }, null, null, h.ctx);
  assert.equal(res.details.delivered, true);
  assert.deepEqual(h.sent, []);
  assert.ok(order.includes('persist:model note'));
  // Prime the subscription by rendering a receipt for the run.
  await h.tools.ideation_change.execute('', { action: 'receipt' }, null, null, h.ctx);
  // Human service feedback: persist BEFORE the coordinator follow-up, and deduped by annotation.
  assert.equal(await callback({ slug: 'stable', markdown: 'human note', annotationIds: ['x'] }), true);
  assert.equal(await callback({ slug: 'stable', markdown: 'human note', annotationIds: ['x'] }), true);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0][1].deliverAs, 'followUp');
  assert.ok(order.indexOf('persist:human note') < order.indexOf('unsubscribe') || !order.includes('unsubscribe'));
  const persistIdx = order.lastIndexOf('persist:human note');
  assert.ok(persistIdx !== -1);
});

test('session disposal makes the service callback inert; it cannot leak into a new session', async t => {
  let callback;
  const service = { publish: async () => ({ slug: 'stable', url: 'http://localhost:1/stable', absPath: '/tmp/stable' }),
    subscribe: async x => { callback = x.onFeedback; return () => {}; }, answer: async () => ({ ok: true }) };
  let root;
  const runner = { status: async id => id ? makeRun('running', { repoRoot: root }) : [makeRun('running', { repoRoot: root })], approve: async () => makeRun('ready', { repoRoot: root }),
    recordFeedback: async () => {}, dispose: async () => {} };
  const h = await harness(t, { runner, service }); root = h.root;
  await h.tools.ideation_change.execute('', { action: 'receipt' }, null, null, h.ctx);
  assert.equal(await callback({ slug: 'stable', markdown: 'live', annotationIds: ['x'] }), true);
  h.sent.length = 0;
  await h.handlers.session_shutdown();
  assert.equal(await callback({ slug: 'stable', markdown: 'after shutdown', annotationIds: ['y'] }), false);
  assert.deepEqual(h.sent, []);
});

test('missing artifacts provider falls back to a durable local snapshot', async t => {
  const runner = { status: async () => [], dispose: async () => {} };
  const h = await harness(t, { runner }); // no service offered
  await writeFile(join(h.root, 'b.json'), JSON.stringify(brief));
  const preview = await h.tools.ideation_change.execute('', { action: 'prepare', path: 'b.json' }, null, null, h.ctx);
  assert.match(preview.details.url, /^file:.*\/\.git\/ideation\/views\//);
  assert.equal(preview.details.approved, false);
});

test('prepare accepts an inline brief, stores a canonical git-common snapshot, and is exclusive with path', async t => {
  const runner = { status: async () => [], dispose: async () => {} };
  const h = await harness(t, { runner });
  await writeFile(join(h.root, 'b.json'), JSON.stringify(brief));
  await assert.rejects(h.tools.ideation_change.execute('', { action: 'prepare' }, null, null, h.ctx), /exactly one/);
  await assert.rejects(h.tools.ideation_change.execute('', { action: 'prepare', path: 'b.json', brief: rawBrief }, null, null, h.ctx), /exactly one/);
  const res = await h.tools.ideation_change.execute('', { action: 'prepare', brief: rawBrief }, null, null, h.ctx);
  assert.equal(res.details.briefHash, hash);
  assert.match(res.details.briefPath, /\/\.git\/ideation\/briefs\//);
  // The canonical snapshot is stored under the git common dir (gitignored) and re-fingerprints identically.
  const stored = validateBrief(JSON.parse(await readFile(res.details.briefPath, 'utf8')));
  assert.equal(briefFingerprint(stored), hash);
});

test('bare approve uses the last prepared brief, including after session reload, but never approves automatically', async t => {
  let approvals = 0, confirmations = 0;
  const runner = { status: async () => [], approve: async () => { approvals++; throw new Error('must not approve a declined dialog'); }, dispose: async () => {} };
  const h = await harness(t, { runner });
  h.ctx.ui.confirm = async () => { confirmations++; return false; };
  await h.tools.ideation_change.execute('', { action: 'prepare', brief: rawBrief }, null, null, h.ctx);
  assert.equal(approvals, 0);
  await h.commands.ideation.handler('approve', h.ctx);
  assert.equal(confirmations, 1);
  await h.handlers.session_shutdown();
  await h.commands.ideation.handler('approve', h.ctx);
  assert.equal(confirmations, 2, 'prepared brief should restore from the active session branch');
  assert.equal(approvals, 0);
});

test('an inline-prepared brief can be approved from its canonical path', async t => {
  const calls = [];
  const runner = { status: async id => id ? makeRun('ready', { repoRoot: root }) : [makeRun('ready', { repoRoot: root })],
    approve: async path => { calls.push(path); await mkdir(join(root, '.git', 'ideation', 'runs', 'r'), { recursive: true }); return makeRun('ready', { repoRoot: root }); },
    start: async () => makeRun('running', { repoRoot: root }), dispose: async () => {} };
  const h = await harness(t, { runner }); const root = h.root;
  const prep = await h.tools.ideation_change.execute('', { action: 'prepare', brief: rawBrief }, null, null, h.ctx);
  await h.commands.ideation.handler(`approve ${prep.details.briefPath}`, h.ctx);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\.git\/ideation\/approvals\//);
});

test('the widget mounts once, animates only while work is live, and motion can be turned off persistently', async t => {
  const agentDir = await mkdtemp(join(tmpdir(), 'ideation-agent-'));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => { if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir; await rm(agentDir, { recursive: true, force: true }); });
  let root, state = 'running';
  const runner = { status: async id => { const r = makeRun(state, { repoRoot: root, startedAt: Date.now() - 5000 }); return id ? r : [r]; }, dispose: async () => {} };
  const h = await harness(t, { runner }); root = h.root;
  h.ctx.mode = 'tui';
  let factories = 0, renders = 0;
  const mounted = [];
  h.ctx.ui.setWidget = (_key, content) => {
    for (const w of mounted.splice(0)) w.dispose?.();
    if (typeof content !== 'function') return;
    factories++;
    mounted.push(content({ requestRender: () => renders++ }, { fg: (_r, s) => s, bold: s => s }));
  };
  await h.handlers.session_start({}, h.ctx);
  await h.handlers.session_start({}, h.ctx);
  assert.equal(factories, 1, 'repaints feed the mounted widget instead of rebuilding it');
  assert.match(mounted[0].render(80)[0], /^▎ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Building · \d+s/);
  const before = renders;
  await new Promise(r => setTimeout(r, 450));
  assert.ok(renders - before >= 3, `live work animates (${renders - before} frames)`);

  state = 'paused';
  await h.handlers.session_start({}, h.ctx);
  const idle = renders;
  await new Promise(r => setTimeout(r, 350));
  assert.equal(renders, idle, 'an idle widget never redraws');

  state = 'running';
  await h.commands.ideation.handler('motion off', h.ctx);
  assert.deepEqual(JSON.parse(await readFile(join(agentDir, 'ideation.json'), 'utf8')), { motion: false });
  assert.match(h.notifications.at(-1), /motion off/);
  await h.handlers.session_start({}, h.ctx);
  assert.match(mounted[0].render(80)[0], /^▎ Building/, 'no spinner when motion is off');
  const still = renders;
  await new Promise(r => setTimeout(r, 450));
  assert.ok(renders - still <= 1, 'only the once-a-second elapsed clock redraws');

  process.env.PI_REDUCED_MOTION = '1';
  t.after(() => { delete process.env.PI_REDUCED_MOTION; });
  await h.commands.ideation.handler('motion on', h.ctx);
  assert.match(h.notifications.at(-1), /overridden by PI_REDUCED_MOTION/);
  await h.handlers.session_shutdown();
  assert.equal(mounted.length, 0, 'shutdown disposes the widget and its timer');
});

test('uncommitted work asks where the run should start and never blocks approval', async t => {
  for (const choice of ['cancel', 'leave', 'include', 'clean']) {
    const approvals = []; let confirmText = '', asked = null, root = '';
    const runner = {
      status: async () => [],
      uncommitted: async ({ exclude }) => { assert.deepEqual(exclude, ['docs/ideation/demo/']); return { head: 'abc1234def567890', paths: choice === 'clean' ? [] : ['src/wip.js', 'notes.md'] }; },
      approve: async (path, options) => { approvals.push(options); await mkdir(join(root, '.git', 'ideation', 'runs', 'r'), { recursive: true }); return makeRun('ready', { repoRoot: root }); },
      start: async () => new Promise(() => {}),
      dispose: async () => {},
    };
    const h = await harness(t, { runner }); root = h.root;
    await h.tools.ideation_change.execute('', { action: 'prepare', brief: rawBrief }, null, null, h.ctx);
    h.ctx.ui.select = async (title, options) => {
      asked = { title, options };
      return choice === 'cancel' ? 'Cancel' : options[choice === 'include' ? 1 : 0];
    };
    h.ctx.ui.confirm = async (_title, text) => { confirmText = text; return true; };
    await h.commands.ideation.handler('approve', h.ctx);
    if (choice === 'clean') assert.equal(asked, null, 'a clean checkout asks nothing extra');
    else {
      assert.match(asked.title, /2 uncommitted files in this checkout/);
      assert.match(asked.options[0], /Start from the last commit \(abc1234\) and leave my changes alone/);
      assert.match(asked.options[1], /Include my 2 uncommitted files/);
    }
    if (choice === 'cancel') { assert.equal(approvals.length, 0); assert.equal(confirmText, ''); continue; }
    assert.equal(approvals.length, 1);
    assert.deepEqual(approvals[0], { includeUncommitted: choice === 'include', exclude: ['docs/ideation/demo/'] });
    assert.match(confirmText, choice === 'include' ? /Starting point: abc1234def56 \+ 2 uncommitted files\./
      : choice === 'leave' ? /Starting point: abc1234def56 \(2 uncommitted files left out\)\./ : /Starting point: abc1234def56\./);
    await h.handlers.session_shutdown();
  }
});

test('the brief, contract and receipt land in docs/ideation for you to keep; nothing commits them', async t => {
  let run = makeRun('ready');
  const runner = { status: async id => id ? run : [run], approve: async () => run, start: async () => new Promise(() => {}), dispose: async () => {} };
  const h = await harness(t, { runner });
  run = makeRun('running', { repoRoot: h.root, sequence: 2 });
  await h.tools.ideation_change.execute('', { action: 'prepare', brief: rawBrief }, null, null, h.ctx);
  const dir = join(h.root, 'docs', 'ideation', 'demo');
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'brief.json'), 'utf8')), brief);
  assert.match(await readFile(join(dir, 'contract.html'), 'utf8'), /data-stamp-state="draft:1"/);
  await assert.rejects(readFile(join(dir, 'receipt.json')), /ENOENT/, 'no receipt before there is evidence');

  // Run pages follow recorded state; the receipt appears once the run is ready for review.
  await h.commands.ideation.handler('status', h.ctx);
  await until(async () => false, 50);
  await h.handlers.session_shutdown();
  assert.match(await readFile(join(dir, 'contract.html'), 'utf8'), /data-stamp-state="running:1"/);
  run = makeRun('ready-for-review', { repoRoot: h.root, sequence: 3, branch: 'ideation/r', sourceRevision: 'src-1',
    evidence: [{ criterionId: 'a', status: 'passed', sourceRevision: 'src-1', command: 'node --test', output: 'ok' }] });
  await h.commands.ideation.handler('status', h.ctx);
  await h.handlers.session_shutdown();
  const receipt = JSON.parse(await readFile(join(dir, 'receipt.json'), 'utf8'));
  assert.equal(receipt.state, 'ready-for-review');
  assert.equal(receipt.branch, 'ideation/r');
  assert.equal(receipt.evidence[0].status, 'passed');
  assert.ok(!('workspace' in receipt), 'no machine-local paths');
});

test('a planning-path project with the same slug is never written into', async t => {
  const runner = { status: async () => [], dispose: async () => {} };
  const h = await harness(t, { runner });
  await mkdir(join(h.root, 'docs', 'ideation', 'demo'), { recursive: true });
  await writeFile(join(h.root, 'docs', 'ideation', 'demo', 'contract-data.json'), '{"planning":true}');
  await h.tools.ideation_change.execute('', { action: 'prepare', brief: rawBrief }, null, null, h.ctx);
  await h.handlers.session_shutdown();
  assert.equal(await readFile(join(h.root, 'docs', 'ideation', 'demo', 'contract-data.json'), 'utf8'), '{"planning":true}');
  await assert.rejects(readFile(join(h.root, 'docs', 'ideation', 'demo', 'contract.html')), /ENOENT/);
  assert.ok(await readFile(join(h.root, 'docs', 'ideation', 'demo-change', 'contract.html'), 'utf8'));
});

test('"Approve in Pi" on the draft page opens the terminal confirmation; the page never approves', async t => {
  let subscription, confirmations = 0, answer = false;
  const approvals = [];
  const service = { publish: async () => ({ slug: 'draft-slug', url: 'http://localhost:7/draft-slug', absPath: '/tmp/draft' }),
    subscribe: async input => { subscription = input; return () => {}; }, answer: async () => ({ ok: true }) };
  const runner = { status: async () => [], uncommitted: async () => ({ head: 'abc1234', paths: [] }),
    approve: async (path, options) => { approvals.push(options); await mkdir(join(root, '.git', 'ideation', 'runs', 'r'), { recursive: true }); return makeRun('ready', { repoRoot: root }); },
    start: async () => new Promise(() => {}), dispose: async () => {} };
  const h = await harness(t, { runner, service }); const root = h.root;
  h.ctx.ui.confirm = async () => { confirmations++; return answer; };
  await h.tools.ideation_change.execute('', { action: 'prepare', brief: rawBrief }, null, null, h.ctx);
  await until(() => subscription);
  assert.deepEqual(subscription.actions, ['approve']);
  const ask = action => subscription.onRequest({ slug: 'draft-slug', action });

  assert.equal(await ask('accept'), false, 'only approve is accepted');
  assert.equal(await ask('approve'), true, 'delivered to the owning session');
  await until(() => confirmations === 1);
  assert.equal(approvals.length, 0, 'a declined confirmation approves nothing');

  // One confirmation at a time: a second request while the dialog is open is refused.
  let release; answer = new Promise(r => release = r);
  assert.equal(await ask('approve'), true);
  await until(() => confirmations === 2);
  assert.equal(await ask('approve'), false, 'no stacked dialogs');
  release(true);
  await until(() => approvals.length === 1);
  assert.deepEqual(approvals[0], { includeUncommitted: false, exclude: ['docs/ideation/demo/'] });
  // The draft became a run; approving it again from the page is refused.
  assert.equal(await ask('approve'), false);
});

test('page approval requests are refused without an interactive terminal', async t => {
  let subscription;
  const service = { publish: async () => ({ slug: 's', url: 'http://localhost:7/s', absPath: '/tmp/s' }),
    subscribe: async input => { subscription = input; return () => {}; }, answer: async () => ({ ok: true }) };
  const runner = { status: async () => [], approve: async () => { throw new Error('must not approve'); }, dispose: async () => {} };
  const h = await harness(t, { runner, service, hasUI: false });
  await h.tools.ideation_change.execute('', { action: 'prepare', brief: rawBrief }, null, null, h.ctx);
  await until(() => subscription);
  assert.equal(await subscription.onRequest({ slug: 's', action: 'approve' }), false);
});
