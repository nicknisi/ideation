import { validateBrief, briefFingerprint } from '../workflows/change-brief.mjs';
import { readFileSync } from 'node:fs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const prose = value => esc(value).replace(/`([^`\n]+)`/g, '<code>$1</code>');
const list = values => values.length ? `<ul>${values.map(v => `<li>${prose(v)}</li>`).join('')}</ul>` : '<p class="muted">None specified.</p>';
const section = (title, body, anchor = title.toLowerCase().replace(/[^a-z0-9]+/g, '-')) => `<section id="${esc(anchor)}" data-artifact-anchor="${esc(anchor)}"><h2>${esc(title)}</h2>${body}</section>`;
const code = value => `<pre><code>${esc(value)}</code></pre>`;
const fold = (title, body) => `<details><summary>${esc(title)}</summary><div class="detail-body">${body}</div></details>`;
const badge = (text, tone = '') => `<span class="badge ${tone}">${esc(text)}</span>`;
// The canonical sheet is included verbatim. This surface defines layout, not a palette.
const css = readFileSync(new URL('./contract-gen.css', import.meta.url), 'utf8') + '\n' + readFileSync(new URL('./change-render.css', import.meta.url), 'utf8');
// Motion is opt-in per page view: content is visible unless this pre-paint script
// confirms motion is welcome, and entrances replay only when the stamped state changes.
const themeBoot = `try{var saved=localStorage.getItem('ideation-contract-theme');if(saved==='light'||saved==='dark')document.documentElement.dataset.theme=saved;}catch{}try{var r=document.documentElement;if(typeof matchMedia==='function'&&typeof IntersectionObserver!=='undefined'&&!matchMedia('(prefers-reduced-motion: reduce)').matches&&!matchMedia('print').matches){r.dataset.motion='on';var k='ideation-stamp:'+location.pathname,st=r.dataset.stampState||'';if(sessionStorage.getItem(k)!==st){r.dataset.fresh='1';sessionStorage.setItem(k,st);}}}catch{}`;
const controls = `(() => {
  const root=document.documentElement, button=document.getElementById('theme-toggle');
  const modes=['auto','light','dark'];
  function apply(mode){
    if(mode==='auto')delete root.dataset.theme;else root.dataset.theme=mode;
    button.dataset.mode=mode;
    const label='Colour theme: '+(mode==='auto'?'follow system':mode)+'. Switch to '+modes[(modes.indexOf(mode)+1)%3];
    button.setAttribute('aria-label',label);button.title=label;
  }
  apply(root.dataset.theme||'auto');
  button.addEventListener('click',()=>{const mode=modes[(modes.indexOf(button.dataset.mode)+1)%3];apply(mode);try{localStorage.setItem('ideation-contract-theme',mode);}catch{}});
  let closed=[];
  addEventListener('beforeprint',()=>{closed=[...document.querySelectorAll('details:not([open])')];closed.forEach(d=>d.open=true);});
  addEventListener('afterprint',()=>{closed.forEach(d=>d.open=false);closed=[];});
})();
(() => {
  const root=document.documentElement;
  if(root.dataset.motion!=='on')return;
  try{
    // Checks that passed since this tab last saw the page are inked on.
    const key='ideation-ticks:'+location.pathname, ticks=[...document.querySelectorAll('[data-tick="passed"]')];
    let prev=null;try{prev=JSON.parse(sessionStorage.getItem(key)||'null');}catch{}
    if(Array.isArray(prev)&&!root.dataset.fresh)ticks.forEach(t=>{if(!prev.includes(t.dataset.criterion))t.classList.add('just-inked');});
    try{sessionStorage.setItem(key,JSON.stringify(ticks.map(t=>t.dataset.criterion)));}catch{}
    if(!root.dataset.fresh)return;
    const io=new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting){e.target.classList.add('seen');io.unobserve(e.target);}}),{rootMargin:'0px 0px -6% 0px'});
    document.querySelectorAll('.native-document section').forEach(s=>io.observe(s));
  }catch{delete root.dataset.fresh;}
})();`;
const themeButton = `<button type="button" class="theme-toggle" id="theme-toggle" data-mode="auto" aria-label="Colour theme: follow system. Switch to light"><svg class="i-auto" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor"/><path d="M8 3a5 5 0 0 1 0 10Z" fill="currentColor"/></svg><svg class="i-light" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4" fill="none" stroke="currentColor"/><path d="M8 0v2m0 12v2M0 8h2m12 0h2M2 2l2 2m8 8l2 2M2 14l2-2m8-8l2-2" stroke="currentColor"/></svg><svg class="i-dark" viewBox="0 0 16 16" aria-hidden="true"><path d="M12 12A6 6 0 0 1 4 3a6 6 0 0 0 8 9Z" fill="none" stroke="currentColor"/></svg></button>`;
const states = {
  ready: ['Ready', 'Execution has not started.'],
  running: ['Running', 'Work is in progress; this is not an acceptance receipt.'],
  verifying: ['Verifying', 'Checking the integrated source.'],
  'needs-decision': ['Needs a decision', 'Execution needs human attention before it can continue.'],
  paused: ['Paused', 'Execution is paused at a safe boundary.'],
  interrupted: ['Interrupted', 'The owner stopped unexpectedly. Reconciliation is required.'],
  failed: ['Failed', 'The run did not complete successfully.'],
  cancelling: ['Cancelling', 'Work is still settling; writes may still be in flight.'],
  cancelled: ['Cancelled', 'Execution has stopped. Changes may remain in the workspace.'],
  'ready-for-review': ['Ready for review', 'Implementation is ready for human review, not accepted or merged.'],
  accepted: ['Accepted', 'The run records explicit human acceptance. This does not mean merged or deployed.'],
};
// The stamp reports recorded state only; a draft is visibly not approved.
const stamps = {
  ready: ['Approved', 'accent'], planning: ['Approved', 'accent'], running: ['Approved', 'accent'], verifying: ['Approved', 'accent'],
  'ready-for-review': ['Ready for review', 'accent'], accepted: ['Accepted', 'go'], paused: ['Paused', 'caution'],
  'needs-decision': ['Needs decision', 'caution'], interrupted: ['Interrupted', 'caution'], failed: ['Failed', 'danger'],
  cancelling: ['Cancelled', 'faint'], cancelled: ['Cancelled', 'faint'],
};
function stampFor(b, run) {
  const [label, tone] = !run ? ['Draft', 'faint'] : Object.hasOwn(stamps, run.state) ? stamps[run.state] : [];
  if (!label) return { key: 'unknown', html: '' };
  const sub = `${!run ? 'Not approved' : 'Rev ' + b.revision} · ${briefFingerprint(b).slice(0, 8).toUpperCase()}`;
  return { key: `${run?.state ?? 'draft'}:${b.revision}`, html: `<div class="stamp brief-stamp${tone === 'faint' ? ' is-faint' : ' is-' + tone}" role="img" aria-label="Status stamp: ${esc(label)}, ${esc(sub)}"><strong>${esc(label)}</strong><span>${esc(sub)}</span></div>` };
}
function page(b, kind, body, run) {
  const guidance = !run ? 'Review this agreement, then open <code>/ideation</code> in Pi to approve or revise it. No work starts before confirmation.' : run.state === 'ready-for-review' ? 'Review the evidence below. Open <code>/ideation</code> in Pi when you are ready to accept the change.' : 'This agreement stays visible as work progresses. Open <code>/ideation</code> in Pi for run controls.';
  const stamp = stampFor(b, run);
  return `<!doctype html>\n<html lang="en" data-stamp-state="${esc(stamp.key)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${esc(b.title)} — ${esc(kind)}</title><script>${themeBoot}</script><style>${css}</style></head><body class="native-document"><main><header id="change-header" data-artifact-anchor="change-header"><div class="document-slug"><span><i class="masthead-mark" aria-hidden="true"></i> Ideation / ${esc(kind)}</span>${themeButton}</div>${stamp.html}<h1>${esc(b.title)}</h1><p class="lead">${prose(b.why)}</p><div class="document-meta">${esc(b.id)} · revision ${b.revision}</div><p class="review-guidance">${guidance}</p></header><nav class="document-nav" aria-label="Contract sections"><a href="#the-change">The change</a><a href="#acceptance-criteria">Verification</a><a href="#boundaries-choices">Boundaries</a>${run ? '<a href="#run-status">Run status</a>' : ''}</nav>${body}<footer>Local, read-only snapshot. No approval is granted by this document. No automatic merge, push, deployment, or publication.</footer></main><script>${controls}</script></body></html>`;
}
const arrow = `<svg class="relation" viewBox="0 0 80 24" aria-hidden="true"><path pathLength="1" d="M2 12H76m-8-7 8 7-8 7"/></svg>`;
// A drawn mark for each evidence state; the badge text stays the source of truth.
const ticks = {
  passed: '<path class="mark" pathLength="1" d="M7 12.5l3.2 3.2L17 9"/>',
  accepted: '<path class="mark" pathLength="1" d="M7 12.5l3.2 3.2L17 9"/>',
  failed: '<path class="mark" pathLength="1" d="M8.5 8.5l7 7m0-7l-7 7"/>',
  stale: '<path class="mark" pathLength="1" d="M12 7.5v5.5m0 3v.5"/>',
};
const tick = (status, id, judgment) => `<svg class="tick tick-${esc(status)}${judgment && status === 'pending' ? ' tick-judgment' : ''}" data-tick="${esc(status)}" data-criterion="${esc(id)}" viewBox="0 0 24 24" aria-hidden="true"><circle class="ring" cx="12" cy="12" r="10"/>${ticks[status] ?? ''}</svg>`;
function change(b) {
  return section('The change', `<figure class="change" id="change-comparison" data-artifact-anchor="change-comparison"><div><h3>Before</h3><p>${prose(b.change.before)}</p></div><div class="change-direction">${arrow}<span>Proposed change</span></div><div class="after"><h3>After</h3><p>${prose(b.change.after)}</p></div><figcaption>The existing experience → the agreed outcome. Read together with the invariants and boundaries below.</figcaption></figure>`);
}
// A row per real unit, with prerequisite edges in a separate routing gutter.
// Titles remain HTML (wrap at any width); SVG contains only relationship geometry.
function dependencies(b, run) {
  if (!b.units.some(u => u.needs.length)) return '';
  const live = run && ['running', 'planning', 'verifying'].includes(run.state);
  const stateOf = id => (Array.isArray(run?.units) ? run.units : []).find(u => u.id === id)?.state;
  const active = id => live && stateOf(id) === 'running';
  const edges = b.units.flatMap((u, to) => u.needs.map(need => ({ from: b.units.findIndex(v => v.id === need), to, need, id: u.id })));
  const width = 40 + edges.length * 12, height = b.units.length * 80;
  return section('How the work connects', `<p class="muted">Arrows run from prerequisite to dependent deliverable. These are dependencies, not a timeline.</p><figure class="dependency-map"><svg id="unit-dependencies-svg" data-artifact-anchor="unit-dependencies-svg" viewBox="0 0 ${width} ${height}" style="height:calc(var(--dependency-row-height) * ${b.units.length})" preserveAspectRatio="none" role="img" aria-label="Deliverable prerequisite relationships">${edges.map((e, i) => {
    const x = 12 + i * 12, y1 = e.from * 80 + 40, y2 = e.to * 80 + 40;
    return `<g data-from="${esc(e.need)}" data-to="${esc(e.id)}"><title>${esc(e.need)} → ${esc(e.id)}</title><path pathLength="1" d="M${width} ${y1}H${x}V${y2}H${width - 5}m-7-5 7 5-7 5"/>${active(e.id) ? `<path class="flow" pathLength="1" d="M${width} ${y1}H${x}V${y2}H${width - 5}"/>` : ''}</g>`;
  }).join('')}</svg><ol>${b.units.map(u => `<li${active(u.id) ? ' class="active"' : stateOf(u.id) === 'completed' ? ' class="done"' : ''}><a href="#deliverable-${esc(u.id)}">${esc(u.title)}</a><small>${active(u.id) ? 'In progress now · ' : stateOf(u.id) === 'completed' ? 'Completed · ' : ''}${esc(u.risk)} risk · ${u.needs.length ? `Needs: ${esc(u.needs.join(', '))}` : 'Independent starting point'}</small></li>`).join('')}</ol></figure>`, 'work-dependencies');
}
function mechanics(b) {
  const a = b.authority;
  return fold('Execution boundaries & mechanics', `<p>Execution mode: ${esc(b.executionMode)}. Independent review remains required. These are requested boundaries, not proof of approval.</p><h3>Writable paths</h3>${list(a.paths)}<p class="muted">Exact files or trailing-slash directory prefixes. “.” covers ordinary project files only; protected internals and dependency manifests/lockfiles remain excluded.</p><h3>Exact commands</h3>${a.commands.map(code).join('') || '<p>None.</p>'}<p>Commands must assert success with exit 0. Expected outcomes are explanatory. Approved scripts execute project code: tool policy is not an OS sandbox.</p><p>Token usage is checked between workers; a running worker can overshoot the remaining token budget. Time, turn and tool-call limits still apply.</p><p>Host-managed local commit: ${a.allowLocalCommit ? 'permitted' : 'not permitted'}. No push, merge, or deploy.</p>${code(JSON.stringify(Object.fromEntries(Object.entries(a).filter(([k]) => k.startsWith('max'))), null, 2))}<h3>Units</h3>${b.units.map(u => `<article id="plan-unit-${esc(u.id)}"><h3>${esc(u.title)} ${badge(u.risk)}</h3><p>${esc(u.goal)}</p><p class="muted">${esc(u.id)} · needs: ${esc(u.needs.join(', ') || 'none')} · criteria: ${esc(u.acceptanceIds.join(', '))}</p>${u.design ? `<p>${esc(u.design)}</p>` : ''}</article>`).join('')}<p>Brief fingerprint</p>${code(briefFingerprint(b))}`);
}
function delta(b, previous) {
  if (!previous) return '';
  const p = validateBrief(previous);
  if (p.id !== b.id) throw new TypeError('previous brief must have the same id');
  const fields = ['title','why','change','mustHold','outOfScope','delegated','decisions','acceptance','units','executionMode','authority'];
  const changed = fields.filter(k => JSON.stringify(p[k]) !== JSON.stringify(b[k]));
  const format = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return section(`Revision delta · ${p.revision} → ${b.revision}`, changed.length ? `<p>${changed.length} changed ${changed.length === 1 ? 'area' : 'areas'}. Review changed boundaries and criteria before any new approval.</p>${changed.map(k => fold(k, `<div class="delta"><div><h3>Previous</h3>${code(format(p[k]))}</div><div><h3>Current</h3>${code(format(b[k]))}</div></div>`)).join('')}` : '<p>No content changes; revision metadata only.</p>', 'revision-delta');
}
function criterionState(c, run, fingerprint) {
  const judgment = !!c.check.judgment;
  const evidence = (Array.isArray(run?.evidence) ? run.evidence : []).filter(e => e.criterionId === c.id).at(-1);
  const fresh = Boolean(run) && run.briefHash === fingerprint && run.evidenceFresh !== false && typeof run?.sourceRevision === 'string' && !!run.sourceRevision && evidence?.sourceRevision === run.sourceRevision;
  let status = 'pending';
  if (!judgment && evidence) status = !fresh ? 'stale' : ['passed','failed','pending'].includes(evidence.status) ? evidence.status : 'unknown';
  const acceptedJudgment = judgment && fresh && run.state === 'accepted' && run.decisions?.some(d => d.type === 'accept' && d.sourceRevision === run.sourceRevision && d.judgments?.includes(c.id));
  if (acceptedJudgment) status = 'accepted';
  return { judgment, evidence, status, acceptedJudgment };
}
function criteria(b, run) {
  const seen = new Set();
  const fingerprint = run ? briefFingerprint(b) : null;
  const plan = !run || (run.state === 'ready' && !run.evidence?.length);
  return section('Acceptance criteria', `<p class="verification-intro"><strong>Verification ${plan ? 'PLAN' : 'record'}</strong> · ${plan ? 'Checks to perform, not results. No execution evidence is claimed.' : 'Latest recorded evidence, checked against this brief and the recorded source.'}</p><p class="muted">Read each row from commitment → check → evidence state. Grouped by the deliverable responsible for it.</p>${b.units.map(u => `<div class="deliverable" id="deliverable-${esc(u.id)}"><div class="deliverable-heading"><h3>${esc(u.title)}</h3><span class="muted">${esc(u.id)}</span></div>${fold('Deliverable intent', `<p>${esc(u.goal)}</p>${u.design ? `<p>${esc(u.design)}</p>` : ''}`)}${u.acceptanceIds.map(id => {
    const c = b.acceptance.find(c => c.id === id);
    if (seen.has(id)) return `<p class="shared-criterion">Also requires <a href="#criterion-${esc(id)}">${esc(c.criterion)}</a> (shared criterion).</p>`;
    seen.add(id);
    const { judgment, evidence, status, acceptedJudgment } = criterionState(c, run, fingerprint);
    const explanation = judgment ? `${acceptedJudgment ? 'Explicit human acceptance recorded' : 'Human judgment required'}.` : status === 'stale' ? 'Evidence does not match this brief and current recorded source.' : !evidence && !plan ? 'No evidence recorded.' : '';
    return `<article class="verification-row" id="criterion-${esc(c.id)}" data-artifact-anchor="criterion-${esc(c.id)}"><div class="commitment"><small>${esc(c.id)}</small><h3>${prose(c.criterion)}</h3></div>${arrow}<div class="check-method"><small>${judgment ? 'Human judgment' : 'Command'}</small>${c.check.cmd ? code(c.check.cmd) : `<p>${esc(c.check.judgment)}</p>`}${c.check.expect ? `<p class="muted">Expected: ${esc(c.check.expect)}</p>` : ''}</div>${arrow}<div class="evidence-state">${tick(status, c.id, judgment)}${badge(status, status === 'failed' ? 'failed' : status === 'stale' ? 'warning' : '')}<small>${judgment ? (acceptedJudgment ? 'Human acceptance' : plan ? 'Human review planned' : 'Awaiting human review') : evidence ? 'Recorded result' : plan ? 'Check planned' : 'Not run yet'}</small></div>${explanation ? `<p class="evidence-note muted">${esc(explanation)}</p>` : ''}${evidence ? fold('Check & evidence', `<p>Recorded status: ${esc(evidence.status)}</p><p>Source revision: <code>${esc(evidence.sourceRevision ?? 'not recorded')}</code></p>${evidence.command ? code(evidence.command) : ''}${evidence.output !== undefined ? code(evidence.output) : ''}${evidence.durationMs !== undefined ? `<p>Duration: ${esc(evidence.durationMs)} ms</p>` : ''}`) : ''}</article>`;
  }).join('')}</div>`).join('')}`);
}
function runSummary(b, run) {
  const [label, explanation] = Object.hasOwn(states, run.state) ? states[run.state] : ['Unknown state', 'No successful outcome can be inferred.'];
  const mismatch = run.briefHash !== briefFingerprint(b);
  const live = ['running', 'planning', 'verifying'].includes(run.state);
  return section('Run status', `<div id="run-progress" data-artifact-anchor="run-progress">${badge(label, ['failed','cancelled','interrupted'].includes(run.state) ? 'failed' : '')}${live ? '<div class="ink-roller" aria-hidden="true"></div>' : ''}<p>${esc(explanation)}${live ? ' The moving rule shows activity, not progress.' : ''}</p></div><p class="muted">Recorded snapshot only; source freshness is compared with the run’s recorded fingerprint, not the live workspace.</p>${mismatch ? '<p class="warning">Brief mismatch: this run is not bound to the displayed brief. Evidence is not current for this brief.</p>' : ''}${run.attention ? `<div class="notice"><p>${esc(run.attention.message ?? run.attention.reason)}</p>${run.attention.detail ? fold('Technical diagnostic', code(run.attention.detail)) : ''}</div>` : ''}${fold('Run provenance', `<dl>${[['Run',run.id],['State',run.state],['Workspace',run.workspace],['Branch',run.branch],['Base revision',run.baseRevision],['Source revision',run.sourceRevision],['Updated',run.updatedAt],['Tokens',run.usage?.totalTokens]].map(([k,v]) => `<dt>${esc(k)}</dt><dd>${esc(v ?? 'not recorded')}</dd>`).join('')}</dl>`)}`);
}
function workAndFeedback(run) {
  const units = Array.isArray(run.units) ? run.units : [];
  const work = section('Work & remaining obligations', units.map(u => `<article class="run-unit" id="run-unit-${esc(u.id)}" data-artifact-anchor="run-unit-${esc(u.id)}"><h3>${esc(u.title)}</h3>${badge(u.state ?? 'pending')}<p>${esc(u.summary || 'No completed outcome yet.')}</p><p class="muted">Attempts: ${esc(u.attempts ?? 0)} · Review: ${esc(u.reviewStatus ?? 'not-run')}${u.commitHash ? ` · Local commit: ${esc(u.commitHash)}` : ' · No local commit recorded'}</p></article>`).join('') || '<p>No work units recorded.</p>', 'run-work');
  const feedback = Array.isArray(run.feedback) ? run.feedback : [];
  const feedbackIds = new Set();
  const feedbackId = value => {
    const base = `feedback-${String(value).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100)}`;
    let id = base, n = 2;
    while (feedbackIds.has(id)) id = `${base}-${n++}`;
    feedbackIds.add(id);
    return esc(id);
  };
  const inbox = section('Conversation with this run', '<p>Annotations reach the coordinating session, not the builder. Feedback never changes approval, scope, or acceptance automatically. Use explicit Pi controls to pause or stop.</p>' + (feedback.length ? feedback.map(f => `<article class="inbox" id="${feedbackId(f.id)}">${badge(!f.status || f.status === 'pending' ? 'received' : f.status)}<p>${esc(f.markdown)}</p></article>`).join('') : '<p class="muted">No feedback recorded. When served by the artifacts extension, use its Review panel to send questions or suggestions.</p>'), 'run-conversation');
  return work + inbox + (run.decisions?.length ? section('Run decisions', code(JSON.stringify(run.decisions, null, 2)), 'run-decisions') : '');
}
function boundaries(b) {
  return section('Boundaries & choices', `<div class="boundary-columns"><div><h3>Out of scope</h3>${list(b.outOfScope)}</div><div><h3>Delegated</h3>${list(b.delegated)}</div></div>${b.decisions.length ? fold('Decisions & rationale', b.decisions.map(d => `<article><h3>${esc(d.decision)}</h3><p>${esc(d.reason)}</p>${d.rejected ? `<p class="muted">Rejected: ${esc(d.rejected)}</p>` : ''}</article>`).join('')) : ''}`);
}
/** Self-contained document. Only theme preference and print disclosure state are interactive. */
export function renderBrief(brief, { previous, run } = {}) {
  const b = validateBrief(brief);
  return page(b, 'Change brief', change(b) + delta(b, previous) + (run ? runSummary(b, run) : '') + section('Must hold', list(b.mustHold)) + dependencies(b, run) + criteria(b, run) + (run ? workAndFeedback(run) : '') + boundaries(b) + mechanics(b), run);
}
/** A receipt reports host-recorded state, never infers acceptance from checks. */
export function renderReceipt(brief, run) {
  const b = validateBrief(brief);
  if (!run || typeof run !== 'object' || Array.isArray(run)) throw new TypeError('run must be an object');
  const units = Array.isArray(run.units) ? run.units : [];
  return page(b, 'Change receipt', change(b) + runSummary(b, run) + dependencies(b, run) + criteria(b, run) + section('Work completed & remaining', b.units.map(u => {
    const record = units.find(r => r.id === u.id);
    return `<article><h3>${esc(u.title)}</h3>${badge(record?.state ?? 'pending')}<p>${esc(record?.summary ?? 'No completion recorded.')}</p><p class="muted">Attempts: ${esc(record?.attempts ?? 0)} · Review: ${esc(record?.reviewStatus ?? 'not recorded')}</p>${record?.commitHash ? `<p>Local commit: <code>${esc(record.commitHash)}</code></p>` : '<p class="muted">No local commit recorded.</p>'}</article>`;
  }).join('')) + (run.decisions?.length ? section('Run decisions', code(JSON.stringify(run.decisions, null, 2))) : '') + section('Must still hold', list(b.mustHold)) + boundaries(b) + mechanics(b), run);
}
