import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { load, validate } from './plan-data.ts';
import { migrate, readFolder } from './plan-migrate.mjs';
import { packPlan, renderPlan } from './plan-render.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RUNTIME = join(ROOT, 'vendor/html-plan/runtime');
const committed = pattern => execFileSync('git', ['ls-files', pattern], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);

// test-fixtures/plan/plan.json describes another project: its level-3 claim cites src/outbox.ts
// lines 10-24 as code that exists. It renders against a stub checkout holding that file.
const stubRoot = mkdtempSync(join(tmpdir(), 'plan-render-root-'));
mkdirSync(join(stubRoot, 'src'));
writeFileSync(join(stubRoot, 'src/outbox.ts'), Array.from({ length: 30 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join('\n'));
test.after(() => rmSync(stubRoot, { recursive: true, force: true }));

/** Every plan the renderer must draw: committed plan files, and every committed 0.x contract and brief, migrated. */
const PLANS = [
  ...committed('*plan.json').map(path => ({ name: path, plan: load(join(ROOT, path)), root: path === 'test-fixtures/plan/plan.json' ? stubRoot : ROOT })),
  ...[...committed('*contract-data.json'), ...committed('*brief.json')].map(dirname).map(dir => {
    const { contractData, brief } = readFolder(join(ROOT, dir));
    return { name: dir, plan: migrate({ contractData, brief }), root: ROOT };
  }),
];

/**
 * The only warnings pack may raise. doc-calls rows citing files that do not exist yet are
 * expected; the rest are pack's writing budgets, raised by 0.x text the renderer shows word
 * for word and never rewords. Any warning not listed here fails, so a new one is a decision.
 */
const ALLOWED_WARNINGS = {
  'test-fixtures/plan/plan.json': [
    '<doc-calls>: 2 rows point at files not found — those rows will not open code',
  ],
  'docs/ideation/ux-dejank': [
    'claim 1.1: the claim is 39 words — one short sentence (≤ ~12) that can be true or false',
    'claim 1.2: the claim is 26 words — one short sentence (≤ ~12) that can be true or false',
    'claim 1.3: the claim is 26 words — one short sentence (≤ ~12) that can be true or false',
    'claim 1.4: the claim is 24 words — one short sentence (≤ ~12) that can be true or false',
    'claim 1.5: the claim is 41 words — one short sentence (≤ ~12) that can be true or false',
    'claim 2.2.3: the claim is 17 words — one short sentence (≤ ~12) that can be true or false',
    'claim 2.2.4: the claim is 24 words — one short sentence (≤ ~12) that can be true or false',
    'doc-plan: 15 decisions — 2 to 5; ask only about forks that change what you build, and default the rest',
    '4 paragraphs over 40 words (longest 70) — two short sentences, then a block; move the rest into a caption, a pin or a table',
    '8 sentences over 25 words — split them; one idea per sentence',
    '749 words of prose for 40 blocks — aim for ≤ 350 words and ≤ ~30 per block; cut, or show it as a block',
  ],
  'test-fixtures/native-change': [
    'claim 1.1: "Self-contained HTML" — write a full sentence with a verb, not a heading',
  ],
  'test-fixtures/open-questions': [
    'claim 1: the claim is 22 words — one short sentence (≤ ~12) that can be true or false',
    'claim 2.1: "A second fixture rather than open questi" — write a full sentence with a verb, not a heading',
    'claim 2.2: "A deliberately stale id in blockedBy" — write a full sentence with a verb, not a heading',
    'ASD-STE100: use simple tenses, not "has/have + verb" — "has already closed"',
  ],
  'test-fixtures/orchestration': [
    'claim 2.1: "Rig Phase 3\'s validation to exit 1 deter" — write a full sentence with a verb, not a heading',
    'claim 2.2: "Prove graph behavior with planner unit t" — write a full sentence with a verb, not a heading',
  ],
  'test-fixtures/plan-migrate/brief-only': [
    'claim 1.1: "Retry three times, five minutes apart" — write a full sentence with a verb, not a heading',
    'claim 1.2: "Keep the attempt count on the outbox row" — write a full sentence with a verb, not a heading',
  ],
};

/** pack.mjs --lint-only over the rendered page: its warnings, or a throw carrying its errors. */
// Line numbers are dropped: they move whenever the page's inline CSS does.
const lint = (plan, root) => packPlan(plan, { root, lintOnly: true }).split('\n').filter(l => l.startsWith('  ⚠ ')).map(l => l.slice(4).replace(/^line \d+ /, ''));

test('every committed plan, contract and brief renders and passes pack lint with only the allowed warnings', () => {
  assert.deepEqual(PLANS.map(p => p.name).sort(), Object.keys(ALLOWED_WARNINGS).sort(), 'each rendered plan has an entry in ALLOWED_WARNINGS');
  for (const { name, plan, root } of PLANS) assert.deepEqual(lint(plan, root), ALLOWED_WARNINGS[name], name);
});

test('pack refuses a plan whose non-sketch exhibit cites a file that is missing', () => {
  const plan = load(join(ROOT, 'test-fixtures/plan/plan.json'));
  assert.throws(() => lint(plan, ROOT), /src="src\/outbox\.ts" ref="main" — git show failed[\s\S]*1 error\(s\)/);
});

/** One plan that reaches every branch of the mapping: each kind with a body and with a src, a sketch src, and every decision state. */
function everyBranch() {
  const p = load(join(ROOT, 'test-fixtures/plan/plan.json'));
  p.claims[1].children = [
    { id: '2.1', text: 'The label is one constant.', exhibit: { kind: 'code', src: 'src/label.ts', body: 'export const GAVE_UP = "Gave up";', sketch: true } },
    { id: '2.2', text: 'The outbox row has an attempt count.', exhibit: { kind: 'schema', src: 'src/outbox.ts', lines: '1-3', sketch: false } },
    { id: '2.3', text: 'The retry state lives in a new file.', exhibit: { kind: 'schema', src: 'src/retry-state.ts', sketch: true } },
  ];
  return validate(p);
}

test('the renderer emits only doc-* elements and attributes the vendored runtime knows', () => {
  const js = readFileSync(join(RUNTIME, 'htmlplan.js'), 'utf8');
  const pack = readFileSync(join(RUNTIME, 'pack.mjs'), 'utf8');
  // Elements: pack's KNOWN list, which its lint enforces, each of which htmlplan.js handles.
  const elements = new Set(pack.match(/const KNOWN = new Set\(\[([^\]]+)\]\)/)[1].match(/doc-[a-z]+/g));
  for (const el of elements) assert.ok(js.includes(el), `${el} is in pack's KNOWN list but not in htmlplan.js`);
  // Attributes: the ones htmlplan.js reads, plus id.
  const attributes = new Set(['id', ...[...js.matchAll(/(?:get|has|toggle)Attribute\('([\w-]+)'/g)].map(m => m[1])]);
  for (const { name, plan } of [...PLANS, { name: 'every branch', plan: everyBranch() }]) {
    for (const [, tag, rest] of renderPlan(plan).matchAll(/<(doc-[a-z]+)\b([^>]*)>/g)) {
      assert.ok(elements.has(tag), `${name}: <${tag}> is not a runtime element`);
      for (const [, attr] of rest.matchAll(/([\w-]+)(?:="[^"]*")?/g)) assert.ok(attributes.has(attr), `${name}: <${tag} ${attr}> is not an attribute the runtime reads`);
    }
  }
});

test('the mapping: claims, exhibits by kind, sketches labelled, decisions with their state and rejections, scope', () => {
  const html = renderPlan(everyBranch());
  assert.match(html, /<h1>Failed sends retry on their own<\/h1>\n<div class="meta"><span>send-retry<\/span><span>Version 2<\/span><span>Supersedes plan\.v1\.json<\/span><\/div>/);
  assert.match(html, /<summary>Why · 2 quotes<\/summary>\n<doc-quote via="prompt" from="user">When a send fails I only find out hours later\.<\/doc-quote>/);
  assert.match(html, /<doc-claim>\n<p>A failed send retries three times, five minutes apart\.<\/p>\n<doc-machine caption="Sketch: this does not exist yet\."><script type="text\/plain">\nmachine send initial failed/);
  assert.match(html, /<doc-calls caption="Sketch: this does not exist yet\."><script type="text\/plain">\n~ retryWorker\(\)/);
  assert.match(html, /<doc-code src="src\/outbox\.ts" lines="10-24" ref="main"><\/doc-code>/);
  assert.match(html, /<doc-mock frame="none" w="440" caption="Sketch: this does not exist yet\."><template><p [^>]*>&lt;div&gt;Gave up after 3 tries · Try again&lt;\/div&gt;<\/p><\/template><\/doc-mock>/);
  assert.match(html, /<doc-schema title="schema · sketch" lang="ts"><script type="text\/plain">\nretry: \{ attempts: number; delayMs: number \}\n<\/script><\/doc-schema>/);
  assert.match(html, /<doc-code title="src\/label\.ts · sketch" lang="ts"><script type="text\/plain">\nexport const GAVE_UP = "Gave up";\n<\/script><\/doc-code>/);
  assert.match(html, /<doc-schema src="src\/outbox\.ts" lines="1-3" lang="ts"><\/doc-schema>/);
  assert.match(html, /<doc-schema title="src\/retry-state\.ts · sketch" lang="ts"><script type="text\/plain">\nNot written yet\.\n<\/script><\/doc-schema>/);
  assert.equal((html.match(/<doc-[a-z]+ src="/g) ?? []).length, 2, 'only non-sketch exhibits get src=');
  const warnings = lint(everyBranch(), stubRoot);
  assert.equal(warnings.length, 1); assert.match(warnings[0], /<doc-calls>: 2 rows point at files not found/);
  // kept: the recommended option is checked; rejections show, with their reason when known.
  assert.match(html, /<doc-ask id="retries">\n {2}<p>How many retries before the worker stops\?<\/p>\n {2}<label><input type="radio" name="retries" value="three" checked> 3, five minutes apart<\/label>\n {2}<label><input type="radio" name="retries" value="five"> 5, with backoff<\/label>\n {2}<label><input type="radio" name="retries" value="none"> None\. The user presses Try again <small>Rejected: It is the problem we are fixing\.<\/small><\/label>\n {2}<p><b>Kept as recommended\.<\/b> Three covers/);
  // answered: the answer is checked, not the recommendation, so Respond keeps it.
  assert.match(html, /value="count" checked> Gave up after 3 tries<\/label>\n {2}<label><input type="radio" name="give-up-label" value="plain"> Not sent <small>Rejected: Reads as if nothing was tried\.<\/small><\/label>\n {2}<p><b>Answered: Gave up after 3 tries\.<\/b>/);
  assert.match(html, /value="config" checked> In config\.json<\/label>[\s\S]*?<p><b>Not opened\.<\/b> Config already/);
  assert.match(html, /<doc-claim aux="scope">\n<p>Scope: what is in, what is not changing\.<\/p>\n<h4>MVP<\/h4>\n<ul>\n<li>Retry worker<\/li>\n<li>Gave-up label<\/li>\n<\/ul>\n<h4>Stretch<\/h4>[\s\S]*<h4>Not changing<\/h4>[\s\S]*<h4>Dropped<\/h4>\n<ul>\n<li>A retry button on every row<\/li>\n<\/ul>\n<\/doc-claim>\n<\/doc-plan>/);
  // A recorded decision with no question asks with its chosen label; a required open one says so.
  const migrated = PLANS.find(p => p.name === 'test-fixtures/plan-migrate/brief-only').plan;
  assert.match(renderPlan(migrated), /<p>Retry three times, five minutes apart<\/p>\n {2}<label><input type="radio" name="decision-1" value="chosen" checked> Retry three times, five minutes apart<\/label>\n {2}<label><input type="radio" name="decision-1" value="rejected"> Exponential backoff <small>Rejected<\/small><\/label>/);
  const open = everyBranch(); open.claims[2].decision.required = true;
  assert.match(renderPlan(open), /<p><b>Not opened \(required\)\.<\/b>/);
});

test('the header shows the gates and the open questions, unblocked first, so a map can be read on its page', () => {
  const open = PLANS.find(p => p.name === 'test-fixtures/open-questions').plan;
  const html = renderPlan({ ...open, stoppedEarly: 'map: the route is still open' });
  assert.match(html, /<\/div>\n<p class="dek">Stopped early: map: the route is still open<\/p>\n/);
  // Any gate not ready keeps the gates open; each row has its state and evidence.
  assert.match(html, /<details class="thread" open><summary>Gates · 1 of 5 ready<\/summary>\n<div class="table-wrap"><table>\n<thead><tr><th>Gate<\/th><th>State<\/th><th>Evidence<\/th><\/tr><\/thead>/);
  assert.match(html, /<tr><td>Problem Clarity<\/td><td><span class="pill ok">Ready<\/span><\/td><td>/);
  assert.match(html, /<tr><td>Goal Definition<\/td><td><span class="pill warn">Not ready<\/span><\/td><td>/);
  // Questions: the frontier in array order, then the blocked ones with only the ids still open.
  assert.match(html, /<summary>Open questions · 4 \(2 unblocked\)<\/summary>\n<h4>Unblocked<\/h4>/);
  const [unblocked, blocked] = html.split('<h4>Blocked</h4>');
  assert.deepEqual([...unblocked.matchAll(/<tr><td><code>([\w-]+)<\/code>/g)].map(m => m[1]), ['runtime-step-timeout', 'resume-line-readability']);
  assert.match(unblocked, /<td><code>runtime-step-timeout<\/code> [^<]+<\/td><td>research<\/td><td>Success Criteria<\/td><\/tr>/);
  assert.match(blocked, /<thead><tr><th>Question<\/th><th>Type<\/th><th>Gate<\/th><th>Blocked by<\/th><\/tr><\/thead>/);
  assert.match(blocked, /<td><code>exit-code-vs-crash<\/code> [^<]+<\/td><td>task<\/td><td>Consistency<\/td><td><code>runtime-step-timeout<\/code><\/td><\/tr>/);
  assert.match(blocked, /<td><code>skip-vs-fail-accounting<\/code> [^<]+<\/td><td>decision<\/td><td>Scope Boundaries<\/td><td><code>runtime-step-timeout<\/code> <code>resume-line-readability<\/code><\/td><\/tr>/);
  assert.doesNotMatch(html, /already-closed-elsewhere/, 'a closed id blocks nothing and is not shown');
  // The header holds them, outside <main>: the claim tree and pack's prose budgets are unchanged.
  assert.ok(html.indexOf('Open questions') < html.indexOf('</header>'));
  // A ready plan with no questions: the gates fold away and there is no questions section or stop line.
  const ready = renderPlan(load(join(ROOT, 'test-fixtures/plan/plan.json')));
  assert.match(ready, /<details class="thread"><summary>Gates · 5 of 5 ready<\/summary>/);
  assert.doesNotMatch(ready, /Open questions|Stopped early/);
});

test('rendering is deterministic: the same plan gives the same bytes, rendered and packed', t => {
  const plan = load(join(ROOT, 'test-fixtures/plan/plan.json'));
  assert.equal(renderPlan(plan), renderPlan(structuredClone(plan)));
  const dir = mkdtempSync(join(tmpdir(), 'plan-render-out-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  packPlan(plan, { root: stubRoot, out: join(dir, 'a.html') });
  packPlan(plan, { root: stubRoot, out: join(dir, 'b.html') });
  const packed = readFileSync(join(dir, 'a.html'), 'utf8');
  assert.equal(packed, readFileSync(join(dir, 'b.html'), 'utf8'));
  // Packed means self-contained: the runtime and the field-guide layer are inline, nothing is linked.
  assert.doesNotMatch(packed, /<link\b|<script\b[^>]*\ssrc=/);
  assert.match(packed, /<style data-htmlplan>/);
  assert.match(packed, /<style data-plan-render>[\s\S]*--paper: #f7f7f3; \/\* --bg \*\//);
  assert.match(packed, /<script data-htmlplan>[\s\S]*NW\.planHost/);
  assert.match(packed, /export const line10 = 10;/, 'the src= exhibit is filled from --root');
});

test('plan text is data: markup and quotes in any field come out inert', () => {
  const evil = '"><script>alert(1)</script><img src=x onerror="alert(2)">\'';
  const p = everyBranch();
  p.title = `${evil} title`;
  p.why[0] = { quote: evil, from: evil };
  p.supersedes = evil;
  p.claims[0].text = evil;
  p.claims[1].children[0].exhibit.body = `${evil}\n</doc-code><script>alert(3)</script><!-- <script>`;
  p.claims[1].exhibit.body = evil;
  Object.assign(p.claims[0].decision, { id: evil, question: evil, reason: evil });
  p.claims[0].decision.options[1].label = evil;
  p.claims[0].decision.rejected[0].reason = evil;
  p.scope.mvp = [evil];
  p.stoppedEarly = evil;
  p.gates.goals = { ready: false, evidence: evil };
  p.openQuestions = [
    { id: evil, question: evil, gate: 'goals', type: 'decision' },
    { id: 'held', question: evil, gate: 'scope', type: 'research', blockedBy: [evil] },
  ];
  const html = renderPlan(p);
  // Block sources sit in text/plain scripts, where the sequences that could end them early are broken.
  const sources = [...html.matchAll(/<script type="text\/plain">([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.ok(sources.some(b => b.includes('<\\/doc-code><script>alert(3)<\\/script><\\!-- <script>')), 'the code body stays inside its script');
  for (const b of sources) assert.doesNotMatch(b, /<\/script|<\/doc-|<!--/i);
  // Outside them, nothing in the plan became markup.
  const rest = html.replace(/<script type="text\/plain">[\s\S]*?<\/script>/g, '');
  assert.deepEqual(rest.match(/<script\b[^>]*>/g), ['<script src="htmlplan.js" defer>'], 'the runtime is the only script');
  assert.doesNotMatch(rest, /<img\b/);
  // No attribute breaks out of its quotes: every tag is name="value" pairs, none of them an on* handler.
  for (const [tag, attrs] of rest.matchAll(/<[a-z][\w-]*((?:\s+[\w-]+(?:="[^"]*")?)*)\s*>/g)) {
    for (const [, name] of attrs.matchAll(/([\w-]+)(?:="[^"]*")?/g)) assert.doesNotMatch(name, /^on/, tag);
  }
  assert.equal(rest.match(/<[a-z]/g).length, rest.match(/<[a-z][\w-]*(?:\s+[\w-]+(?:="[^"]*")?)*\s*>/g).length, 'every tag is well formed');
  assert.ok(rest.includes('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=&quot;alert(2)&quot;&gt;\''));
  // And the page still lints: the escaped text breaks no block.
  assert.doesNotThrow(() => lint(p, stubRoot));
});

test('Send hook: Respond hands the response to the host when there is one, and only copy is offered otherwise', () => {
  const js = readFileSync(join(RUNTIME, 'htmlplan.js'), 'utf8');
  // The DOM-free half of the runtime, as pack loads it: no document, so it stops after the parsers and planHost.
  const context = vm.createContext({});
  vm.runInContext(js, context);
  const { planHost } = context.HtmlPlan;
  const payload = { markdown: '# Re: Plan\n', answers: { retries: 'five' } };

  const calls = [];
  const page = { __planRespond: p => calls.push(p) }; page.parent = page;
  planHost(page)(payload);
  assert.deepEqual(calls, [payload], '__planRespond fires with the payload');

  const posted = [];
  const framed = { parent: { postMessage: (...args) => posted.push(args) } };
  planHost(framed)(payload);
  // The message object is built inside the vm realm, so compare its parts, not its prototype.
  assert.equal(posted.length, 1, 'a framed page posts to its parent');
  assert.deepEqual(Object.keys(posted[0][0]), ['type', 'payload']);
  assert.equal(posted[0][0].type, 'ideation:plan-respond'); assert.equal(posted[0][0].payload, payload); assert.equal(posted[0][1], '*');

  const both = { __planRespond: p => calls.push(p), parent: { postMessage: (...args) => posted.push(args) } };
  planHost(both)(payload);
  assert.equal(calls.length, 2); assert.equal(posted.length, 1, 'a page with both hands it over once, through __planRespond');

  const alone = {}; alone.parent = alone;
  assert.equal(planHost(alone), null, 'no host: no sender');

  // openResponse wires planHost in: with no host, liveOn is false and send is null, upstream's copy-only sheet.
  assert.ok(js.includes("const host = NW.planHost(window), liveOn = !!host, send = liveOn ? h('button', { class: 'nw-btn primary', onclick: () => { host({ markdown: r.md, answers: ans }); state.textContent = 'Sent'; } }, 'Send') : null;"));
  assert.ok(js.includes("[reset, state, h('span', { class: 'sp' }), copy, send]"), 'the sheet footer shows copy, and send only when live');
});
