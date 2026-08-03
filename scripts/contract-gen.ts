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
  adviseRunMode,
  committablePhases,
  isJudgment,
  isStaticCheck,
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

interface OpenQuestion {
  /** Stable kebab-case id; other entries point at it in blockedBy */
  id: string;
  /** The question, phrased precisely enough to hand to someone else as-is */
  question: string;
  /** Which gate stays open until this closes — a gates.dimensions key */
  gate: string;
  /** How it closes: an Explore agent, a spike, an AskUserQuestion, or
      out-of-band work a human has to go do */
  type: 'research' | 'prototype' | 'decision' | 'task';
  /** Ids of entries that must close first. Absent = takeable now. */
  blockedBy?: string[];
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
  /** Files this phase claims. The engine reads it twice — to serialise phases
      that would collide inside one wave (splitWavesByFileOverlap) and as the
      commit stage's fallback list of what to stage when the builder reports
      no filesChanged. It also logs a WARN for every fileless phase dispatched
      into a parallel wave.

      This is NOT the engine's source of truth. autopilot builds the dispatch
      manifest by extracting every path from each spec's File Changes tables
      (skills/autopilot/SKILL.md, "Populate `files` from each spec's File
      Changes table"), so a contract that omits the field can still be
      serialised correctly. The field is here because contract-data.json may
      carry it — the memory-and-retrieval contract does, on all five phases —
      and a plan that names what it touches should render that. Where the two
      disagree, the run follows the specs, not this page. */
  files?: string[];
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
  /** Gates the interview could not close, each naming the out-of-band work
      that would close it. Absent or empty = section suppressed. */
  openQuestions?: OpenQuestion[];
  execution: {
    strategy: string;
    phases: Phase[];
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

function cmdField(id: string, cmd: string, block = false): string {
  return `<div class="cmd${block ? ' cmd-block' : ''}">
            <span class="cmd-text" id="${id}">${esc(cmd)}</span>
            <button type="button" class="copy" data-copy="${id}">copy</button>
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

/** Section head: a serif heading, an optional deck of one sentence, and an
    optional right-aligned count. Deliberately NOT a tracked uppercase eyebrow
    — those are reserved here for labels on measurements. */
function secHead(
  id: string,
  title: string,
  sub?: string,
  count?: string,
): string {
  return `      <div class="sec-head">
        <div>
          <h2 id="${id}-h">${esc(title)}</h2>${
            sub ? `\n          <p class="sec-sub">${sub}</p>` : ''
          }
        </div>${
          count ? `\n        <span class="sec-count">${esc(count)}</span>` : ''
        }
      </div>`;
}

/** `<section>` wrapper: one band of the document. */
function band(
  id: string,
  inner: string,
  opts: { wash?: boolean } = {},
): string {
  return `
    <section class="band${opts.wash ? ' band-wash' : ''}" id="${id}" aria-labelledby="${id}-h">
      <div class="wrap">
${inner}
      </div>
    </section>`;
}

// --- Derived facts -------------------------------------------------------
//
// Everything the page states about itself is computed once, here, so a
// figure in the flight strip and the sentence that explains it downstream can
// never drift apart.

type Advice = ReturnType<typeof adviseRunMode>;

interface Facts {
  phases: Phase[];
  waves: number[];
  waveCount: number;
  /** Prereqs were declared, so the wave columns mean something. */
  explicitGraph: boolean;
  /** Any phase claims files, so file-overlap serialisation is actually live. */
  anyFiles: boolean;
  /** Phases expected to leave a commit — verify.mjs's own filter. */
  committable: number;
  risk: { high: number; medium: number; low: number };
  criteria: NormalizedCriterion[];
  cmdCount: number;
  judgmentCount: number;
  staticCount: number;
  scopeCommitted: number;
  gatesReady: number;
  gatesTotal: number;
  advice: Advice;
  /** Phases whose failure strands work downstream, with what gets stranded. */
  chokepoints: Array<{ title: string; index: number; blocks: string[] }>;
}

function deriveFacts(d: ContractData): Facts {
  const phases = d.execution.phases ?? [];
  const waves = computePhaseDepths(phases);
  const criteria = (d.successCriteria ?? []).map(asCriterion);
  const cmds = criteria.filter(c => isCmd(c.check));
  const risk = { high: 0, medium: 0, low: 0 };
  for (const p of phases) risk[p.risk ?? 'low']++;

  // Transitive dependents of each phase — the concrete cost of a failure. Uses
  // declared prereqs; with none declared the plan is an implicit chain, so
  // everything after a phase is downstream of it.
  const anyPrereqs = phases.some(p => p.prereqs?.length);
  const byTitle = new Map(phases.map((p, i) => [p.title, i] as const));
  const directDeps = phases.map((_, i) =>
    phases
      .map((p, j) => {
        if (i === j) return -1;
        if (!anyPrereqs) return j === i + 1 ? j : -1;
        return (p.prereqs ?? []).some(t => byTitle.get(t) === i) ? j : -1;
      })
      .filter(j => j >= 0),
  );
  const downstream = (i: number): string[] => {
    const seen = new Set<number>();
    const stack = [...directDeps[i]];
    while (stack.length) {
      const j = stack.pop() as number;
      if (seen.has(j)) continue;
      seen.add(j);
      stack.push(...directDeps[j]);
    }
    return [...seen].sort((a, b) => a - b).map(j => phases[j].title);
  };
  const chokepoints = phases
    .map((p, index) => ({ title: p.title, index, blocks: downstream(index) }))
    .filter(c => c.blocks.length > 0);

  return {
    phases,
    waves,
    waveCount: phases.length ? Math.max(...waves) + 1 : 0,
    explicitGraph: anyPrereqs,
    anyFiles: phases.some(p => (p.files ?? []).length > 0),
    committable: committablePhases(d).length,
    risk,
    criteria,
    cmdCount: cmds.length,
    judgmentCount: criteria.length - cmds.length,
    staticCount: cmds.filter(c => isCmd(c.check) && isStaticCheck(c.check.cmd))
      .length,
    scopeCommitted:
      d.scope.mvp.length + d.scope.full.length + d.scope.stretch.length,
    gatesReady: d.gates.dimensions.filter(g => g.status === 'ready').length,
    gatesTotal: d.gates.dimensions.length,
    advice: adviseRunMode(d as never),
    chokepoints,
  };
}

// --- Masthead ------------------------------------------------------------

const THEME_ICONS = `<svg class="i-auto" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="5"/><path d="M8 3v10" /><path d="M8 3a5 5 0 010 10z" fill="currentColor" stroke="none"/></svg>
      <svg class="i-light" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="3.1"/><path d="M8 1v1.6M8 13.4V15M15 8h-1.6M2.6 8H1M12.9 3.1l-1.1 1.1M4.2 11.8l-1.1 1.1M12.9 12.9l-1.1-1.1M4.2 4.2L3.1 3.1"/></svg>
      <svg class="i-dark" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M13.4 9.8A5.8 5.8 0 016.2 2.6a5.8 5.8 0 107.2 7.2z"/></svg>`;

function buildRunhead(d: ContractData, f: Facts, paths: ContractPaths): string {
  const links: Array<[string, string]> = [
    ['readiness', 'Readiness'],
    ['brief', 'Brief'],
    ['scope', 'Scope'],
    ['plan', 'Plan'],
    ['run-model', 'Run model'],
    ['done', 'Done when'],
  ];
  if ((d.decisions ?? []).length) links.push(['decisions', 'Decisions']);
  if ((d.openQuestions ?? []).length)
    links.push(['open-questions', 'Open questions']);
  // No "Run it" entry: nothing ever carried `id="run"`, and the run commands
  // live in the `run-model` band that already has its own link above. Pointing
  // this at the sticky header instead just scrolled the reader back to the top.
  const canRun = d.status === 'Approved' && f.phases.length > 0;
  return `    <div class="runhead" id="runhead" data-visible="false">
      <div class="wrap runhead-inner">
        <span class="runhead-name">${esc(d.projectName)}</span>
        <nav class="runhead-nav" aria-label="Contract sections">
${links
  .map(([id, label]) => `          <a href="#${id}">${esc(label)}</a>`)
  .join('\n')}
        </nav>${
          canRun
            ? `\n        <button type="button" class="runhead-run" data-copy-text="${esc(primaryCommand(d, f, paths))}">copy run command</button>`
            : ''
        }
      </div>
    </div>`;
}

/** One sentence stating what this contract commits to, assembled from its own
    numbers. The reader should not have to scroll 6,000px to learn the shape. */
function ledeFor(d: ContractData, f: Facts): string {
  if (!f.phases.length) {
    return `A <strong>${esc(d.status.toLowerCase())}</strong> contract awaiting its execution plan. ${f.scopeCommitted} committed scope item${f.scopeCommitted === 1 ? '' : 's'}, ${f.criteria.length} success criteri${f.criteria.length === 1 ? 'on' : 'a'}.`;
  }
  // Gates are human checkpoints, not build phases — counting them together
  // overstates the work and misnumbers it against spec-phase-N.md.
  const gates = f.phases.length - f.committable;
  const built = `<strong>${f.committable} build phase${f.committable === 1 ? '' : 's'}</strong>${gates ? ` plus ${gates} human gate${gates === 1 ? '' : 's'}` : ''}`;
  const shape = f.explicitGraph
    ? `${built} across ${f.waveCount} dependency wave${f.waveCount === 1 ? '' : 's'}`
    : `${built}, run in order`;
  return `${shape}, delivering ${f.scopeCommitted} committed scope item${f.scopeCommitted === 1 ? '' : 's'}. Completion is decided by <strong>${f.cmdCount} of ${f.criteria.length}</strong> criteria a machine can check${f.judgmentCount ? ` and ${f.judgmentCount} a human must` : ''}.`;
}

function buildMasthead(d: ContractData, f: Facts): string {
  const stampClass = d.status === 'Approved' ? 'is-go' : 'is-caution';
  return `
    <header class="band masthead" id="top">
      <div class="wrap">
        <div class="masthead-top">
          <div>
            <div class="masthead-slug">
              <span class="masthead-mark" aria-hidden="true"></span>
              <span class="kicker">contract · ${esc(d.slug)}</span>
            </div>
            <h1>${esc(d.projectName)}</h1>
          </div>
          <div class="masthead-aside">
            <span class="stamp ${stampClass}">${esc(d.status)}</span>
            <div class="masthead-dates">
              <span class="meta">drafted ${esc(d.date)}</span>${
                d.approvedOn
                  ? `\n              <span class="meta">approved ${esc(d.approvedOn)}${d.approvedBy ? ` · ${esc(d.approvedBy)}` : ''}</span>`
                  : ''
              }${
                d.approvalMode === 'express'
                  ? `\n              <span class="meta">express · one confirmation</span>`
                  : ''
              }${
                d.branch
                  ? `\n              <span class="meta">branch ${esc(d.branch)}</span>`
                  : ''
              }${
                d.supersedes
                  ? `\n              <span class="meta">supersedes ${esc(d.supersedes)}</span>`
                  : ''
              }
            </div>
            <button type="button" class="theme-toggle" id="theme-toggle" data-mode="auto" aria-label="Colour theme: follow system">
      ${THEME_ICONS}
            </button>
          </div>
        </div>
        <p class="masthead-lede">${ledeFor(d, f)}</p>
${buildFlightStrip(d, f)}
      </div>
    </header>`;
}

/** The measurements that decide whether you hand this to a machine, drawn to
    scale where a proportion exists. Reading these five is meant to be enough
    to know whether to read the rest. */
function buildFlightStrip(d: ContractData, f: Facts): string {
  const cell = (
    label: string,
    figure: string,
    note: string,
    extra = '',
  ): string => `          <div class="fs-cell">
            <span class="kicker">${esc(label)}</span>
            <span class="fs-figure">${figure}</span>
            <span class="fs-note">${note}</span>${extra ? `\n            ${extra}` : ''}
          </div>`;

  const cells: string[] = [];

  cells.push(
    cell(
      'gates',
      `<span class="num">${f.gatesReady}</span><span class="fs-of">/${f.gatesTotal}</span>`,
      f.gatesReady === f.gatesTotal
        ? 'ready — the interview closed every gate'
        : `${f.gatesTotal - f.gatesReady} open — the interview ended early`,
      `<div class="meter" aria-hidden="true">${d.gates.dimensions
        .map(g => `<span class="${g.status === 'ready' ? 'on' : ''}"></span>`)
        .join('')}</div>`,
    ),
  );

  if (f.phases.length) {
    cells.push(
      cell(
        'phases',
        `<span class="num">${pad2(f.phases.length)}</span>`,
        f.explicitGraph
          ? `${f.waveCount} dependency wave${f.waveCount === 1 ? '' : 's'} · ${f.committable} expected to commit`
          : `run in order · ${f.committable} expected to commit`,
      ),
    );
  }

  cells.push(
    cell(
      'checkable',
      `<span class="num">${f.cmdCount}</span><span class="fs-of">/${f.criteria.length}</span>`,
      f.judgmentCount === 0
        ? 'every criterion runs unattended'
        : `${f.judgmentCount} ${f.judgmentCount === 1 ? 'needs' : 'need'} a human to look`,
      `<div class="meter" aria-hidden="true">${f.criteria
        .map(
          c =>
            `<span class="${isCmd(c.check) ? (isStaticCheck(c.check.cmd) ? 'warn' : 'on') : ''}"></span>`,
        )
        .join('')}</div>`,
    ),
  );

  cells.push(
    cell(
      'scope',
      `<span class="num">${pad2(f.scopeCommitted)}</span>`,
      `${d.scope.mvp.length} MVP · ${d.scope.full.length} full · ${d.scope.stretch.length} stretch · ${d.scope.outOfScope.length} refused`,
    ),
  );

  if (f.phases.length) {
    const total = f.phases.length;
    const seg = (k: 'high' | 'medium' | 'low') =>
      f.risk[k]
        ? `<i class="r-${k}" style="width:${((f.risk[k] / total) * 100).toFixed(1)}%"></i>`
        : '';
    const parts = (['high', 'medium', 'low'] as const)
      .filter(k => f.risk[k])
      .map(k => `${f.risk[k]} ${k}`);
    // The figure is the count at the WORST level present, with that level as
    // its unit — a bare "1" next to "1 high · 2 medium · 1 low" says nothing.
    const worst = f.risk.high ? 'high' : f.risk.medium ? 'medium' : 'low';
    cells.push(
      cell(
        'risk',
        `<span class="num">${f.risk[worst]}</span><span class="fs-of">${worst}</span>`,
        // Gates carry a risk rating but are not build phases, so "of N phases"
        // overstates the work whenever one is present.
        `of ${total} ${total > f.committable ? 'plan item' : 'phase'}${total === 1 ? '' : 's'} · ${parts.join(' · ')}`,
        `<div class="riskbar" aria-hidden="true">${seg('high')}${seg('medium')}${seg('low')}</div>`,
      ),
    );
  }

  return `        <div class="flightstrip">
${cells.join('\n')}
        </div>`;
}

// --- Readiness -----------------------------------------------------------

function buildReadiness(
  d: ContractData,
  f: Facts,
  paths: ContractPaths,
): string {
  const open = d.gates.dimensions.filter(g => g.status !== 'ready');
  const sub =
    open.length === 0
      ? 'Every dimension the interview probes closed with evidence. Each cell below is what closed it.'
      : `The interview ended before ${open.length} dimension${open.length === 1 ? '' : 's'} closed. Read the open cells first — they are where this plan is guessing.`;

  const gates = `      <div class="gates">
${d.gates.dimensions
  .map(
    g => `        <div class="gate">
          <span class="gate-mark ${g.status === 'ready' ? 'is-go' : 'is-caution'}" aria-hidden="true">${g.status === 'ready' ? '✓' : '✗'}</span>
          <span class="gate-name">${esc(g.label)} <span class="sr-only">— ${g.status === 'ready' ? 'ready' : 'not ready'}</span></span>
          <span class="gate-ev">${esc(g.evidence)}</span>
        </div>`,
  )
  .join('\n')}
      </div>`;

  return band(
    'readiness',
    `${secHead('readiness', 'Is this ready to hand over?', sub, `${f.gatesReady}/${f.gatesTotal} ready`)}
${gates}
${buildAdvice(d, f, paths)}`,
  );
}

/** verify.mjs's adviseRunMode(), rendered. The routing verdict has always been
    derivable from this contract; printing it here is the difference between a
    decision the reader can audit and one that scrolled out of a transcript. */
function buildAdvice(d: ContractData, f: Facts, paths: ContractPaths): string {
  if (!f.phases.length) return '';
  const a = f.advice;
  const copy: Record<string, { title: string; gloss: string }> = {
    'walk-away': {
      title: 'Safe to walk away',
      gloss:
        'The checks are mechanical enough that verify.mjs can certify completion without you. Start it, leave, and read the VERIFY line when it lands.',
    },
    watch: {
      title: 'Stay at the desk',
      gloss:
        'Something here needs a human at the failure gate. Run it, but do not leave the session — a green result would not mean what you want it to mean.',
    },
    'run-spec': {
      title: 'Skip the orchestration',
      gloss:
        'Wave planning, parallel dispatch, and skip propagation have nothing to do at this size. Run the one spec directly and save the overhead.',
    },
  };
  const c = copy[a.mode] ?? copy.watch;
  const tone =
    a.mode === 'walk-away' ? 'is-go' : a.mode === 'watch' ? 'is-caution' : 'is-accent';
  const marks: Record<string, string> = { ok: '✓', no: '✗', warn: '!' };

  return `
      <div class="advice" data-few="${a.reasons.length < 3}" style="margin-top: var(--s5)">
        <div class="advice-verdict">
          <span class="stamp ${tone}">${esc(a.mode)}</span>
          <span class="advice-mode">${esc(c.title)}</span>
          <span class="advice-gloss">${esc(c.gloss)}</span>
          <span class="meta">${esc(a.line)}</span>
        </div>
        <ul class="advice-reasons">
${a.reasons
  .map(
    r => `          <li><span class="r-mark m-${r.mark}" aria-hidden="true">${marks[r.mark] ?? '·'}</span><span><span class="sr-only">${r.mark === 'ok' ? 'In favour: ' : r.mark === 'no' ? 'Against: ' : 'Caveat: '}</span>${esc(r.text)}</span></li>`,
  )
  .join('\n')}
        </ul>
      </div>${d.status === 'Approved' ? topRunbar(d, f, paths) : ''}`;
}

/** The action must agree with the verdict directly above it. On a one-phase
    contract the advisor says "skip the orchestration" — leading with
    `/ideation:autopilot` there told the reader to do the thing the sentence
    above had just argued against. */
function primaryCommand(
  d: ContractData,
  f: Facts,
  paths: ContractPaths,
): string {
  const only = f.phases.find(p => p.specPath && p.kind !== 'gate');
  return f.advice.mode === 'run-spec' && only
    ? phaseCommand(only, d.slug, f.phases.indexOf(only))
    : `/ideation:autopilot ${paths.contractPath}`;
}

function topRunbar(d: ContractData, f: Facts, paths: ContractPaths): string {
  const only = f.phases.find(p => p.specPath && p.kind !== 'gate');
  const runSpec = f.advice.mode === 'run-spec' && only;
  const head = runSpec
    ? {
        kicker: 'start here',
        title: 'Run the one spec.',
        body: `A single phase has no waves to plan, no dependents to gate, and nothing to resume past. <code>execute-spec</code> runs the same scout → build → review → commit loop without the orchestration around it.`,
        cmd: phaseCommand(only, d.slug, f.phases.indexOf(only)),
      }
    : {
        kicker: 'start here',
        title: 'Run the whole contract.',
        body: 'Autopilot reads this plan, orders the phases, and dispatches each one through the loop below. It skips phases that already have a commit, so re-running after a fix is safe.',
        cmd: `/ideation:autopilot ${paths.contractPath}`,
      };
  return `
      <div class="runbar" style="margin-top: var(--s5)">
        <div>
          <span class="kicker">${head.kicker}</span>
          <h3>${head.title}</h3>
          <p>${head.body}</p>
        </div>
        ${cmdField('cmd-top', head.cmd)}
      </div>`;
}

// --- Brief: problem & goals ----------------------------------------------

function buildProblemGoals(d: ContractData): string {
  return band(
    'brief',
    `${secHead(
      'brief',
      'What is wrong, and what would fix it',
      'The problem this contract exists to close, and the outcomes that would mean it closed.',
    )}
      <div class="split">
        <div class="prose">
${d.problem.map(p => `          <p>${esc(p)}</p>`).join('\n')}
        </div>
        <div>
          <div class="tier-hd">
            <h3>Goals</h3>
            <span class="hrule"></span>
            <span class="sec-count">×${d.goals.length}</span>
          </div>
          <ol class="goals">
${d.goals.map(g => `            <li>${esc(g)}</li>`).join('\n')}
          </ol>
        </div>
      </div>`,
  );
}

// --- Scope ---------------------------------------------------------------

function buildScope(d: ContractData, f: Facts): string {
  const tier = (key: string, title: string, items: ScopeItem[]) => {
    if (!items.length) return '';
    return `          <div class="tier-group" data-tier="${key}">
            <div class="tier-hd">
              <h3>${esc(title)}</h3>
              <span class="hrule"></span>
              <span class="sec-count">×${items.length}</span>
            </div>
            <ul class="items">
${items
  .map(
    it =>
      `              <li><strong>${esc(it.item)}</strong>${it.reason ? ` <span class="why">— ${esc(it.reason)}</span>` : ''}</li>`,
  )
  .join('\n')}
            </ul>
          </div>`;
  };

  const boundList = (items: string[], empty: string) =>
    items.length
      ? `<ul>\n${items.map(i => `            <li>${i}</li>`).join('\n')}\n          </ul>`
      : `<p class="bound-empty">${esc(empty)}</p>`;

  return band(
    'scope',
    `${secHead(
      'scope',
      'What is in, and what was refused',
      'MVP nests inside Full nests inside Stretch — each ring contains the one before it. Select a ring to isolate its items.',
      `${f.scopeCommitted} committed · ${d.scope.outOfScope.length} refused`,
    )}
      <div class="scope">
        <div>
          <div class="nest">
            <button type="button" class="nest-ring nest-stretch" data-tier="stretch" aria-pressed="false"><span class="nest-label">Stretch ×${d.scope.stretch.length}</span></button>
            <button type="button" class="nest-ring nest-full" data-tier="full" aria-pressed="false"><span class="nest-label">Full ×${d.scope.full.length}</span></button>
            <button type="button" class="nest-ring nest-mvp" data-tier="mvp" aria-pressed="false"><span class="nest-label">MVP ×${d.scope.mvp.length}</span></button>
          </div>
          <p class="nest-caption">Cutting to the inner ring is always a legal move. Adding a ring is not — that is a new revision that supersedes this one.</p>
        </div>
        <div class="tiers" id="tiers">
${tier('mvp', 'MVP — must ship', d.scope.mvp)}
${tier('full', 'Full — the target outcome', d.scope.full)}
${tier('stretch', 'Stretch — only if time allows', d.scope.stretch)}
        </div>
      </div>

      <div class="boundaries">
        <div class="bound bound-out">
          <h3>Out of scope — refused on purpose</h3>
          ${boundList(
            d.scope.outOfScope.map(
              it =>
                `<span class="struck">${esc(it.item)}</span>${it.reason ? ` — ${esc(it.reason)}` : ''}`,
            ),
            'Nothing was explicitly refused.',
          )}
        </div>
        <div class="bound">
          <h3>Future — someday, maybe</h3>
          ${boundList(
            d.scope.future.map(x => esc(x)),
            'Nothing deferred.',
          )}
        </div>
      </div>`,
    { wash: true },
  );
}

// --- Plan: the graph and the ledger --------------------------------------

/** Wave (column) per phase: longest prereq chain depth.
    When no phase declares prereqs, the plan is an implicit sequential chain.
    Display-depth for the graph layout — deliberately NOT the dispatch planner
    in `workflows/wave-planner.mjs`; different output, different cycle semantics. */
function computePhaseDepths(phases: Phase[]): number[] {
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

function riskChip(risk: string): string {
  const cls =
    risk === 'high' ? 'chip-danger' : risk === 'medium' ? 'chip-caution' : 'chip-go';
  return `<span class="chip ${cls}">${esc(risk)} risk</span>`;
}

/** HTML nodes on a CSS grid, with edges drawn by JS from measured geometry.
    The predecessor used SVG <text>, which forced titles to be truncated at 26
    characters; a phase you cannot read is not a plan you can approve. */
function buildGraph(f: Facts): string {
  const { phases, waves, waveCount } = f;
  // Row within the wave, so two phases in one wave stack instead of collide.
  const rows = phases.map(
    (_, i) => waves.slice(0, i).filter(w => w === waves[i]).length,
  );

  const labels = Array.from({ length: waveCount }, (_, w) => {
    const inWave = phases.filter((_, i) => waves[i] === w);
    // A wave is only as parallel as its file claims allow: the engine
    // serialises phases that would collide, so "N in parallel" is a lie
    // whenever two of them name the same file. Report what will actually
    // happen, not the wave's width.
    const collides = inWave.some((a, x) =>
      inWave.slice(x + 1).some(b =>
        (a.files ?? []).some(file => (b.files ?? []).includes(file)),
      ),
    );
    const n = inWave.length;
    const concurrency =
      n > 1 ? (collides ? ' · serialised by file overlap' : ` · ${n} in parallel`) : '';
    const text = f.explicitGraph ? `wave ${w + 1}${concurrency}` : `step ${w + 1}`;
    return `          <div class="wave-label" style="grid-column:${w + 1}">${esc(text)}</div>`;
  }).join('\n');

  const nodes = phases
    .map((p, i) => {
      const risk = p.risk ?? 'low';
      const isGate = p.kind === 'gate';
      const tags = [
        isGate ? '<span class="chip chip-accent">gate</span>' : '',
        p.blocking ? '<span class="chip">blocking</span>' : '',
        riskChip(risk),
      ]
        .filter(Boolean)
        .join('\n              ');
      return `          <button type="button" class="pnode${isGate ? ' pnode-gate' : ''}" data-phase="${i}" data-risk="${risk}" aria-pressed="false"
            style="grid-column:${waves[i] + 1}; grid-row:${rows[i] + 2}">
            <span class="pnode-top">
              <span class="pnode-n">${pad2(i + 1)}</span>
            </span>
            <span class="pnode-title">${esc(p.title)}</span>
            <span class="pnode-foot">
              ${tags}
            </span>
          </button>`;
    })
    .join('\n');

  // Edge list mirrors the run engine: declared prereqs, else an implicit chain.
  const byTitle = new Map(phases.map((p, i) => [p.title, i] as const));
  const edges: Array<[number, number]> = [];
  if (f.explicitGraph) {
    phases.forEach((p, i) => {
      for (const t of p.prereqs ?? []) {
        const j = byTitle.get(t);
        if (j !== undefined) edges.push([j, i]);
      }
    });
  } else {
    for (let i = 1; i < phases.length; i++) edges.push([i - 1, i]);
  }

  const summary = phases
    .map(
      (p, i) =>
        `${pad2(i + 1)} ${p.title}${f.explicitGraph ? ` (wave ${waves[i] + 1})` : ''}`,
    )
    .join('; ');

  return `      <div class="graph" id="graph" data-edges="${esc(JSON.stringify(edges))}">
        <div class="graph-grid" aria-label="Phase dependency graph: ${esc(summary)}" style="grid-template-columns: repeat(${waveCount}, max-content)">
          <svg class="graph-edges" aria-hidden="true"></svg>
${labels}
${nodes}
        </div>
      </div>
      <div class="graph-hint" id="graph-hint" data-active="false">
        <span>Select a phase to isolate it here and in the ledger below.</span>
        <button type="button" class="graph-clear" id="graph-clear">show all</button>
      </div>`;
}

function buildLedger(d: ContractData, f: Facts): string {
  return `      <div class="ledger" id="ledger">
${f.phases
  .map((p, i) => {
    const risk = p.risk ?? 'low';
    const tags = [
      p.kind === 'gate'
        ? '<span class="chip chip-accent">human gate</span>'
        : '<span class="chip">phase</span>',
      p.blocking ? '<span class="chip chip-caution">blocking</span>' : '',
      riskChip(risk),
      f.explicitGraph
        ? `<span class="chip">wave ${f.waves[i] + 1}</span>`
        : '',
    ]
      .filter(Boolean)
      .join('\n              ');
    const choke = f.chokepoints.find(c => c.index === i);
    return `        <div class="lrow" id="phase-${i}" data-phase="${i}">
          <div class="lrow-n">${pad2(i + 1)}</div>
          <div class="lrow-head">
            <h3>${esc(p.title)}</h3>
            <div class="lrow-tags">
              ${tags}
            </div>
          </div>
          <div class="lrow-body">
            ${p.notes ? esc(p.notes) : '<span class="lrow-none">No implementation notes recorded.</span>'}${
              p.prereqs?.length
                ? `\n            <div style="margin-top: var(--s2)">Waits for ${p.prereqs.map(t => `<strong>${esc(t)}</strong>`).join(', ')}.</div>`
                : ''
            }${
              choke
                ? `\n            <div style="margin-top: var(--s2)">If this fails, ${choke.blocks.length} downstream phase${choke.blocks.length === 1 ? '' : 's'} ${choke.blocks.length === 1 ? 'is' : 'are'} skipped, not attempted: ${choke.blocks.map(t => esc(t)).join(', ')}.</div>`
                : ''
            }${
              (p.files ?? []).length
                ? `\n            <div style="margin-top: var(--s2)">Claims ${(p.files ?? []).map(x => `<code>${esc(x)}</code>`).join(', ')} — used to serialise colliding phases and as the commit stage's fallback file list.</div>`
                : ''
            }${
              p.specPath
                ? `\n            <span class="spec">${esc(p.specPath)}</span>`
                : ''
            }
          </div>
        </div>`;
  })
  .join('\n')}
      </div>`;
}

function buildPlan(d: ContractData, f: Facts): string {
  if (!f.phases.length) {
    return band(
      'plan',
      `${secHead('plan', 'The plan', d.execution.strategy)}
      <p class="placeholder">Phases are decided after approval.</p>`,
    );
  }
  const sub = f.explicitGraph
    ? `${d.execution.strategy}. Columns are dependency waves — nothing in a column waits on anything else in it, but two phases naming the same file are still serialised, so a column is an upper bound on concurrency rather than a promise of it.`
    : `${d.execution.strategy}. No phase declares a prerequisite, so the engine runs them in the order written.`;

  const awaiting =
    d.status === 'Draft'
      ? `
      <div class="awaiting">
        <span class="stamp is-caution">awaiting approval</span>
        <p>Approve this contract in the session. Specs are then written per phase and this document regenerates carrying its run commands.</p>
      </div>`
      : '';

  return band(
    'plan',
    `${secHead('plan', 'What gets built, in what order', sub, f.phases.length > f.committable ? `${f.committable} phases + ${f.phases.length - f.committable} gate${f.phases.length - f.committable === 1 ? '' : 's'}` : `${f.phases.length} phases`)}
${buildGraph(f)}
${buildLedger(d, f)}${awaiting}`,
  );
}

// --- The run model -------------------------------------------------------

interface Stage {
  name: string;
  agent: string;
  what: string;
  /** The stage's result enum, verbatim from execute-contract.mjs's schemas. */
  outs: Array<[string, string]>;
  /** How the run leaves the loop HERE rather than continuing. Trusted HTML —
      authored in this file, never from contract data. The single most
      decision-relevant fact per stage, and the one a linear diagram hides. */
  exit: string;
}

/** The engine's real per-phase loop, as implemented in
    workflows/execute-contract.mjs. Kept literal on purpose: a diagram that
    flatters the engine is worse than no diagram, because the reader calibrates
    their trust on it. Every `outs` value below is an enum member from that
    file's *_RESULT_SCHEMA — do not invent a friendlier one. */
const STAGES: Stage[] = [
  {
    name: 'Scout',
    agent: 'ideation:scout',
    what: 'Reads the codebase against the spec and scores five evidence gates before a line is written.',
    outs: [
      ['chip-go', 'GO'],
      ['chip-caution', 'HOLD'],
    ],
    exit: 'Under --strict a HOLD stops here — nothing is built.',
  },
  {
    name: 'Build',
    agent: 'general-purpose',
    what: 'Implements the spec, then runs the validation the spec itself declares.',
    outs: [
      ['chip-go', 'BUILT'],
      ['chip', 'NO-OP'],
      ['chip-danger', 'FAIL'],
    ],
    exit: 'Failed validation stops here. An empty diff is a NO-OP and also stops here — review never runs.',
  },
  {
    name: 'Review',
    agent: 'ideation:reviewer',
    what: 'Reads the diff back against the spec and returns findings counted by severity.',
    outs: [
      ['chip-go', 'PASS'],
      ['chip-danger', 'FAIL'],
    ],
    exit: 'An unavailable reviewer stops here under --strict; otherwise it commits as validation-only.',
  },
  {
    name: 'Fix',
    agent: 'general-purpose',
    what: 'Applies or refutes every blocking finding, then hands back for another review.',
    outs: [
      ['chip-go', 'FIXED'],
      ['chip-danger', 'FAIL'],
    ],
    exit: 'Still FAIL on cycle 3 stops here — changes are left unstaged, not committed.',
  },
  {
    name: 'Commit',
    agent: 'general-purpose',
    what: 'Stages only the files the builder named and writes the spec path into the commit body.',
    outs: [
      ['chip-accent', 'COMMITTED'],
      ['chip-danger', 'FAILED'],
    ],
    exit: 'If neither the builder nor the phase named a file, it refuses to commit blind rather than <code>git add -A</code>.',
  },
];

function buildRunModel(d: ContractData, f: Facts): string {
  if (!f.phases.length) return '';
  const strict = d.approvalMode === 'express';

  const stages = STAGES.map(
    (s, i) => `            <div class="stage" data-stage="${i}" data-reached="false">
              <span class="stage-dot" aria-hidden="true"></span>
              <span class="stage-name">${esc(s.name)}</span>
              <span class="stage-agent">${esc(s.agent)}</span>
              <span class="stage-what">${esc(s.what)}</span>
              <span class="stage-outs">${s.outs
                .map(([cls, label]) => `<span class="chip ${cls}">${esc(label)}</span>`)
                .join('')}</span>
              <span class="stage-exit"><span class="sr-only">Stops here when: </span>${s.exit}</span>
            </div>`,
  ).join('\n');

  // Rules stated with this contract's own numbers, not in the abstract.
  const rules: Array<[string, string]> = [];

  rules.push([
    f.explicitGraph ? 'Waves, not a queue' : 'One at a time',
    f.explicitGraph
      ? `Phases are grouped into ${f.waveCount} wave${f.waveCount === 1 ? '' : 's'} from their declared prerequisites. A wave dispatches together; the next one waits for all of it. ${
          f.anyFiles
            ? 'Two phases naming the same file are serialised even inside one wave. Autopilot re-derives that list from each spec&rsquo;s File Changes tables at dispatch, so the run follows the specs rather than this page.'
            : 'No phase here declares <code>files</code>, but autopilot derives them from each spec&rsquo;s File Changes tables before dispatch, so colliding phases can still be serialised. A phase whose spec has no readable File Changes section is treated as parallel-safe, and the engine logs a warning saying so.'
        }`
      : `No phase declares a prerequisite, so all ${f.phases.length} run one after another. Declaring <code>prereqs</code> is what unlocks parallel dispatch.`,
  ]);

  rules.push([
    'Failure strands, it does not retry',
    f.chokepoints.length
      ? `A failed phase is not retried, and everything downstream of it is marked <code>SKIPPED</code> rather than attempted. Here that means ${f.chokepoints
          .slice(0, 2)
          .map(
            c =>
              `<strong>${esc(c.title)}</strong> failing costs ${c.blocks.length} more phase${c.blocks.length === 1 ? '' : 's'}`,
          )
          .join(', and ')}.`
      : 'A failed phase is not retried. No phase here has dependents, so a failure costs only itself.',
  ]);

  rules.push([
    'Resume is a git question',
    `Re-running skips any phase whose spec path already appears in a commit body — which is why the commit stage writes it there. ${f.committable} build phase${f.committable === 1 ? '' : 's'} ${f.committable === 1 ? 'is' : 'are'} expected to leave one${f.phases.length > f.committable ? `; the ${f.phases.length - f.committable} human gate${f.phases.length - f.committable === 1 ? '' : 's'} commit${f.phases.length - f.committable === 1 ? 's' : ''} nothing` : ''}.`,
  ]);

  rules.push([
    strict ? 'Strict: it fails closed' : 'Non-strict: it degrades loudly',
    strict
      ? 'This is an express contract — no human reviewed the specs — so phases dispatch <code>--strict</code>. A scout HOLD or an unavailable reviewer stops the phase instead of proceeding on an assumption.'
      : 'If the scout holds or the reviewer is unavailable, the phase proceeds and says so in its warnings rather than failing. The result reports <code>validation-only</code>, never a bare pass.',
  ]);

  return band(
    'run-model',
    `${secHead(
      'run-model',
      'What actually happens when you run it',
      'Every build phase goes through the same five stages. These are the real agents and the real gates — the points where the run can stop before anything is committed. Human gates in the plan above are not build phases: nothing is specced, built, or committed for them.',
      'per build phase',
    )}
      <div class="model" id="model">
        <div class="model-track">
          <div class="stages">
            <span class="token" id="token" aria-hidden="true"></span>
${stages}
            <div class="loopback" aria-hidden="true">
              <svg viewBox="0 0 200 26" preserveAspectRatio="none"><path vector-effect="non-scaling-stroke" d="M197 0 V17 Q197 24 190 24 H10 Q3 24 3 17 V0"/></svg>
              <span class="loopback-label">review → fix → review · 3 cycles max, then it stops</span>
            </div>
          </div>
        </div>
        <div class="rules">
${rules
  .map(
    ([h, p]) => `          <div class="rule">
            <h3>${esc(h)}</h3>
            <p>${p}</p>
          </div>`,
  )
  .join('\n')}
        </div>
      </div>`,
    { wash: true },
  );
}

// --- Done when -----------------------------------------------------------

function buildSuccess(
  d: ContractData,
  f: Facts,
  paths: ContractPaths,
): string {
  const cmds = f.criteria.filter(c => isCmd(c.check));
  const judged = f.criteria.filter(c => !isCmd(c.check));

  const item = (c: NormalizedCriterion, n: number): string => {
    const isJ = !isCmd(c.check);
    let body: string;
    if (isCmd(c.check)) {
      const stat = isStaticCheck(c.check.cmd)
        ? '<span class="chip chip-caution crit-static">inspects files only</span>'
        : '';
      // "exits 0" is what a passing shell command already means — verify.mjs
      // checks the exit code and nothing else. Across this repo's contracts it
      // is 23 of 31 expect values, so printing it is 23 lines of restated
      // mechanism down the longest section on the page.
      const expect = /^exits\s+0\.?$/i.test((c.check.expect ?? '').trim())
        ? ''
        : c.check.expect;
      body = `<code class="crit-check">${esc(c.check.cmd)}</code>${
        expect
          ? `<span class="crit-expect">expect: ${esc(expect)}${stat}</span>`
          : stat
            ? `<span class="crit-expect">${stat}</span>`
            : ''
      }`;
    } else {
      const note = isJudge(c.check) ? c.check.judgment : '';
      body = `<span class="crit-check">${note ? esc(note) : 'No mechanical check, and no reviewer named. verify.mjs cannot certify this one.'}</span>`;
    }
    return `          <li class="crit${isJ ? ' crit-judge' : ''}">
            <span class="crit-n">${pad2(n)}</span>
            <span class="crit-text">${esc(c.criterion)}${body}</span>
          </li>`;
  };

  // Index against the full list: contract-gen's own render errors report
  // successCriteria[i], so the numbers here have to be those indices.
  const indexOf = new Map(f.criteria.map((c, i) => [c, i + 1] as const));

  const group = (
    title: string,
    note: string,
    list: NormalizedCriterion[],
  ): string =>
    list.length
      ? `      <div class="crit-group">
        <h3>${esc(title)} <span class="hrule"></span> <span class="sec-count">${esc(note)}</span></h3>
        <ul class="crits">
${list.map(c => item(c, indexOf.get(c) ?? 0)).join('\n')}
        </ul>
      </div>`
      : '';

  const goalTarget = f.committable;
  const verify = `<span class="vk">VERIFY</span> ${esc(d.slug)}: commits=<span class="vg">${goalTarget}/${goalTarget}</span> pass=<span class="vg">${f.cmdCount}</span> fail=<span class="vg">0</span> judgment=${f.judgmentCount}`;

  return band(
    'done',
    `${secHead(
      'done',
      'How you will know it worked',
      'These are not aspirations — the ones with a command are executed by <code>verify.mjs</code>, and their result is what an unattended run is judged on.',
      `${f.cmdCount} of ${f.criteria.length} mechanical`,
    )}
      <div class="score">
        <div class="score-panel">
          <span class="kicker">completion predicate</span>
          <div class="score-figure"><span class="num">${f.cmdCount}</span><span class="of">/${f.criteria.length}</span></div>
          <p class="score-label">${
            f.judgmentCount === 0
              ? 'Every criterion is machine-checkable. A green run means what it says.'
              : `${f.judgmentCount} criteri${f.judgmentCount === 1 ? 'on is a judgment call' : 'a are judgment calls'} — printed, but never counted. A green run does not cover ${f.judgmentCount === 1 ? 'it' : 'them'}.`
          }</p>
          <div class="verify-line">${verify}</div>
          <p class="verify-cap">${
            f.judgmentCount === 0
              ? 'The line this contract is finished on, as <code>verify.mjs</code> will print it. Anything else is not done.'
              : `Mechanical verification only, as <code>verify.mjs</code> will print it — a green line here is necessary, not sufficient. ${f.judgmentCount === 1 ? 'The judgment criterion above is' : `The ${f.judgmentCount} judgment criteria above are`} uncounted, so this contract is not finished until ${f.judgmentCount === 1 ? 'it has' : 'they have'} been signed off too.`
          }</p>
          ${cmdField('cmd-verify', `node ${paths.verifyBin} ${paths.dataPath}`)}
        </div>
        <div>
${group('Mechanically checked', `×${cmds.length}`, cmds)}
${group('Judgment calls', `×${judged.length} · a human must look`, judged)}
        </div>
      </div>`,
  );
}

// --- Decisions -----------------------------------------------------------

function buildDecisionLog(d: ContractData): string {
  const items = Array.isArray(d.decisions) ? d.decisions : [];
  if (items.length === 0) return '';
  return band(
    'decisions',
    `${secHead(
      'decisions',
      'What was considered and turned down',
      'A rejected alternative is evidence, not an oversight. Before proposing one of these, read why it lost.',
      `×${items.length}`,
    )}
      <ul class="decisions">
${items
  .map(
    it => `        <li class="decision">
          <h3>${esc(it.decision)}</h3>
          <p>${it.rejected ? `<span class="rejected">Instead of</span> ${esc(it.rejected)}. ` : ''}${esc(it.reason)}</p>
        </li>`,
  )
  .join('\n')}
      </ul>`,
    { wash: true },
  );
}

// --- Open questions ------------------------------------------------------

/** The ids in `blockedBy` that are still open, resolved against the entries
    actually present. A closed question is dropped from the array, and the
    interview engine has no rule telling the writer to also scrub that id out
    of every entry pointing at it — so a stale id here is expected, not a
    defect in the data. Reading takeability from presence keeps the two
    renderers honest: a question whose blockers have all closed renders as
    takeable without anyone having to remember to prune. */
function stillBlocking(items: OpenQuestion[], it: OpenQuestion): string[] {
  const present = new Set(items.map(q => q.id));
  return (it.blockedBy ?? []).filter(id => id && present.has(id));
}

/** Not a wash band: `decisions` above is washed and `.band` carries its own
    border-top, so a plain band is what separates the two. */
function buildOpenQuestions(d: ContractData): string {
  const items = Array.isArray(d.openQuestions) ? d.openQuestions : [];
  if (items.length === 0) return '';
  const gateLabel = (key: string) =>
    d.gates.dimensions.find(g => g.key === key)?.label ?? key;
  return band(
    'open-questions',
    `${secHead(
      'open-questions',
      'What is still open, and what would close it',
      'Each of these is a gate the interview could not close, paired with the work that closes it. A resumed interview asks these and nothing else.',
      `×${items.length}`,
    )}
      <ul class="openqs">
${items
  .map(it => {
    const waiting = stillBlocking(items, it);
    const wait = waiting.length
      ? ` · <span class="openq-wait">waiting on</span> ${waiting
          .map(id => `<code>${esc(id)}</code>`)
          .join(', ')}`
      : '';
    return `        <li class="openq">
          <span class="openq-type">${esc(it.type)}</span>
          <h3>${esc(it.question)}</h3>
          <p class="openq-meta"><code class="openq-id">${esc(it.id)}</code> · Blocks ${esc(gateLabel(it.gate))}${wait}</p>
        </li>`;
  })
  .join('\n')}
      </ul>`,
  );
}

// --- Run it --------------------------------------------------------------

function buildCommands(
  d: ContractData,
  f: Facts,
  paths: ContractPaths,
): string {
  if (d.status !== 'Approved' || !f.phases.length) return '';
  const first = f.phases[0];

  return band(
    'run',
    `${secHead(
      'run',
      'Run it',
      'Three ways in, in descending order of how much you can walk away from.',
    )}
      <div class="runbar">
        <div>
          <span class="kicker">recommended</span>
          <h3>Autopilot.</h3>
          <p>Dispatches every phase through the loop above, in dependency order, gating on failure. Already-committed phases are skipped, so re-running after a fix picks up where it stopped.</p>
        </div>
        ${cmdField('cmd-autopilot', `/ideation:autopilot ${paths.contractPath}`)}
      </div>

      <details class="fold">
        <summary>Unattended, with a stop condition (/goal)</summary>
        <div class="fold-body">
          <p>A durability wrapper around the same autopilot run: Claude re-checks this condition before it is allowed to stop, so a failed phase gets repaired and re-run instead of ending the session. The done-when is deliberately disjunctive — two identical failing VERIFY lines release the run, because a contract whose checks have rotted must not trap it forever.</p>
          ${cmdField('cmd-goal', buildGoal(d, paths), true)}
        </div>
      </details>

      <details class="fold">
        <summary>One phase at a time (${f.phases.length})</summary>
        <div class="fold-body">
          <p>No orchestration, no failure gating, no resume — you are the scheduler. Start with <strong>${esc(first.title)}</strong>.</p>
          <div class="phase-cmds">
${f.phases
  .map(
    (p, i) => `            <div class="phase-cmd">
              <span class="n">${pad2(i + 1)}</span>
              <span class="t">${esc(p.title)}</span>
              ${cmdField(`cmd-${i + 1}`, phaseCommand(p, d.slug, i))}
            </div>`,
  )
  .join('\n')}
          </div>
        </div>
      </details>`,
  );
}

/** Closing band — the contract ends on the commitment, not a footnote. */
function buildClose(d: ContractData, f: Facts, paths: ContractPaths): string {
  if (d.status !== 'Approved') return '';
  const when = d.approvedOn ?? d.date;
  const expressNote =
    d.approvalMode === 'express'
      ? ' Express run — approved in one confirmation after the interview, so the review lives in the branch diff rather than in a per-artifact sign-off.'
      : '';
  return `
    <section class="band" id="close" aria-labelledby="close-h">
      <div class="wrap">
        <div class="close">
          <div>
            <span class="kicker">the commitment</span>
            <h2 id="close-h">This plan is what was agreed.</h2>
            <p>${f.phases.length} phase${f.phases.length === 1 ? '' : 's'} · ${esc(d.execution.strategy)}. Scope changes mean a new revision that supersedes this document — not silent drift.${expressNote}</p>
          </div>
          <div class="close-meta">
            <span class="stamp is-go">approved</span>
            <span class="meta">${esc(when)}${d.approvedBy ? ` · ${esc(d.approvedBy)}` : ''}</span>
          </div>
        </div>
        <p class="colophon">Generated by <code>ideation:contract-gen</code> from <code>${esc(paths.dataPath)}</code>. That JSON is the source of truth; this page and <code>${esc(paths.contractPath)}</code> are both rendered from it, so edit the data and re-render rather than editing either output.</p>
      </div>
    </section>`;
}

// --- Markdown Builders ---
//
// contract.md is the generator's second output (via --md-output): the same
// ContractData rendered in the structure the repo's existing contracts use.
// The structure is a deliberate legacy compatibility contract —
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

/** Unlike mdDecisions, an empty list emits nothing at all. Decisions record
    absence explicitly because a spec consumer must tell silence from a missing
    section; no consumer reads open questions out of a spec. */
function mdOpenQuestions(d: ContractData): string {
  const items = Array.isArray(d.openQuestions) ? d.openQuestions : [];
  if (items.length === 0) return '';
  const gateLabel = (key: string) =>
    d.gates.dimensions.find(g => g.key === key)?.label ?? key;
  const body = items.map(it => {
    const waiting = stillBlocking(items, it);
    const wait = waiting.length
      ? `; waiting on ${waiting.map(id => `\`${id}\``).join(', ')}`
      : '';
    return `- \`${it.id}\` **${it.question}** — ${it.type}, blocks ${gateLabel(it.gate)}${wait}`;
  });
  return ['## Open Questions', '', ...body].join('\n');
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
  return parts.join('\n');
}

function buildMarkdown(d: ContractData, paths: ContractPaths): string {
  // Conditional spread, not a bare entry: sections.join would otherwise leave
  // a stray blank block on every contract with no open questions.
  const oq = mdOpenQuestions(d);
  const sections = [
    mdHeader(d),
    mdProblem(d),
    mdGoals(d),
    mdCriteria(d),
    mdScope(d),
    mdDecisions(d),
    ...(oq ? [oq] : []),
    mdExecutionPlan(d, paths),
    '---',
    '_This contract was generated from brain dump input. Review and approve before proceeding to specification._',
  ];
  return `${sections.join('\n\n')}\n`;
}

// --- Main Template ---

/* Client behaviour. Deliberately dependency-free and written without template
   literals: this string is itself inside one. Everything below degrades to a
   readable document if it never runs. */
const CLIENT_JS = String.raw`
(function () {
  'use strict';
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---- copy ------------------------------------------------------------ */
  function flash(btn, label) {
    var prior = btn.dataset.label || btn.textContent;
    btn.dataset.label = prior;
    btn.textContent = label;
    btn.dataset.state = 'done';
    setTimeout(function () {
      btn.textContent = prior;
      btn.removeAttribute('data-state');
    }, 1800);
  }
  function wireCopy(btn, getText) {
    btn.setAttribute('aria-live', 'polite');
    btn.addEventListener('click', function () {
      var text = getText();
      if (text == null) return;
      /* file:// or a denied permission: point at the manual path rather than
         failing silently — and select the text first, so "press ⌘C" is true.
         navigator.clipboard is absent entirely outside a secure context, which
         throws synchronously before any rejection handler runs, so the guard
         has to come before the call and not only after it. */
      var manual = function () {
        var t = btn.dataset.copy ? document.getElementById(btn.dataset.copy) : null;
        if (t && window.getSelection && document.createRange) {
          var range = document.createRange();
          range.selectNodeContents(t);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
        flash(btn, 'press ' + (navigator.platform.indexOf('Mac') === 0 ? '⌘C' : 'Ctrl+C'));
      };
      if (!navigator.clipboard || !navigator.clipboard.writeText) { manual(); return; }
      navigator.clipboard.writeText(text).then(
        function () { flash(btn, 'copied'); },
        manual
      );
    });
  }
  document.querySelectorAll('.copy[data-copy]').forEach(function (btn) {
    wireCopy(btn, function () {
      var t = document.getElementById(btn.dataset.copy);
      return t ? t.textContent.trim() : null;
    });
  });
  document.querySelectorAll('[data-copy-text]').forEach(function (btn) {
    wireCopy(btn, function () { return btn.dataset.copyText; });
  });

  /* ---- theme (auto -> light -> dark) ----------------------------------- */
  var themeBtn = document.getElementById('theme-toggle');
  if (themeBtn) {
    var KEY = 'ideation-contract-theme';
    var root = document.documentElement;
    var LABEL = {
      auto: 'Colour theme: follow system',
      light: 'Colour theme: light',
      dark: 'Colour theme: dark'
    };
    var apply = function (mode) {
      if (mode === 'auto') delete root.dataset.theme;
      else root.dataset.theme = mode;
      themeBtn.dataset.mode = mode;
      themeBtn.setAttribute('aria-label', LABEL[mode]);
      themeBtn.title = LABEL[mode];
      try {
        if (mode === 'auto') localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, mode);
      } catch (e) {}
    };
    apply(root.dataset.theme || 'auto');
    themeBtn.addEventListener('click', function () {
      var order = ['auto', 'light', 'dark'];
      apply(order[(order.indexOf(root.dataset.theme || 'auto') + 1) % 3]);
    });
  }

  /* ---- running head + scrollspy ---------------------------------------- */
  var runhead = document.getElementById('runhead');
  var masthead = document.querySelector('.masthead');
  if (runhead && masthead && 'IntersectionObserver' in window) {
    new IntersectionObserver(function (es) {
      runhead.dataset.visible = String(!es[0].isIntersecting);
    }, { rootMargin: '-60px 0px 0px 0px' }).observe(masthead);

    var navLinks = {};
    runhead.querySelectorAll('.runhead-nav a').forEach(function (a) {
      navLinks[a.getAttribute('href').slice(1)] = a;
    });
    /* One observer over every section; the topmost intersecting one wins, so
       the marker never flickers between two bands sharing the viewport. */
    var visible = {};
    var spy = new IntersectionObserver(function (es) {
      es.forEach(function (e) { visible[e.target.id] = e.isIntersecting; });
      var order = Object.keys(navLinks);
      var current = order.filter(function (id) { return visible[id]; })[0];
      order.forEach(function (id) {
        if (current === id) navLinks[id].setAttribute('aria-current', 'true');
        else navLinks[id].removeAttribute('aria-current');
      });
    }, { rootMargin: '-70px 0px -55% 0px' });
    Object.keys(navLinks).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) spy.observe(el);
    });
  }

  /* ---- phase graph: edges measured from real geometry ------------------ */
  var graph = document.getElementById('graph');
  var ledger = document.getElementById('ledger');
  if (graph) {
    var grid = graph.querySelector('.graph-grid');
    var svg = graph.querySelector('.graph-edges');
    var nodes = Array.prototype.slice.call(grid.querySelectorAll('.pnode'));
    var edges = [];
    try { edges = JSON.parse(graph.dataset.edges || '[]'); } catch (e) {}
    var byIndex = {};
    nodes.forEach(function (n) { byIndex[n.dataset.phase] = n; });

    var draw = function () {
      if (!edges.length) return;
      var gb = grid.getBoundingClientRect();
      svg.setAttribute('viewBox', '0 0 ' + gb.width + ' ' + gb.height);
      var box = function (i) {
        var el = byIndex[i];
        if (!el) return null;
        var r = el.getBoundingClientRect();
        return {
          l: r.left - gb.left, r: r.right - gb.left,
          cy: r.top - gb.top + r.height / 2
        };
      };
      var focus = graph.dataset.focus;
      /* Built with DOM calls rather than innerHTML: every value here is
         geometry, but a renderer that cannot inject markup cannot regress
         into one that can. */
      var NS = 'http://www.w3.org/2000/svg';
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      var defs = document.createElementNS(NS, 'defs');
      var marker = document.createElementNS(NS, 'marker');
      marker.setAttribute('id', 'ah');
      marker.setAttribute('viewBox', '0 0 10 10');
      marker.setAttribute('refX', '9');
      marker.setAttribute('refY', '5');
      marker.setAttribute('markerWidth', '6');
      marker.setAttribute('markerHeight', '6');
      marker.setAttribute('orient', 'auto');
      var head = document.createElementNS(NS, 'path');
      head.setAttribute('d', 'M0 0 L10 5 L0 10 z');
      head.setAttribute('fill', 'context-stroke');
      marker.appendChild(head);
      defs.appendChild(marker);
      svg.appendChild(defs);
      edges.forEach(function (e) {
        var a = box(e[0]), b = box(e[1]);
        if (!a || !b) return;
        var x1 = a.r, x2 = b.l - 7, y1 = a.cy, y2 = b.cy;
        var mid = x1 + (x2 - x1) / 2;
        var d = Math.abs(y1 - y2) < 0.5
          ? 'M' + x1 + ' ' + y1 + ' H' + x2
          : 'M' + x1 + ' ' + y1 + ' H' + mid + ' V' + y2 + ' H' + x2;
        var p = document.createElementNS(NS, 'path');
        p.setAttribute('d', d);
        p.setAttribute('marker-end', 'url(#ah)');
        if (focus !== undefined && (String(e[0]) === focus || String(e[1]) === focus)) {
          p.setAttribute('class', 'e-hot');
        }
        svg.appendChild(p);
      });
    };

    /* Fonts land after first paint and change node heights. */
    draw();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(draw);
    addEventListener('resize', draw);
    addEventListener('beforeprint', draw);
    graph.addEventListener('scroll', draw);

    /* ---- focus: one phase isolated across graph and ledger ------------- */
    var hint = document.getElementById('graph-hint');
    var rows = ledger ? Array.prototype.slice.call(ledger.querySelectorAll('.lrow')) : [];
    var clearFocus = function () {
      delete graph.dataset.focus;
      if (ledger) delete ledger.dataset.focus;
      nodes.forEach(function (n) { n.setAttribute('aria-pressed', 'false'); });
      rows.forEach(function (r) { r.dataset.hot = 'false'; });
      if (hint) hint.dataset.active = 'false';
      draw();
    };
    var setFocus = function (i, scroll) {
      if (graph.dataset.focus === String(i)) return clearFocus();
      graph.dataset.focus = String(i);
      if (ledger) ledger.dataset.focus = String(i);
      nodes.forEach(function (n) {
        n.setAttribute('aria-pressed', String(n.dataset.phase === String(i)));
      });
      rows.forEach(function (r) { r.dataset.hot = String(r.dataset.phase === String(i)); });
      if (hint) hint.dataset.active = 'true';
      draw();
      if (scroll) {
        var row = document.getElementById('phase-' + i);
        if (row) row.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
      }
    };
    nodes.forEach(function (n) {
      n.addEventListener('click', function () { setFocus(n.dataset.phase, true); });
    });
    var clearBtn = document.getElementById('graph-clear');
    if (clearBtn) clearBtn.addEventListener('click', clearFocus);
    addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && graph.dataset.focus !== undefined) clearFocus();
    });
  }

  /* ---- scope rings ------------------------------------------------------ */
  var tiers = document.getElementById('tiers');
  if (tiers) {
    var rings = Array.prototype.slice.call(document.querySelectorAll('.nest-ring'));
    rings.forEach(function (ring) {
      ring.addEventListener('click', function () {
        var t = ring.dataset.tier;
        var on = tiers.dataset.tier !== t;
        if (on) tiers.dataset.tier = t; else delete tiers.dataset.tier;
        rings.forEach(function (r) {
          r.setAttribute('aria-pressed', String(on && r.dataset.tier === t));
        });
      });
    });
  }

  /* ---- the one authored moment: the run model's token ------------------ */
  var model = document.getElementById('model');
  var token = document.getElementById('token');
  if (model && token && 'IntersectionObserver' in window) {
    var stages = Array.prototype.slice.call(model.querySelectorAll('.stage'));
    var light = function (animate) {
      var dots = stages.map(function (s) { return s.querySelector('.stage-dot'); });
      var wrap = model.querySelector('.stages');
      var wb = wrap.getBoundingClientRect();
      var first = dots[0].getBoundingClientRect();
      var last = dots[dots.length - 1].getBoundingClientRect();
      token.style.left = (first.left - wb.left + first.width / 2 - 5.5) + 'px';
      token.style.setProperty('--travel', (last.left - first.left) + 'px');
      if (!animate) {
        stages.forEach(function (s) { s.dataset.reached = 'true'; });
        model.dataset.lit = 'done';
        return;
      }
      var dur = 420 * (stages.length - 1);
      token.style.setProperty('--dur', dur + 'ms');
      model.dataset.lit = 'running';
      stages.forEach(function (s, i) {
        setTimeout(function () { s.dataset.reached = 'true'; }, (dur / (stages.length - 1)) * i);
      });
      setTimeout(function () { model.dataset.lit = 'done'; }, dur + 260);
    };
    var io = new IntersectionObserver(function (es) {
      if (!es[0].isIntersecting) return;
      io.disconnect();
      light(!reduce);
    }, { threshold: 0.3 });
    io.observe(model);
  }
})();
`;

function generate(data: ContractData, paths: ContractPaths): string {
  const d = data;
  const f = deriveFacts(d);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>${esc(d.projectName)} — Contract</title>
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
${buildRunhead(d, f, paths)}
${buildMasthead(d, f)}
    <main>
${buildReadiness(d, f, paths)}
${buildProblemGoals(d)}
${buildScope(d, f)}
${buildPlan(d, f)}
${buildRunModel(d, f)}
${buildSuccess(d, f, paths)}
${buildDecisionLog(d)}
${buildOpenQuestions(d)}
${buildCommands(d, f, paths)}
${buildClose(d, f, paths)}
    </main>
    <script>${CLIENT_JS}</script>
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
