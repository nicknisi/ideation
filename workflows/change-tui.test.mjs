import test from 'node:test';
import assert from 'node:assert/strict';
import { createProgressWidget, createLiveProgressWidget, createMotion, createChangeToolCall, createChangeToolResult, progressFallback } from './change-tui.mjs';

// Standalone injected test doubles; no Pi or third-party installation required.
const strip = s => s.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, '').replace(/\x1b\[[0-9;]*m/g, '');
const graphemes = s => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].map(x => x.segment);
const cell = s => /\p{Extended_Pictographic}|[\u2e80-\ua4cf\uac00-\ud7af\uff01-\uff60]/u.test(s) ? 2 : 1;
const visibleWidth = s => graphemes(strip(s)).reduce((n, x) => n + cell(x), 0);
function truncateToWidth(s, width, ellipsis = '…') {
  if (visibleWidth(s) <= width) return s;
  if (width < visibleWidth(ellipsis)) return '';
  let out = '';
  for (const g of graphemes(strip(s))) {
    if (visibleWidth(out + g + ellipsis) > width) break;
    out += g;
  }
  return out + ellipsis;
}
function harness() {
  const roles = [], links = [];
  let generation = 1;
  const theme = {
    fg(role, text) { roles.push([generation, role, strip(text)]); return `\x1b[36m${text}\x1b[0m`; },
    bold(text) { roles.push([generation, 'bold', strip(text)]); return `\x1b[1m${text}\x1b[0m`; },
  };
  const helpers = { visibleWidth, truncateToWidth, hyperlink(text, url) { links.push([text, url]); return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`; } };
  return { theme, helpers, roles, links, nextTheme() { generation++; } };
}
const url = 'file:///tmp/contract.html';
function run(overrides = {}) {
  return {
    id: 'run-1', state: 'running', activeStage: 'build', sourceRevision: 'rev-1',
    brief: { title: 'Installer 日本語 👩‍💻', acceptance: [
      ...Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, check: { cmd: `check-${i}` } })),
      { id: 'human1', check: { judgment: 'Review UX' } }, { id: 'human2', check: { judgment: 'Review copy' } },
    ] },
    units: [], evidence: [], feedback: [], ...overrides,
  };
}
const text = (component, width = 80) => component.render(width).map(strip).join('\n');

test('running card has hierarchy, compact real progress and a same-card native link', () => {
  const h = harness();
  const c = createProgressWidget(run(), url, h.theme, h.helpers);
  assert.equal(h.roles.length, 0, 'theme consulted during render only');
  assert.equal(text(c), '▎ Building  Contract ↗\n  Installer 日本語 👩‍💻\n  ────────────────────  0/10 checks verified');
  assert.match(text(c, 60), /\n  ─{12}  0\/10/); assert.match(text(c, 40), /\n  ─{6}  0\/10/);
  assert.deepEqual(h.links[0], ['Contract ↗', url], 'real Pi hyperlink(text, url) order');
  for (const role of ['borderAccent', 'accent', 'text', 'muted', 'dim', 'bold']) assert.ok(h.roles.some(x => x[1] === role), role);
  assert.ok(!h.roles.some(x => ['warning', 'error', 'success'].includes(x[1])));
  assert.doesNotMatch(text(c), /judgment|feedback|Needs you|running|\|/i);
});

test('drafts show the next action, cancellation stays cancelled, and elapsed time is never progress', () => {
  const h = harness();
  const draft = text(createProgressWidget(run({ state: 'draft' }), url, h.theme, h.helpers));
  assert.match(draft, /Ready for your review/);
  assert.match(draft, /\/ideation to approve or revise/);
  assert.doesNotMatch(draft, /0\/10|checks verified|────/);
  const cancelled = text(createProgressWidget(run({ state: 'cancelled', attention: { message: 'Run aborted' } }), url, h.theme, h.helpers));
  assert.match(cancelled, /Cancelled/); assert.doesNotMatch(cancelled, /Needs attention/);
  const r = run({ elapsedMs: 83000 });
  const waiting = text(createProgressWidget(r, url, h.theme, h.helpers));
  assert.match(waiting, /1m 23s/);
  assert.match(waiting, /0\/10 checks verified/);
});

test('stage names and active Unicode unit title are human readable', () => {
  const h = harness();
  for (const [activeStage, label] of [['plan', 'Planning'], ['scout', 'Exploring'], ['review', 'Reviewing'], ['fix', 'Addressing review'], ['acceptance', 'Verifying checks'], ['commit', 'Recording local commit']]) {
    const c = createProgressWidget(run({ activeStage, units: [{ state: 'running', title: '設定 café 👩‍💻' }] }), url, h.theme, h.helpers);
    assert.match(text(c), new RegExp(label));
    assert.match(text(c), /設定 café 👩‍💻/u);
    assert.doesNotMatch(text(c), /human|judgment/);
  }
});

test('counts only latest passing evidence for the current revision, never unit or token estimates', () => {
  const h = harness();
  const r = run({ units: Array.from({ length: 10 }, () => ({ state: 'completed' })), usage: { totalTokens: 99999 }, evidence: [
    { criterionId: 'c0', status: 'passed', sourceRevision: 'rev-1' },
    { criterionId: 'c1', status: 'passed', sourceRevision: 'old' },
    { criterionId: 'c2', status: 'passed', sourceRevision: 'rev-1' },
    { criterionId: 'c2', status: 'failed', sourceRevision: 'rev-1' },
    { criterionId: 'unknown', status: 'passed', sourceRevision: 'rev-1' },
  ] });
  const c = createProgressWidget(r, url, h.theme, h.helpers);
  assert.match(text(c), /1\/10 checks verified/);
  assert.doesNotMatch(text(c), /done|complete|100%|99999/i);
  r.evidenceFresh = false;
  assert.match(text(c), /0\/10 checks verified/);
  assert.match(text(c), /Evidence is out of date/);
  r.evidenceFresh = true; delete r.sourceRevision;
  assert.match(text(c), /0\/10 checks verified/);
});

test('attention is actionable; review is not accepted; judgments surface only when useful', () => {
  const h = harness();
  const r = run({ state: 'needs-decision', attention: { message: 'Scope changed · review contract' } });
  const c = createProgressWidget(r, url, h.theme, h.helpers);
  assert.match(text(c), /Needs attention.*\n.*\n.*\n  Scope changed/);
  assert.ok(h.roles.some(x => x[1] === 'warning'));
  r.state = 'ready-for-review';
  r.evidence = Array.from({ length: 10 }, (_, i) => ({ criterionId: `c${i}`, status: 'passed', sourceRevision: 'rev-1' }));
  assert.match(text(c), /Ready for review/);
  assert.match(text(c), /2 human judgments · accept after review/);
  assert.doesNotMatch(text(c), /Accepted|Done/);
  r.state = 'accepted'; r.attention = null;
  assert.match(text(c), /Needs attention/, 'missing acceptance decision cannot imply done');
  r.decisions = [{ type: 'accept', sourceRevision: 'rev-1' }];
  assert.match(text(c), /Accepted/);
  assert.doesNotMatch(text(c), /human judgments/);
  assert.ok(h.roles.some(x => x[1] === 'success'));
});

test('zero objectives do not imply completion; comments are not presented as blockers', () => {
  const h = harness();
  const r = run({ brief: { title: 'Manual review', acceptance: [{ id: 'h', check: {} }] } });
  const c = createProgressWidget(r, url, h.theme, h.helpers);
  assert.match(text(c), /No objective checks configured/);
  assert.doesNotMatch(text(c), /0\/0|100%|Accepted|judgment|feedback/);
  r.feedback = [{ status: 'resolved' }, { status: 'pending' }];
  assert.doesNotMatch(text(c), /feedback pending/, 'the annotation system owns question/reply status, not this historical inbox');
});

test('responsive cards at 40/60/80/120, Unicode and tiny widths', () => {
  const h = harness();
  for (const state of ['running', 'ready', 'ready-for-review', 'needs-decision', 'paused', 'cancelled', 'failed']) {
    const r = run({ state, attention: state === 'needs-decision' ? { message: 'Review '.repeat(100) } : null });
    r.brief.title = '日本語 👩‍💻 café '.repeat(100);
    const c = createProgressWidget(r, url, h.theme, h.helpers);
    for (const width of [0, 1, 2, 5, 20, 40, 60, 80, 120]) {
      const lines = c.render(width);
      assert.ok(lines.length <= 4);
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${strip(line)}`);
      if (width >= 40) assert.match(strip(lines[0]), /Contract ↗/);
    }
  }
});

test('invalidation consults current theme for widget and both tool components', () => {
  const h = harness(); let calls = 0;
  const getter = () => { calls++; return h.theme; };
  for (const c of [createProgressWidget(run(), url, getter, h.helpers), createChangeToolCall({ action: 'prepare' }, getter, h.helpers), createChangeToolResult({ details: { approved: false, url } }, {}, getter, h.helpers)]) {
    c.render(60); h.nextTheme(); h.roles.length = 0; c.invalidate(); c.render(60);
    assert.ok(h.roles.length); assert.ok(h.roles.every(x => x[0] > 1));
  }
  assert.equal(calls, 6);
});

test('startup fallback and RPC are safe plain text, preserve Unicode and contain a real URL', () => {
  const r = run({ attention: { message: '\x1b[31mReview\x1b[0m\nnow' } });
  r.brief.title = '\x1b]8;;https://evil.test\x1b\\日本語\x1b]8;;\x1b\\ 👩‍💻';
  for (const helpers of [undefined, {}]) {
    const c = createProgressWidget(r, url, { fg() { throw Error('No ANSI in fallback'); } }, helpers);
    const output = c.render(72).join('\n');
    assert.doesNotMatch(output, /\x1b|evil\.test/);
    assert.match(output, /日本語 👩‍💻/u); assert.match(output, /file:\/\/\/tmp\/contract.html/);
    assert.equal(output, progressFallback(r, url));
  }
  for (const width of [0, 1, 5, 40, 60, 80, 120]) for (const line of progressFallback(r, url, width).split('\n')) assert.ok(visibleWidth(line) <= width);
  for (const bad of ['javascript:alert(1)', 'https://a/\x1b', 'not a URL']) {
    const h = harness();
    assert.doesNotThrow(() => text(createProgressWidget(r, bad, h.theme, h.helpers)));
    assert.equal(h.links.length, 0);
  }
});

test('tool calls never serialize args, and handle partial input without helpers', () => {
  const h = harness();
  const args = { action: 'prepare', brief: { title: '日本語 contract', why: 'SECRET', authority: { commands: ['SECRET'] } }, path: 'SECRET' };
  assert.equal(text(createChangeToolCall(args, h.theme, h.helpers)), '▎ Preparing contract\n  日本語 contract');
  for (const action of ['status', 'receipt', 'feedback', 'answer', undefined]) {
    const c = createChangeToolCall({ action, markdown: 'SECRET', content: 'SECRET' });
    assert.doesNotMatch(text(c), /SECRET|\{|\x1b/);
  }
  assert.doesNotThrow(() => createChangeToolCall().render(40));
});

test('tool results handle actual preview, receipt, status, error and delivery shapes', () => {
  const h = harness(), make = (details, options = {}) => createChangeToolResult({ details }, options, h.theme, h.helpers);
  const preview = make({ approved: false, url, briefPath: '/tmp/brief.json', briefHash: 'SECRET' });
  assert.match(text(preview), /Ready for review.*Contract ↗/);
  assert.match(text(preview), /approval required/);
  assert.doesNotMatch(text(preview), /SECRET|briefHash|approved|\{/);
  assert.match(text(make({ run: run(), url })), /0\/10 checks verified/);
  assert.match(text(make(run())), /Building/);
  assert.match(text(make([])), /No changes yet/);
  assert.match(text(make([run(), run()])), /2 changes/);
  assert.match(text(make({ delivered: false })), /Feedback not delivered/);
  assert.match(text(make({ delivered: true })), /Feedback delivered/);
  assert.match(text(make({ ok: true })), /Answer recorded/);
  assert.match(text(make({ ok: false })), /Needs attention/);
  assert.match(text(make({ error: 'Invalid contract', url })), /Needs attention.*Contract ↗/);
  const partial = make({ approved: false, url }, { isPartial: true });
  assert.match(text(partial), /Updating change/); assert.doesNotMatch(text(partial), /Ready|Accepted|Done/);
  const unknown = createChangeToolResult({ content: [{ type: 'text', text: '{"secret":"SECRET"}' }] }, {}, h.theme, h.helpers);
  assert.doesNotMatch(text(unknown), /SECRET|Done|Ready/);
  assert.match(text(createChangeToolResult({ isError: true, content: [{ type: 'text', text: 'Request failed' }] }, {}, h.theme, h.helpers)), /Request failed/);
});

test('expanded diagnostics are real, allowlisted, bounded and width-safe', () => {
  const h = harness();
  const r = run({ evidence: Array.from({ length: 100 }, (_, i) => ({ criterionId: `c${i}`, status: 'failed', sourceRevision: 'rev-1', stdout: 'SECRET'.repeat(1000) })) });
  const result = { details: { run: r, url } };
  const collapsed = createChangeToolResult(result, {}, h.theme, h.helpers);
  assert.doesNotMatch(text(collapsed), /Run:|Revision:|c99/);
  const expanded = createChangeToolResult(result, { expanded: true }, h.theme, h.helpers);
  assert.match(text(expanded), /Run: run-1/); assert.match(text(expanded), /c99: failed/);
  assert.doesNotMatch(text(expanded), /SECRET|c94:/);
  for (const width of [40, 60, 80, 120]) {
    const lines = expanded.render(width); assert.ok(lines.length <= 12);
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
  }
});

const units = [['content', 'Swappable installer content'], ['model', 'Event-driven run model'], ['host', 'UI host seam in ui.ts'], ['full', 'Full-screen Ink installer and wiring']];
const liveRun = (overrides = {}) => run({
  brief: { ...run().brief, title: 'Full-screen installer', units: units.map(([id, title]) => ({ id, title })) },
  units: units.map(([id, title], i) => ({ id, title, state: i < 1 ? 'completed' : i === 1 ? 'running' : 'ready', reviewStatus: i < 1 ? 'passed' : 'not-run' })),
  evidence: [{ criterionId: 'c0', status: 'passed', sourceRevision: 'rev-1' }, { criterionId: 'c1', status: 'passed', sourceRevision: 'rev-1' }, { criterionId: 'c2', status: 'passed', sourceRevision: 'rev-1' }],
  ...overrides,
});

test('step strip shows each deliverable once, fits the width, and drops out when narrow', () => {
  const h = harness();
  const c = createProgressWidget(liveRun(), url, h.theme, h.helpers);
  const lines = c.render(80).map(strip);
  assert.match(lines[2], /^  ✓ .+  ◐ .+  ○ .+  ○ .+$/);
  assert.equal(lines[2], '  ✓ Swappable inst…  ◐ Event-driven r…  ○ UI host seam i…  ○ Full-screen Ink…', 'titles shrink evenly to fit 80 columns');
  assert.match(strip(c.render(120)[2]), /✓ Swappable installer content  ◐ Event-driven run model  ○ UI host seam in ui\.ts  ○ Full-screen Ink .+…$/, 'at 120 only the longest shrinks');
  for (const width of [60, 80, 120]) for (const line of c.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${strip(line)}`);
  assert.ok(!c.render(59).map(strip).some(l => l.includes('◐')), 'no strip below 60 columns');
  assert.ok(c.render(120).length <= 5);
  const many = liveRun({ brief: { ...liveRun().brief, units: Array.from({ length: 14 }, (_, i) => ({ id: `u${i}`, title: `Deliverable number ${i}` })) } });
  const compact = strip(createProgressWidget(many, url, h.theme, h.helpers).render(60)[2]);
  assert.match(compact, /^  [✓◐○✗ ]+$/, 'too many to name: glyphs only');
  for (const state of ['needs-decision', 'draft', 'cancelled', 'accepted']) assert.ok(!text(createProgressWidget(liveRun({ state }), url, h.theme, h.helpers)).includes('◐'), state);
});

test('motion decorates recorded state: frames move, counts and fills never do', () => {
  const h = harness();
  let clock = 1000;
  const motion = createMotion(() => clock);
  const r = liveRun();
  motion.observe(r);
  // Roles made visible so a moving highlight is observable.
  const roleTheme = { fg: (role, t) => `\x1b[${role.length}m${t}\x1b[0m`, bold: t => `\x1b[1m${t}\x1b[0m` };
  const c = createProgressWidget(r, url, roleTheme, h.helpers, motion);
  const frames = [];
  for (let i = 0; i < 12; i++) { clock += 85; frames.push(c.render(80)); }
  const plain = frames.map(f => f.map(strip));
  assert.ok(new Set(plain.map(f => f[0][2])).size > 3, 'the spinner turns');
  assert.ok(new Set(frames.map(f => f[1])).size > 1, 'the highlight sweeps the active title');
  assert.equal(new Set(plain.map(f => f[1])).size, 1, 'title text itself never changes');
  assert.equal(new Set(plain.map(f => f[3])).size, 1, 'bar fill and "3/10 checks verified" are identical in every frame');
  assert.match(plain[0][3], /3\/10 checks verified|1\/4 deliverables reviewed/);
  assert.ok(motion.animating(r));
  const still = createProgressWidget(r, url, h.theme, h.helpers);
  assert.equal(new Set([still.render(80).join(), (clock += 500, still.render(80).join())]).size, 1, 'without motion the widget is static');
});

test('a deliverable sparkles once when its review passes; ready celebrates once; reloads replay nothing', () => {
  let clock = 0;
  const motion = createMotion(() => clock);
  const r = liveRun();
  motion.observe(r);
  assert.equal(motion.frame(r).sparks.size, 0, 'already-passed work on first sight does not sparkle');
  r.units[1] = { ...r.units[1], state: 'completed', reviewStatus: 'passed' };
  clock = 100; motion.observe(r);
  clock = 400;
  const h = harness();
  assert.match(strip(createProgressWidget(r, url, h.theme, h.helpers, motion).render(80)[2]), /✓ Event-driven r… [✦✧⋆·]  ○ UI host seam.+  ○ Full-screen.+$/);
  clock = 1100;
  assert.equal(motion.frame(r).sparks.size, 0, 'the sparkle ends');
  const ready = { ...r, state: 'ready-for-review', units: r.units.map(u => ({ ...u, state: 'completed', reviewStatus: 'passed' })),
    evidence: Array.from({ length: 10 }, (_, i) => ({ criterionId: `c${i}`, status: 'passed', sourceRevision: 'rev-1' })) };
  clock = 2000; motion.observe(ready);
  clock = 2500;
  assert.ok(motion.animating(ready));
  const celebrating = strip(createProgressWidget(ready, url, h.theme, h.helpers, motion).render(80)[0]);
  assert.match(celebrating, /^▎ [✦✧⋆] Ready for review [✦✧⋆] [✦✧⋆]/);
  clock = 5000;
  assert.ok(!motion.animating(ready), 'ready settles');
  assert.match(strip(createProgressWidget(ready, url, h.theme, h.helpers, motion).render(80)[0]), /^▎ ✦ Ready for review  Contract ↗$/);
  const reloaded = createMotion(() => clock);
  reloaded.observe(ready);
  assert.equal(reloaded.frame(ready).celebrate, undefined);
  for (const state of ['paused', 'draft', 'accepted', 'cancelled', 'needs-decision']) assert.ok(!reloaded.animating({ ...ready, state }), `${state} is idle`);
});

test('the live widget reads the latest presentation and a motion getter each render', () => {
  const h = harness();
  let presentation = { run: liveRun(), url }, enabled = false;
  const motion = createMotion(() => 1234);
  const c = createLiveProgressWidget(() => presentation, h.theme, h.helpers, () => enabled ? motion : undefined);
  assert.match(strip(c.render(80)[0]), /^▎ Building/);
  enabled = true;
  assert.match(strip(c.render(80)[0]), /^▎ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Building/);
  presentation = { run: liveRun({ state: 'paused' }), url };
  assert.match(strip(c.render(80)[0]), /^▎ Paused/);
});
