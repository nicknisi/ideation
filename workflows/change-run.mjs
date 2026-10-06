import { mkdir, readFile, writeFile, rename, rm, readdir, rmdir, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { realpathSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { gitText } from './change-workspace.mjs';
import { runContractEngine } from './engine-host.mjs';
import { computeWaves } from './wave-planner.mjs';

const clone = value => structuredClone(value);
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const alive = pid => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
const transient = message => /\b(429|5\d\d)\b/.test(message);

export function failureAttention(error) {
  const detail = String(error?.message ?? error);
  if (/claude_code_version_too_old|Claude Code .* does not support this model/i.test(detail)) {
    return { reason: 'provider-client-version', message: 'The worker could not start because its Anthropic client was out of date. After updating ideation’s Pi SDK dependencies, reload Pi and resume this run. Your brief is unchanged.', detail };
  }
  return { reason: 'execution', message: detail };
}

/** Trusted-command API. dependencies is an optional test seam; default modules are lazy
 * imported so importing the controller never starts work (or requires a Pi runtime).
 * A lease is repository-wide: even different runs never share concurrent builders.
 */
export function createChangeRunner({ repoRoot, pluginRoot, spawn, ownerId = randomUUID(), onEvent, now = Date.now, dependencies = {} }) {
  repoRoot = realpathSync(resolve(repoRoot));
  let active, disposed = false, saveTail = Promise.resolve(), feedbackTail = Promise.resolve();
  const git = async (...args) => (await gitText(repoRoot, args)).trim();
  const root = git('rev-parse', '--git-common-dir').then(p => join(resolve(repoRoot, p), 'ideation', 'runs'));
  const modules = async () => ({
    brief: dependencies.brief ?? await import('./change-brief.mjs'),
    workspace: dependencies.workspace ?? await import('./change-workspace.mjs'),
    engine: dependencies.engine ?? runContractEngine,
  });
  const dir = async id => {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid run ID');
    return join(await root, id);
  };
  const load = async id => {
    const r = await json(join(await dir(id), 'state.json'));
    if (r.schemaVersion !== 1 || r.id !== id || typeof r.repoRoot !== 'string' || realpathSync(r.repoRoot) !== repoRoot) throw new Error('Invalid persisted run');
    r.repoRoot = repoRoot;
    if (r.attention?.message) {
      const readable = failureAttention(r.attention.message);
      if (readable.reason === 'provider-client-version') r.attention = readable;
    }
    return r;
  };
  async function save(r) {
    r.sequence++; r.updatedAt = now();
    const snapshot = clone(r);
    const operation = saveTail.then(async () => {
      const path = join(await dir(r.id), 'state.json');
      const tmp = `${path}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
      await rename(tmp, path);
      try { Promise.resolve(onEvent?.({ type: 'ideation:v1:run-changed', run: clone(snapshot) })).catch(() => {}); } catch { /* observational */ }
    });
    saveTail = operation.catch(() => {});
    await operation;
  }
  async function lease(reclaim = false) {
    const path = join(await root, '.lease');
    await mkdir(await root, { recursive: true });
    const gate = join(await root, '.lease-acquire');
    // Publish a nonempty gate atomically: no ownerless acquisition window.
    const candidate = `${gate}.${randomUUID()}`;
    await mkdir(candidate);
    await writeFile(join(candidate, String(process.pid)), ownerId);
    try {
      try { await rename(candidate, gate); } catch (e) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(e.code)) throw e;
        const owners = await readdir(gate);
        if (owners.some(p => alive(Number(p)))) throw new Error('Repository lease acquisition is active');
        for (const p of owners) await unlink(join(gate, p)).catch(e => { if (e.code !== 'ENOENT') throw e; });
        await rmdir(gate).catch(e => { if (e.code !== 'ENOENT') throw e; });
        await rename(candidate, gate);
      }
    } finally { await rm(candidate, { recursive: true, force: true }); }
    try {
    try { await mkdir(path); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const old = await json(join(path, 'owner.json')).catch(() => null);
      if ((old && alive(old.hostPid)) || !reclaim) throw new Error('Repository has a live or unreconciled run lease');
      // Rename rather than delete in place; contenders must acquire mkdir anew.
      const stale = `${path}.dead-${randomUUID()}`;
      await rename(path, stale);
      await rm(stale, { recursive: true });
      await mkdir(path);
    }
    await writeFile(join(path, 'owner.json'), JSON.stringify({ ownerId, hostPid: process.pid }), { mode: 0o600 });
    return () => rm(path, { recursive: true });
    } finally { await rm(gate, { recursive: true }); }
  }
  async function approved(r, b) {
    if (b.briefFingerprint(b.validateBrief(await json(r.briefPath))) !== r.briefHash || b.briefFingerprint(r.brief) !== r.briefHash)
      throw new Error('Approved brief changed; new explicit approval required');
  }
  /** What an approval would leave out, so the front door can ask. Never blocks:
   * uncommitted work is the user's, and the run is isolated from it either way. */
  async function uncommitted({ exclude = [] } = {}) {
    const { workspace: w } = await modules();
    return { head: await git('rev-parse', 'HEAD'), paths: await w.uncommittedPaths(repoRoot, { exclude }) };
  }
  /** includeUncommitted: start from a snapshot of the checkout as it is now
   * (tracked edits and untracked files, minus `exclude` and host-written paths)
   * instead of the last commit. Neither choice touches the user's files. */
  async function approve(briefPath, { includeUncommitted = false, exclude = [] } = {}) {
    if (disposed) throw new Error('Runner disposed');
    const release = await lease();
    try {
      const { brief: b, workspace: w } = await modules();
      briefPath = resolve(repoRoot, briefPath);
      const brief = b.validateBrief(await json(briefPath));
      const id = `${brief.id}-${randomUUID()}`;
      const head = await git('rev-parse', 'HEAD');
      let baseRevision = head, includedChanges = [];
      if (includeUncommitted) {
        const paths = await w.uncommittedPaths(repoRoot, { exclude });
        const snapshot = paths.length ? await w.snapshotWorkingTree(repoRoot, { ref: `refs/ideation/${id}/base`, exclude,
          message: `ideation: uncommitted work included when ${brief.id} r${brief.revision} was approved` }) : null;
        if (snapshot) { baseRevision = snapshot; includedChanges = paths; }
      }
      const r = { schemaVersion: 1, id, briefHash: b.briefFingerprint(brief), brief, briefPath, repoRoot,
        workspace: null, branch: null, baseRevision, approvedHead: head, includedChanges, sourceRevision: null,
        state: 'ready', sequence: 0, ownerId: null, hostPid: null, startedAt: null, updatedAt: now(),
        units: brief.units.map(u => ({ id: u.id, title: u.title, state: 'ready', attempts: 0, reviewStatus: 'not-run', commitHash: null, summary: '' })),
        evidence: [], attention: null, usage: { totalTokens: 0 }, decisions: [] };
      await mkdir(await dir(id), { recursive: false });
      await writeFile(join(await dir(id), 'brief.json'), JSON.stringify(brief), { flag: 'wx', mode: 0o400 });
      await save(r); return clone(r);
    } finally { await release(); }
  }
  async function status(id) {
    if (!id) {
      const ids = (await readdir(await root).catch(e => { if (e.code === 'ENOENT') return []; throw e; })).filter(x => !x.startsWith('.'));
      const runs = [];
      for (const candidate of ids) {
        const stored = await json(join(await dir(candidate), 'state.json'));
        // Worktrees share a Git common directory, not a planning context.
        if (typeof stored.repoRoot === 'string' && resolve(stored.repoRoot) !== repoRoot) {
          try { if (realpathSync(stored.repoRoot) !== repoRoot) continue; }
          catch (e) { if (e.code === 'ENOENT') continue; throw e; }
        }
        runs.push(await status(candidate));
      }
      return runs;
    }
    let r = await load(id);
    if (['running', 'verifying', 'cancelling', 'paused'].includes(r.state) && !alive(r.hostPid)) {
      const release = await lease(true);
      try { r = await load(id); (r.interruptions ??= []).push({ at: now(), ownerId: r.ownerId, hostPid: r.hostPid, sourceRevision: r.sourceRevision, units: r.units.filter(u => u.state === 'running').map(u => ({ id: u.id, attempt: u.attempts })) }); r.state = 'interrupted'; r.attention = { reason: 'interrupted', message: 'Host exited; explicit resume required' }; await save(r); }
      finally { await release(); }
    }
    const snapshot = clone(r);
    if (snapshot.workspace && snapshot.sourceRevision && ['ready-for-review', 'accepted'].includes(snapshot.state)) {
      const { workspace: w } = await modules();
      try { snapshot.evidenceFresh = await w.sourceRevision(snapshot.workspace) === snapshot.sourceRevision; }
      catch { snapshot.evidenceFresh = false; }
      if (!snapshot.evidenceFresh) snapshot.attention = { reason: 'stale-evidence', message: 'Workspace changed since verification. Restore the reviewed source or approve a new change; old evidence is not current.' };
    }
    return snapshot;
  }
  async function boundary(ctx) {
    const { r } = ctx;
    if (ctx.abort.signal.aborted) throw new Error('Run aborted');
    if (ctx.pause) {
      if (r.workspace) {
        const { workspace: w } = await modules();
        ctx.pauseRevision = await w.sourceRevision(r.workspace);
        r.sourceRevision = ctx.pauseRevision;
      }
      r.state = 'paused'; await save(r);
      await new Promise(resolve => {
        const finish = () => { ctx.abort.signal.removeEventListener('abort', finish); resolve(); };
        ctx.unpause = finish;
        ctx.abort.signal.addEventListener('abort', finish, { once: true });
        if (ctx.abort.signal.aborted || !ctx.pause) finish();
      });
      ctx.unpause = null;
      if (ctx.abort.signal.aborted) throw new Error('Run aborted');
      r.state = 'running'; await save(r);
    }
  }
  // There are no budgets: a run ends when it is done, when you pause or stop it,
  // or when it cannot make its checks pass. Usage is recorded for information only.
  const invoke = (ctx, options) => spawn(options);
  async function account(ctx, result) {
    const usage = result?.usage ?? {}, u = ctx.r.usage;
    for (const key of ['totalTokens', 'inputTokens', 'outputTokens', 'cost'])
      if (Number.isFinite(usage[key]) && usage[key] >= 0) u[key] = (u[key] ?? 0) + usage[key];
    await save(ctx.r);
    await boundary(ctx);
  }
  async function checks(ctx, criteria, w) {
    await boundary(ctx);
    const r = ctx.r;
    await w.assertScope(r.workspace, r.brief.authority.paths);
    const evidence = await w.runChecks(r.workspace, criteria, { signal: ctx.abort.signal });
    const revision = await w.sourceRevision(r.workspace);
    r.evidence = evidence; r.sourceRevision = revision; await save(r);
    for (const c of criteria) {
      const e = evidence.filter(e => e.criterionId === c.id);
      if (e.length !== 1 || e[0].sourceRevision !== revision || (c.check.cmd ? e[0].status !== 'passed' : e[0].status !== 'pending'))
        throw new Error(`CHECK_FAILED: Missing, stale or failed evidence for ${c.id}`);
    }
    await boundary(ctx); return revision;
  }
  async function execute(ctx, resume) {
    const r = ctx.r;
    try {
      const { brief: b, workspace: w, engine } = await modules();
      await approved(r, b);
      if (r.reconciliationRequired) throw new Error('Workspace state could not be recorded safely; inspect it and make a fresh approval rather than blindly resuming.');
      if (ctx.abort.signal.aborted) throw new Error('Run aborted');
      if (!r.workspace) {
        // Built from the approved starting point, wherever HEAD has moved since.
        const created = await w.createWorkspace(repoRoot, r.id, r.baseRevision);
        if (created.baseRevision !== r.baseRevision) throw new Error('Workspace baseline differs from approval');
        Object.assign(r, created);
        await save(r);
      } else if (resume && r.sourceRevision && await w.sourceRevision(r.workspace) !== r.sourceRevision) {
        throw new Error('Workspace differs from durable evidence; explicit decision/new approval required');
      }
      r.startedAt ??= now(); r.state = 'running'; r.pauseRequested = false; r.attention = null; await save(r);
      await boundary(ctx);
      if (w.prepareDependencies) {
        r.activeStage = 'environment'; await save(r);
        await w.prepareDependencies(repoRoot, r.workspace, { signal: ctx.abort.signal });
        await boundary(ctx);
      }
      const policy = await w.writePolicy(await dir(r.id), r.workspace, r.brief.authority, pluginRoot);
      const a = r.brief.authority;
      // timeoutMs 0: no time limit on a worker (the runtime's own default would impose one).
      const options = () => ({ spawn, pluginRoot, cwd: r.workspace, signal: ctx.abort.signal, timeoutMs: 0,
        extensionPaths: [policy], systemPrompt: 'Only the approved authority applies. Host alone checks, stages and commits. Never modify host packets.' });
      const order = computeWaves(r.brief.units.map(u => ({ title: u.id, prereqs: u.needs }))).flat();
      for (const id of order) {
        const unit = r.brief.units.find(u => u.id === id), receipt = r.units.find(u => u.id === id);
        if (receipt.state === 'completed') {
          if (receipt.reviewStatus !== 'passed') throw new Error('Completed receipt lacks independent review');
          continue; // final integrated checks below always rerun, including on resume
        }
        // Not an allowance: a unit keeps going until it is reviewed and verified,
        // and stops to ask you only when it is stuck (the same check failing twice,
        // or the provider still failing after a few spaced retries).
        let done = false, providerRetries = 0;
        while (!done) {
          await boundary(ctx); receipt.attempts++; receipt.state = 'running'; r.activeStage = 'plan'; await save(r);
          let reviewedRevision = null, reviewInputRevision = null, committed = false, stagePermit = false;
          try {
            const planned = await invoke(ctx, { ...options(), agent: `plan:${id}`, tools: ['read', 'grep', 'find', 'ls'],
              prompt: `Plan only this unit against the current workspace. No edits or shell. Approved brief:\n${JSON.stringify(r.brief)}\nUnit: ${id}\nReturn only a JSON object with one field: {"plan":"your concise implementation plan"}. Put it in your final message as plain JSON, not a tool call. No StructuredOutput tool exists.`,
              outputSchema: { type: 'object', additionalProperties: false, required: ['plan'], properties: { plan: { type: 'string', minLength: 1 } } } });
            await account(ctx, planned);
            if (!planned.ok || typeof planned.data?.plan !== 'string' || !planned.data.plan.trim()) throw new Error(`${planned.kind}: ${planned.error ?? 'Invalid plan'}`);
            const packetDir = join(r.workspace, 'docs', 'ideation', '.native', r.id);
            await mkdir(packetDir, { recursive: true });
            const specPath = join(packetDir, `spec-phase-${order.indexOf(id) + 1}.md`);
            await writeFile(specPath, b.workPacket(r.brief, unit, { plan: planned.data.plan, sourceRevision: await w.sourceRevision(r.workspace) }));
            const criteria = r.brief.acceptance.filter(c => unit.acceptanceIds.includes(c.id));
            const summary = await engine({ projectName: r.brief.title, slug: r.id, projectDir: packetDir, strict: true, native: true,
              executionMode: r.brief.executionMode,
              phases: [{ title: unit.title, specPath, prereqs: [], risk: unit.risk, files: [] }] }, {
              ...options(),
              // Old hosts without correctness hooks must not execute even one child.
              spawn: async opts => {
                if (!stagePermit) throw new Error('Engine host correctness hooks required');
                stagePermit = false;
                await boundary(ctx);
                return invoke(ctx, opts);
              },
              beforeStage: async info => {
                await boundary(ctx);
                if (!['scout', 'build', 'review', 'fix', 'commit'].includes(info.stage)) throw new Error('Unknown engine stage');
                r.activeStage = info.stage; r.state = info.stage === 'review' ? 'verifying' : 'running'; await save(r);
                stagePermit = info.stage !== 'commit';
                if (info.stage === 'review') { await w.prepareReview(r.workspace, a.paths, { signal: ctx.abort.signal, timeoutMs: Infinity }); reviewInputRevision = await checks(ctx, criteria, w); }
                if (info.stage === 'build' || info.stage === 'fix') reviewedRevision = null;
                if (info.stage === 'commit') {
                  if (!reviewedRevision || reviewedRevision !== await w.sourceRevision(r.workspace)) throw new Error('Independent current-source review required');
                  const revision = await checks(ctx, criteria, w);
                  const hash = a.allowLocalCommit ? await w.commitWorkspace(r.workspace, a.paths, { message: `${r.brief.title}: ${unit.title}`, specPath, sourceRevision: revision, signal: ctx.abort.signal }) : null;
                  receipt.commitHash = hash; committed = true;
                  r.sourceRevision = await w.sourceRevision(r.workspace); await save(r);
                  const empty = (await w.changedFiles(r.workspace)).length === 0;
                  receipt.outcome = hash ? 'COMMITTED' : empty ? 'NO-OP' : 'VERIFIED';
                  return { result: { result: receipt.outcome, commitHash: hash, summary: hash ? 'Host verified local commit' : empty ? 'Verified no source changes; no commit created' : 'Verified only; local commit not authorized, no commit created' } };
                }
              },
              afterStage: async info => {
                if (info.stage === 'review') {
                  const clean = info.result.ok && info.result.data?.verdict === 'PASS' && (info.result.data.blocking ?? 0) === 0;
                  reviewedRevision = clean && reviewInputRevision === await w.sourceRevision(r.workspace) ? reviewInputRevision : null;
                  receipt.reviewStatus = reviewedRevision ? 'passed' : info.result.ok ? 'failed' : 'unavailable';
                  receipt.reviewEvidence = { at: now(), sourceRevision: reviewInputRevision, result: clone(info.result.data ?? null) };
                }
                await account(ctx, info.result);
              },
            });
            await boundary(ctx);
            const result = summary?.results?.[0];
            if (!committed || !reviewedRevision || !['PASS', 'NO-OP'].includes(result?.result) || result.reviewStatus !== 'passed')
              throw new Error(result?.summary ?? 'Engine did not produce independently reviewed completion');
            receipt.state = 'completed'; receipt.reviewStatus = 'passed'; receipt.summary = a.allowLocalCommit ? result.summary : `${result.summary ?? ''} No local commit authorized or created.`;
            receipt.sourceRevision = r.sourceRevision; done = true; await save(r);
          } catch (e) {
            if (ctx.pause || ctx.abort.signal.aborted) throw e;
            const signature = String(e.message);
            const repeated = receipt.failureSignature === signature;
            receipt.failureSignature = signature; receipt.state = 'failed';
            receipt.summary = failureAttention(e).message; receipt.failureStage = r.activeStage;
            await save(r);
            const retryableTransport = transient(signature);
            if ((!retryableTransport && repeated) || (!retryableTransport && !signature.includes('CHECK_FAILED'))) throw e;
            if (retryableTransport) {
              if (++providerRetries > 3) throw e;
              // The spawn result does not expose response headers: spaced backoff,
              // not an invented Retry-After value.
              await new Promise(resolve => {
                const finish = () => { clearTimeout(timer); ctx.abort.signal.removeEventListener('abort', finish); resolve(); };
                const timer = setTimeout(finish, Math.min(1000 * 2 ** (providerRetries - 1), 8000));
                ctx.abort.signal.addEventListener('abort', finish, { once: true });
                if (ctx.abort.signal.aborted) finish();
              });
            }
          }
        }
      }
      r.state = 'verifying'; r.activeStage = 'acceptance'; await save(r);
      await checks(ctx, r.brief.acceptance, w);
      const judgments = r.brief.acceptance.filter(c => c.check.judgment).length;
      r.state = 'ready-for-review'; r.attention = { reason: 'acceptance', message: `Objective verification complete. Explicit acceptance required${judgments ? `; ${judgments} human judgment(s) pending` : ''}.` };
    } catch (e) {
      r.state = ctx.shutdown ? 'interrupted' : ctx.abort.signal.aborted ? 'cancelled' : ctx.pause ? 'paused' : 'needs-decision';
      r.attention = failureAttention(e);
    } finally {
      if (r.workspace) {
        const { workspace: w } = await modules();
        try {
          r.sourceRevision = w.withGitControl ? await w.withGitControl({ timeoutMs: 2000 }, () => w.sourceRevision(r.workspace)) : await w.sourceRevision(r.workspace);
        } catch (e) {
          r.reconciliationRequired = true;
          r.attention = { reason: 'source-unavailable', message: 'Could not safely record the final workspace state. Work is retained; inspect it before a fresh approval.', detail: String(e.message) };
          if (r.state === 'ready-for-review') r.state = 'needs-decision';
        }
      }
      if (r.state === 'interrupted') {
        (r.interruptions ??= []).push({ at: now(), ownerId, units: r.units.filter(u => u.state === 'running').map(u => ({ id: u.id, attempt: u.attempts })), sourceRevision: r.sourceRevision });
      }
      r.ownerId = null; r.hostPid = null; r.activeStage = null;
      await save(r);
    }
    return clone(r);
  }
  async function launch(id, resume) {
    if (disposed || active) throw new Error('Runner disposed or already active');
    const release = await lease(resume);
    try {
      const r = await load(id);
      if (!(resume ? ['paused', 'interrupted', 'needs-decision'] : ['ready']).includes(r.state)) throw new Error(`Cannot ${resume ? 'resume' : 'start'} ${r.state}`);
      const ctx = { r, abort: new AbortController(), pause: false, shutdown: false };
      active = ctx; r.ownerId = ownerId; r.hostPid = process.pid;
      r.state = 'running';
      ctx.promise = (async () => { await save(r); return execute(ctx, resume); })();
      try { return await ctx.promise; } finally { active = null; }
    } finally { await release(); }
  }
  async function pause(id) {
    if (!active || active.r.id !== id || !active.promise) throw new Error('Only active owning host can pause');
    active.pause = true; active.r.pauseRequested = true; await save(active.r); return clone(active.r);
  }
  async function stop(id) {
    if (disposed) throw new Error('Runner disposed');
    if (active) {
      if (active.r.id !== id || !active.promise) throw new Error('Only active owning host can stop');
      const ctx = active; ctx.r.state = 'cancelling'; ctx.abort.abort(); await save(ctx.r);
      return ctx.promise;
    }
    // A blocked/interrupted run has no live child to abort, but users must still
    // be able to set it aside. Keep its branch, worktree and evidence.
    const release = await lease(true);
    try {
      const r = await load(id);
      if (r.state === 'cancelled') return clone(r);
      if (!['ready', 'paused', 'interrupted', 'needs-decision', 'ready-for-review'].includes(r.state)) throw new Error('This run cannot be stopped by this host');
      if (r.hostPid && alive(r.hostPid)) throw new Error('Another live host still owns this run');
      r.state = 'cancelled'; r.attention = null; r.ownerId = null; r.hostPid = null; r.activeStage = null;
      await save(r); return clone(r);
    } finally { await release(); }
  }
  async function accept(id, expected = {}) {
    const release = await lease();
    try {
      const r = await load(id), { brief: b, workspace: w } = await modules();
      if ((expected.expectedSequence !== undefined && expected.expectedSequence !== r.sequence) ||
          (expected.expectedBriefHash !== undefined && expected.expectedBriefHash !== r.briefHash) ||
          (expected.expectedState !== undefined && expected.expectedState !== r.state)) throw new Error('Run changed since acceptance confirmation');
      if (b.briefFingerprint(b.validateBrief(await json(join(await dir(id), 'brief.json')))) !== r.briefHash || b.briefFingerprint(r.brief) !== r.briefHash) throw new Error('Approved snapshot changed');
      if (r.state !== 'ready-for-review' || r.units.some(u => u.state !== 'completed' || u.reviewStatus !== 'passed')) throw new Error('Run is not ready for acceptance');
      const revision = await w.sourceRevision(r.workspace);
      await w.assertScope(r.workspace, r.brief.authority.paths);
      if (r.sourceRevision !== revision) throw new Error('Acceptance evidence is stale');
      for (const c of r.brief.acceptance) {
        const e = r.evidence.filter(e => e.criterionId === c.id);
        if (e.length !== 1 || e[0].sourceRevision !== revision || e[0].status !== (c.check.cmd ? 'passed' : 'pending')) throw new Error('Missing or invalid acceptance evidence');
      }
      // Calling this trusted API is the explicit human judgment, never model approval.
      r.decisions.push({ type: 'accept', at: now(), ownerId, sourceRevision: revision, judgments: r.brief.acceptance.filter(c => c.check.judgment).map(c => c.id) });
      r.state = 'accepted'; r.attention = null; await save(r); return clone(r);
    } finally { await release(); }
  }
  async function resume(id) {
    if (active?.r.id === id) {
      const { brief: b, workspace: w } = await modules();
      await approved(active.r, b);
      if (active.pauseRevision && await w.sourceRevision(active.r.workspace) !== active.pauseRevision) throw new Error('Workspace changed while paused; explicit decision/new approval required');
      active.pauseRevision = null;
      active.pause = false; active.r.pauseRequested = false;
      await save(active.r); active.unpause?.();
      return active.promise;
    }
    return launch(id, true);
  }
  function recordFeedback(id, feedback) {
    const operation = feedbackTail.then(() => persistFeedback(id, feedback));
    feedbackTail = operation.catch(() => {});
    return operation;
  }
  async function persistFeedback(id, feedback) {
    if (!feedback || typeof feedback.markdown !== 'string' || !feedback.markdown.trim() ||
        (feedback.id !== undefined && (typeof feedback.id !== 'string' || !feedback.id)) ||
        (feedback.annotationIds !== undefined && (!Array.isArray(feedback.annotationIds) || feedback.annotationIds.some(x => typeof x !== 'string')))) throw new Error('Invalid feedback');
    const release = active?.r.id === id ? null : await lease(true);
    try {
      const r = active?.r.id === id ? active.r : await load(id);
      const annotationIds = [...new Set(feedback.annotationIds ?? [])].sort();
      const key = feedback.id ?? JSON.stringify([feedback.markdown, annotationIds]);
      r.feedback ??= [];
      if (!r.feedback.some(f => f.id === key)) {
        r.feedback.push({ id: key, markdown: feedback.markdown, annotationIds, at: now(), status: 'pending' });
        await save(r);
      }
      return clone(r);
    } finally { await release?.(); }
  }
  async function dispose() {
    disposed = true;
    if (active) { const ctx = active; ctx.shutdown = true; ctx.abort.abort(); if (ctx.promise) await ctx.promise; }
  }
  /** What a run has changed so far, for the "bring it over?" question. */
  async function work(id) {
    const r = await load(id);
    if (!r.workspace || !existsSync(r.workspace)) return { files: [], branch: r.branch, workspace: r.workspace };
    const { workspace: w } = await modules();
    const { files } = await w.workPatch(r.workspace, r.baseRevision);
    return { files, branch: r.branch, workspace: r.workspace };
  }
  /** Leave ideation for a run. Stops it if it is working, keeps its exact final
   * state under refs/ideation/<id>/exit, and with `apply` brings the work into
   * the checkout as ordinary uncommitted changes (removing the worktree only
   * once that has succeeded). Nothing the run produced is thrown away. */
  async function leave(id, { apply = false } = {}) {
    if (disposed) throw new Error('Runner disposed');
    let r = await status(id);
    if (!['cancelled', 'accepted'].includes(r.state)) r = await stop(id);
    const { workspace: w } = await modules();
    const outcome = { files: [], applied: false, branch: r.branch, workspace: r.workspace };
    if (r.workspace && existsSync(r.workspace)) {
      const exported = await w.workPatch(r.workspace, r.baseRevision);
      outcome.files = exported.files;
      if (exported.files.length) {
        const kept = await git('commit-tree', exported.tree, '-p', exported.head, '-m', `ideation: work when leaving ${r.brief.id}`);
        await git('update-ref', `refs/ideation/${r.id}/exit`, kept);
        outcome.ref = `refs/ideation/${r.id}/exit`;
        if (apply) {
          const result = await w.applyWork(repoRoot, exported.patch);
          outcome.applied = result.applied; outcome.reason = result.reason;
          if (result.applied) { await git('worktree', 'remove', '--force', r.workspace); outcome.workspaceRemoved = true; }
        }
      }
    }
    const release = await lease(true);
    try {
      r = await load(id);
      r.exit = { at: now(), files: outcome.files.length, applied: outcome.applied, ref: outcome.ref ?? null, workspaceRemoved: Boolean(outcome.workspaceRemoved) };
      r.attention = null; await save(r);
    } finally { await release(); }
    return { run: clone(r), ...outcome };
  }
  return { approve, uncommitted, start: id => launch(id, false), status, pause, resume, stop, accept, recordFeedback, work, leave, dispose };
}
