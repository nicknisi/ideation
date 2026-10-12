/**
 * The Pi walkthrough, rendered by the product's own code at build time.
 *
 * Nothing on /walkthrough/pi/ is a mockup of the contract or the widget:
 *
 * - every contract page is `renderBrief()` from scripts/change-render.mjs, the
 *   same call the Pi extension makes, over a fixture brief that has to pass
 *   the real `validateBrief()` or the build fails;
 * - every widget frame is `createLiveProgressWidget()` from
 *   workflows/change-tui.mjs, driven by `createMotion()` on a scripted clock;
 * - the approval and acceptance dialogs are `approvalText()` /
 *   `acceptanceText()` from workflows/change-ui.mjs.
 *
 * Only the run's history is scripted, which is what a fixture is. change-tui
 * takes its width helpers and theme by injection (it has no Pi imports), so
 * the adapter below stands in for pi-tui: roles become CSS classes on the
 * graphite deck instead of ANSI colours, and every line is checked against
 * the width it was rendered for.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { repoPath } from './repo';

// Astro bundles this module into dist/.prerender, so plugin code is loaded by
// absolute path at build time rather than through a relative import.
const load = (path: string): Promise<any> =>
  import(/* @vite-ignore */ pathToFileURL(repoPath(path)).href);

const SITE = 'https://ideation.engineering';
export const CONTRACT_STATES = ['proposed', 'revised', 'running', 'ready', 'accepted'] as const;
export type ContractState = (typeof CONTRACT_STATES)[number];
export const contractHref = (state: ContractState) => `/walkthrough/pi/contract/${state}.html`;

/* ─── Terminal adapter ─────────────────────────────────────────────────── */

const ROLES = ['accent', 'borderAccent', 'success', 'error', 'warning', 'muted', 'dim', 'text', 'toolTitle'];
// A role travels as a private 256-colour code so it stays zero-width to the
// helpers; the HTML pass turns it back into a class.
const theme = {
  fg: (role: string, s: string) => {
    const i = ROLES.indexOf(role);
    if (i < 0) throw new Error(`change-tui used an unmapped theme role: ${role}`);
    return `\x1b[38;5;${200 + i}m${s}\x1b[39m`;
  },
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
};

const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
// East Asian wide/fullwidth ranges and emoji take two cells; the widget's own
// glyphs (braille, ✓ ◐ ✦ ━ ▎ ↗ …) are all single-cell.
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u{1f300}-\u{1faff}]/u;
const graphemes = (s: string) => [...segmenter.segment(s)].map(g => g.segment);
const cellWidth = (g: string) => (WIDE.test(g) ? 2 : 1);
const visibleWidth = (s: string) =>
  graphemes(s.replace(ANSI, '')).reduce((n, g) => n + cellWidth(g), 0);

function truncateToWidth(text: string, max: number, ellipsis = '...') {
  if (max <= 0) return '';
  if (visibleWidth(text) <= max) return text;
  const target = Math.max(0, max - visibleWidth(ellipsis));
  let out = '';
  let used = 0;
  for (const token of text.split(/(\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\)/)) {
    if (!token) continue;
    if (token.startsWith('\x1b')) {
      out += token;
      continue;
    }
    for (const g of graphemes(token)) {
      if (used + cellWidth(g) > target) return `${out}\x1b[0m${ellipsis}`;
      out += g;
      used += cellWidth(g);
    }
  }
  return `${out}\x1b[0m${ellipsis}`;
}

const hyperlink = (text: string, url: string) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
const helpers = { visibleWidth, truncateToWidth, hyperlink };

const esc = (s: string) =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** One rendered terminal line → HTML with role classes. */
function lineHtml(line: string): string {
  let out = '';
  let role = -1;
  let bold = false;
  for (const token of line.split(/(\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\)/)) {
    if (!token) continue;
    const osc = token.match(/^\x1b\]8;;([^\x1b]*)\x1b\\$/);
    if (osc) {
      out += osc[1] ? `<a href="${esc(osc[1].replace(SITE, ''))}">` : '</a>';
      continue;
    }
    const sgr = token.match(/^\x1b\[([0-9;]*)m$/);
    if (sgr) {
      const codes = (sgr[1] || '0').split(';').map(Number);
      for (let i = 0; i < codes.length; i++) {
        const c = codes[i];
        if (c === 0) (role = -1), (bold = false);
        else if (c === 1) bold = true;
        else if (c === 22) bold = false;
        else if (c === 39) role = -1;
        else if (c === 38 && codes[i + 1] === 5) (role = codes[i + 2] - 200), (i += 2);
      }
      continue;
    }
    const cls = [role >= 0 ? `t-${ROLES[role]}` : '', bold ? 't-b' : ''].filter(Boolean).join(' ');
    out += cls ? `<span class="${cls}">${esc(token)}</span>` : esc(token);
  }
  return out;
}

function screen(component: { render(width: number): string[] }, cols: number, what: string) {
  const lines = component.render(cols);
  for (const l of lines) {
    if (visibleWidth(l) > cols) throw new Error(`${what}: a ${visibleWidth(l)}-cell line overflows ${cols} columns`);
  }
  return lines.map(lineHtml).join('\n');
}

/* ─── Fixture ──────────────────────────────────────────────────────────── */

const readBrief = (rev: number) =>
  JSON.parse(readFileSync(repoPath('site', 'src', 'data', 'walkthrough', `offline-drafts.r${rev}.json`), 'utf8'));

export interface Walkthrough {
  brief: any;
  previous: any;
  fingerprint: string;
  previousFingerprint: string;
  runId: string;
  branch: string;
  contracts: Record<ContractState, string>;
  term: {
    width: number;
    toolCall: string;
    toolResult: string;
    draft: string;
    running: { still: string; frames: string[] };
    ready: { still: string; frames: string[] };
    accepted: string;
  };
  approval: { title: string; lines: string[] };
  acceptance: { title: string; lines: string[] };
  evidence: { passed: number; total: number; judgments: number };
}

let memo: Promise<Walkthrough> | undefined;
/** Rendered once per build and shared by the page and the contract routes. */
export const walkthrough = () => (memo ??= build());

async function build(): Promise<Walkthrough> {
  const [{ validateBrief, briefFingerprint }, { renderBrief }, tui, ui] = await Promise.all([
    load('workflows/change-brief.mjs'),
    load('scripts/change-render.mjs'),
    load('workflows/change-tui.mjs'),
    load('workflows/change-ui.mjs'),
  ]);

  const previous = validateBrief(readBrief(1));
  const brief = validateBrief(readBrief(2));
  if (brief.id !== previous.id || brief.revision !== previous.revision + 1) {
    throw new Error('walkthrough fixture: revision 2 must revise revision 1 of the same change');
  }
  const briefHash = briefFingerprint(brief);
  const runId = `${brief.id}-${briefHash.slice(0, 8)}`;
  const branch = `ideation/${runId}`;
  const source = 'c41e09d7b2a8f3615e0d2b9c7a4f18e3d5b60a92';
  const commands = brief.acceptance.filter((a: any) => a.check.cmd);
  const judgments = brief.acceptance.filter((a: any) => a.check.judgment);

  const unit = (u: any, i: number, done: number, active: number) => ({
    id: u.id,
    title: u.title,
    state: i < done ? 'completed' : i === active ? 'running' : 'ready',
    attempts: i <= Math.max(done - 1, active) ? 1 : 0,
    reviewStatus: i < done ? 'passed' : 'not-run',
    summary: i < done ? `${u.goal} Reviewed independently.` : undefined,
    commitHash: i < done ? `${(0x5eedbed + i * 0x1f3a7).toString(16)}` : undefined,
  });
  const evidence = (n: number) =>
    commands.slice(0, n).map((a: any, i: number) => ({
      criterionId: a.id,
      status: 'passed',
      sourceRevision: source,
      command: a.check.cmd,
      output: a.check.cmd.startsWith('pnpm typecheck') ? 'Found 0 errors.' : `${6 + i * 3} tests passed`,
      durationMs: 1800 + i * 1370,
    }));
  const base = {
    id: runId,
    brief,
    briefHash,
    branch,
    workspace: `.git/ideation/workspaces/${runId}`,
    baseRevision: '9d27a61f0c4b8e53d1a2f6c90b7e4d3a18c5f207',
    usage: { totalTokens: 0 },
    feedback: [],
  };
  const running = {
    ...base,
    state: 'running',
    activeStage: 'build',
    elapsedMs: 377_000,
    sourceRevision: undefined,
    updatedAt: '2026-09-24T15:06:17Z',
    usage: { totalTokens: 61_240 },
    units: brief.units.map((u: any, i: number) => unit(u, i, 2, 2)),
    evidence: [],
  };
  const ready = {
    ...base,
    state: 'ready-for-review',
    elapsedMs: 694_000,
    sourceRevision: source,
    updatedAt: '2026-09-24T15:11:34Z',
    usage: { totalTokens: 118_905 },
    units: brief.units.map((u: any, i: number) => unit(u, i, 4, -1)),
    evidence: evidence(commands.length),
  };
  const accepted = {
    ...ready,
    state: 'accepted',
    updatedAt: '2026-09-24T15:40:02Z',
    decisions: [
      { type: 'accept', sourceRevision: source, judgments: judgments.map((j: any) => j.id), at: '2026-09-24T15:40:02Z' },
    ],
  };

  const contracts = {
    proposed: renderBrief(previous),
    revised: renderBrief(brief, { previous }),
    running: renderBrief(brief, { previous, run: running }),
    ready: renderBrief(brief, { previous, run: ready }),
    accepted: renderBrief(brief, { previous, run: accepted }),
  } satisfies Record<ContractState, string>;

  /* Widget frames. The clock is the only thing the fixture drives. */
  const WIDTH = 80;
  const url = (s: ContractState) => `${SITE}${contractHref(s)}`;
  const still = (run: any, s: ContractState) =>
    screen(tui.createProgressWidget(run, url(s), theme, helpers), WIDTH, `${s} widget`);
  const flipbook = (history: any[], s: ContractState, seconds: number, what: string) => {
    let clock = 0;
    const motion = tui.createMotion(() => clock);
    let current = history[0];
    const widget = tui.createLiveProgressWidget(() => ({ run: current, url: url(s) }), theme, helpers, motion);
    for (const run of history) motion.observe((current = run));
    const frames: string[] = [];
    for (let ms = 0; ms <= seconds * 1000; ms += 100) {
      clock = ms;
      frames.push(screen(widget, WIDTH, what));
    }
    return frames;
  };

  // Live work loops at a constant recorded state: spinner, shimmer and the
  // shine on already-filled cells move; no count changes.
  const runningFrames = flipbook([running], 'running', 4, 'running widget');
  // Ready celebrates once, because the transition from verifying is observed,
  // then settles on its final frame.
  const verifying = { ...ready, state: 'verifying', activeStage: 'acceptance' };
  const readyFrames = flipbook([verifying, ready], 'ready', 2.6, 'ready widget');

  const toolCall = screen(tui.createChangeToolCall({ action: 'prepare', brief: previous }, theme, helpers), WIDTH, 'tool call');
  const toolResult = screen(
    tui.createChangeToolResult(
      { details: { approved: false, title: previous.title, url: url('proposed') } },
      {},
      theme,
      helpers,
    ),
    WIDTH,
    'tool result',
  );

  const p = ui.progressSummary(ready);
  if (p.passed !== p.total || !p.pendingJudgments) {
    throw new Error('walkthrough fixture: ready run must verify every check and leave a judgment pending');
  }

  return {
    brief,
    previous,
    fingerprint: briefHash,
    previousFingerprint: briefFingerprint(previous),
    runId,
    branch,
    contracts,
    term: {
      width: WIDTH,
      toolCall,
      toolResult,
      draft: still({ ...base, brief: previous, state: 'draft', units: [], evidence: [] }, 'proposed'),
      running: { still: runningFrames[0], frames: runningFrames },
      ready: { still: readyFrames.at(-1)!, frames: readyFrames },
      accepted: still(accepted, 'accepted'),
    },
    approval: {
      title: 'Approve change?',
      // As the extension assembles it: the starting point sits just above the question.
      lines: [
        ...ui.approvalText(brief).split('\n').flatMap((line: string, i: number, all: string[]) =>
          i === all.length - 1 ? [`Starting point: ${base.baseRevision.slice(0, 12)}.`, line] : [line]),
        `Brief: v${brief.revision} / ${briefHash.slice(0, 12)}`,
        'Contract: open full agreement',
      ],
    },
    acceptance: {
      title: 'Accept change?',
      lines: [...ui.acceptanceText(ready).split('\n'), `Candidate: ${source.slice(0, 12)}`, 'Contract: open evidence and judgments'],
    },
    evidence: { passed: p.passed, total: p.total, judgments: p.judgments },
  };
}
