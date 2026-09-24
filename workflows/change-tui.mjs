import { progressSummary, safeUrl } from './change-ui.mjs';

// Presentation only: no Pi imports, timers, mutations, or execution/approval logic.
// Motion is decoration over recorded state: frames come from an injected clock, and
// nothing here moves a count, a bar or a tick that the evidence does not support.
const clean = value => String(value ?? '')
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ')
  .replace(/\s+/g, ' ').trim();
const columns = width => Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 72;
const urlOf = url => { try { return safeUrl(url); } catch { return undefined; } };
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
// Conservative cell budget for the no-helper path; never splits a grapheme.
const cells = s => /^[\x20-\x7e]*$/.test(s) ? s.length : 2;
function plainCut(text, width) {
  const parts = [...segmenter.segment(clean(text))].map(x => x.segment);
  if (parts.reduce((n, s) => n + cells(s), 0) <= width) return parts.join('');
  let out = '', used = 0;
  for (const s of parts) { if (used + cells(s) > width - 2) break; out += s; used += cells(s); }
  return width >= 2 ? out + '…' : '';
}
const stages = {
  environment: 'Preparing workspace', plan: 'Planning', planning: 'Planning', scout: 'Exploring', discovery: 'Exploring',
  build: 'Building', builder: 'Building', implement: 'Building', implementation: 'Building',
  review: 'Reviewing', fix: 'Addressing review', revise: 'Addressing review',
  acceptance: 'Verifying checks', verify: 'Verifying checks', commit: 'Recording local commit',
};
function status(run, p) {
  const stale = run.evidenceFresh === false;
  const ready = run.state === 'ready-for-review';
  const accepted = run.state === 'accepted' && !stale && Boolean(run.sourceRevision) &&
    run.decisions?.some(d => d.type === 'accept' && d.sourceRevision === run.sourceRevision) && p.passed === p.total;
  if (run.state === 'draft') return ['Ready for your review', 'accent'];
  if (run.state === 'cancelled') return ['Cancelled', 'muted'];
  if (run.state === 'cancelling') return ['Cancelling', 'muted'];
  if (stale) return ['Needs attention', 'warning'];
  if (run.state === 'failed') return ['Needs attention', 'error'];
  if (['needs-decision', 'interrupted'].includes(run.state) || (run.attention && !ready)) return ['Needs attention', 'warning'];
  if (ready) return p.passed === p.total ? ['Ready for review', 'accent'] : ['Needs attention', 'warning'];
  if (accepted) return ['Accepted', 'success'];
  if (run.state === 'accepted') return ['Needs attention', 'warning'];
  if (run.pauseRequested) return ['Pausing', 'muted'];
  if (run.state === 'paused') return ['Paused', 'muted'];
  if (run.state === 'ready') return ['Ready to start', 'accent'];
  if (['running', 'verifying', 'planning'].includes(run.state)) {
    return [(Object.hasOwn(stages, run.activeStage) ? stages[run.activeStage] : undefined) ?? (run.state === 'verifying' ? 'Verifying checks' : run.state === 'planning' ? 'Planning' : 'Building'), 'accent'];
  }
  return ['Awaiting status', 'muted'];
}
function progressCard(run = {}, url) {
  const p = progressSummary(run), [stateHeading, role] = status(run, p);
  const seconds = Math.floor(Math.max(0, run.elapsedMs ?? 0) / 1000);
  const elapsed = seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`;
  // This is elapsed wall time, never a progress estimate or an animated meter.
  const heading = ['running', 'verifying'].includes(run.state) && Number.isFinite(run.elapsedMs) ? `${stateHeading} · ${elapsed}` : stateHeading;
  const review = stateHeading === 'Ready for review';
  const attention = stateHeading === 'Needs attention';
  let note = '';
  if (run.state === 'draft') note = 'Review the contract · /ideation to approve or revise';
  else if (attention) note = run.evidenceFresh === false ? 'Evidence is out of date · review required' : clean(run.attention?.message) || 'Review the contract and current evidence';
  else if (review) note = p.pendingJudgments ? `${p.pendingJudgments} human judgment${p.pendingJudgments === 1 ? '' : 's'} · accept after review` : 'Review evidence before accepting';
  else if (run.state === 'paused') note = 'Resume when ready';
  const building = ['running', 'verifying', 'planning', 'paused'].includes(run.state) && run.activeStage !== 'acceptance';
  const deliverables = building && run.brief?.units?.length ? {
    passed: run.brief.units.filter(u => run.units?.some(r => r.id === u.id && r.state === 'completed' && r.reviewStatus === 'passed')).length,
    total: run.brief.units.length, label: 'deliverables reviewed',
  } : null;
  const stepsShown = ['running', 'verifying', 'planning', 'paused', 'ready-for-review'].includes(run.state) && !attention;
  const steps = stepsShown && Array.isArray(run.brief?.units) && run.brief.units.length ? run.brief.units.map(u => {
    const r = run.units?.find(x => x.id === u.id);
    const state = r?.state === 'completed' && r.reviewStatus === 'passed' ? 'done' : r?.state === 'running' ? 'active' : r?.state === 'failed' ? 'failed' : 'pending';
    return { id: String(u.id), title: clean(u.title), state };
  }) : undefined;
  return {
    heading, role, url, title: clean(run.units?.find(u => u.state === 'running')?.title || run.brief?.title),
    evidence: run.state === 'draft' ? undefined : deliverables ?? p, note, steps,
    live: LIVE.has(run.state), ready: review, runId: run.id,
  };
}

const LIVE = new Set(['running', 'verifying', 'planning']);
const SPARK_SECONDS = 0.9, CELEBRATE_SECONDS = 2.4;
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏', MOON = '◐◓◑◒', SPARK = ['✦', '✧', '⋆', '·'];
const passedUnits = run => new Set((run?.units ?? []).filter(u => u.state === 'completed' && u.reviewStatus === 'passed').map(u => String(u.id)));
/**
 * Remembers transitions this session actually observed, so a deliverable
 * sparkles once when its review passes and ready-for-review celebrates once.
 * State already present on first sight (a reload) never replays a celebration.
 */
export function createMotion(now = () => Date.now()) {
  const runs = new Map();
  const frame = run => {
    const t = now(), r = runs.get(run?.id);
    const sparks = new Map([...(r?.sparks ?? [])].map(([id, at]) => [id, (t - at) / 1000]).filter(([, age]) => age >= 0 && age < SPARK_SECONDS));
    const age = r?.readyAt !== undefined && run?.state === 'ready-for-review' ? (t - r.readyAt) / 1000 : undefined;
    return { t: t / 1000, sparks, celebrate: age !== undefined && age >= 0 && age < CELEBRATE_SECONDS ? age : undefined };
  };
  return {
    observe(run) {
      if (!run?.id) return;
      const t = now(), prior = runs.get(run.id), done = passedUnits(run);
      if (!prior) { runs.set(run.id, { done, state: run.state, sparks: new Map() }); return; }
      for (const id of done) if (!prior.done.has(id)) prior.sparks.set(id, t);
      if (run.state === 'ready-for-review' && prior.state !== 'ready-for-review') prior.readyAt = t;
      prior.done = done; prior.state = run.state;
    },
    frame,
    /** Whether anything should move: idle widgets never redraw. */
    animating(run) { const f = frame(run); return LIVE.has(run?.state) || f.sparks.size > 0 || f.celebrate !== undefined; },
  };
}
function evidenceText(p) {
  return p.total ? `${p.passed}/${p.total} ${p.label ?? 'checks verified'}` : 'No objective checks configured';
}
function plainLines(card, width) {
  const lines = [card.heading, card.title, card.evidence && evidenceText(card.evidence), card.note].filter(Boolean);
  const url = urlOf(card.url);
  if (url) lines.push(`Contract: ${url}`);
  return lines.map(line => plainCut(line, width));
}

/** Concise, ANSI-free RPC/startup text. Width is a conservative cell bound. */
export function progressFallback(run, url, width = 72) {
  return plainLines(progressCard(run, url), columns(width)).join('\n');
}
function component(getCard, theme, helpers, diagnostics = () => [], getFrame = () => null) {
  return {
    // No cached styled strings: theme methods (or a theme getter) run every render.
    invalidate() {},
    render(width) {
      width = columns(width);
      if (!width) return [];
      const card = getCard();
      const native = typeof helpers?.truncateToWidth === 'function' && typeof helpers?.visibleWidth === 'function';
      if (!native) return [...plainLines(card, width), ...diagnostics().map(s => plainCut(s, width))];
      const th = typeof theme === 'function' ? theme() : theme;
      const fg = (role, s) => th?.fg ? th.fg(role, s) : s;
      const bold = s => th?.bold ? th.bold(s) : s;
      const cut = (s, w = width) => helpers.truncateToWidth(s, Math.max(0, w), '…');
      const frame = card.steps || card.live || card.ready ? getFrame(card) : null;
      const t = frame?.t ?? 0, moving = Boolean(frame) && card.live;
      const url = urlOf(card.url);
      const link = url && typeof helpers.hyperlink === 'function' ? fg('accent', helpers.hyperlink('Contract ↗', url)) : '';
      const prefix = fg('borderAccent', '▎ ');
      const available = Math.max(0, width - helpers.visibleWidth(prefix));
      const linkWidth = link ? helpers.visibleWidth(link) + 2 : 0;
      let lead = '', trail = '';
      if (moving) lead = fg('accent', SPIN[Math.floor(t * 11) % SPIN.length]) + ' ';
      else if (card.ready && frame?.celebrate !== undefined) {
        const k = Math.floor(t * 7);
        lead = fg('accent', bold(SPARK[k % 3])) + ' ';
        trail = ' ' + fg('accent', bold(SPARK[(k + 1) % 3] + ' ' + SPARK[(k + 2) % 3]));
      } else if (card.ready) lead = fg('accent', '✦') + ' ';
      const decor = helpers.visibleWidth(lead) + helpers.visibleWidth(trail);
      const heading = fg(card.role, bold(cut(card.heading, available - linkWidth - decor)));
      const lines = [cut(prefix + lead + heading + trail + (link ? '  ' + link : ''))];
      if (card.title) lines.push(cut('  ' + (moving ? shimmer(clean(card.title), t, fg, bold) : fg('text', bold(clean(card.title))))));
      if (card.steps && width >= 60) lines.push(cut('  ' + strip(card.steps, width - 2, frame, fg, bold, helpers)));
      if (card.evidence) {
        const p = card.evidence, size = width >= 80 ? 20 : width >= 60 ? 12 : 6;
        const filled = p.total ? Math.floor(size * p.passed / p.total) : 0;
        let track = '';
        if (p.total) {
          // The shine travels only across cells that real evidence already filled.
          const pos = moving && filled ? Math.floor(t * 12) % (filled + 6) : -1;
          for (let i = 0; i < filled; i++) track += i === pos ? fg('borderAccent', bold('━')) : Math.abs(i - pos) === 1 ? fg('borderAccent', '━') : fg('accent', '━');
          track += fg('dim', '─'.repeat(size - filled)) + '  ';
        }
        lines.push(cut('  ' + track + fg('muted', evidenceText(p))));
      }
      if (card.note) lines.push(cut('  ' + fg(card.role === 'warning' || card.role === 'error' ? card.role : 'muted', clean(card.note))));
      if (url && !link) lines.push(cut('  ' + fg('muted', `Contract: ${url}`)));
      for (const text of diagnostics()) lines.push(cut('  ' + fg('dim', clean(text))));
      return lines;
    },
  };
}
// A three-cell highlight sweeping across the active title.
function shimmer(text, t, fg, bold) {
  const parts = [...segmenter.segment(text)].map(x => x.segment);
  const head = Math.floor((t * 16) % (parts.length + 10)) - 5;
  return parts.map((g, i) => { const d = Math.abs(i - head); return d === 0 ? fg('borderAccent', bold(g)) : d <= 2 ? fg('accent', bold(g)) : fg('text', bold(g)); }).join('');
}
// One chip per deliverable. Titles shrink longest-first to fit; tiny widths keep glyphs only.
function strip(steps, width, frame, fg, bold, helpers) {
  const glyph = { done: '✓', failed: '✗', pending: '○' };
  const gap = 2, n = steps.length;
  const budget = width - n * 2 - gap * (n - 1) - 3 - 2 * (frame?.sparks?.size ?? 0); // room for sparkles
  const sizes = steps.map(s => helpers.visibleWidth(s.title));
  while (sizes.reduce((a, b) => a + b, 0) > budget && Math.max(...sizes) > 4) sizes[sizes.indexOf(Math.max(...sizes))]--;
  const compact = sizes.reduce((a, b) => a + b, 0) > budget;
  const t = frame?.t ?? 0;
  return steps.map((s, i) => {
    const mark = s.state === 'active' ? fg('accent', frame ? MOON[Math.floor(t * 6) % 4] : '◐') : fg(s.state === 'done' ? 'success' : s.state === 'failed' ? 'error' : 'dim', glyph[s.state]);
    const age = frame?.sparks?.get(s.id);
    const spark = age !== undefined ? ' ' + fg('success', bold(SPARK[Math.min(3, Math.floor(age / 0.23))])) : '';
    if (compact) return mark + spark;
    const name = helpers.truncateToWidth(s.title, sizes[i], '…');
    const label = s.state === 'active' ? fg('text', bold(name)) : fg(s.state === 'pending' ? 'dim' : 'muted', name);
    return mark + ' ' + label + spark;
  }).join(compact ? ' ' : ' '.repeat(gap));
}

/** theme may be Pi's callback theme object or () => currentTheme. */
export function createProgressWidget(run, url, theme, helpers, motion) {
  return createLiveProgressWidget(() => ({ run, url }), theme, helpers, motion);
}
/**
 * The mounted widget reads the latest presentation each render. motion may be a
 * tracker from createMotion(), or a getter returning one (undefined = still).
 */
export function createLiveProgressWidget(getPresentation, theme, helpers, motion) {
  const tracker = () => typeof motion === 'function' ? motion() : motion;
  let last;
  const getCard = () => { const p = getPresentation() ?? {}; last = p.run; return progressCard(p.run, p.url); };
  return component(getCard, theme, helpers, () => [], () => tracker()?.frame(last) ?? null);
}

const callLabels = {
  prepare: 'Preparing contract', status: 'Checking progress', receipt: 'Opening receipt',
  feedback: 'Sending feedback', answer: 'Answering review question',
};
export function createChangeToolCall(args, theme, helpers) {
  return component(() => ({
    heading: callLabels[args?.action] ?? 'Preparing change', role: 'toolTitle',
    title: clean(args?.brief?.title),
  }), theme, helpers);
}

/** Supports existing details: preview, run, {run,url}, run[], delivery/answer. */
export function createChangeToolResult(result, options, theme, helpers) {
  const getCard = () => {
    const d = result?.details;
    if (result?.isError || options?.isError || d?.error) return {
      heading: 'Needs attention', role: 'error', url: d?.url,
      note: clean(d?.error?.message ?? d?.error ?? result?.content?.find(c => c.type === 'text')?.text) || 'Unable to complete this request',
    };
    if (options?.isPartial) return { heading: 'Updating change', role: 'accent', url: d?.url };
    if (d?.run || d?.state) return progressCard(d.run ?? d, d.url);
    if (d?.approved === false) return {
      heading: 'Ready for review', role: 'accent', url: d.url, title: clean(d.title ?? d.brief?.title),
      note: 'Review contract · approval required to start',
    };
    if (Array.isArray(d)) return { heading: d.length ? `${d.length} change${d.length === 1 ? '' : 's'}` : 'No changes yet', role: 'muted', note: d.length ? 'Select a run to review its progress' : '' };
    if (typeof d?.delivered === 'boolean') return { heading: d.delivered ? 'Feedback delivered' : 'Feedback not delivered', role: d.delivered ? 'success' : 'warning' };
    if (d?.ok === true) return { heading: 'Answer recorded', role: 'success' };
    if (d?.ok === false) return { heading: 'Needs attention', role: 'warning', note: 'Answer was not recorded' };
    return { heading: 'Change update', role: 'muted', url: d?.url, note: 'No progress details available' };
  };
  const diagnostics = () => {
    if (!options?.expanded || options?.isPartial) return [];
    const d = result?.details, run = d?.run ?? (d?.state ? d : undefined);
    // Deliberate allowlist: no raw JSON, prompts, arbitrary args, or unbounded logs.
    return [
      run?.id && `Run: ${clean(run.id)}`,
      run?.sourceRevision && `Revision: ${clean(run.sourceRevision)}`,
      d?.briefPath && `Contract file: ${clean(d.briefPath)}`,
      ...(run?.evidence ?? []).slice(-5).map(e => `${clean(e.criterionId)}: ${clean(e.status)}${e.sourceRevision ? ` · ${clean(e.sourceRevision)}` : ''}`),
    ].filter(Boolean).slice(0, 8);
  };
  return component(getCard, theme, helpers, diagnostics);
}
