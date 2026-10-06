import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { renderBrief, renderReceipt } from './change-render.mjs';
import { briefFingerprint } from '../workflows/change-brief.mjs';
const fixture = JSON.parse(readFileSync(new URL('../test-fixtures/native-change/brief.json', import.meta.url), 'utf8'));
const fresh = () => structuredClone(fixture);
function runFor(b, state = 'ready-for-review') {
  return { id: 'run-123', briefHash: briefFingerprint(b), state, sourceRevision: 'source-abc', branch: 'ideation/run-123', workspace: '/tmp/workspace', baseRevision: 'base-abc', updatedAt: '2026-04-01T12:00:00Z', usage: { totalTokens: 1200 }, units: [{ id: 'render', state: 'completed', attempts: 1, reviewStatus: 'PASS', summary: 'Rendered and checked.', commitHash: 'commit-abc' }], evidence: [{ criterionId: 'render-tests', status: 'passed', sourceRevision: 'source-abc', output: '2 tests passed', durationMs: 123 }, { criterionId: 'readability', status: 'passed', sourceRevision: 'source-abc', output: 'Model thinks it looks good' }] };
}
const criterion = (html, name) => [...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/g)].map(m => m[1]).find(s => s.includes(`<h3>${name}</h3>`));

test('brief is change-first, self-contained, responsive and read-only', () => {
  const b = fresh(), html = renderBrief(b);
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('name="viewport"'));
  assert.ok(html.includes('@media(max-width:640px)'));
  assert.ok(html.indexOf('The change</h2>') < html.indexOf('Must hold</h2>'));
  assert.ok(html.indexOf('Acceptance criteria</h2>') < html.indexOf('<summary>Execution boundaries'));
  assert.ok(html.includes(b.change.before)); assert.ok(html.includes(b.change.after));
  assert.ok(html.includes('<details><summary>Execution boundaries'));
  assert.ok(!/<details[^>]*\bopen\b/.test(html));
  assert.equal((html.match(/<script>/g) ?? []).length, 2, 'only trusted theme/print scripts');
  assert.equal((html.match(/<button\b/g) ?? []).length, 1, 'only theme control');
  assert.ok(!/<(?:form|iframe|img)\b/.test(html));
  assert.ok(!/\bsrc\s*=/.test(html));
  assert.ok([...html.matchAll(/href="([^"]*)"/g)].every(m => m[1].startsWith('#')));
  assert.ok(html.includes('No approval is granted'));
  assert.ok(html.includes('pending'));
  assert.ok(!html.includes('>passed</span>'));
});
test('both renderers escape every untrusted presentation surface', () => {
  const attack = '<img src=x onerror="alert(1)"> & \' </style><script>alert(2)</script>';
  const escaped = '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39; &lt;/style&gt;&lt;script&gt;alert(2)&lt;/script&gt;';
  const b = fresh();
  b.title = b.why = b.change.before = b.change.after = attack;
  b.mustHold = b.outOfScope = b.delegated = [attack];
  b.decisions = [{ decision: attack, reason: attack, rejected: attack }];
  b.units[0].title = b.units[0].goal = b.units[0].design = attack;
  b.acceptance[0].criterion = b.acceptance[0].check.expect = b.acceptance[1].check.judgment = attack;
  const run = runFor(b);
  run.attention = { message: attack }; run.branch = run.workspace = run.id = run.updatedAt = attack;
  run.units[0].summary = run.units[0].reviewStatus = run.units[0].commitHash = attack;
  run.evidence[0].output = run.evidence[0].command = attack;
  for (const html of [renderBrief(b, { run }), renderReceipt(b, run)]) {
    assert.ok(html.includes(escaped));
    assert.ok(!html.includes(attack));
    assert.ok(!html.includes('<img'));
    const trustedScripts = renderBrief(fresh()).match(/<script>[\s\S]*?<\/script>/g);
    assert.deepEqual(html.match(/<script>[\s\S]*?<\/script>/g), trustedScripts, 'untrusted input cannot enter executable scripts');
    assert.equal((html.match(/<style>/g) ?? []).length, 1);
    assert.equal((html.match(/<\/style>/g) ?? []).length, 1);
  }
});
test('receipt distinguishes current objective evidence from pending judgments and acceptance', () => {
  const b = fresh(), run = runFor(b), html = renderReceipt(b, run);
  assert.ok(criterion(html, b.acceptance[0].criterion).includes('>passed</span>'));
  const human = criterion(html, b.acceptance[1].criterion);
  assert.ok(human.includes('>pending</span>')); assert.ok(!human.includes('>passed</span>'));
  assert.ok(human.includes('Human judgment required'));
  assert.ok(html.includes('not accepted or merged'));
  assert.ok(html.includes('commit-abc')); assert.ok(html.includes('Review: PASS'));
  assert.ok(html.includes('Tokens</dt><dd>1200'));
  assert.ok(html.includes('not the live workspace'));
});
for (const status of ['failed','pending','unknown']) test(`renders ${status} objective evidence without upgrading it`, () => {
  const b = fresh(), run = runFor(b); run.evidence[0].status = status === 'unknown' ? 'maybe' : status;
  const html = criterion(renderReceipt(b, run), b.acceptance[0].criterion);
  assert.ok(html.includes(`>${status}</span>`)); assert.ok(!html.includes('>passed</span>'));
});
for (const [name, mutate] of [
  ['old source', r => { r.evidence[0].sourceRevision = 'old'; }],
  ['no source', r => { delete r.sourceRevision; delete r.evidence[0].sourceRevision; }],
  ['wrong brief', r => { r.briefHash = 'old'; }],
  ['missing brief hash', r => { delete r.briefHash; }],
]) test(`stale evidence: ${name}`, () => {
  const b = fresh(), run = runFor(b); mutate(run);
  const html = criterion(renderReceipt(b, run), b.acceptance[0].criterion);
  assert.ok(html.includes('>stale</span>')); assert.ok(!html.includes('>passed</span>'));
});
test('latest evidence wins, absent evidence and absent unit remain pending', () => {
  const b = fresh(), run = runFor(b);
  run.evidence.push({ ...run.evidence[0], status: 'failed', output: 'Latest failure' });
  let html = renderReceipt(b, run);
  assert.ok(criterion(html, b.acceptance[0].criterion).includes('>failed</span>'));
  assert.ok(html.includes('Latest failure'));
  run.evidence = []; run.units = [];
  html = renderReceipt(b, run);
  assert.ok(html.includes('No completion recorded')); assert.ok(html.includes('No local commit recorded'));
  assert.ok(criterion(html, b.acceptance[0].criterion).includes('>pending</span>'));
});
for (const [state, label] of Object.entries({ready:'Ready',running:'Running',verifying:'Verifying','needs-decision':'Needs a decision',paused:'Paused',interrupted:'Interrupted',failed:'Failed',cancelling:'Cancelling',cancelled:'Cancelled','ready-for-review':'Ready for review',accepted:'Accepted',future:'Unknown state'})) {
  test(`receipt faithfully reports state ${state}`, () => {
    const b = fresh(), run = runFor(b, state), html = renderReceipt(b, run);
    assert.ok(html.includes(`>${label}</span>`));
    if (state !== 'accepted') assert.ok(!html.includes('>Accepted</span>'));
    if (state === 'cancelling') assert.ok(html.includes('writes may still be in flight'));
    if (state === 'accepted') assert.ok(html.includes('does not mean merged or deployed'));
  });
}
test('revision delta shows actual old/new content and authority changes, not only a revision number', () => {
  const previous = fresh(), current = fresh();
  current.revision = 2; current.change.after = 'New <outcome>'; current.authority.paths.push('src/');
  const html = renderBrief(current, { previous });
  assert.ok(html.includes('Revision delta · 1 → 2'));
  assert.ok(html.includes('2 changed areas'));
  assert.ok(html.includes(previous.change.after)); assert.ok(html.includes('New &lt;outcome&gt;'));
  assert.ok(html.includes('<summary>authority</summary>'));
  assert.ok(html.includes('<h3>Previous</h3>')); assert.ok(html.includes('<h3>Current</h3>'));
  assert.ok(!html.includes('<summary>title</summary>'));
  assert.ok(html.indexOf('Revision delta') < html.indexOf('Acceptance criteria</h2>'));
});
test('revision-only delta is explicit; unrelated briefs and invalid input fail closed', () => {
  const previous = fresh(), b = fresh(); b.revision++;
  assert.ok(renderBrief(b, { previous }).includes('No content changes; revision metadata only'));
  previous.id = 'other'; assert.throws(() => renderBrief(b, { previous }), /same id/);
  assert.throws(() => renderBrief({ ...b, acceptance: [] }));
  assert.throws(() => renderReceipt(b, null), /run must/);
});
test('prototype-like state names are unknown, never inherited labels', () => {
  const b = fresh();
  for (const state of ['__proto__', 'constructor', 'toString']) assert.ok(renderReceipt(b, runFor(b, state)).includes('>Unknown state</span>'));
});
test('canonical theme is reused verbatim, without another token palette', () => {
  const html = renderBrief(fresh());
  const canonical = readFileSync(new URL('./contract-gen.css', import.meta.url), 'utf8');
  const layout = readFileSync(new URL('./change-render.css', import.meta.url), 'utf8');
  assert.ok(html.includes(canonical));
  assert.ok(!/#[\da-f]{3,8}\b/i.test(layout), 'no invented palette');
  assert.deepEqual([...layout.matchAll(/(--[a-z-]+)\s*:/g)].map(m => m[1]), ['--dependency-row-height'], 'only a local geometry variable; visual tokens stay canonical');
  assert.ok(html.indexOf('<script>') < html.indexOf('<style>'), 'pre-paint theme');
  assert.ok(html.includes('prefers-reduced-motion: reduce'));
  assert.ok(html.includes('details::details-content'));
  assert.ok(html.includes('color-scheme: light;'));
});

test('theme cycles with native keyboard button semantics, persists, and print restores disclosures', () => {
  const scripts = [...renderBrief(fresh()).matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  for (const storageFails of [false, true]) {
    const root = { dataset: {} }, events = {}, attrs = {}, closed = [{ open: false }, { open: false }];
    let click, saved = 'dark';
    const button = { dataset: {}, setAttribute: (k,v) => attrs[k] = v, addEventListener: (type, fn) => { assert.equal(type, 'click'); click = fn; } };
    const context = {
      document: { documentElement: root, getElementById: id => { assert.equal(id, 'theme-toggle'); return button; }, querySelectorAll: () => closed },
      localStorage: { getItem: () => { if (storageFails) throw Error(); return saved; }, setItem: (k,v) => { assert.equal(k, 'ideation-contract-theme'); if (storageFails) throw Error(); saved = v; } },
      addEventListener: (event, fn) => events[event] = fn,
    };
    runInNewContext(scripts[0], context);
    assert.equal(root.dataset.theme, storageFails ? undefined : 'dark');
    runInNewContext(scripts[1], context);
    for (let i = 0; i < 3; i++) { click(); assert.ok(attrs['aria-label'].includes('Switch to')); }
    assert.equal(button.dataset.mode, storageFails ? 'auto' : 'dark');
    if (!storageFails) assert.equal(saved, 'dark');
    events.beforeprint(); assert.ok(closed.every(d => d.open));
    events.afterprint(); assert.ok(closed.every(d => !d.open));
  }
  assert.match(renderBrief(fresh()), /<button type="button"[^>]*id="theme-toggle"/);
});

test('dependency SVG encodes real needs; verification connects every criterion once to its check and state', () => {
  const b = fresh();
  const first = b.units[0];
  b.units.push({ ...structuredClone(first), id: 'dependent', title: 'Dependent <deliverable>', needs: [first.id] });
  const html = renderBrief(b);
  assert.ok(html.includes(`data-from="${first.id}" data-to="dependent"`));
  assert.ok(html.includes('Dependent &lt;deliverable&gt;'));
  assert.ok(html.includes('Verification PLAN'));
  assert.ok(!html.includes('<progress'));
  assert.ok(html.includes('(shared criterion)'));
  for (const c of b.acceptance) {
    assert.equal(html.split(`id="criterion-${c.id}"`).length - 1, 1);
    const row = criterion(html, c.criterion);
    assert.ok(row.includes('class="relation"'));
    assert.ok(row.includes('>pending</span>'));
    assert.ok(row.includes(c.check.cmd || c.check.judgment));
  }
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(ids.length, new Set(ids).size);
  for (const [, target] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.includes(target));
  assert.ok(!renderBrief(fresh()).includes('id="work-dependencies"'), 'omit dependency diagram without edges');
});

test('explicit evidence invalidation and human acceptance stay source-bound', () => {
  const b = fresh(), run = runFor(b, 'accepted');
  run.decisions = [{ type: 'accept', sourceRevision: run.sourceRevision, judgments: [b.acceptance[1].id] }];
  assert.ok(criterion(renderReceipt(b, run), b.acceptance[1].criterion).includes('>accepted</span>'));
  run.evidenceFresh = false;
  const html = renderReceipt(b, run);
  assert.ok(criterion(html, b.acceptance[0].criterion).includes('>stale</span>'));
  assert.ok(criterion(html, b.acceptance[1].criterion).includes('>pending</span>'));
  assert.ok(html.includes('Boundaries &amp; choices'), 'receipt retains original agreement');
});

test('feedback anchors preserve existing IDs and disambiguate sanitized collisions', () => {
  const b = fresh(), run = runFor(b);
  run.feedback = [{ id: 'note', markdown: 'First' }, { id: 'note!', markdown: 'Second' }];
  const html = renderBrief(b, { run });
  assert.ok(html.includes('id="feedback-note"'));
  assert.ok(html.includes('id="feedback-note-2"'));
});

test('rendering never mutates brief, previous revision or run', () => {
  const b = fresh(), previous = fresh(), run = runFor(b);
  const before = structuredClone({ b, previous, run });
  renderBrief(b, { previous, run }); renderReceipt(b, run);
  assert.deepEqual({ b, previous, run }, before);
});

test('status stamp reports recorded state only: drafts are visibly not approved, unknown states get none', () => {
  const b = fresh();
  const draft = renderBrief(b);
  assert.match(draft, /class="stamp brief-stamp is-faint"[^>]*><strong>Draft<\/strong><span>Not approved · [0-9A-F]{8}<\/span>/);
  assert.ok(draft.includes('data-stamp-state="draft:1"'));
  assert.ok(!/<strong>Approved<\/strong>/.test(draft));
  assert.match(renderBrief(b, { run: runFor(b, 'running') }), /brief-stamp is-accent"[^>]*><strong>Approved<\/strong>/);
  assert.match(renderReceipt(b, runFor(b, 'ready-for-review')), /<strong>Ready for review<\/strong>/);
  assert.match(renderReceipt(b, runFor(b, 'accepted')), /brief-stamp is-go"[^>]*><strong>Accepted<\/strong>/);
  assert.match(renderReceipt(b, runFor(b, 'failed')), /brief-stamp is-danger"/);
  for (const state of ['future', '__proto__']) assert.ok(!renderReceipt(b, runFor(b, state)).includes('class="stamp brief-stamp'));
});

test('motion is opt-in pre-paint, respects reduced motion, and replays entrances only for a new stamped state', () => {
  const boot = [...renderBrief(fresh()).matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  const run = ({ reduce = false, store = new Map(), state = 'draft:1' } = {}) => {
    const root = { dataset: { stampState: state } };
    runInNewContext(boot, {
      document: { documentElement: root }, location: { pathname: '/contract.html' }, IntersectionObserver: function () {},
      matchMedia: q => ({ matches: q.includes('reduce') ? reduce : false }),
      localStorage: { getItem: () => null }, sessionStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    });
    return root.dataset;
  };
  const store = new Map();
  assert.deepEqual([run({ store }).motion, run({ store }).fresh], ['on', undefined], 'reload of the same state stays still');
  assert.equal(run({ store, state: 'running:1' }).fresh, '1', 'a new state stamps again');
  const reduced = run({ reduce: true });
  assert.equal(reduced.motion, undefined); assert.equal(reduced.fresh, undefined);
});

test('newly passed checks are inked on a live page; previously seen passes stay still', () => {
  const b = fresh();
  const scripts = [...renderBrief(b, { run: runFor(b) }).matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const ticks = ['render-tests', 'readability'].map(criterion => ({ dataset: { criterion }, classList: { added: [], add(c) { this.added.push(c); } } }));
  const store = new Map([['ideation-ticks:/c.html', JSON.stringify(['render-tests'])]]);
  const root = { dataset: { motion: 'on' } };
  runInNewContext(scripts[1], {
    document: { documentElement: root, getElementById: () => ({ dataset: {}, setAttribute() {}, addEventListener() {} }), querySelectorAll: sel => sel.includes('data-tick') ? ticks : [] },
    location: { pathname: '/c.html' }, addEventListener() {}, localStorage: { setItem() {} },
    sessionStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
  });
  assert.deepEqual(ticks.map(t => t.classList.added), [[], ['just-inked']]);
  assert.deepEqual(JSON.parse(store.get('ideation-ticks:/c.html')), ['render-tests', 'readability']);
});

test('the dependency token only travels into a unit that is actually running', () => {
  const b = fresh();
  const first = b.units[0];
  b.units.push({ ...structuredClone(first), id: 'dependent', title: 'Dependent', needs: [first.id] });
  const live = { ...runFor(b, 'running'), units: [{ id: first.id, state: 'completed' }, { id: 'dependent', state: 'running' }] };
  const running = renderBrief(b, { run: live });
  assert.equal((running.match(/class="flow"/g) ?? []).length, 1);
  assert.match(running, /<li class="active"><a href="#deliverable-dependent">/);
  assert.match(running, /<li class="done">/);
  assert.ok(running.includes('ink-roller'));
  for (const html of [renderBrief(b), renderReceipt(b, { ...live, state: 'paused' }), renderReceipt(b, { ...live, state: 'ready-for-review' })]) {
    assert.ok(!html.includes('class="flow"')); assert.ok(!html.includes('class="ink-roller"'));
  }
});

test('print and reduced motion are still and final', () => {
  const layout = readFileSync(new URL('./change-render.css', import.meta.url), 'utf8');
  const print = layout.slice(layout.indexOf('@media print'));
  assert.ok(print.includes('animation: none !important') && print.includes('stroke-dashoffset: 0 !important') && print.includes('opacity: 1 !important'));
  const reduced = layout.slice(layout.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.ok(reduced.includes('path.flow { display: none; }'));
  assert.ok(!/\[data-motion=on\]/.test(layout.replace(/\[data-motion=on\]\[data-fresh\]/g, '')), 'hidden entrance states always require both opt-in flags');
});
