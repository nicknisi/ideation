import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
// scripts/verify.mjs owns what a `check` is — the thing that runs the checks
// decides what is runnable, and importing keeps the renderer and the executor
// from ever disagreeing about a criterion's kind.
import {
  committablePhases,
  isJudgment,
  normalizeCriterion,
  summarizeCriteria,
  validateCheck,
} from './verify.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(__dirname, 'contract-gen.css'), 'utf8');

// --- Types ---

interface ScopeItem {
  item: string;
  reason?: string;
}

interface DecisionItem {
  /** What was chosen */
  decision: string;
  /** The alternative not taken */
  rejected?: string;
  /** Why */
  reason: string;
}

interface GateDimension {
  key: string;
  label: string;
  status: 'ready' | 'not-ready';
  evidence: string;
}

interface Phase {
  title: string;
  risk?: 'high' | 'medium' | 'low';
  blocking?: boolean;
  kind?: 'gate' | 'phase';
  prereqs?: string[];
  specPath?: string;
  notes?: string;
}

/** A runnable command plus the outcome that means it passed. */
interface CmdCheck {
  cmd: string;
  expect: string;
}
/** No command exists — say who has to look at what, in one sentence. */
interface JudgmentCheck {
  judgment: string;
}
type Check = CmdCheck | JudgmentCheck;

interface SuccessCriterion {
  criterion: string;
  /** How the criterion is verified. `string` is the legacy shape ("cmd — expected
      outcome") and still renders: normalizeCriterion splits it on the em-dash,
      or coerces it to a judgment when it plainly isn't shell. Absent = judgment,
      unstated. */
  check?: Check | string;
}

/** Post-normalization shape — what every builder below actually sees. */
interface NormalizedCriterion {
  criterion: string;
  check?: Check;
}

/** verify.mjs owns the runtime rule; these restate it as type predicates so
    the renderer narrows properly (the imported helper is plain JS). */
function isCmd(check: Check | undefined): check is CmdCheck {
  return check !== undefined && !isJudgment(check);
}
function isJudge(check: Check | undefined): check is JudgmentCheck {
  return check !== undefined && isJudgment(check);
}

interface ContractData {
  projectName: string;
  slug: string;
  date: string;
  status: 'Draft' | 'Approved';
  /** How approval happened: interactive per-artifact review (default when
      absent) or express — single consolidated confirmation after the
      interview, no per-artifact human review */
  approvalMode?: 'interactive' | 'express';
  /** Isolation branch execution commits to (express runs). Autopilot
      re-asserts this checkout on every entry so the guarantee survives
      fresh sessions. */
  branch?: string;
  /** When the contract was approved (distinct from creation date) */
  approvedOn?: string;
  /** Who approved it */
  approvedBy?: string;
  supersedes: string | null;
  gates: {
    /** Legacy fields, ignored — readiness is derived from dimensions */
    passed?: number;
    total?: number;
    dimensions: GateDimension[];
  };
  problem: string[];
  goals: string[];
  successCriteria: Array<string | SuccessCriterion>;
  scope: {
    mvp: ScopeItem[];
    full: ScopeItem[];
    stretch: ScopeItem[];
    outOfScope: ScopeItem[];
    future: string[];
  };
  /** Alternatives weighed and turned down (interview rejections +
      critic-blocker fixes). Absent or empty = section suppressed. */
  decisions?: DecisionItem[];
  execution: {
    strategy: string;
    phases: Phase[];
    agentTeamPrompt?: string;
  };
}

// --- Helpers ---

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function riskMeta(risk: string): { color: string; label: string } {
  switch (risk) {
    case 'high':
      return { color: 'var(--danger)', label: 'high' };
    case 'medium':
      return { color: 'var(--caution)', label: 'med' };
    default:
      return { color: 'var(--go)', label: 'low' };
  }
}

function asCriterion(c: string | SuccessCriterion): NormalizedCriterion {
  return normalizeCriterion(c) as NormalizedCriterion;
}

function phaseCommand(phase: Phase, slug: string, index: number): string {
  if (phase.kind === 'gate')
    return `# Review: ${phase.specPath ?? phase.title}`;
  if (phase.specPath) return `/ideation:execute-spec ${phase.specPath}`;
  return `/ideation:execute-spec docs/ideation/${slug}/spec-phase-${index + 1}.md`;
}

function cmdField(id: string, cmd: string, wide = false): string {
  return `<div class="cmd-field${wide ? ' cmd-field-wide' : ''}">
            <span class="cmd-field-text" id="${id}">${esc(cmd)}</span>
            <button type="button" class="copy-btn" data-copy="${id}">copy</button>
          </div>`;
}

interface ContractPaths {
  /** Repo-relative contract-data.json — what verify.mjs is pointed at */
  dataPath: string;
  /** Repo-relative contract.md — what autopilot is pointed at */
  contractPath: string;
  /** How to invoke verify.mjs from the project being executed */
  verifyBin: string;
}

/** Where the run commands should point. Derived from --input when it sits
    inside the cwd, otherwise from the slug convention. `verifyBin` is relative
    when the generator lives inside the project it is rendering (this repo
    dogfooding itself) and ${CLAUDE_PLUGIN_ROOT}-qualified when it is an
    installed plugin acting on someone else's repo — never an absolute path,
    which would bake this machine into a committed contract. */
function contractPaths(d: ContractData, inputPath?: string): ContractPaths {
  let dataPath = `docs/ideation/${d.slug}/contract-data.json`;
  if (inputPath) {
    const rel = relative(process.cwd(), resolve(inputPath));
    if (rel && !rel.startsWith('..')) dataPath = rel;
  }
  const scriptRel = relative(process.cwd(), join(__dirname, 'verify.mjs'));
  const verifyBin =
    scriptRel && !scriptRel.startsWith('..')
      ? scriptRel
      : '${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs';
  return {
    dataPath,
    contractPath: join(dirname(dataPath), 'contract.md'),
    verifyBin,
  };
}

/** The one owner of the `/goal` string. Rendered into contract.html's copy
    field, into contract.md, and printed by `--print-goal`.

    `/goal` is "set a goal Claude checks before stopping" — the argument is a
    CONDITION evaluated against the transcript, not a procedure. So this reads
    as a state of the world, and every imperative in it exists only because the
    condition can't be true unless it happened.

    Three things it must carry:
      1. Autopilot dispatches a BACKGROUND workflow — wait for the completion
         notification, and never start a second run while one is in flight.
         (Without this the Stop hook fires mid-run and re-injects the goal as a
         directive, launching a concurrent engine run.)
      2. verify.mjs after every run, VERIFY line left in the transcript — the
         evaluator reads the transcript and nothing else, so evidence that
         isn't in the conversation does not exist.
      3. A DISJUNCTIVE done-when. A rotted contract can never reach fail=0, and
         a purely conjunctive goal would loop on it forever; two consecutive
         identical failing VERIFY lines is the escape hatch. */
function buildGoal(d: ContractData, paths: ContractPaths): string {
  // Single owner: verify.mjs decides which phases are expected to leave a commit,
  // and it is what produces the VERIFY line this goal is judged on. Re-deriving
  // the filter here once made the two disagree, which produced a goal whose
  // commits=N/N could never be reached — a trap the escape hatch does not cover.
  const phases = committablePhases(d).length;
  const branch = d.branch
    ? ` All commits belong on branch ${d.branch} — switch to it before any run.`
    : '';
  // Numbered lines, not a paragraph. /goal takes free text, so structure is free —
  // and the person pasting this has to be able to skim it and confirm it says what
  // they meant before they walk away. The done-when goes last, on its own line,
  // because it is the only part that decides when the run is allowed to stop.
  // ${CLAUDE_PLUGIN_ROOT} is a plugin-markdown substitution, not a shell variable —
  // bash expands it to nothing. The artifact must stay portable (an absolute path
  // bakes in this machine and the plugin version), so the goal names it as a
  // placeholder to resolve rather than handing over a command that fails verbatim.
  const verifyStep = paths.verifyBin.startsWith('${')
    ? `Then run the ideation plugin's \`scripts/verify.mjs\` against \`${paths.dataPath}\` and leave its VERIFY line in the conversation. Resolve the plugin's install directory first — \`${paths.verifyBin}\` is a placeholder, not a shell variable, and bash will not expand it.`
    : `Then run \`node ${paths.verifyBin} ${paths.dataPath}\` and leave its VERIFY line in the conversation.`;

  return [
    `/goal Drive the ${d.projectName} contract (${d.slug}) to completion with /ideation:autopilot.`,
    ``,
    `1. Run \`/ideation:autopilot ${paths.contractPath}\`.${branch}`,
    `2. It dispatches a BACKGROUND workflow. Wait for the completion notification — never start a second autopilot run while one is in flight.`,
    `3. ${verifyStep} That line is the only evidence this goal is judged on.`,
    `4. If anything failed, fix the spec or the implementation and go back to step 1. Autopilot skips phases that already have commits.`,
    ``,
    `Done when the most recent VERIFY line reads fail=0 and commits=${phases}/${phases} — or when two consecutive VERIFY lines are identical and still failing, in which case name the failing checks and stop, because a contract whose checks have rotted must not trap the run.`,
  ].join('\n');
}

function sectionHdr(title: string, count?: string): string {
  return `      <div class="section-hdr">
        <span class="label">${esc(title)}</span>
        <span class="section-hdr-rule"></span>${
          count
            ? `\n        <span class="section-count">${esc(count)}</span>`
            : ''
        }
      </div>`;
}

// --- Pipeline DAG ---

/** Wave (column) per phase: longest prereq chain depth.
    When no phase declares prereqs, the plan is an implicit sequential chain. */
function computeWaves(phases: Phase[]): number[] {
  const anyPrereqs = phases.some(p => p.prereqs && p.prereqs.length > 0);
  if (!anyPrereqs) return phases.map((_, i) => i);

  const byTitle = new Map(phases.map((p, i) => [p.title, i] as const));
  const depth: number[] = new Array(phases.length).fill(-1);
  const visit = (i: number, stack: Set<number>): number => {
    if (depth[i] >= 0) return depth[i];
    if (stack.has(i)) return 0; // cycle guard: treat as root
    stack.add(i);
    const prereqIdx = (phases[i].prereqs ?? [])
      .map(t => byTitle.get(t))
      .filter((x): x is number => x !== undefined);
    depth[i] = prereqIdx.length
      ? 1 + Math.max(...prereqIdx.map(j => visit(j, stack)))
      : 0;
    stack.delete(i);
    return depth[i];
  };
  phases.forEach((_, i) => visit(i, new Set()));
  return depth;
}

const NODE_W = 200;
const NODE_H = 64;
const GAP_X = 64;
const GAP_Y = 16;
const PAD = 6;

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function buildPipeline(phases: Phase[], waves: number[]): string {
  const waveCount = Math.max(...waves) + 1;
  const rows: number[] = phases
    .map((_, i) => waves.slice(0, i).filter(w => w === waves[i]))
    .map(arr => arr.length);
  const maxRows = Math.max(...phases.map((_, i) => rows[i])) + 1;

  const x = (i: number) => PAD + waves[i] * (NODE_W + GAP_X);
  const y = (i: number) => PAD + rows[i] * (NODE_H + GAP_Y);
  const width = PAD * 2 + waveCount * NODE_W + (waveCount - 1) * GAP_X;
  const height = PAD * 2 + maxRows * NODE_H + (maxRows - 1) * GAP_Y;

  const byTitle = new Map(phases.map((p, i) => [p.title, i] as const));
  const anyPrereqs = phases.some(p => p.prereqs && p.prereqs.length > 0);
  const edges: Array<[number, number]> = [];
  if (anyPrereqs) {
    phases.forEach((p, i) => {
      for (const t of p.prereqs ?? []) {
        const j = byTitle.get(t);
        if (j !== undefined) edges.push([j, i]);
      }
    });
  } else {
    for (let i = 1; i < phases.length; i++) edges.push([i - 1, i]);
  }

  const edgePaths = edges
    .map(([from, to]) => {
      const x1 = x(from) + NODE_W;
      const y1 = y(from) + NODE_H / 2;
      const x2 = x(to) - 7; // leave room for the arrowhead
      const y2 = y(to) + NODE_H / 2;
      const mid = x1 + (x(to) - x1) / 2;
      const d =
        y1 === y2
          ? `M ${x1} ${y1} H ${x2}`
          : `M ${x1} ${y1} H ${mid} V ${y2} H ${x2}`;
      return `      <path class="edge" d="${d}" marker-end="url(#arrow)" />`;
    })
    .join('\n');

  const nodes = phases
    .map((p, i) => {
      const rm = riskMeta(p.risk ?? 'low');
      const nx = x(i);
      const ny = y(i);
      const isGate = p.kind === 'gate';
      return `      <g class="node${isGate ? ' node-gate' : ''}">
        <rect class="node-box" x="${nx}" y="${ny}" width="${NODE_W}" height="${NODE_H}" rx="5" />
        <line class="node-rail" x1="${nx + 1}" y1="${ny + 1.5}" x2="${nx + NODE_W - 1}" y2="${ny + 1.5}" stroke="${rm.color}" />
        <text class="node-num" x="${nx + 12}" y="${ny + 22}">${pad2(i + 1)}</text>
        <text class="node-kind" x="${nx + NODE_W - 12}" y="${ny + 22}" text-anchor="end" fill="${rm.color}">${rm.label}</text>
        <text class="node-title" x="${nx + 12}" y="${ny + 41}">${esc(truncate(p.title, 26))}</text>
        <text class="node-kind" x="${nx + 12}" y="${ny + 56}">${isGate ? 'gate' : 'phase'}${p.blocking ? ' · blocking' : ''}</text>
      </g>`;
    })
    .join('\n');

  const waveLabel = anyPrereqs
    ? `${waveCount} wave${waveCount === 1 ? '' : 's'}`
    : 'sequential';
  return `      <div class="panel pipeline-wrap">
        <svg class="pipeline" viewBox="0 0 ${width} ${height}" role="img" aria-label="Phase pipeline: ${esc(
          phases
            .map((p, i) => `${pad2(i + 1)} ${p.title} (wave ${waves[i] + 1})`)
            .join('; '),
        )} — ${waveLabel}">
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
              <path class="edge-head" d="M0,0 L10,5 L0,10 z" />
            </marker>
          </defs>
${edgePaths}
${nodes}
        </svg>
      </div>`;
}

// --- Section Builders ---

function buildHeader(d: ContractData): string {
  const dims = d.gates.dimensions;
  const open = dims.filter(dim => dim.status !== 'ready');
  const allReady = open.length === 0;
  const verdict = allReady
    ? 'All gates ready'
    : `${open.length} gate${open.length === 1 ? '' : 's'} open — interview ended early`;
  const statusClass = d.status === 'Approved' ? 'status-go' : 'status-caution';
  return `
    <header class="deck-header">
      <div class="deck-id">
        <div>
          <div class="deck-slug label">mission brief · ${esc(d.slug)}</div>
          <h1 class="deck-title">${esc(d.projectName)}</h1>
        </div>
        <div class="deck-meta">
          <span class="status-ind ${statusClass}"><span class="status-dot" aria-hidden="true"></span>${esc(d.status)}</span>
          ${d.approvalMode === 'express' ? `<span class="mono-meta">express · single-confirmation approval</span>` : ''}
          <span class="mono-meta">created ${esc(d.date)}</span>
          ${d.approvedOn ? `<span class="mono-meta">approved ${esc(d.approvedOn)}${d.approvedBy ? ` · ${esc(d.approvedBy)}` : ''}</span>` : ''}
          ${d.supersedes ? `<span class="mono-meta">supersedes ${esc(d.supersedes)}</span>` : ''}
          <button type="button" class="theme-toggle" id="theme-toggle">theme · auto</button>
        </div>
      </div>

      <div class="gate-verdict">
        <span class="label">Readiness gates</span>
        <span class="status-ind ${allReady ? 'status-go' : 'status-caution'}">${esc(verdict)}</span>
      </div>
      <div class="gate-strip">
${dims
  .map(
    dim => `        <div class="gate-cell">
          <span class="gate-mark" style="color: ${dim.status === 'ready' ? 'var(--go)' : 'var(--caution)'}">${dim.status === 'ready' ? '✓' : '✗'}</span>
          <span class="gate-name">${esc(dim.label)}</span>
          <span class="gate-evidence">${esc(dim.evidence)}</span>
        </div>`,
  )
  .join('\n')}
      </div>
    </header>`;
}

function buildFirstMove(d: ContractData): string {
  const phase = d.execution.phases[0];
  if (!phase || d.status === 'Draft') return '';
  const cmd = phaseCommand(phase, d.slug, 0);
  return `
    <section class="run-bar">
      <div>
        <div class="label label-accent">First move</div>
        <div class="run-bar-headline">Run this.</div>
        <div class="run-bar-desc">Phase 01 of ${pad2(d.execution.phases.length)} — <strong>${esc(phase.title)}</strong></div>
      </div>
      ${cmdField('cmd-first', cmd)}
    </section>`;
}

function buildProblemGoals(d: ContractData): string {
  return `
    <div class="section two-col">
      <section>
${sectionHdr('The problem')}
        <div class="prose">
${d.problem
  .map(
    (p, i) =>
      `          <p><span class="line-num">${pad2(i + 1)}</span>${esc(p)}</p>`,
  )
  .join('\n')}
        </div>
      </section>
      <section>
${sectionHdr('Goals', `×${d.goals.length}`)}
        <div class="goal-list">
${d.goals
  .map(
    (g, i) => `          <div class="goal-row">
            <span class="goal-num">${pad2(i + 1)}</span>
            <span class="goal-text">${esc(g)}</span>
          </div>`,
  )
  .join('\n')}
        </div>
      </section>
    </div>`;
}

function buildSuccess(d: ContractData): string {
  const criteria = d.successCriteria.map(asCriterion);
  const checked = criteria.filter(c => isCmd(c.check)).length;
  const countLabel =
    checked === criteria.length
      ? `${criteria.length} signals · all mechanically checked`
      : `${criteria.length} signals · ${checked} mechanically checked`;
  const body = (c: NormalizedCriterion): string => {
    if (isCmd(c.check)) {
      const { cmd, expect } = c.check;
      return [
        `<code class="criteria-check">${esc(cmd)}</code>`,
        expect ? `<span class="criteria-expect">expect: ${esc(expect)}</span>` : '',
      ]
        .filter(Boolean)
        .join('\n            ');
    }
    const note = isJudge(c.check) ? c.check.judgment : '';
    return [
      `<span class="criteria-judgment">judgment call${note ? '' : ' — no mechanical check'}</span>`,
      note ? `<span class="criteria-expect">${esc(note)}</span>` : '',
    ]
      .filter(Boolean)
      .join('\n            ');
  };
  return `
    <section class="section">
${sectionHdr('Done when', countLabel)}
      <ul class="criteria-grid">
${criteria
  .map(
    (c, i) => `        <li class="criteria-item">
          <span class="line-num">${pad2(i + 1)}</span>
          <div class="criteria-body">
            <span>${esc(c.criterion)}</span>
            ${body(c)}
          </div>
        </li>`,
  )
  .join('\n')}
      </ul>
    </section>`;
}

function buildScope(d: ContractData): string {
  const tierList = (title: string, items: ScopeItem[]) => {
    if (!items.length) return '';
    return `
          <div class="tier-group">
            <div class="tier-header">
              <span class="tier-title">${esc(title)}</span>
              <span class="tier-rule"></span>
              <span class="tier-count">×${items.length}</span>
            </div>
            <ul class="tier-items">
${items
  .map(
    it =>
      `              <li><strong>${esc(it.item)}</strong>${it.reason ? `<span class="tier-reason">— ${esc(it.reason)}</span>` : ''}</li>`,
  )
  .join('\n')}
            </ul>
          </div>`;
  };

  return `
    <section class="section">
${sectionHdr('Scope', 'MVP nests inside Full nests inside Stretch')}
      <div class="scope-layout">
        <div class="nested-tiers" aria-hidden="true">
          <div class="tier-box tier-box-stretch"><span class="tier-box-label">Stretch ×${d.scope.stretch.length}</span></div>
          <div class="tier-box tier-box-full"><span class="tier-box-label">Full ×${d.scope.full.length}</span></div>
          <div class="tier-box tier-box-mvp"><span class="tier-box-label">MVP ×${d.scope.mvp.length}</span></div>
        </div>
        <div class="tier-lists">
${tierList('MVP — must ship', d.scope.mvp)}
${tierList('Full — target outcome', d.scope.full)}
${tierList('Stretch — if time permits', d.scope.stretch)}
        </div>
      </div>

      <div class="two-col scope-extras">
        <div class="scope-panel scope-panel-out">
          <span class="label label-danger">Out of scope — said no on purpose</span>
          <ul class="scope-list">
${d.scope.outOfScope
  .map(
    it =>
      `            <li><span class="scope-out-item">${esc(it.item)}</span>${it.reason ? ` — ${esc(it.reason)}` : ''}</li>`,
  )
  .join('\n')}
          </ul>
        </div>
        <div class="scope-panel">
          <span class="label">Future — someday, maybe</span>
          <ul class="scope-list">
${d.scope.future.map(f => `            <li>${esc(f)}</li>`).join('\n')}
          </ul>
        </div>
      </div>
    </section>`;
}

function buildDecisionLog(d: ContractData): string {
  const items = Array.isArray(d.decisions) ? d.decisions : [];
  if (items.length === 0) return '';
  return `
    <section class="section">
${sectionHdr('Decisions considered and rejected', `×${items.length}`)}
      <ul class="tier-items">
${items
  .map(it => {
    const clause = [
      it.rejected ? `rejected: ${esc(it.rejected)}.` : '',
      it.reason ? esc(it.reason) : '',
    ]
      .filter(Boolean)
      .join(' ');
    return `        <li><strong>${esc(it.decision)}</strong>${clause ? `<span class="tier-reason">— ${clause}</span>` : ''}</li>`;
  })
  .join('\n')}
      </ul>
    </section>`;
}

function buildExecution(d: ContractData, paths: ContractPaths): string {
  const phases = d.execution.phases;
  const isDraft = d.status === 'Draft';

  if (!phases.length) {
    return `
    <section class="section">
${sectionHdr(isDraft ? 'Plan' : 'Execution', d.execution.strategy)}
      <p class="plan-placeholder">Phases are decided after approval.</p>
    </section>`;
  }

  const waves = computeWaves(phases);
  const pipeline = buildPipeline(phases, waves);

  const table = `      <div class="panel">
        <table class="phase-table">
          <thead>
            <tr>
              <th scope="col">##</th>
              <th scope="col">Phase</th>
              <th scope="col">Kind</th>
              <th scope="col">Risk</th>
              <th scope="col" class="phase-notes-col">Notes</th>
            </tr>
          </thead>
          <tbody>
${phases
  .map((p, i) => {
    const rm = riskMeta(p.risk ?? 'low');
    return `            <tr>
              <td class="phase-num">${pad2(i + 1)}</td>
              <td class="phase-title">${esc(p.title)}</td>
              <td class="phase-kind">${p.kind === 'gate' ? 'gate' : 'phase'}${p.blocking ? ' · blocking' : ''}</td>
              <td class="phase-risk" style="color: ${rm.color}">${rm.label}</td>
              <td class="phase-notes phase-notes-col">${p.notes ? esc(p.notes) : '—'}</td>
            </tr>`;
  })
  .join('\n')}
          </tbody>
        </table>
      </div>`;

  if (isDraft) {
    return `
    <section class="section">
${sectionHdr('Plan', d.execution.strategy)}
${pipeline}
${table}

      <div class="approval-bar">
        <span class="status-ind status-caution"><span class="status-dot" aria-hidden="true"></span>Awaiting approval</span>
        <div class="approval-desc">Approve this contract in the session. Specs are then generated per phase, and this brief regenerates with its run commands.</div>
      </div>
    </section>`;
  }

  return `
    <section class="section">
${sectionHdr('Execution', d.execution.strategy)}
${pipeline}
${table}

      <div class="run-bar">
        <div>
          <div class="label label-accent">Run all phases</div>
          <div class="run-bar-headline">Autopilot.</div>
          <div class="run-bar-desc">Reads the contract, walks the dependency graph, and dispatches phases automatically.</div>
        </div>
        ${cmdField('cmd-autopilot', `/ideation:autopilot ${paths.contractPath}`)}
      </div>

      <details class="disclosure">
        <summary>Run it unattended (/goal)</summary>
        <div class="disclosure-body">
          <p class="run-bar-desc">A durability wrapper around autopilot: Claude re-checks this condition before it is allowed to stop, so a failed phase gets repaired and re-run instead of ending the session. Verified by <code>verify.mjs</code>, which reports on this contract only.</p>
          ${cmdField('cmd-goal', buildGoal(d, paths), true)}
        </div>
      </details>

      <details class="disclosure">
        <summary>Run phases individually (${phases.length})</summary>
        <div class="disclosure-body">
          <div class="cmd-list">
${phases
  .map((p, i) => {
    const cmd = phaseCommand(p, d.slug, i);
    return `            <div class="cmd-row">
              <span class="cmd-row-num">${pad2(i + 1)}</span>
              <span class="cmd-row-title">${esc(p.title)}</span>
              ${cmdField(`cmd-${i + 1}`, cmd)}
            </div>`;
  })
  .join('\n')}
          </div>
        </div>
      </details>
${
  d.execution.agentTeamPrompt
    ? `
      <details class="disclosure">
        <summary>Agent Team Prompt (parallel execution)</summary>
        <div class="disclosure-body">
          ${cmdField('agent-team-prompt', d.execution.agentTeamPrompt, true)}
        </div>
      </details>`
    : ''
}
    </section>`;
}

/** Closing approval band — the contract ends on the decision, not a footnote.
    Approval happens in the session; this records it (peak-end). */
function buildClose(d: ContractData): string {
  if (d.status !== 'Approved') return '';
  const phaseCount = d.execution.phases.length;
  const when = d.approvedOn ?? d.date;
  const expressNote =
    d.approvalMode === 'express'
      ? ' Express run — approved in one confirmation after the interview; review lives in the branch diff.'
      : '';
  return `
    <section class="contract-close">
      <div>
        <div class="label label-accent">Contract approved</div>
        <div class="close-headline">This plan is the commitment.</div>
        <div class="close-desc">${phaseCount} phase${phaseCount === 1 ? '' : 's'} · ${esc(d.execution.strategy)}. Scope changes mean a new revision that supersedes this brief — not silent drift.${expressNote}</div>
      </div>
      <div class="close-meta">
        <span class="status-ind status-go"><span class="status-dot" aria-hidden="true"></span>Approved</span>
        <span class="mono-meta">${esc(when)}${d.approvedBy ? ` · ${esc(d.approvedBy)}` : ''}</span>
      </div>
    </section>`;
}

// --- Markdown Builders ---
//
// contract.md is the generator's second output (via --md-output): the same
// ContractData rendered in the hand-authored structure the repo's existing
// contracts use (skills/ideation/references/contract-template.md documents
// it). The structure is a deliberate legacy compatibility contract —
// autopilot's fallback parser (when contract-data.json is absent) reads the
// Execution Plan's graph and /ideation:execute-spec lines plus the
// **Approval** header line, and get-goal-prompt uses the file as a locator
// and name source. A parallel composer, not a transform of the HTML: both
// consume the same `d`, section order stays identical to generate().
// Markdown needs no escaping; esc() is HTML-specific — do not reuse it.

function mdHeader(d: ContractData): string {
  const dims = d.gates.dimensions;
  const open = dims.filter(dim => dim.status !== 'ready');
  const readiness =
    open.length === 0
      ? `All ${dims.length} gates ready`
      : `${open.length} gate${open.length === 1 ? '' : 's'} open: ${open
          .map(dim => dim.label)
          .join(', ')} — interview ended early`;
  const approval =
    d.approvalMode === 'express'
      ? 'Express — single consolidated confirmation, no per-artifact review'
      : 'Interactive review';
  return [
    `# ${d.projectName} Contract`,
    '',
    `**Created**: ${d.date}`,
    `**Readiness**: ${readiness}`,
    `**Status**: ${d.status}`,
    `**Approval**: ${approval}`,
    `**Supersedes**: ${d.supersedes ?? 'None'}`,
  ].join('\n');
}

function mdProblem(d: ContractData): string {
  return ['## Problem Statement', '', d.problem.join('\n\n')].join('\n');
}

function mdGoals(d: ContractData): string {
  return [
    '## Goals',
    '',
    ...d.goals.map((g, i) => `${i + 1}. ${g}`),
  ].join('\n');
}

function mdCriteria(d: ContractData): string {
  return [
    '## Success Criteria',
    '',
    ...d.successCriteria.map(asCriterion).map(c => {
      if (isCmd(c.check)) {
        const expect = c.check.expect ? ` → ${c.check.expect}` : '';
        return `- [ ] ${c.criterion} — check: \`${c.check.cmd}\`${expect}`;
      }
      const note = isJudge(c.check) ? c.check.judgment : '';
      return `- [ ] ${c.criterion} — judgment call${note ? `: ${note}` : ''}`;
    }),
  ].join('\n');
}

function mdScope(d: ContractData): string {
  const bullet = (it: ScopeItem) =>
    `- ${it.item}${it.reason ? ` — ${it.reason}` : ''}`;
  const list = (items: string[]) => (items.length ? items : ['- None.']);
  const inScope = [...d.scope.mvp, ...d.scope.full, ...d.scope.stretch];
  return [
    '## Scope Boundaries',
    '',
    '### In Scope',
    '',
    ...list(inScope.map(bullet)),
    '',
    '### Out of Scope',
    '',
    ...list(d.scope.outOfScope.map(bullet)),
    '',
    '### Future Considerations',
    '',
    ...list(d.scope.future.map(f => `- ${f}`)),
  ].join('\n');
}

function mdDecisions(d: ContractData): string {
  const items = Array.isArray(d.decisions) ? d.decisions : [];
  // Absence must be explicit — an executor must be able to distinguish
  // "nothing considered" from "section missing" (spec-template rule).
  const body = items.length
    ? items.map(it => {
        const clause = it.rejected ? `rejected: ${it.rejected}. ` : '';
        return `- **${it.decision}** — ${clause}${it.reason}`;
      })
    : ['None recorded.'];
  return ['## Decisions Considered and Rejected', '', ...body].join('\n');
}

/** ASCII dependency graph. Mirrors buildPipeline's edge semantics: declared
    prereqs, or an implicit sequential chain when no phase declares any.
    Multi-parent phases render under their first prereq; the annotation names
    every prereq — autopilot's fallback parser derives blocking relationships
    from these `(blocked by …)` annotations. */
function mdDependencyGraph(phases: Phase[]): string {
  const anyPrereqs = phases.some(p => p.prereqs && p.prereqs.length > 0);
  const byTitle = new Map(phases.map((p, i) => [p.title, i] as const));
  const prereqsOf = (i: number): number[] => {
    if (!anyPrereqs) return i > 0 ? [i - 1] : [];
    return (phases[i].prereqs ?? [])
      .map(t => byTitle.get(t))
      .filter((x): x is number => x !== undefined);
  };
  const children: number[][] = phases.map(() => []);
  phases.forEach((_, i) => {
    const parents = prereqsOf(i);
    if (parents.length) children[parents[0]].push(i);
  });

  const lines: string[] = [];
  const visited = new Set<number>();
  const render = (i: number, depth: number, isLast: boolean): void => {
    if (visited.has(i)) return;
    visited.add(i);
    const parents = prereqsOf(i);
    const note = parents.length
      ? `  (blocked by ${parents.map(j => phases[j].title).join(', ')})`
      : '';
    const prefix =
      depth === 0
        ? ''
        : `  ${'      '.repeat(depth - 1)}${isLast ? '└── ' : '├── '}`;
    lines.push(`${prefix}${phases[i].title}${note}`);
    children[i].forEach((k, idx, kids) =>
      render(k, depth + 1, idx === kids.length - 1),
    );
  };
  phases.forEach((_, i) => {
    if (prereqsOf(i).length === 0) render(i, 0, true);
  });
  // Cycle guard: anything unreachable from a root still renders, at root level.
  phases.forEach((_, i) => render(i, 0, true));

  return ['### Dependency Graph', '', '```', ...lines, '```'].join('\n');
}

function mdExecutionSteps(d: ContractData, paths: ContractPaths): string {
  const phaseLines = d.execution.phases.flatMap((p, i) => {
    const marker = p.blocking
      ? ' _(blocking)_'
      : p.prereqs?.length
        ? ` _(blocked by ${p.prereqs.join(', ')})_`
        : '';
    return [
      `${i + 1}. **Phase ${i + 1}** — ${p.title}${marker}`,
      '',
      '   ```bash',
      `   ${phaseCommand(p, d.slug, i)}`,
      '   ```',
      '',
    ];
  });
  return [
    '### Execution Steps',
    '',
    '**Run the project** (recommended) — autopilot reads this contract, plans dependency waves, runs independent phases in parallel, and gates on failure:',
    '',
    '```bash',
    `/ideation:autopilot ${paths.contractPath}`,
    '```',
    '',
    '**Or run it unattended** — a `/goal` is a durability wrapper around the same autopilot run: Claude re-checks the condition before it is allowed to stop, so failures get repaired and re-run. Generated by `contract-gen --print-goal`; this is the only copy of that string:',
    '',
    '```',
    buildGoal(d, paths),
    '```',
    '',
    '**Or run phases manually** in dependency order:',
    '',
    `**Strategy**: ${d.execution.strategy}`,
    '',
    ...phaseLines,
  ]
    .join('\n')
    .replace(/\n+$/, '');
}

function mdExecutionPlan(d: ContractData, paths: ContractPaths): string {
  const parts = [
    '## Execution Plan',
    '',
    '_Added during Phase 5 handoff. Pick up this contract cold and know exactly how to execute._',
  ];
  if (!d.execution.phases.length) {
    parts.push('', 'Phases are decided after approval.');
    return parts.join('\n');
  }
  parts.push(
    '',
    mdDependencyGraph(d.execution.phases),
    '',
    mdExecutionSteps(d, paths),
  );
  if (d.execution.agentTeamPrompt) {
    parts.push(
      '',
      '### Agent Team Prompt',
      '',
      '```',
      d.execution.agentTeamPrompt,
      '```',
    );
  }
  return parts.join('\n');
}

function buildMarkdown(d: ContractData, paths: ContractPaths): string {
  const sections = [
    mdHeader(d),
    mdProblem(d),
    mdGoals(d),
    mdCriteria(d),
    mdScope(d),
    mdDecisions(d),
    mdExecutionPlan(d, paths),
    '---',
    '_This contract was generated from brain dump input. Review and approve before proceeding to specification._',
  ];
  return `${sections.join('\n\n')}\n`;
}

// --- Main Template ---

function generate(data: ContractData, paths: ContractPaths): string {
  const d = data;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(d.projectName)} — Mission Brief</title>
    <script>
      // Apply a saved forced theme before first paint to avoid a flash
      try {
        const saved = localStorage.getItem('ideation-contract-theme');
        if (saved === 'light' || saved === 'dark')
          document.documentElement.dataset.theme = saved;
      } catch {}
    </script>
    <style>
${CSS}
    </style>
  </head>
  <body data-contract-status="${esc(d.status)}">
${buildHeader(d)}
    <main>
${buildFirstMove(d)}
${buildProblemGoals(d)}
${buildSuccess(d)}
${buildScope(d)}
${buildDecisionLog(d)}
${buildExecution(d, paths)}
${buildClose(d)}
    </main>

    <script>
      document.querySelectorAll('.copy-btn').forEach(btn => {
        // aria-live so the copied/failed text swap is announced
        btn.setAttribute('aria-live', 'polite');
        btn.addEventListener('click', () => {
          const target = document.getElementById(btn.dataset.copy);
          if (!target) return;
          const flash = label => {
            btn.textContent = label;
            setTimeout(() => (btn.textContent = 'copy'), 2000);
          };
          navigator.clipboard
            .writeText(target.textContent.trim())
            .then(() => flash('copied'))
            // file:// or denied permission — the text is select-all, so
            // point at the manual path instead of failing silently
            .catch(() => flash('press ⌘C / Ctrl+C'));
        });
      });

      /* === THEME TOGGLE (auto → light → dark) === */
      const themeBtn = document.getElementById('theme-toggle');
      if (themeBtn) {
        const KEY = 'ideation-contract-theme';
        const root = document.documentElement;
        const apply = mode => {
          if (mode === 'auto') delete root.dataset.theme;
          else root.dataset.theme = mode;
          themeBtn.textContent = 'theme · ' + mode;
          try {
            if (mode === 'auto') localStorage.removeItem(KEY);
            else localStorage.setItem(KEY, mode);
          } catch {}
        };
        apply(root.dataset.theme || 'auto');
        themeBtn.addEventListener('click', () => {
          const order = ['auto', 'light', 'dark'];
          const current = root.dataset.theme || 'auto';
          apply(order[(order.indexOf(current) + 1) % order.length]);
        });
      }
    </script>
  </body>
</html>
`;
}

// --- CLI ---

const { values } = parseArgs({
  options: {
    input: { type: 'string', short: 'i' },
    output: { type: 'string', short: 'o' },
    'md-output': { type: 'string' },
    'print-goal': { type: 'boolean' },
  },
});

if (!values.input) {
  console.error(
    'Usage: contract-gen.ts --input <data.json> --output <contract.html> [--md-output <contract.md>]\n' +
      '  --md-output also emits the Markdown contract and declares generator\n' +
      '  ownership of both representations: lineage then archives the html+md\n' +
      '  pair together — including a pre-existing hand-authored sibling md.\n' +
      '  --print-goal prints the /goal command for this contract and exits,\n' +
      '  writing nothing.',
  );
  process.exit(1);
}

const raw = readFileSync(values.input, 'utf8');
const parsed = JSON.parse(raw) as Record<string, unknown>;

if (!('gates' in parsed) && 'confidence' in parsed) {
  console.error(
    'contract-data.json uses the pre-gate `confidence` schema; regenerate via ideation to produce the `gates` schema.',
  );
  process.exit(1);
}

const data = parsed as unknown as ContractData;
const paths = contractPaths(data, values.input);

// Render-time rejection of prose in the executable slot. Errors are collected
// and reported together — one fix pass, not one per run — and name the
// criterion index so the field is findable in contract-data.json.
// This runs BEFORE the --print-goal exit: the goal's done-when delegates to
// verify.mjs, so handing out a goal for a contract whose cmd slot holds prose
// promises that prose will be executed unattended.
const normalized = (data.successCriteria ?? []).map(asCriterion);
const checkErrors = normalized
  .map((c, i) => {
    const err = validateCheck(c.check);
    return err ? `  successCriteria[${i}] (${c.criterion}): ${err}` : '';
  })
  .filter(Boolean);

// EARLY EXIT, and it must stay above everything below it: mkdir, the lineage
// rename, and the writes are all side effects. Merely asking for the goal
// string must never rewrite the user's contract.
if (values['print-goal']) {
  if (checkErrors.length) {
    console.error(
      `Refusing to print a /goal: ${checkErrors.length} unrunnable check${checkErrors.length === 1 ? '' : 's'}.\n` +
        `${checkErrors.join('\n')}\n` +
        '  This goal is judged by scripts/verify.mjs, which would execute these.',
    );
    process.exit(1);
  }
  console.log(buildGoal(data, paths));
  process.exit(0);
}

if (checkErrors.length) {
  console.error(
    `contract-data.json has ${checkErrors.length} unrunnable check${checkErrors.length === 1 ? '' : 's'}:\n` +
      `${checkErrors.join('\n')}\n` +
      '  A check is either { "cmd": "…", "expect": "…" } that a shell can run\n' +
      '  unattended, or { "judgment": "who looks at what" }. Prose in the cmd\n' +
      '  slot gets executed by scripts/verify.mjs.',
  );
  process.exit(1);
}

const outputPath = values.output ?? `contract.html`;
const outputDir = dirname(outputPath);

if (outputDir && !existsSync(outputDir)) {
  mkdirSync(outputDir, { recursive: true });
}

/** First free lineage path: base-{date}.ext, then base-{date}-2.ext, -3, ... */
function nextLineagePath(
  dir: string,
  base: string,
  date: string,
  ext: string,
): string {
  for (let n = 1; ; n++) {
    const candidate = join(
      dir,
      `${base}-${date}${n === 1 ? '' : `-${n}`}${ext}`,
    );
    if (!existsSync(candidate)) return candidate;
  }
}

if (existsSync(outputPath)) {
  const existing = readFileSync(outputPath, 'utf8');
  // A Draft being overwritten is the same contract still converging
  // (interview revisions, the same-session Draft→Approved flip) — replace it
  // in place. Only Approved contracts are commitments worth a lineage
  // snapshot. Files generated before the status attribute existed fall
  // through to the snapshot path.
  if (/data-contract-status="Draft"/.test(existing)) {
    console.log('Replacing Draft contract in place (no lineage snapshot)');
  } else {
    const dateMatch = existing.match(/(\d{4}-\d{2}-\d{2})/);
    const existingDate = dateMatch?.[1] ?? 'unknown';
    const htmlMtime = statSync(outputPath).mtimeMs;
    const renamedPath = nextLineagePath(
      outputDir,
      basename(outputPath, '.html'),
      existingDate,
      '.html',
    );
    const renamedBase = basename(renamedPath);
    renameSync(outputPath, renamedPath);

    // With --md-output the generator owns both representations: the html+md
    // pair came from the same run, so archive them together — the mtime
    // comparison below is meaningless when both files are seconds apart, and
    // the flag declares generator ownership even of a pre-existing
    // hand-authored md. Without the flag, legacy behavior: archive the
    // sibling .md only if it belongs to the superseded revision — an .md
    // newer than the .html being archived was written for the NEW revision
    // and must stay in place.
    const mdPath = outputPath.replace(/\.html$/, '.md');
    const mdBelongsToArchived =
      values['md-output'] !== undefined ||
      (existsSync(mdPath) && statSync(mdPath).mtimeMs <= htmlMtime);
    if (existsSync(mdPath) && mdBelongsToArchived) {
      renameSync(
        mdPath,
        nextLineagePath(
          outputDir,
          basename(mdPath, '.md'),
          existingDate,
          '.md',
        ),
      );
    }

    if (!data.supersedes) {
      data.supersedes = renamedBase;
    }

    console.log(`Renamed existing contract to ${renamedBase}`);
  }
}

const html = generate(data, paths);
writeFileSync(outputPath, html, 'utf8');
console.log(`Generated ${outputPath} (${html.length} bytes)`);

// The verifiability count, printed rather than eyeballed. Routing decisions
// that used to read "most criteria are checkable" have a number to read.
console.log(summarizeCriteria(normalized).line);

// After the lineage pass on purpose: `data.supersedes` may have been set
// above, and the md must record the same lineage the html does.
if (values['md-output']) {
  const mdOutputDir = dirname(values['md-output']);
  if (mdOutputDir && !existsSync(mdOutputDir)) {
    mkdirSync(mdOutputDir, { recursive: true });
  }
  const md = buildMarkdown(data, paths);
  writeFileSync(values['md-output'], md, 'utf8');
  console.log(`Generated ${values['md-output']} (${md.length} bytes)`);
}
