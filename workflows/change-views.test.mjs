import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateBrief, briefFingerprint } from './change-brief.mjs';
import { progressSummary } from './change-ui.mjs';
import { renderBrief } from '../scripts/change-render.mjs';
const brief = validateBrief(JSON.parse(readFileSync(new URL('../test-fixtures/native-change/brief.json', import.meta.url), 'utf8')));
function run() {
  return { id: 'test-run', brief, briefHash: briefFingerprint(brief), sourceRevision: 'source-a', state: 'running', sequence: 1,
    units: brief.units.map(u => ({ id: u.id, title: u.title, state: 'running', attempts: 1 })), evidence: [], decisions: [] };
}
test('progress counts objective evidence, not tokens, unit count or pending judgments', () => {
  const r = run(); const command = brief.acceptance.find(c => c.check.cmd);
  r.evidence = [{ criterionId: command.id, sourceRevision: 'source-a', status: 'passed' }];
  assert.equal(progressSummary(r).passed, 1);
  assert.equal(progressSummary(r).total, brief.acceptance.filter(c => c.check.cmd).length);
  r.evidence.push({ criterionId: command.id, sourceRevision: 'source-a', status: 'failed' });
  assert.equal(progressSummary(r).passed, 0, 'latest failed receipt wins over older pass');
  r.evidence = [{ criterionId: command.id, sourceRevision: 'stale', status: 'passed' }];
  assert.equal(progressSummary(r).passed, 0);
});
test('live contract keeps stable anchors across running, evidence and final receipt state', () => {
  const r = run(); const first = renderBrief(brief, { run: r });
  r.state = 'ready-for-review'; r.sequence++;
  r.units[0].state = 'completed'; r.units[0].summary = 'Implemented and reviewed';
  const last = renderBrief(brief, { run: r });
  for (const id of ['change-header', 'the-change', 'run-status', 'run-progress', 'run-work', 'run-conversation', ...brief.acceptance.map(c => `criterion-${c.id}`)]) {
    assert.ok(first.includes(`id="${id}"`), id); assert.ok(last.includes(`id="${id}"`), id);
  }
  assert.match(last, /Implemented and reviewed/);
  assert.ok(last.includes(brief.change.before)); assert.ok(last.includes(brief.change.after));
  const ids = [...last.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length);
});
test('feedback is escaped and acceptance requires explicit human evidence', () => {
  const r = run(); r.feedback = [{ id: 'feedback-one', markdown: '<script>steal()</script>', status: 'pending' }];
  const html = renderBrief(brief, { run: r });
  assert.ok(html.includes('&lt;script&gt;steal()&lt;/script&gt;')); assert.ok(!html.includes('<script>steal()'));
  assert.match(html, /Feedback never changes approval/);
  const c = brief.acceptance.find(c => c.check.judgment);
  if (c) {
    r.evidence = [{ criterionId: c.id, sourceRevision: r.sourceRevision, status: 'pending' }];
    r.state = 'accepted'; assert.equal(progressSummary(r).pendingJudgments, 1);
    r.decisions = [{ type: 'accept', sourceRevision: r.sourceRevision, judgments: [c.id] }];
    assert.equal(progressSummary(r).pendingJudgments, 0);
    assert.match(renderBrief(brief, { run: r }), /Explicit human acceptance recorded/);
  }
});
