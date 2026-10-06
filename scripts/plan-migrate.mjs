#!/usr/bin/env node
// plan-migrate.mjs — convert a 0.x contract folder to plan data on read.
//
// Usage: node scripts/plan-migrate.mjs <folder> [--dry-run]
//
// A folder holding contract-data.json (a 0.x contract) or brief.json (the
// change workflow's run contract) and no plan.json gets plan.json v1 written
// beside its old files, which are never modified or deleted. migrate() is the
// pure mapping; migrateFolder() does the I/O. Every input field is either in
// CARRIED (where it goes) or DROPPED (why not), and the test walks every
// committed contract against both.
//
// A converted 0.x contract keeps change, mustHold and authority empty until the
// user revises it: it can be read and resumed, but not approved as converted.

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEGACY_LIMITS } from '../workflows/change-brief.mjs';
import { GATE_KEYS, MAX_CLAIMS, MAX_DEPTH } from '../schemas/plan.ts';
import { load, validate } from './plan-data.ts';
import { isEntryPoint, normalizeCriterion } from './verify.mjs';

/** Where each carried input field lands in the plan. Paths are rooted at migrate's input keys; `[]` is any array item. */
export const CARRIED = {
  'contractData.slug': 'id',
  'contractData.projectName': 'title',
  'contractData.supersedes': 'supersedes (when not null; otherwise "contract-data.json")',
  'contractData.problem[]': 'why[].quote, from "contract-data.json"',
  'contractData.gates.dimensions[].key': 'gates.<key>',
  'contractData.gates.dimensions[].status': 'gates.<key>.ready (status === "ready")',
  'contractData.gates.dimensions[].evidence': 'gates.<key>.evidence',
  'contractData.goals[]': 'level-1 claims, grouped when more than fit',
  'contractData.successCriteria[]': 'checks[].criterion (a plain-string criterion, judged by a human)',
  'contractData.successCriteria[].criterion': 'checks[].criterion; ids are criterion-<n>',
  'contractData.successCriteria[].check': 'checks[].check (a legacy string, via verify.mjs normalizeCriterion)',
  'contractData.successCriteria[].check.cmd': 'checks[].check.cmd',
  'contractData.successCriteria[].check.expect': 'checks[].check.expect',
  'contractData.successCriteria[].check.judgment': 'checks[].check.judgment',
  'contractData.scope.mvp[].item': 'scope.mvp',
  'contractData.scope.full[].item': 'scope.full',
  'contractData.scope.stretch[].item': 'scope.stretch',
  'contractData.scope.outOfScope[].item': 'scope.notChanging',
  'contractData.scope.future[]': 'scope.future',
  'contractData.decisions[].decision': 'an answered decision: its chosen option\'s label, and its claim\'s text',
  'contractData.decisions[].rejected': 'the decision\'s other option, listed in rejected[] without a reason',
  'contractData.decisions[].reason': 'the decision\'s reason',
  'contractData.openQuestions[].id': 'openQuestions[].id',
  'contractData.openQuestions[].question': 'openQuestions[].question',
  'contractData.openQuestions[].gate': 'openQuestions[].gate',
  'contractData.openQuestions[].type': 'openQuestions[].type',
  'contractData.openQuestions[].blockedBy[]': 'openQuestions[].blockedBy',
  'contractData.execution.phases[].title': 'units[].title, and units[].id slugged',
  'contractData.execution.phases[].prereqs[]': 'units[].needs, as the prerequisite\'s slugged id',
  'contractData.execution.phases[].risk': 'units[].risk ("low" when absent, as 0.x rendered it)',
  'contractData.execution.phases[].notes': 'units[].goal (the title when absent)',

  'brief.id': 'id',
  'brief.title': 'title',
  'brief.revision': 'version',
  'brief.why': 'why[0].quote, from "brief.json"',
  'brief.change.before': 'change.before',
  'brief.change.after': 'change.after',
  'brief.mustHold[]': 'mustHold',
  'brief.outOfScope[]': 'scope.notChanging',
  'brief.decisions[].decision': 'an answered decision: its chosen option\'s label, and its claim\'s text',
  'brief.decisions[].rejected': 'the decision\'s other option, listed in rejected[] without a reason',
  'brief.decisions[].reason': 'the decision\'s reason',
  'brief.acceptance[].id': 'checks[].id',
  'brief.acceptance[].criterion': 'checks[].criterion',
  'brief.acceptance[].check.cmd': 'checks[].check.cmd',
  'brief.acceptance[].check.expect': 'checks[].check.expect',
  'brief.acceptance[].check.judgment': 'checks[].check.judgment',
  'brief.units[].id': 'units[].id',
  'brief.units[].title': 'units[].title',
  'brief.units[].goal': 'units[].goal',
  'brief.units[].risk': 'units[].risk',
  'brief.units[].design': 'units[].design',
  'brief.units[].needs[]': 'units[].needs',
  'brief.units[].acceptanceIds[]': 'units[].checkIds',
  'brief.authority.paths[]': 'authority.paths',
  'brief.authority.commands[]': 'authority.commands',
  'brief.authority.allowLocalCommit': 'authority.allowLocalCommit',
};

const KEPT = 'stays in contract-data.json, which is kept unchanged beside plan.json';
const SCOPE_REASON = `Plan scope items are plain strings, so the item's reason ${KEPT}.`;

/** Input fields the plan does not carry, and why. A path also covers everything under it. */
export const DROPPED = [
  { path: 'contractData.date', reason: `Plan data has no dates: version and supersedes order it. The date ${KEPT}.` },
  { path: 'contractData.status', reason: 'A plan has no status: approval is freezing its run contract (toRunContract), and a converted plan, with empty change, mustHold and authority, must be revised before that whatever its 0.x status.' },
  { path: 'contractData.approvedOn', reason: `The 0.x approval approved the specs, not this plan; it ${KEPT}.` },
  { path: 'contractData.approvedBy', reason: `The 0.x approval approved the specs, not this plan; it ${KEPT}.` },
  { path: 'contractData.approvalMode', reason: '0.x routing between express and interactive review; a plan is approved by freezing its run contract, whichever way it was reviewed.' },
  { path: 'contractData.branch', reason: '0.x express isolation branch; a 1.0 run creates its own branch when it starts.' },
  { path: 'contractData.gates.passed', reason: 'Legacy count that 0.x already ignored; readiness comes from the dimensions.' },
  { path: 'contractData.gates.total', reason: 'Legacy count that 0.x already ignored; readiness comes from the dimensions.' },
  { path: 'contractData.gates.dimensions[].label', reason: 'Display name for the gate; plan gates are keyed by the fixed GATE_KEYS.' },
  ...['mvp', 'full', 'stretch', 'outOfScope'].map(tier => ({ path: `contractData.scope.${tier}[].reason`, reason: SCOPE_REASON })),
  { path: 'contractData.execution.strategy', reason: 'A label for the shape of the phase graph (Sequential, Hybrid); units[].needs carry the graph itself.' },
  { path: 'contractData.execution.phases[].blocking', reason: 'Display-only in 0.x (a chip in contract.html and contract.md); the engine orders by prereqs, which become needs.' },
  { path: 'contractData.execution.phases[].kind', reason: 'A unit has no kind: a 0.x review-gate phase becomes an ordinary unit, to be revised before a native run.' },
  { path: 'contractData.execution.phases[].specPath', reason: 'A unit has no spec path: 1.0 derives work packets from plan data. The spec files stay in the folder, and autopilot can still run the 0.x contract against them during 1.0.x.' },
  { path: 'contractData.execution.phases[].files', reason: 'A unit has no file hint, and authority.paths stays empty until the user revises; autopilot already takes files from the specs\' File Changes tables.' },

  { path: 'brief.schemaVersion', reason: 'The brief format\'s version; the plan has its own schemaVersion, and toRunContract writes the brief\'s.' },
  { path: 'brief.delegated', reason: 'Plan data has no list of choices delegated to the agent, so toRunContract emits none; brief.json keeps it.' },
  { path: 'brief.executionMode', reason: 'Plan data has no execution mode; toRunContract emits the default, strict.' },
  ...LEGACY_LIMITS.map(limit => ({ path: `brief.authority.${limit}`, reason: 'Runs have no budgets: validateBrief accepts and ignores legacy limits (LEGACY_LIMITS in workflows/change-brief.mjs).' })),
  { path: 'receipt', reason: 'Run evidence, not plan data: receipt.json stays beside plan.json untouched, and Riker\'s catch-up (receiptState) reads it in place.' },
];

const closedGates = () => Object.fromEntries(GATE_KEYS.map(k => [k, { ready: false, evidence: '' }]));
const noAuthority = () => ({ paths: [], commands: [], allowLocalCommit: true });
const slug = s => String(s).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Converts parsed 0.x inputs to a plan. Pure: no I/O, clock or randomness.
 * Takes contract-data.json or brief.json, not both; receipt.json carries
 * nothing into the plan (see DROPPED). The result passes validate.
 */
export function migrate({ contractData, brief } = {}) {
  if (contractData && brief) throw new Error('found both contract-data.json and brief.json; a folder converts from one of them, so move the other out');
  if (brief) return validate(fromBrief(structuredClone(brief)));
  if (contractData) return validate(fromContract(structuredClone(contractData)));
  throw new Error('nothing to convert: expected contract-data.json or brief.json');
}

function fromContract(c) {
  if (!c.gates && c.confidence) {
    throw new Error('contract-data.json uses the pre-gate `confidence` schema (0.14), which cannot be converted; regenerate it via ideation to produce the `gates` schema.');
  }
  const gates = closedGates();
  (c.gates?.dimensions ?? []).forEach((g, i) => {
    if (!GATE_KEYS.includes(g.key)) throw new TypeError(`gates.dimensions[${i}].key: unknown gate "${g.key}"`);
    gates[g.key] = { ready: g.status === 'ready', evidence: g.evidence ?? '' };
  });
  const items = list => (list ?? []).map(x => typeof x === 'string' ? x : x.item);
  const scope = c.scope ?? {};
  return {
    schemaVersion: 1,
    id: slug(c.slug ?? c.projectName),
    title: c.projectName,
    version: 1,
    supersedes: c.supersedes ?? 'contract-data.json',
    why: (c.problem ?? []).map(quote => ({ quote, from: 'contract-data.json' })),
    change: { before: '', after: '' },
    mustHold: [],
    gates,
    claims: claims(c.goals ?? [], c.decisions ?? [], 'contract-data.json'),
    checks: (c.successCriteria ?? []).map((raw, i) => {
      const { criterion, check } = normalizeCriterion(raw);
      // No check means a human judges the criterion itself, as 0.x rendered it.
      const plain = !check ? { judgment: criterion } : check.judgment !== undefined ? check : { cmd: check.cmd, ...(check.expect ? { expect: check.expect } : {}) };
      return { id: `criterion-${i + 1}`, criterion, check: plain };
    }),
    openQuestions: c.openQuestions ?? [],
    units: (c.execution?.phases ?? []).map(p => ({
      id: slug(p.title), title: p.title, goal: p.notes ?? p.title, risk: p.risk ?? 'low',
      needs: (p.prereqs ?? []).map(slug), checkIds: [], claimIds: [],
    })),
    authority: noAuthority(),
    scope: { mvp: items(scope.mvp), full: items(scope.full), stretch: items(scope.stretch), future: items(scope.future), notChanging: items(scope.outOfScope), dropped: [] },
  };
}

/** A brief is already run-contract shaped: each field maps 1:1, so toRunContract gives it back. */
function fromBrief(b) {
  return {
    schemaVersion: 1,
    id: b.id,
    title: b.title,
    version: b.revision,
    supersedes: 'brief.json',
    why: [{ quote: b.why, from: 'brief.json' }],
    change: b.change,
    mustHold: b.mustHold,
    gates: closedGates(),
    stoppedEarly: 'Converted from brief.json: the change workflow approves a brief without the planning gates.',
    claims: claims([], b.decisions ?? [], 'brief.json'),
    checks: b.acceptance,
    openQuestions: [],
    units: b.units.map(u => ({
      id: u.id, title: u.title, goal: u.goal, risk: u.risk, ...(u.design === undefined ? {} : { design: u.design }),
      needs: u.needs ?? [], checkIds: u.acceptanceIds, claimIds: [],
    })),
    authority: { paths: b.authority.paths, commands: b.authority.commands ?? [], allowLocalCommit: b.authority.allowLocalCommit ?? true },
    scope: { mvp: [], full: [], stretch: [], future: [], notChanging: b.outOfScope ?? [], dropped: [] },
  };
}

/**
 * The honest tree the data supports: one level-1 claim per goal (what someone
 * can now do or see), then one claim holding the recorded decisions, which 0.x
 * never tied to the claims they change. Every exhibit is a placeholder sketch.
 */
function claims(goals, decisions, file) {
  const exhibit = { kind: 'mock', body: `Converted from 0.x ${file}; it has no exhibit yet.`, sketch: true };
  const recorded = decisions.map((d, i) => ({
    text: d.decision,
    decision: {
      id: `decision-${i + 1}`,
      options: [{ value: 'chosen', label: d.decision }, ...(d.rejected ? [{ value: 'rejected', label: d.rejected }] : [])],
      recommended: 'chosen', reason: d.reason, required: true, state: 'answered', answer: 'chosen',
      rejected: d.rejected ? [{ value: 'rejected' }] : [],
    },
  }));
  const holder = recorded.length ? [{
    text: `${file} recorded ${recorded.length} decision${recorded.length === 1 ? '' : 's'}, not yet placed on the claims they change.`,
    children: fit(recorded, MAX_CLAIMS, MAX_DEPTH - 1, 'Decisions'),
  }] : [];
  const top = [...fit(goals.map(text => ({ text })), MAX_CLAIMS - holder.length, MAX_DEPTH, 'Goals'), ...holder];
  const number = (cs, prefix) => cs.map((c, i) => {
    const id = `${prefix}${i + 1}`;
    return { id, text: c.text, exhibit: { ...exhibit }, ...(c.decision ? { decision: c.decision } : {}), ...(c.children ? { children: number(c.children, `${id}.`) } : {}) };
  });
  return number(top, '');
}

/** Lays items out as at most `slots` claims over `levels` levels: as they are when they
 * fit, otherwise in groups of 5, 25, … under claims that say they are groups. */
function fit(items, slots, levels, what) {
  if (items.length <= slots) return items;
  let size = MAX_CLAIMS;
  while (Math.ceil(items.length / size) > slots) size *= MAX_CLAIMS;
  if (size > MAX_CLAIMS ** (levels - 1)) throw new RangeError(`${items.length} ${what.toLowerCase()} do not fit in ${levels} levels of at most ${MAX_CLAIMS} claims`);
  const groups = [];
  for (let i = 0; i < items.length; i += size) {
    const part = items.slice(i, i + size);
    groups.push({
      text: `${what} ${i + 1}–${i + part.length} of ${items.length}, grouped to fit at most ${MAX_CLAIMS} claims on a level.`,
      children: fit(part, MAX_CLAIMS, levels - 1, what),
    });
  }
  return groups;
}

function readJson(folder, name) {
  const path = join(folder, name);
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { throw new TypeError(`${path}: ${e.message}`); }
}

/** The parsed inputs migrate takes, read from a contract folder. */
export const readFolder = folder => ({
  contractData: readJson(folder, 'contract-data.json'), brief: readJson(folder, 'brief.json'), receipt: readJson(folder, 'receipt.json'),
});

/**
 * Writes plan.json beside a folder's 0.x files, which it never touches. An
 * existing plan.json is never overwritten: it is loaded and returned as is.
 */
export function migrateFolder(folder) {
  const path = join(folder, 'plan.json');
  if (existsSync(path)) return { path, plan: load(path), written: false };
  const plan = migrate(readFolder(folder));
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx' });
  try { renameSync(tmp, path); } catch (e) { rmSync(tmp, { force: true }); throw e; }
  return { path, plan, written: true };
}

function main([folder, ...flags]) {
  if (!folder || flags.some(f => f !== '--dry-run')) {
    console.error('Usage: node scripts/plan-migrate.mjs <folder> [--dry-run]');
    return 2;
  }
  try {
    if (flags.length) console.log(JSON.stringify(migrate(readFolder(folder)), null, 2));
    else {
      const { path, written } = migrateFolder(folder);
      console.log(written ? `wrote ${path}` : `${path} already exists; left as is`);
    }
    return 0;
  } catch (e) {
    console.error(e.message);
    return 1;
  }
}

if (isEntryPoint(import.meta.url)) process.exitCode = main(process.argv.slice(2));
