/*
 * run-report-gen — the post-flight document.
 *
 * An unattended autopilot run produces its most valuable data in the places
 * nobody is watching: the reviewer's findings, the phases that committed with
 * no review at all, the VERIFY line. All of it currently lives in a transcript
 * that scrolls away. This renders one self-contained HTML report from a
 * persisted run record so it survives the run.
 *
 * The record's WRITER is an LLM (the autopilot skill session transcribing the
 * engine's return value), which is why validation here is a trust boundary and
 * not a formality: enums are closed, buckets are cross-checked against
 * results[], and an invalid record is refused rather than rendered. A report
 * that misstates a run is worse than no report, because the reader calibrates
 * how much to trust the next unattended run on it.
 *
 * Sibling of contract-gen.ts and deliberately dumber than it: render input →
 * output, overwrite allowed. Phase 2 re-renders the same path after
 * verification runs, so there is no lineage or rename machinery here and no
 * --force — filename choice belongs to the caller.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(__dirname, 'run-report-gen.css'), 'utf8');

// --- Types ---------------------------------------------------------------
//
// This file is the only owner of the run-record schema — there is no separate
// schema file, and these interfaces are the documentation. The shape mirrors
// workflows/execute-contract.mjs's PHASE_RESULT_SCHEMA and summarize() return
// value verbatim, so the skill session transcribing the engine's output never
// has to translate anything. The two `as const` arrays below are what the
// drift test in run-report-gen.test.mjs compares against the engine's source.

/** Every per-phase outcome the engine can return. Mirrors
    PHASE_RESULT_SCHEMA.properties.result.enum. */
const PHASE_RESULTS = ['PASS', 'NO-OP', 'FAIL', 'SKIPPED'] as const;

/** How much review a phase actually got. This is the field that stops a run
    report showing a bare PASS for work nothing reviewed. Mirrors
    PHASE_RESULT_SCHEMA.properties.reviewStatus.enum. */
const REVIEW_STATUSES = [
  'passed', // reviewer ran and returned PASS (possibly after fix cycles)
  'validation-only', // no reviewer verdict; committed on validation alone
  'failed', // reviewer ran and still returned FAIL at the cycle cap
  'skipped-empty-diff', // nothing to review — an honest no-op
  'not-run', // never reached review (strict scout HOLD, build failure, skip)
] as const;

/** How the pi mining front door ended. Sourced from the sibling
    contract-data.json's intake.miningOutcome; absent on legacy contracts that
    predate the mining intake. Closed enum, mirroring the two above. */
const MINING_OUTCOMES = ['picked', 'rejected-all', 'dismissed'] as const;

type PhaseOutcome = (typeof PHASE_RESULTS)[number];
type ReviewStatus = (typeof REVIEW_STATUSES)[number];
type MiningOutcome = (typeof MINING_OUTCOMES)[number];

/** One phase's outcome, mirroring the engine's results[] entry verbatim. */
interface PhaseResult {
  title: string;
  result: PhaseOutcome;
  reviewStatus: ReviewStatus;
  /** null when nothing was committed — a no-op, a skip, or a failure */
  commitHash: string | null;
  summary: string;
  /** Reviewer findings. The data that evaporates today; every one renders. */
  findings: string[];
  warnings: string[];
  reviewCycles: number;
}

interface RunRecord {
  projectName: string;
  /** kebab-case, used in the RUN stdout line */
  slug: string;
  /** YYYY-MM-DD — the day the run finished */
  date: string;
  /** isolation branch, when the contract carries one */
  branch: string | null;
  /** the repo's default branch the review diff runs against (skill-detected at
      write time); null = unknown, and the report renders no diff command — a
      wrong base produces a misleading diff, which is worse than none */
  baseBranch: string | null;
  /** true when the run dispatched with strict semantics (express) */
  strict: boolean;
  summary: {
    completed: string[];
    noops: string[];
    failed: string[];
    skipped: string[];
    results: PhaseResult[];
  };
  /** null = verification had not run when this record was written */
  verify: { line: string; exitCode: number } | null;
  /** implementation-notes paths relative to the project dir, [] when none */
  notesFiles: string[];
  /** user-facing questions asked during intake (intake.questionsAsked in the
      sibling contract-data.json). Optional and additive: legacy contracts that
      predate the mining intake carry no intake block, so this is omitted and
      nothing renders. Note the naming asymmetry — the contract stores
      questionsAsked, the run record exposes questionCount. */
  questionCount?: number;
  /** how the mining front door ended (intake.miningOutcome in the sibling
      contract-data.json). Optional and additive; omitted on legacy contracts. */
  miningOutcome?: MiningOutcome;
}

/** Which bucket a given result belongs in. The engine's summarize() derives
    the buckets from results[], so in the engine this mapping is a tautology —
    here it is the transcription guard on the LLM that retyped both sides. */
const BUCKETS = [
  ['completed', 'PASS'],
  ['noops', 'NO-OP'],
  ['failed', 'FAIL'],
  ['skipped', 'SKIPPED'],
] as const;

// --- Validation ----------------------------------------------------------
//
// Every violation is collected and returned; the CLI prints them together and
// exits before any filesystem side effect. One fix pass, not one per run.

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** What the reader needs to see instead of "expected string": the thing that
    was actually there, named in prose rather than as a typeof token. */
function typeName(v: unknown): string {
  if (v === undefined) return 'nothing (the field is absent)';
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'string') return `the string "${v}"`;
  return `a ${typeof v}`;
}

function validateRecord(data: unknown): string[] {
  const errors: string[] = [];

  if (!isObject(data)) {
    errors.push(
      `the record root: expected a JSON object carrying projectName, slug, date, branch, baseBranch, strict, summary, verify and notesFiles — got ${typeName(data)}`,
    );
    return errors;
  }

  const requireString = (path: string, value: unknown): boolean => {
    if (typeof value !== 'string' || value.trim() === '') {
      errors.push(
        `${path}: expected a non-empty string, got ${typeName(value)}`,
      );
      return false;
    }
    return true;
  };

  const requireStringArray = (path: string, value: unknown): boolean => {
    if (!Array.isArray(value)) {
      errors.push(
        `${path}: expected an array of strings ([] when there are none), got ${typeName(value)}`,
      );
      return false;
    }
    let ok = true;
    value.forEach((entry, i) => {
      if (typeof entry !== 'string' || entry.trim() === '') {
        errors.push(
          `${path}[${i}]: expected a non-empty string, got ${typeName(entry)}`,
        );
        ok = false;
      }
    });
    return ok;
  };

  const requireEnum = (
    path: string,
    value: unknown,
    accepted: readonly string[],
  ): boolean => {
    if (typeof value !== 'string' || !accepted.includes(value)) {
      errors.push(
        `${path}: ${typeName(value)} is not one of ${accepted.join('|')}`,
      );
      return false;
    }
    return true;
  };

  // --- Provenance ---
  requireString('projectName', data.projectName);
  requireString('slug', data.slug);
  if (
    requireString('date', data.date) &&
    !/^\d{4}-\d{2}-\d{2}$/.test(data.date as string)
  ) {
    errors.push(
      `date: "${String(data.date)}" is not YYYY-MM-DD — the day the run finished`,
    );
  }
  if (data.branch !== null && typeof data.branch !== 'string') {
    errors.push(
      `branch: expected a string or null (null = the contract carried no isolation branch), got ${typeName(data.branch)}`,
    );
  }
  if (data.baseBranch !== null && typeof data.baseBranch !== 'string') {
    errors.push(
      `baseBranch: expected a string or null (the default branch the review diff runs against; null = unknown, no diff command is rendered), got ${typeName(data.baseBranch)}`,
    );
  }
  if (typeof data.strict !== 'boolean') {
    errors.push(
      `strict: expected a boolean — true when the run dispatched with strict semantics — got ${typeName(data.strict)}`,
    );
  }

  // --- intake stats (optional, additive) ---
  // Sourced from the sibling contract-data.json at generation time; a record
  // may also carry them directly. Absent is always legal (legacy contracts);
  // present must be well-typed, and miningOutcome's enum is closed the same way
  // result/reviewStatus are — a junk value must never reach the flight strip.
  if (data.questionCount !== undefined) {
    if (
      typeof data.questionCount !== 'number' ||
      !Number.isInteger(data.questionCount) ||
      data.questionCount < 0
    ) {
      errors.push(
        `questionCount: expected a non-negative integer — user-facing questions asked at intake — got ${typeName(data.questionCount)}`,
      );
    }
  }
  if (data.miningOutcome !== undefined) {
    requireEnum('miningOutcome', data.miningOutcome, MINING_OUTCOMES);
  }

  // --- notesFiles ---
  // Rejecting URLs here rather than at render time: a report is a
  // self-contained file:// document, and an external href in it is a
  // correctness bug in the record, not something the renderer should
  // silently launder.
  if (requireStringArray('notesFiles', data.notesFiles)) {
    (data.notesFiles as string[]).forEach((path, i) => {
      if (path.includes('://')) {
        errors.push(
          `notesFiles[${i}]: "${path}" is a URL — notes paths must be relative to the project directory, because a report carries no external references`,
        );
      }
    });
  }

  // --- verify ---
  if (data.verify !== null) {
    if (!isObject(data.verify)) {
      errors.push(
        `verify: expected { line, exitCode } or null (null = verification had not run when this record was written), got ${typeName(data.verify)}`,
      );
    } else {
      requireString('verify.line', data.verify.line);
      if (
        typeof data.verify.exitCode !== 'number' ||
        !Number.isInteger(data.verify.exitCode)
      ) {
        errors.push(
          `verify.exitCode: expected an integer — the exit status of the verify run — got ${typeName(data.verify.exitCode)}`,
        );
      }
    }
  }

  // --- summary ---
  const summary = data.summary;
  if (!isObject(summary)) {
    errors.push(
      `summary: expected the engine's return shape { completed, noops, failed, skipped, results }, got ${typeName(summary)}`,
    );
    return errors;
  }

  // The engine only ever attaches `error` to a summary whose every bucket is
  // empty — it is the "the run threw before anything ran" shape. There is no
  // run to report on, so there is no report.
  if (summary.error !== undefined && summary.error !== null) {
    errors.push(
      `summary.error: run-level errors produce no report (nothing ran) — the record carries "${String(summary.error)}". Fix the run, do not render it.`,
    );
  }

  let structureOk = true;
  for (const [bucket] of BUCKETS) {
    if (!requireStringArray(`summary.${bucket}`, summary[bucket])) {
      structureOk = false;
    }
  }

  const results = summary.results;
  if (!Array.isArray(results)) {
    errors.push(
      `summary.results: expected an array of phase results (one per phase the run touched), got ${typeName(results)}`,
    );
    return errors;
  }

  // Same rationale as the summary.error rule: no phases ran, so there is no
  // run to report on. Rendering it would produce "0 of 0 phases completed",
  // "every phase in the plan finished" and a clean stamp — a document
  // describing a run that touched nothing as a successful one.
  if (results.length === 0) {
    errors.push(
      `summary.results: empty — a run that touched no phase has nothing to report (same rule as summary.error). Fix the run, do not render it.`,
    );
  }

  results.forEach((entry, i) => {
    const p = `summary.results[${i}]`;
    if (!isObject(entry)) {
      errors.push(
        `${p}: expected an object with title, result, reviewStatus, commitHash, summary, findings, warnings, reviewCycles — got ${typeName(entry)}`,
      );
      structureOk = false;
      return;
    }
    if (!requireString(`${p}.title`, entry.title)) structureOk = false;
    if (!requireEnum(`${p}.result`, entry.result, PHASE_RESULTS)) {
      structureOk = false;
    }
    requireEnum(`${p}.reviewStatus`, entry.reviewStatus, REVIEW_STATUSES);
    if (entry.commitHash !== null && typeof entry.commitHash !== 'string') {
      errors.push(
        `${p}.commitHash: expected a string or null (null = this phase committed nothing), got ${typeName(entry.commitHash)}`,
      );
    }
    // Empty is legal here, unlike everywhere else: the engine builds this
    // field as [...warnings, build.summary, review?.summary].filter(Boolean)
    // .join(' — '), which is '' when the build stage returned no prose and no
    // reviewer spoke. Demanding non-empty would refuse a faithful record.
    if (typeof entry.summary !== 'string') {
      errors.push(
        `${p}.summary: expected a string ("" when the engine's build and review stages produced no prose), got ${typeName(entry.summary)}`,
      );
      structureOk = false;
    }
    requireStringArray(`${p}.findings`, entry.findings);
    requireStringArray(`${p}.warnings`, entry.warnings);
    if (
      typeof entry.reviewCycles !== 'number' ||
      !Number.isInteger(entry.reviewCycles) ||
      entry.reviewCycles < 0
    ) {
      errors.push(
        `${p}.reviewCycles: expected a non-negative integer — how many review cycles this phase took — got ${typeName(entry.reviewCycles)}`,
      );
    }
  });

  // --- Cross-consistency -------------------------------------------------
  //
  // Runs only when the shapes above held: a record with a missing title or an
  // unknown result would otherwise produce a second, more confusing error
  // about the disagreement its own defect created.
  if (!structureOk) return errors;

  const phases = results as PhaseResult[];
  const indexesByTitle = new Map<string, number[]>();
  phases.forEach((r, i) => {
    const seen = indexesByTitle.get(r.title);
    if (seen) seen.push(i);
    else indexesByTitle.set(r.title, [i]);
  });

  for (const [bucket, expected] of BUCKETS) {
    (summary[bucket] as string[]).forEach((title, i) => {
      const found = indexesByTitle.get(title) ?? [];
      if (found.length === 0) {
        errors.push(
          `summary.${bucket}[${i}]: "${title}" appears in no summary.results[] entry — every bucketed title must name exactly one result, or the report states an outcome for a phase it cannot describe`,
        );
        return;
      }
      if (found.length > 1) {
        errors.push(
          `summary.${bucket}[${i}]: "${title}" matches ${found.length} summary.results[] entries (${found.join(', ')}) — phase titles must be unique within a run`,
        );
        return;
      }
      const actual = phases[found[0]].result;
      if (actual !== expected) {
        errors.push(
          `summary.${bucket}[${i}]: "${title}" is bucketed as ${bucket} (which means result "${expected}") but summary.results[${found[0]}].result is "${actual}" — the buckets and the results disagree about this phase`,
        );
      }
    });
  }

  phases.forEach((r, i) => {
    const bucket = BUCKETS.find(([, res]) => res === r.result)?.[0];
    if (!bucket) return;
    // Exactly one, not at least one. deriveFacts() takes its counts from the
    // bucket lengths, so a title listed twice in one bucket renders "2 of 1
    // phases completed" and "-1 did not complete": a record that disagrees
    // with itself, dressed as a measurement.
    const listed = (summary[bucket] as string[]).filter(
      t => t === r.title,
    ).length;
    if (listed === 0) {
      errors.push(
        `summary.results[${i}]: "${r.title}" has result "${r.result}" but is missing from summary.${bucket} — every result must also appear in its bucket, or the counts understate the run`,
      );
    } else if (listed > 1) {
      errors.push(
        `summary.results[${i}]: "${r.title}" appears ${listed} times in summary.${bucket} but names one summary.results[] entry — each result belongs to exactly one bucket slot, and the buckets are what the report counts`,
      );
    }
  });

  return errors;
}

/** Read intake stats from the sibling contract-data.json (same directory as
    the run record). The mining intake writes { intake: { questionsAsked,
    miningOutcome } } there at contract time; this maps questionsAsked →
    questionCount and closes miningOutcome's enum. A missing file, missing
    intake block, or junk value yields no field — legacy contracts predate the
    intake block, and the report must never render `undefined`. */
function readIntakeStats(inputPath: string): {
  questionCount?: number;
  miningOutcome?: MiningOutcome;
} {
  const sibling = join(dirname(resolve(inputPath)), 'contract-data.json');
  if (!existsSync(sibling)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(sibling, 'utf8'));
  } catch {
    return {};
  }
  if (!isObject(parsed) || !isObject(parsed.intake)) return {};
  const intake = parsed.intake;
  const out: { questionCount?: number; miningOutcome?: MiningOutcome } = {};
  if (
    typeof intake.questionsAsked === 'number' &&
    Number.isInteger(intake.questionsAsked) &&
    intake.questionsAsked >= 0
  ) {
    out.questionCount = intake.questionsAsked;
  }
  if (
    typeof intake.miningOutcome === 'string' &&
    (MINING_OUTCOMES as readonly string[]).includes(intake.miningOutcome)
  ) {
    out.miningOutcome = intake.miningOutcome as MiningOutcome;
  }
  return out;
}

// --- Helpers -------------------------------------------------------------

/** Escapes &, <, >, " — not '. Every attribute this file emits is
    double-quoted, which is what makes that safe; keep it that way. */
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

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

function cmdField(id: string, cmd: string): string {
  return `<div class="cmd">
            <span class="cmd-text" id="${id}">${esc(cmd)}</span>
            <button type="button" class="copy" data-copy="${id}">copy</button>
          </div>`;
}

/** Section head: a serif heading, an optional deck of one sentence, and an
    optional right-aligned count. */
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
  opts: { wash?: boolean; extra?: string } = {},
): string {
  return `
    <section class="band${opts.wash ? ' band-wash' : ''}${opts.extra ? ` ${opts.extra}` : ''}" id="${id}" aria-labelledby="${id}-h">
      <div class="wrap">
${inner}
      </div>
    </section>`;
}

const RESULT_CHIP: Record<PhaseOutcome, string> = {
  PASS: 'chip-go',
  'NO-OP': '',
  FAIL: 'chip-danger',
  SKIPPED: 'chip-caution',
};

/** Plain-language gloss on a reviewStatus. The enum member is the evidence and
    is always shown; this is what stops a reader guessing what it meant. */
const REVIEW_GLOSS: Record<ReviewStatus, string> = {
  passed: 'a reviewer returned PASS',
  'validation-only': 'the reviewer stage never produced a verdict',
  failed: 'the reviewer still returned FAIL at the cycle cap',
  'skipped-empty-diff': 'nothing to review — an honest no-op',
  'not-run': 'never reached review',
};

// --- Derived facts -------------------------------------------------------
//
// Everything the page states about itself is computed once, here, so a figure
// in the flight strip and the sentence that explains it downstream can never
// drift apart.

interface WarnRow {
  phase: string;
  text: string;
  severe: boolean;
}

interface VerifyCounts {
  commits: string;
  commitsOf: string;
  pass: string;
  fail: string;
  judgment: string;
}

interface Facts {
  phases: PhaseResult[];
  completed: number;
  noops: number;
  failed: number;
  skipped: number;
  reviewCycles: number;
  findingsCount: number;
  /** Every warning string in the record, in results order, with its phase. */
  warnRows: WarnRow[];
  /** Phases that left a commit that no reviewer passed. `commitHash !== null`
      is load-bearing: a healthy no-op carries reviewStatus
      'skipped-empty-diff' and committed nothing, and flagging it would make
      the warnings band fire on every clean run. */
  unreviewed: PhaseResult[];
  showWarnings: boolean;
  /** Counts parsed out of the VERIFY line FOR DISPLAY ONLY, and all-or-
      nothing: a partial match renders no cells rather than an `undefined`
      dressed up as a measurement. */
  verifyCounts: VerifyCounts | null;
  verifyState: 'ok' | 'fail' | 'not-run';
  /** Intake stats, present only when the sibling contract-data.json carried an
      intake block (mining intake). Omitted for legacy contracts. */
  questionCount?: number;
  miningOutcome?: MiningOutcome;
}

function deriveFacts(d: RunRecord): Facts {
  const phases = d.summary.results;
  const warnRows: WarnRow[] = [];
  for (const p of phases) {
    for (const text of p.warnings) {
      warnRows.push({
        phase: p.title,
        text,
        // The engine's UNREVIEWED prefix and any warning on a failed phase are
        // the two that must not read as housekeeping.
        severe: p.result === 'FAIL' || text.includes('UNREVIEWED'),
      });
    }
  }
  const unreviewed = phases.filter(
    p => p.commitHash !== null && p.reviewStatus !== 'passed',
  );

  const m = d.verify?.line.match(
    /commits=(\d+)\/(\d+)\s+pass=(\d+)\s+fail=(\d+)\s+judgment=(\d+)/,
  );

  return {
    phases,
    completed: d.summary.completed.length,
    noops: d.summary.noops.length,
    failed: d.summary.failed.length,
    skipped: d.summary.skipped.length,
    reviewCycles: phases.reduce((n, p) => n + p.reviewCycles, 0),
    findingsCount: phases.reduce((n, p) => n + p.findings.length, 0),
    warnRows,
    unreviewed,
    showWarnings: warnRows.length > 0 || unreviewed.length > 0,
    verifyCounts: m
      ? {
          commits: m[1],
          commitsOf: m[2],
          pass: m[3],
          fail: m[4],
          judgment: m[5],
        }
      : null,
    verifyState: !d.verify ? 'not-run' : d.verify.exitCode === 0 ? 'ok' : 'fail',
    questionCount: d.questionCount,
    miningOutcome: d.miningOutcome,
  };
}

// --- Masthead ------------------------------------------------------------

const THEME_ICONS = `<svg class="i-auto" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="5"/><path d="M8 3v10" /><path d="M8 3a5 5 0 010 10z" fill="currentColor" stroke="none"/></svg>
      <svg class="i-light" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="3.1"/><path d="M8 1v1.6M8 13.4V15M15 8h-1.6M2.6 8H1M12.9 3.1l-1.1 1.1M4.2 11.8l-1.1 1.1M12.9 12.9l-1.1-1.1M4.2 4.2L3.1 3.1"/></svg>
      <svg class="i-dark" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M13.4 9.8A5.8 5.8 0 016.2 2.6a5.8 5.8 0 107.2 7.2z"/></svg>`;

/** The run's verdict as a stamp. Failures outrank unreviewed commits outrank
    clean, and the word is always present — the colour is the second signal. */
function runStamp(f: Facts): { cls: string; label: string } {
  if (f.failed > 0) return { cls: 'is-danger', label: 'failed' };
  if (f.showWarnings) return { cls: 'is-caution', label: 'warned' };
  if (f.verifyState === 'fail') return { cls: 'is-caution', label: 'unverified' };
  // Not measured is not clean: the report may have been rendered before
  // verification ran, in which case the completion predicate is unknown and a
  // `clean` stamp would contradict the two bands that say so.
  if (f.verifyState === 'not-run') return { cls: 'is-caution', label: 'pending' };
  return { cls: 'is-go', label: 'clean' };
}

/** One sentence naming what this run executed, then how it ended, assembled
    from the run's own numbers. The association comes first: a report can be
    opened cold, days later, from a directory of siblings — and the close
    band's contract link at the foot of the page is too late to orient the
    reader (a project literally named "Run Report" proved the masthead alone
    reads as tautology). */
function ledeFor(d: RunRecord, f: Facts): string {
  const total = f.phases.length;
  const parts = [
    `<strong>${f.completed} of ${total} ${plural(total, 'phase')} completed</strong>`,
  ];
  if (f.failed) parts.push(`${f.failed} failed`);
  if (f.skipped) parts.push(`${f.skipped} skipped`);
  if (f.noops) parts.push(`${f.noops} left an empty diff`);
  const review = f.unreviewed.length
    ? ` <strong>${f.unreviewed.length} ${plural(f.unreviewed.length, 'commit')} landed without a passing review.</strong>`
    : '';
  const findings = f.findingsCount
    ? ` ${f.findingsCount} reviewer ${plural(f.findingsCount, 'finding')} ${plural(f.findingsCount, 'is', 'are')} recorded below.`
    : ' No reviewer findings were recorded.';
  return `Execution record of the <a href="contract.html">${esc(d.projectName)} contract</a>: ${parts.join(', ')}.${review}${findings}`;
}

function buildMasthead(d: RunRecord, f: Facts): string {
  const stamp = runStamp(f);
  return `
    <header class="band masthead" id="top">
      <div class="wrap">
        <div class="masthead-top">
          <div>
            <div class="masthead-slug">
              <span class="masthead-mark" aria-hidden="true"></span>
              <span class="kicker">run report · ${esc(d.slug)}</span>
            </div>
            <h1>${esc(d.projectName)}</h1>
          </div>
          <div class="masthead-aside">
            <span class="stamp ${stamp.cls}">${stamp.label}</span>
            <div class="masthead-dates">
              <span class="meta">run ${esc(d.date)}</span>${
                d.branch
                  ? `\n              <span class="meta">branch ${esc(d.branch)}</span>`
                  : ''
              }${
                d.strict
                  ? `\n              <span class="meta">strict · unreviewed code does not land</span>`
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

/** The measurements that decide whether this run needs a human. Reading these
    is meant to be enough to know whether to read the rest. */
function buildFlightStrip(d: RunRecord, f: Facts): string {
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

  const total = f.phases.length;
  const seg = (p: PhaseResult) =>
    p.result === 'PASS'
      ? `<span class="m-pass"></span>`
      : p.result === 'FAIL'
        ? `<span class="m-fail"></span>`
        : p.result === 'SKIPPED'
          ? `<span class="m-warn"></span>`
          : `<span></span>`;

  const cells: string[] = [];

  cells.push(
    cell(
      'completed',
      `<span class="num">${pad2(f.completed)}</span><span class="fs-of">/${total}</span>`,
      f.completed === total
        ? 'every phase in the plan finished'
        : `${total - f.completed} did not complete`,
      `<div class="meter" aria-hidden="true">${f.phases.map(seg).join('')}</div>`,
    ),
  );

  cells.push(
    cell(
      'failed',
      `<span class="num">${pad2(f.failed)}</span>`,
      f.failed === 0
        ? 'no phase failed'
        : 'left unstaged — nothing was committed',
    ),
  );

  cells.push(
    cell(
      'no-op',
      `<span class="num">${pad2(f.noops)}</span>`,
      f.noops === 0
        ? 'every phase changed something'
        : 'empty diff — nothing was left to build',
    ),
  );

  cells.push(
    cell(
      'skipped',
      `<span class="num">${pad2(f.skipped)}</span>`,
      f.skipped === 0
        ? 'nothing was skipped'
        : 'never ran — a dependency did not land',
    ),
  );

  cells.push(
    cell(
      'review cycles',
      `<span class="num">${pad2(f.reviewCycles)}</span>`,
      f.reviewCycles === 0
        ? 'no phase went back for a fix'
        : `across ${f.phases.filter(p => p.reviewCycles > 0).length} ${plural(f.phases.filter(p => p.reviewCycles > 0).length, 'phase')} · 3 is the cap`,
    ),
  );

  // Intake stats, rendered only when the sibling contract-data.json carried
  // them (mining intake). Omitted entirely for legacy contracts — same
  // never-render-`undefined` rule as the verify counts below.
  if (typeof f.questionCount === 'number') {
    cells.push(
      cell(
        'intake questions',
        `<span class="num">${pad2(f.questionCount)}</span>`,
        f.questionCount === 1
          ? 'user-facing question asked at intake'
          : 'user-facing questions asked at intake',
      ),
    );
  }
  if (f.miningOutcome) {
    cells.push(
      cell(
        'mining',
        `<span class="num">${esc(f.miningOutcome)}</span>`,
        f.miningOutcome === 'picked'
          ? 'the human picked a mined option'
          : f.miningOutcome === 'rejected-all'
            ? 'reject-all — fell back to the classic interview'
            : 'the mining gate was dismissed',
      ),
    );
  }

  // Display-only, and all-or-nothing: a VERIFY line the regex does not
  // recognise contributes its exit code and nothing else. The line itself is
  // always rendered verbatim in the verification band.
  if (!d.verify) {
    cells.push(
      cell(
        'verify',
        `<span class="num">—</span>`,
        'verification had not run when this record was written',
      ),
    );
  } else if (f.verifyCounts) {
    const c = f.verifyCounts;
    cells.push(
      cell(
        'verify',
        `<span class="num">${c.fail}</span><span class="fs-of">fail</span>`,
        `commits ${c.commits}/${c.commitsOf} · ${c.pass} pass · ${c.judgment} for a human`,
      ),
    );
  } else {
    cells.push(
      cell(
        'verify',
        `<span class="num">${d.verify.exitCode}</span><span class="fs-of">exit</span>`,
        'the VERIFY line did not match the expected shape — read it below',
      ),
    );
  }

  return `        <div class="flightstrip">
${cells.join('\n')}
        </div>`;
}

// --- Warnings ------------------------------------------------------------
//
// Leads the document, on the same rule as the terminal report: the worst
// failure mode of a run report is reading clean when the run was not.

function buildWarnings(f: Facts): string {
  if (!f.showWarnings) return '';

  const severe = f.warnRows.some(w => w.severe) || f.unreviewed.length > 0;
  const groups: string[] = [];

  if (f.unreviewed.length) {
    groups.push(
      `        <div class="warn-group-head">
          <h3>Commits nothing passed</h3>
          <p>${f.unreviewed.length} of ${f.phases.length} ${plural(f.phases.length, 'phase')} left a commit without a passing review</p>
        </div>
${f.unreviewed
  .map(
    p => `        <div class="warn-row is-severe">
          <span class="warn-glyph" aria-hidden="true">!!</span>
          <div>
            <span class="warn-phase">${esc(p.title)}<span class="chip chip-danger">${esc(p.reviewStatus)}</span><span class="meta">${esc(p.commitHash ?? '—')}</span></span>
            <p class="warn-text">Committed as <strong>${esc(p.result)}</strong> — ${esc(REVIEW_GLOSS[p.reviewStatus])}. Read the diff for this phase before trusting it.</p>
          </div>
        </div>`,
  )
  .join('\n')}`,
    );
  }

  if (f.warnRows.length) {
    groups.push(
      `        <div class="warn-group-head">
          <h3>Warnings the run raised</h3>
          <p>verbatim, in run order</p>
        </div>
${f.warnRows
  .map(
    w => `        <div class="warn-row${w.severe ? ' is-severe' : ''}">
          <span class="warn-glyph" aria-hidden="true">${w.severe ? '!!' : '!'}</span>
          <div>
            <span class="warn-phase">${esc(w.phase)}</span>
            <p class="warn-text">${esc(w.text)}</p>
          </div>
        </div>`,
  )
  .join('\n')}`,
    );
  }

  const count = f.unreviewed.length + f.warnRows.length;
  return band(
    'warnings',
    `${secHead(
      'warnings',
      'Read this first',
      'A run that reads clean when it was not is the one failure this document exists to prevent. Everything below is verbatim from the run record.',
      `${count} to read`,
    )}
      <div class="warnstrip">
${groups.join('\n')}
      </div>`,
    { extra: `warnband${severe ? ' is-severe' : ''}` },
  );
}

// --- Phases --------------------------------------------------------------

function buildPhases(f: Facts): string {
  const phase = (p: PhaseResult, i: number): string => {
    const chip = RESULT_CHIP[p.result];
    return `      <article class="phase">
        <div class="phase-strip">
          <div class="ph-cell ph-title">
            <span class="ph-index">phase ${pad2(i + 1)}</span>
            <h3>${esc(p.title)}</h3>
          </div>
          <div class="ph-cell">
            <span class="kicker">result</span>
            <span><span class="chip${chip ? ` ${chip}` : ''}">${esc(p.result)}</span></span>
          </div>
          <div class="ph-cell">
            <span class="kicker">review</span>
            <span class="ph-val">${esc(p.reviewStatus)}</span>
          </div>
          <div class="ph-cell">
            <span class="kicker">commit</span>
            <span class="ph-val">${p.commitHash ? esc(p.commitHash) : '—'}</span>
          </div>
          <div class="ph-cell">
            <span class="kicker">cycles</span>
            <span class="ph-val num">${p.reviewCycles}</span>
          </div>
        </div>
        <div class="phase-body">
          ${
            p.summary.trim()
              ? `<p class="phase-summary">${esc(p.summary)}</p>`
              : `<p class="phase-summary placeholder">No summary text — the engine’s build and review stages produced none.</p>`
          }${
            p.findings.length
              ? `\n          <div class="findings">
            <div class="findings-head">
              <span class="kicker">findings</span>
              <span class="meta">${p.findings.length}</span>
            </div>
            <ul>
${p.findings.map(x => `              <li>${esc(x)}</li>`).join('\n')}
            </ul>
          </div>`
              : ''
          }${p.warnings
            .map(
              w =>
                `\n          <p class="phase-warn"><strong>Warning</strong> — ${esc(w)}</p>`,
            )
            .join('')}
        </div>
      </article>`;
  };

  return band(
    'phases',
    `${secHead(
      'phases',
      'Phases',
      `In run order, with every reviewer finding the run produced. ${f.findingsCount ? 'Findings are the data that dies in a transcript — this is the only place they survive.' : 'This run produced no findings.'}`,
      `${f.phases.length} ${plural(f.phases.length, 'phase')}`,
    )}
${f.phases.map(phase).join('\n')}`,
  );
}

// --- Verification --------------------------------------------------------

function buildVerification(d: RunRecord): string {
  if (!d.verify) {
    return band(
      'verify',
      `${secHead(
        'verify',
        'Verification',
        'The contract\u2019s completion predicate, run against the repository after the phases finished.',
      )}
      <div class="verify">
        <div>
          <p class="verify-line placeholder">Verification had not run when this record was written.</p>
          <p class="verify-note">This report was rendered from the run record as it stood at the end of the run. Re-render it after <code>scripts/verify.mjs</code> has run to fill this band in.</p>
        </div>
      </div>`,
    );
  }

  const ok = d.verify.exitCode === 0;
  return band(
    'verify',
    `${secHead(
      'verify',
      'Verification',
      'The contract\u2019s completion predicate, run against the repository after the phases finished. The line below is verbatim.',
    )}
      <div class="verify">
        <div>
          <p class="verify-line">${esc(d.verify.line)}</p>
          <p class="verify-note">Exit ${d.verify.exitCode} — ${
            ok
              ? 'every command criterion passed and every phase expected to commit did. Criteria marked for judgment still need a human to look.'
              : 'the contract is not yet satisfied. The counts above say which part: a missing commit means a phase never landed, a failing check means the work landed and does not hold.'
          }</p>
        </div>
        <span class="stamp ${ok ? 'is-go' : 'is-danger'}">${ok ? 'verified' : 'not verified'}</span>
      </div>`,
  );
}

// --- Close ---------------------------------------------------------------

/** The one instruction the reader leaves with. Phases alone do not finish a
    run — the contract's completion predicate does — so "done" is only said
    when verification says so, or the page would tell someone who was not
    watching to stop looking while the masthead stamp reads unverified. */
function closeAdvice(f: Facts): { head: string; body: string } {
  if (f.failed) {
    return {
      head: 'Fix the failures, then run again.',
      body: `${f.failed} ${plural(f.failed, 'phase')} left ${plural(f.failed, 'its', 'their')} changes unstaged. Autopilot skips phases that already have commits, so a second run picks up where this one stopped.`,
    };
  }
  if (f.showWarnings) {
    return {
      head: 'Read the diff before you trust this run.',
      body: 'Every phase landed, but not every commit was reviewed. The warnings band names which.',
    };
  }
  if (f.verifyState === 'fail') {
    return {
      head: 'Every phase passed. Verification did not.',
      body: 'Each phase completed with a passing review, but the contract’s completion predicate exited non-zero. The verification band says which part did not hold — a missing commit means a phase never landed, a failing check means the work landed and does not hold.',
    };
  }
  if (f.verifyState === 'not-run') {
    return {
      head: 'Verification has not run yet.',
      body: 'Every phase completed with a passing review, but nothing has checked the contract’s completion predicate, so this run is not finished. Run <code>scripts/verify.mjs</code> and re-render this report from the same record.',
    };
  }
  return {
    head: 'This run is done.',
    body: 'Every phase completed with a passing review, and verification passed.',
  };
}

function buildClose(d: RunRecord, f: Facts, recordPath: string): string {
  // Relative hrefs only: a report lives in the project directory next to the
  // contract and the notes it points at, and is opened over file:// where an
  // absolute path from the generating machine would be a dead link.
  const links = [
    `        <li><a href="contract.html">contract.html</a><span class="meta">the plan this run executed</span></li>`,
    ...d.notesFiles.map(
      n =>
        `        <li><a href="${esc(n)}">${esc(n)}</a><span class="meta">implementation notes</span></li>`,
    ),
  ];

  const advice = closeAdvice(f);

  return `
    <section class="band" id="close" aria-labelledby="close-h">
      <div class="wrap">
        <div class="close">
          <div>
            <span class="kicker">what to do next</span>
            <h2 id="close-h">${advice.head}</h2>
            <p>${advice.body}</p>
          </div>
          <div class="close-meta">
            <span class="stamp ${runStamp(f).cls}">${runStamp(f).label}</span>
            <span class="meta">${esc(d.date)}</span>
          </div>
        </div>
        <ul class="links">
${links.join('\n')}
        </ul>${
          d.branch && d.baseBranch
            ? `\n        <div class="review-cmd">
          ${cmdField('cmd-diff', `git diff ${d.baseBranch}...${d.branch}`)}
        </div>`
            : ''
        }
        <p class="colophon">Generated by <code>ideation:run-report-gen</code> from <code>${esc(recordPath)}</code>. That JSON is the source of truth for this page — edit the record and re-render rather than editing this file, which is overwritten in place.</p>
      </div>
    </section>`;
}

// --- Client behaviour ----------------------------------------------------

/* Deliberately dependency-free and written without template literals: this
   string is itself inside one. Everything below degrades to a readable
   document if it never runs. */
const CLIENT_JS = String.raw`
(function () {
  'use strict';

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
  document.querySelectorAll('.copy[data-copy]').forEach(function (btn) {
    btn.setAttribute('aria-live', 'polite');
    btn.addEventListener('click', function () {
      var target = document.getElementById(btn.dataset.copy);
      if (!target) return;
      var text = target.textContent.trim();
      /* Reports are opened over file://, where navigator.clipboard is absent
         entirely — reading it throws before any rejection handler could run,
         so the guard comes before the call. Select the text first so the
         "press ⌘C" fallback is a true instruction and not an excuse. */
      var manual = function () {
        if (window.getSelection && document.createRange) {
          var range = document.createRange();
          range.selectNodeContents(target);
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
  });

  /* ---- theme (auto -> light -> dark) ----------------------------------- */
  var themeBtn = document.getElementById('theme-toggle');
  if (themeBtn) {
    var KEY = 'ideation-run-report-theme';
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
})();
`;

function generate(d: RunRecord, f: Facts, recordPath: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>${esc(d.projectName)} — Run Report ${esc(d.date)}</title>
    <script>
      // Apply a saved forced theme before first paint to avoid a flash
      try {
        const saved = localStorage.getItem('ideation-run-report-theme');
        if (saved === 'light' || saved === 'dark')
          document.documentElement.dataset.theme = saved;
      } catch {}
    </script>
    <style>
${CSS}
    </style>
  </head>
  <body data-run-outcome="${esc(runStamp(f).label)}">
${buildMasthead(d, f)}
    <main>
${buildWarnings(f)}
${buildPhases(f)}
${buildVerification(d)}
${buildClose(d, f, recordPath)}
    </main>
    <script>${CLIENT_JS}</script>
  </body>
</html>
`;
}

// --- CLI -----------------------------------------------------------------

const { values } = parseArgs({
  options: {
    input: { type: 'string', short: 'i' },
    output: { type: 'string', short: 'o' },
  },
});

if (!values.input) {
  console.error(
    'Usage: run-report-gen.ts --input <run-record.json> --output <run-report.html>\n' +
      '  --input  the run record the autopilot session wrote for one run: the\n' +
      '           engine\'s {completed, noops, failed, skipped, results} summary\n' +
      '           plus provenance (projectName, slug, date, branch, baseBranch,\n' +
      '           strict), a\n' +
      '           nullable verify block, and notesFiles.\n' +
      '  --output where to write the report. Defaults to run-report.html in the\n' +
      '           current directory, and OVERWRITES it — the same run is\n' +
      '           re-rendered once verification has run, and choosing a\n' +
      '           per-run filename is the caller\'s job, not this tool\'s.',
  );
  process.exit(1);
}

if (!existsSync(values.input)) {
  console.error(
    `Cannot read the run record at ${values.input} — no such file. Nothing was written.`,
  );
  process.exit(1);
}

// Two separate failures, two separate messages: an unreadable path (a
// directory, a permission denial) is not a syntax error, and reporting it as
// "is not valid JSON: EISDIR" sends the reader to fix the wrong thing.
let raw: string;
try {
  raw = readFileSync(values.input, 'utf8');
} catch (err) {
  console.error(
    `Cannot read the run record at ${values.input}: ${(err as Error).message}\n` +
      '  Nothing was written.',
  );
  process.exit(1);
}

let parsed: unknown;
try {
  parsed = JSON.parse(raw);
} catch (err) {
  console.error(
    `${values.input} is not valid JSON: ${(err as Error).message}\n` +
      '  Nothing was written. A run record is a single JSON object.',
  );
  process.exit(1);
}

// The trust boundary. The record's writer is an LLM transcribing the engine's
// return value, so every violation is collected and reported together — one
// fix pass, not one per run — and this exits before mkdir or write, which are
// the only side effects below it. A record that misstates a run must not
// become a document that misstates a run.
const violations = validateRecord(parsed);
if (violations.length) {
  console.error(
    `${values.input} is not a valid run record — ${violations.length} ${plural(violations.length, 'violation')}:\n` +
      violations.map(v => `  ${v}`).join('\n') +
      '\n  Nothing was written. The record mirrors the workflow engine\u2019s return\n' +
      '  shape verbatim: summary.results[] carries one entry per phase, and\n' +
      '  summary.completed/noops/failed/skipped list those same titles by\n' +
      '  outcome. Fix the record against the engine\u2019s output, not against this\n' +
      '  message.',
  );
  process.exit(1);
}

// Merge the intake stats from the sibling contract-data.json. They are sourced
// there (not in the run record itself), so this happens after validation — a
// legacy contract with no intake block simply contributes nothing.
const record: RunRecord = { ...(parsed as RunRecord), ...readIntakeStats(values.input) };

// Name the record the way the reader can act on it: repo-relative when it sits
// inside the working directory, as given otherwise. An absolute path from the
// generating machine in a committed artifact is a dead reference.
const rel = relative(process.cwd(), resolve(values.input));
const recordPath = rel && !rel.startsWith('..') ? rel : values.input;

const outputPath = values.output ?? 'run-report.html';
const outputDir = dirname(outputPath);
if (outputDir && !existsSync(outputDir)) {
  mkdirSync(outputDir, { recursive: true });
}

// Derived once, here: the RUN line below and every figure in the page are the
// same numbers, so they cannot disagree about the run they describe.
const f = deriveFacts(record);

const html = generate(record, f, recordPath);
writeFileSync(outputPath, html, 'utf8');
console.log(`Generated ${outputPath} (${html.length} bytes)`);

// The machine-summarizable line: what a caller (or a /goal evaluator reading
// the transcript) needs without opening the report.
console.log(
  `RUN ${record.slug}: completed=${f.completed} noops=${f.noops} failed=${f.failed} skipped=${f.skipped} warnings=${f.warnRows.length} verify=${f.verifyState}`,
);
