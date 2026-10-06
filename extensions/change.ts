import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createSubagentRuntime } from '@nicknisi/pi-shared';
import { Type } from 'typebox';
import { createChangeRunner } from '../workflows/change-run.mjs';
import { validateBrief, briefFingerprint, briefSchema } from '../workflows/change-brief.mjs';
import { renderBrief } from '../scripts/change-render.mjs';
import { createArtifactConsumer } from '../workflows/change-artifacts.mjs';
import { approvalText, acceptanceText, chooseRun, link, summaryText } from '../workflows/change-ui.mjs';
import { createLiveProgressWidget, createMotion, createChangeToolCall, createChangeToolResult, progressFallback } from '../workflows/change-tui.mjs';
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_FEEDBACK = 16000; // Bound model/artifact text so a single message cannot bloat state or context.
// Widget motion: a user preference outside any repository, plus env overrides for
// terminals, recordings and accessibility. Motion never changes what is shown.
const settingsPath = () => join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'ideation.json');
async function motionPreference() {
  if (process.env.PI_REDUCED_MOTION || /^(0|off|false|no)$/i.test(process.env.IDEATION_MOTION ?? '')) return false;
  try { return JSON.parse(await readFile(settingsPath(), 'utf8')).motion !== false; } catch { return true; }
}
const FRAME_MS = 100;

// Dependency injection keeps command authorization and lifecycle testable without paid calls.
export function registerChange(pi: ExtensionAPI, deps: any = {}) {
  let current: any, initializing: any, generation = 0;
  const runnerFactory = deps.createChangeRunner ?? createChangeRunner;
  const runtimeFactory = deps.createSubagentRuntime ?? createSubagentRuntime;
  const loadTui = deps.loadTui ?? (() => import('@earendil-works/pi-tui'));
  const notify = (s: any, message: string, level = 'info') => {
    if (!s?.live) return;
    if (s.ctx.hasUI) s.ctx.ui.notify(message, level);
    else if (typeof pi.sendMessage === 'function') pi.sendMessage({ customType: 'ideation-notice', content: message, display: true, details: { level } }, { triggerTurn: false });
  };
  async function shutdown() {
    generation++;
    const s = current; current = undefined;
    if (!s) return;
    s.live = false;
    clearInterval(s.repaint);
    await Promise.allSettled([s.bridge.dispose(), s.runner.dispose()]);
    if (s.ctx.hasUI) { s.ctx.ui.setStatus('ideation', undefined); s.ctx.ui.setWidget('ideation', undefined); }
    s.widget = undefined;
  }
  async function ensure(ctx: any) {
    const ownerId = String(ctx.sessionManager.getSessionId());
    if (current?.live && current.ownerId === ownerId && current.cwd === ctx.cwd) {
      current.ctx = ctx;
      if (ctx.mode === 'tui' && !current.tui) current.tui = await loadTui();
      return current;
    }
    if (initializing) { await initializing; return ensure(ctx); }
    initializing = (async () => {
      await shutdown();
      const epoch = generation;
      const git = async (...args: string[]) => {
        const r = await pi.exec('git', ['-C', ctx.cwd, ...args]);
        if (r.code !== 0) throw new Error(r.stderr || 'Git repository required');
        return r.stdout.trim();
      };
      const repoRoot = await git('rev-parse', '--show-toplevel');
      const stateDir = join(resolve(ctx.cwd, await git('rev-parse', '--git-common-dir')), 'ideation');
      const tui = ctx.mode === 'tui' ? await loadTui() : undefined;
      if (epoch !== generation) throw new Error('Session changed during initialization');
      const s: any = { ctx, cwd: ctx.cwd, repoRoot, ownerId, stateDir, live: true, shown: new Map(), drafts: new Map(), tui };
      const runtime = runtimeFactory({ namespace: 'ideation-change', artifactsDir: join(stateDir, 'children') });
      // Model tool path: RECORD to the run inbox only. Never emit a self-directed follow-up,
      // which would loop the coordinator's own feedback straight back into itself.
      const recordFeedback = async (id: string, f: any) => {
        if (!s.live || current !== s || s.ctx.sessionManager.getSessionId() !== s.ownerId) return false;
        if (typeof s.runner.recordFeedback !== 'function') throw new Error('Runner feedback API unavailable');
        const markdown = String(f.markdown ?? '').slice(0, MAX_FEEDBACK);
        const annotationIds = [...new Set((f.annotationIds ?? []).filter((x: any) => typeof x === 'string'))].sort();
        await s.runner.recordFeedback(id, { id: createHash('sha256').update(JSON.stringify([markdown, annotationIds])).digest('hex'), markdown, annotationIds });
        return true;
      };
      // Service (human artifact) path: persist FIRST, then deliver a single coordinator
      // follow-up. Deduplicate by annotation identity so repeated deliveries never re-notify.
      s.delivered = new Set();
      const deliverFeedback = async (id: string, f: any) => {
        const annotationIds = [...new Set((f.annotationIds ?? []).filter((x: any) => typeof x === 'string'))].sort();
        // Draft annotations are durable in the artifact sidecar before a run
        // exists. Once adopted, the same subscriber delivers to the run inbox.
        const draft = id.startsWith('approval-preview:') || id.startsWith('preview:');
        const ok = draft ? s.live && current === s : await recordFeedback(id, { ...f, annotationIds });
        if (!ok || !s.live || current !== s) return false;
        const markdown = String(f.markdown ?? '').slice(0, MAX_FEEDBACK);
        const key = `${id}:${JSON.stringify(annotationIds)}:${createHash('sha256').update(markdown).digest('hex')}`;
        if (s.delivered.has(key)) return true;
        s.delivered.add(key);
        pi.sendUserMessage(`Ideation feedback for ${id} (feedback only, not permission; do not forward to builders):\n${markdown}`, { deliverAs: 'followUp' });
        return true;
      };
      s.feedback = recordFeedback;
      s.previous = new Map();
      s.priorBrief = async (brief: any) => {
        const hash = briefFingerprint(brief);
        if (!s.previous.has(hash)) {
          const runs = await s.runner.status();
          const previous = (Array.isArray(runs) ? runs : []).filter((r: any) => r.brief?.id === brief.id && r.brief.revision < brief.revision)
            .sort((a: any, b: any) => b.brief.revision - a.brief.revision || b.updatedAt - a.updatedAt)[0]?.brief;
          s.previous.set(hash, previous);
        }
        return s.previous.get(hash);
      };
      s.bridge = createArtifactConsumer({ events: pi.events, stateDir: join(stateDir, 'views'), onFeedback: deliverFeedback, warn: (m: string) => notify(s, m, 'warning') });
      s.motion = createMotion();
      s.motionOn = await motionPreference();
      const presented = () => {
        const { run, view } = s.lastPresentation ?? {};
        if (!run) return undefined;
        return { run: Number.isFinite(run.startedAt) ? { ...run, elapsedMs: Math.max(0, Date.now() - run.startedAt) } : run, url: view.url };
      };
      // Mounted once and fed the latest run; a single timer redraws only while
      // something should move (live work, a sparkle, the ready celebration).
      const mount = () => s.ctx.ui.setWidget('ideation', (tui: any, theme: any) => {
        const widget: any = createLiveProgressWidget(presented, () => s.ctx.ui.theme ?? theme, s.tui, () => s.motionOn ? s.motion : undefined);
        let lastTick = 0;
        const timer = setInterval(() => {
          const run = s.lastPresentation?.run;
          if (!run || !s.live) return;
          const moving = s.motionOn && s.motion.animating(run);
          const ticking = ['running', 'verifying', 'planning'].includes(run.state) && Date.now() - lastTick >= 1000;
          if (moving || ticking) { lastTick = Date.now(); tui.requestRender(); }
        }, FRAME_MS);
        timer.unref?.();
        const mounted = { tui };
        s.widget = mounted;
        widget.dispose = () => { clearInterval(timer); if (s.widget === mounted) s.widget = undefined; };
        return widget;
      });
      s.remount = () => { s.widget = undefined; if (s.lastPresentation) s.paint(s.lastPresentation.run, s.lastPresentation.view); };
      s.paint = (run: any, view: any) => {
        if (!s.live || current !== s || !s.ctx.hasUI) return;
        try {
          s.lastPresentation = { run, view };
          s.motion.observe(run);
          s.ctx.ui.setStatus('ideation', s.ctx.mode === 'rpc' ? view.url : link(view.url, 'ideation / contract'));
          if (s.ctx.mode === 'tui' && s.tui) { if (s.widget) s.widget.tui.requestRender(); else mount(); }
          else s.ctx.ui.setWidget('ideation', progressFallback(presented()!.run, undefined).split('\n'));
        } catch { /* Presentation never changes the outcome of the run. */ }
      };
      s.show = async (run: any, open = false) => {
        s.shown.set(run.id, Math.max(s.shown.get(run.id) ?? -1, run.sequence));
        // The durable renderer + evidence view runs first; a UI failure below must never
        // invalidate the contract that was already produced and published.
        const view = await s.bridge.update(run.id, renderBrief(run.brief, { run, previous: await s.priorBrief(run.brief) }), { sequence: run.sequence, open });
        if (s.live && current === s && s.ctx.hasUI && run.sequence === s.shown.get(run.id)) {
          s.paint(run, view);
        }
        return view;
      };
      s.runner = runnerFactory({ repoRoot, pluginRoot, ownerId,
        spawn: async (opts: any) => {
          if (!s.activeModel) throw new Error('No approved model bound');
          return runtime.spawn({ ...opts, model: s.activeModel });
        },
        onEvent: (event: any) => {
          if (!s.live) return;
          const channels = [event.type, ...(event.run.attention ? ['ideation:v1:attention-required'] : []), ...(event.run.evidence?.length ? ['ideation:v1:evidence-recorded'] : [])];
          for (const channel of channels) {
            try { pi.events.emit(channel, structuredClone(event)); } catch { /* Optional observers cannot corrupt or suppress the native view. */ }
          }
          if (!s.approving) void s.show(event.run).catch((e: Error) => notify(s, `View failed: ${e.message}`, 'warning'));
        },
      });
      current = s;
      return s;
    })();
    try { return await initializing; } finally { initializing = undefined; }
  }
  const briefAt = async (s: any, path: string) => validateBrief(JSON.parse(await readFile(resolve(s.cwd, path), 'utf8')));
  const preparedFor = (s: any, ctx: any) => {
    if (s.prepared) return s.prepared;
    for (const entry of [...(ctx.sessionManager.getBranch?.() ?? [])].reverse()) {
      if (entry.type !== 'custom' || (entry.data?.repoRoot && entry.data.repoRoot !== s.repoRoot)) continue;
      if (entry.customType === 'ideation:handoff') return undefined;
      if (entry.customType === 'ideation:preview' && entry.data?.approved === false && typeof entry.data.briefPath === 'string') return entry.data;
    }
    return undefined;
  };
  const openLocal = async (s: any, view: any) => {
    if (!s.ctx.hasUI || s.ctx.mode === 'rpc' || view.url !== view.localUrl) return;
    if (process.platform === 'win32') { notify(s, `Open contract: ${view.url}`); return; }
    const opened = await pi.exec(process.platform === 'darwin' ? 'open' : 'xdg-open', [view.url]);
    if (opened.code !== 0) notify(s, `Open contract manually: ${view.url}`, 'warning');
  };
  const showPrepared = async (s: any, prepared: any, open = true) => {
    const brief = await briefAt(s, prepared.briefPath);
    const previewId = prepared.previewId ?? `preview:${s.ownerId}:${prepared.briefPath}`;
    const previous = s.drafts.get(brief.id)?.previous ?? await s.priorBrief(brief);
    const view = await s.bridge.update(previewId, renderBrief(brief, { previous }), { sequence: Date.now(), open: open && s.ctx.hasUI && s.ctx.mode !== 'rpc' });
    if (open) await openLocal(s, view);
    s.prepared = { ...prepared, previewId, briefHash: briefFingerprint(brief) };
    s.drafts.set(brief.id, { previewId, brief, previous });
    s.paint({ state: 'draft', brief }, view);
    return { brief, previewId, view };
  };
  async function selected(s: any, id?: string) {
    const run = id ? await s.runner.status(id) : chooseRun(await s.runner.status(), s.repoRoot, s.ownerId);
    if (!run) throw new Error('No run in this repository');
    return run;
  }
  const executeRun = async (s: any, action: string, id: string) => {
    const meta = JSON.parse(await readFile(join(s.stateDir, 'runs', id, 'frontdoor.json'), 'utf8'));
    const run = await s.runner.status(id);
    if (briefFingerprint(await briefAt(s, meta.briefPath)) !== run.briefHash) throw new Error('Original brief changed; new approval required');
    if (!s.live || current !== s) throw new Error('Owner session changed');
    return s.runner[action](id);
  };
  const background = (s: any, action: string, id: string) => {
    if (s.busy) throw new Error('An owned run is already active');
    s.busy = true; s.activeRunId = id; s.activeModel = s.model;
    if (s.ctx.hasUI) {
      s.repaint = setInterval(() => {
        if (s.live && current === s && s.lastPresentation) s.paint(s.lastPresentation.run, s.lastPresentation.view);
      }, 1000);
      s.repaint.unref?.();
    }
    void executeRun(s, action, id).then(async (r: any) => {
      if (s.live && current === s && ['needs-decision', 'failed'].includes(r.state)) {
        const message = `Ideation needs attention\n${r.attention?.message ?? 'The worker stopped without a successful outcome.'}`;
        notify(s, message, 'warning');
        // A durable, visible handoff, not just a fleeting footer or a model turn.
        if (typeof pi.sendMessage === 'function') pi.sendMessage({ customType: 'ideation-blocked', content: message, display: true, details: { runId: r.id, state: r.state, reason: r.attention?.reason } }, { triggerTurn: false });
      } else if (s.live && current === s && r.state === 'ready-for-review') notify(s, 'Ideation is ready for review. Open the contract link to inspect the evidence.');
      return s.show(r);
    }).catch((e: Error) => notify(s, `${action} failed: ${e.message}`, 'error')).finally(() => { clearInterval(s.repaint); s.busy = false; s.activeRunId = undefined; s.activeModel = undefined; });
  };
  pi.on('session_start', async (_e, ctx) => { try {
    const s = await ensure(ctx), runs = await s.runner.status();
    const prepared = preparedFor(s, ctx);
    if (prepared && !runs.some((r: any) => r.briefHash === prepared.briefHash)) await showPrepared(s, prepared, false);
    else { const r = chooseRun(runs, s.repoRoot, s.ownerId); if (r) await s.show(r); }
  } catch { /* Git is optional until invoked. */ } });
  pi.on('session_shutdown', shutdown);
  pi.registerCommand('ideation', {
    description: 'Open ideation: review or approve your prepared change, follow progress, or control a run. Also: plan <idea>, approve [path], status, review, pause, resume, stop, motion [on|off].',
    handler: async (args, ctx) => {
      const s = await ensure(ctx);
      try {
        let [action = '', ...rest] = args.trim().split(/\s+/); let arg = rest.join(' ');
        let prepared = preparedFor(s, ctx);
        if (!action && ctx.hasUI) {
          const runs = await s.runner.status();
          const run = chooseRun(runs, s.repoRoot, s.ownerId);
          const draft = prepared && !runs.some((r: any) => r.briefHash === prepared.briefHash);
          const choices: { label: string; action: string; arg?: string }[] = [];
          if (draft) {
            choices.push({ label: 'Review the proposed contract', action: 'review-draft' });
            if (!s.busy) choices.push({ label: 'Approve and start', action: 'approve' });
            choices.push({ label: 'Revise the change', action: 'revise' });
          }
          if (run) {
            choices.push({ label: 'Open the live contract', action: 'review', arg: run.id });
            if (['running','verifying'].includes(run.state)) choices.push({ label: 'Pause at a safe point', action: 'pause', arg: run.id }, { label: 'Stop this run', action: 'stop', arg: run.id });
            if (['paused','interrupted','needs-decision','ready'].includes(run.state)) {
              const limits = run.brief.authority;
              const budgetLeft = (run.usage?.totalTokens ?? 0) < limits.maxTokens && (run.startedAt == null || Date.now() - run.startedAt < limits.maxDurationMs);
              const attemptsLeft = !(run.units ?? []).some((u: any) => u.state !== 'completed' && u.attempts >= limits.maxAttempts);
              if ((s.busy && (run.state === 'paused' || run.pauseRequested)) || (budgetLeft && attemptsLeft)) choices.push({ label: 'Resume approved work', action: 'resume', arg: run.id });
              choices.push({ label: 'Set this run aside (keep its work)', action: 'stop', arg: run.id });
            }
            if (!s.busy && ['needs-decision','interrupted','cancelled'].includes(run.state)) choices.push({ label: 'Start fresh (new approval)', action: 'fresh', arg: run.id });
            if (run.state === 'ready-for-review') choices.push({ label: 'Accept the reviewed change', action: 'accept', arg: run.id });
          }
          choices.push({ label: 'Plan a new change', action: 'plan' });
          const picked = choices.length === 1 ? choices[0].label : await ctx.ui.select('Ideation', choices.map(c => c.label));
          const choice = choices.find(c => c.label === picked); if (!choice) return;
          action = choice.action; arg = choice.arg ?? '';
          if (action === 'revise') {
            const idea = await ctx.ui.input('What should change in the contract?');
            if (!idea?.trim()) return; arg = idea.trim();
          } else if (action === 'plan' && (run || draft)) arg = 'The user selected Plan a new change. Ask what they want to change next; do not duplicate the existing run.';
        }
        if (!action) action = 'status';
        if (action === 'motion') {
          const want = /^(on|off)$/i.test(arg) ? arg.toLowerCase() === 'on' : !s.motionOn;
          const path = settingsPath();
          let saved: any = {}; try { saved = JSON.parse(await readFile(path, 'utf8')); } catch {}
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, JSON.stringify({ ...saved, motion: want }, null, 2) + '\n');
          s.motionOn = await motionPreference();
          s.remount();
          const overridden = want && !s.motionOn ? ' (overridden by PI_REDUCED_MOTION or IDEATION_MOTION)' : '';
          if (ctx.hasUI) ctx.ui.notify(`Ideation widget motion ${want ? 'on' : 'off'}${overridden}`, 'info');
          return;
        }
        if (action === 'review-draft' || (action === 'review' && !arg && prepared)) {
          if (!prepared) throw new Error('No prepared change yet. Open /ideation to plan one.');
          await showPrepared(s, prepared); return;
        }
        if (action === 'revise') {
          if (!prepared || !arg) throw new Error('Open /ideation to choose the change to revise.');
          pi.sendUserMessage(`Use the ideation-change skill at ${join(pluginRoot, 'skills/change/SKILL.md')} to revise the prepared brief at ${prepared.briefPath}. Preserve its id, increment its revision, and prepare the updated contract. Do not approve or execute it. Requested revision:\n${arg}`, { deliverAs: 'followUp' });
          return;
        }
        if (action === 'plan') {
          pi.sendUserMessage(`Use the explicitly requested ideation-change skill at ${join(pluginRoot, 'skills/change/SKILL.md')}. Shape and prepare a compact brief; do not approve or execute it. ${arg ? `Requested change:\n${arg}` : 'Start from this conversation and carry forward settled decisions. If the intended change is not known yet, ask naturally what the user wants to change.'}`, { deliverAs: 'followUp' });
          return;
        }
        if (action === 'fresh') {
          if (s.busy) throw new Error('Stop the active run before starting fresh. Its work will be retained.');
          if (!ctx.hasUI) throw new Error('Interactive confirmation required for a fresh approval');
          const prior = await selected(s, arg || undefined);
          if (!['needs-decision','interrupted','cancelled'].includes(prior.state)) throw new Error('This run does not need a fresh start. Use /ideation to review it.');
          const brief = validateBrief({ ...prior.brief, revision: prior.brief.revision + 1 });
          const hash = briefFingerprint(brief), folder = join(s.stateDir, 'briefs');
          await mkdir(folder, { recursive: true });
          const path = join(folder, `${hash}.json`); await writeFile(path, JSON.stringify(brief));
          prepared = { title: brief.title, briefId: brief.id, briefPath: path, briefHash: hash, previewId: `preview:${s.ownerId}:${randomUUID()}`, repoRoot: s.repoRoot, approved: false, restartOf: prior.id };
          s.prepared = prepared; pi.appendEntry('ideation:preview', prepared);
          await showPrepared(s, prepared);
          action = 'approve'; arg = path;
        }
        if (action === 'approve') {
          if (s.busy) throw new Error('An owned run is already active');
          if (!ctx.hasUI) throw new Error('Interactive confirmation required; headless cannot approve');
          const briefPath = arg || prepared?.briefPath;
          if (!briefPath) throw new Error('No prepared brief in this session. Run /ideation plan <idea>, or /ideation approve <brief-path>.');
          const brief = await briefAt(s, briefPath), hash = briefFingerprint(brief);
          if (!ctx.model) throw new Error('Select a model before approval');
          const model = `${ctx.model.provider}/${ctx.model.id}`;
          // Render and open the complete contract (risk, units, evidence states, full authority)
          // before asking. The renderer runs independently of any UI outcome.
          if (!arg && (await s.runner.status()).some((r: any) => r.briefHash === hash)) throw new Error('This change already has an approved run. Open /ideation to resume or review it.');
          const matchingPrepared = prepared?.briefHash === hash;
          const previewId = matchingPrepared ? prepared.previewId ?? `preview:${s.ownerId}:${prepared.briefPath}` : `approval-preview:${s.ownerId}:${randomUUID()}`;
          const preview = await s.bridge.update(previewId, renderBrief(brief, { previous: s.drafts.get(brief.id)?.previous ?? await s.priorBrief(brief) }), { sequence: Date.now(), open: !matchingPrepared && ctx.mode !== 'rpc' });
          if (!matchingPrepared) await openLocal(s, preview);
          ctx.ui.setStatus('ideation', link(preview.url, 'review contract'));
          const restartOf = prepared?.briefHash === hash ? prepared.restartOf : undefined;
          if (!await ctx.ui.confirm(restartOf ? 'Start a fresh run?' : 'Approve change?', (restartOf ? 'Fresh budgets require this new approval. Previous work is kept.\n' : '') + approvalText(brief) + `\nBrief: v${brief.revision} / ${hash.slice(0, 12)}\nModel: ${summaryText(model)}\nContract: ${link(preview.url, 'open full agreement')}`)) return;
          if (s.busy) throw new Error('An owned run is already active');
          if (!s.live || briefFingerprint(await briefAt(s, briefPath)) !== hash) throw new Error('Brief/session changed during confirmation');
          // Immutable confirmation copy closes the read/approve race without modifying the checkout.
          const approvedDir = join(s.stateDir, 'approvals'); await mkdir(approvedDir, { recursive: true });
          const path = join(approvedDir, `${hash}.json`); await writeFile(path, JSON.stringify(brief));
          s.approving = true;
          let run: any;
          try {
            run = await s.runner.approve(path);
            if (run.briefHash !== hash) throw new Error('Approval fingerprint mismatch');
            await writeFile(join(s.stateDir, 'runs', run.id, 'frontdoor.json'), JSON.stringify({ ownerId: s.ownerId, model, briefPath: resolve(s.cwd, briefPath) }));
            await s.bridge.adopt(run.id, previewId);
            if (restartOf) {
              const prior = await s.runner.status(restartOf);
              if (!['accepted', 'cancelled'].includes(prior.state)) await s.runner.stop(restartOf);
            }
            s.prepared = undefined; s.drafts.delete(brief.id);
            pi.appendEntry('ideation:handoff', { runId: run.id, briefHash: hash, repoRoot: s.repoRoot });
          } finally { s.approving = false; }
          s.model = model;
          background(s, 'start', run.id);
          await s.show(run);
          notify(s, `Approval recorded. Starting ${summaryText(brief.title)} in an isolated workspace. The contract will update as work progresses.`);
          return;
        }
        if (action === 'status' && !arg) {
          const runs = await s.runner.status();
          if (prepared && !runs.some((r: any) => r.briefHash === prepared.briefHash)) { await showPrepared(s, prepared, false); notify(s, 'Your contract is ready. Open /ideation to review, approve or revise it.'); return; }
          const r = chooseRun(runs, s.repoRoot, s.ownerId); if (r) await s.show(r);
          notify(s, runs.map((r: any) => `${summaryText(r.brief?.title ?? r.id)}: ${r.state}`).join('\n') || 'Describe a change with /ideation plan, or open /ideation for the guided flow.'); return;
        }
        if (!['status','review','pause','resume','stop','accept'].includes(action)) throw new Error('Unknown ideation command');
        let run = await selected(s, arg || undefined);
        if (action === 'accept') {
          if (!ctx.hasUI) throw new Error('Interactive confirmation required');
          if (run.state !== 'ready-for-review') throw new Error('Run is not ready for acceptance');
          if (run.evidenceFresh === false) throw new Error('The source changed after verification. Review the contract before accepting.');
          const acceptanceView = await s.show(run, ctx.mode !== 'rpc');
          await openLocal(s, acceptanceView);
          if (!await ctx.ui.confirm('Accept change?', acceptanceText(run) + `\nCandidate: ${run.sourceRevision?.slice(0, 12)}\nContract: ${link(acceptanceView.url, 'open evidence and judgments')}`)) return;
          const fresh = await s.runner.status(run.id);
          if (!s.live || fresh.sequence !== run.sequence || fresh.briefHash !== run.briefHash || fresh.state !== run.state) throw new Error('Run changed during confirmation');
          run = await s.runner.accept(run.id, { expectedState: run.state, expectedBriefHash: run.briefHash, expectedSequence: run.sequence });
        } else if (action === 'resume') {
          if (s.busy && s.activeRunId !== run.id) throw new Error('Another owned run is already active');
          const meta = JSON.parse(await readFile(join(s.stateDir, 'runs', run.id, 'frontdoor.json'), 'utf8'));
          if (briefFingerprint(await briefAt(s, meta.briefPath)) !== run.briefHash) throw new Error('Original brief changed; new approval required');
          s.model = meta.model;
          if (typeof s.model !== 'string' || !s.model) throw new Error('Persisted approved model missing');
          if (s.busy) {
            // A live background run already owns this repository. If it is the paused run,
            // unpause the EXISTING background promise in place rather than launching a second
            // worker; s.busy stays set so the original background task keeps tracking completion.
            if ((run.ownerId && run.ownerId !== s.ownerId) || (run.state !== 'paused' && !run.pauseRequested))
              throw new Error('An owned run is already active');
            s.runner.resume(run.id).then((r: any) => s.show(r)).catch((e: Error) => notify(s, `resume failed: ${e.message}`, 'error'));
            run = await s.runner.status(run.id);
          } else if (!ctx.hasUI) {
            // A print/JSON host must not exit while its resumed run is still active.
            s.busy = true; s.activeRunId = run.id; s.activeModel = s.model;
            try { run = await executeRun(s, run.state === 'ready' ? 'start' : 'resume', run.id); } finally { s.busy = false; s.activeRunId = undefined; s.activeModel = undefined; }
          } else background(s, run.state === 'ready' ? 'start' : 'resume', run.id);
        } else if (['pause','stop'].includes(action)) run = await s.runner[action](run.id);
        const view = await s.show(run, action === 'review');
        if (action === 'review') await openLocal(s, view);
        notify(s, `${run.id}: ${run.state}\n${view.url}`);
      } catch (e: any) { notify(s, e.message, 'error'); throw e; }
    },
  });
  pi.registerTool({
    name: 'ideation_change', label: 'Ideation change',
    renderCall: (args, theme) => createChangeToolCall(args, theme, current?.tui),
    renderResult: (result, options, theme) => createChangeToolResult(result, options, theme, current?.tui),
    description: 'Prepare a brief preview, read status/receipt, record feedback, or answer an artifact question. For prepare, pass brief as an object (not a JSON string), or path to an existing JSON file. Inline briefs are stored by the host; do not create a temporary file just to prepare one. Never grants approval. Output limited to 40KB.',
    parameters: Type.Object({ action: Type.String({ enum: ['prepare','status','receipt','feedback','answer'] }), path: Type.Optional(Type.String()), brief: Type.Optional(Type.Unsafe(briefSchema)), runId: Type.Optional(Type.String()), markdown: Type.Optional(Type.String()), annotationId: Type.Optional(Type.String()), content: Type.Optional(Type.String()) }),
    async execute(_id, p, _signal, _update, ctx) {
      if (!['prepare','status','receipt','feedback','answer'].includes(p.action)) throw new Error('Unsupported model action');
      const s = await ensure(ctx); let result: any;
      if (p.action === 'prepare') {
        if ((p.path && p.brief !== undefined) || (!p.path && p.brief === undefined)) throw new Error('Provide exactly one of path or brief');
        let b: any, briefPath: string;
        if (p.brief !== undefined) {
          // Inline brief: validate, then persist the canonical snapshot under the git common
          // dir (gitignored) so approval never needs a dirty checkout and the fingerprint the
          // approval binds to stays stable and independently re-checkable for later edits.
          b = validateBrief(p.brief);
          const briefsDir = join(s.stateDir, 'briefs'); await mkdir(briefsDir, { recursive: true });
          briefPath = join(briefsDir, `${briefFingerprint(b)}.json`);
          await writeFile(briefPath, JSON.stringify(b));
        } else {
          b = await briefAt(s, p.path);
          briefPath = resolve(s.cwd, p.path);
        }
        const draft = s.drafts.get(b.id);
        const previewId = draft?.previewId ?? `preview:${s.ownerId}:${randomUUID()}`;
        const previous = draft && briefFingerprint(draft.brief) !== briefFingerprint(b) ? draft.brief : draft?.previous ?? await s.priorBrief(b);
        const open = Boolean(ctx.hasUI) && ctx.mode !== 'rpc' && !draft;
        result = await s.bridge.update(previewId, renderBrief(b, { previous }), { sequence: Date.now(), open });
        if (open) await openLocal(s, result);
        result = { ...result, title: b.title, briefId: b.id, previewId, briefPath, briefHash: briefFingerprint(b), repoRoot: s.repoRoot, approved: false };
        s.prepared = result; s.drafts.set(b.id, { previewId, brief: b, previous });
        s.paint({ state: 'draft', brief: b }, result);
        pi.appendEntry('ideation:preview', result);
      } else if (p.action === 'status') result = await s.runner.status(p.runId);
      else {
        const r = await selected(s, p.runId);
        if (p.action === 'receipt') result = { run: r, ...await s.show(r) };
        else if (p.action === 'feedback') { if (!p.markdown) throw new Error('Feedback required'); result = { delivered: await s.feedback(r.id, { markdown: String(p.markdown).slice(0, MAX_FEEDBACK) }) }; }
        else if (p.action === 'answer') { if (!p.annotationId || !p.content) throw new Error('Question id and answer required'); await s.show(r); result = await s.bridge.answer(r.id, p.annotationId, String(p.content).slice(0, MAX_FEEDBACK)); }
        else throw new Error('Unsupported model action');
      }
      const text = JSON.stringify(result);
      return { content: [{ type: 'text', text: text.length > 40000 ? text.slice(0, 40000) + '\n[Truncated; use runId or receipt view]' : text }], details: result };
    },
  });
}
export default function (pi: ExtensionAPI) { registerChange(pi); }
