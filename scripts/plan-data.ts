// Load, validate and version plan data, and derive the frozen run contract
// (the change brief) from an approved plan. Validation follows
// workflows/change-brief.mjs: hand-written checks that throw a TypeError
// naming the JSON path, no validator framework.
import { readFileSync } from 'node:fs';
import { briefFingerprint, validateBrief } from '../workflows/change-brief.mjs';
import {
  DECISION_STATES, EXHIBIT_KINDS, GATE_KEYS, MAX_CLAIMS, MAX_DEPTH, QUESTION_TYPES, RISKS, SCOPE_TIERS,
  type Claim, type Decision, type Plan, type RunContract,
} from '../schemas/plan.ts';

const fail = (at: string, why: string): never => { throw new TypeError(`${at}: ${why}`); };
function object(value: any, keys: readonly string[], required: readonly string[], at: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(at, 'expected object');
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${at}.${key}`, 'unknown field');
  for (const key of required) if (value[key] === undefined) fail(`${at}.${key}`, 'required');
}
function str(value: any, at: string, nonempty = true) {
  if (typeof value !== 'string' || (nonempty && !value.trim())) fail(at, nonempty ? 'expected nonempty string' : 'expected string');
}
function list(value: any, at: string, each: (v: any, at: string) => void) {
  if (!Array.isArray(value)) fail(at, 'expected array');
  value.forEach((v: any, i: number) => each(v, `${at}[${i}]`));
}
const strings = (value: any, at: string) => list(value, at, str);
function oneOf(value: any, allowed: readonly unknown[], at: string) {
  if (!allowed.includes(value)) fail(at, `expected one of ${allowed.join(', ')}`);
}
function slug(value: any, at: string) {
  if (typeof value !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) fail(at, 'expected lowercase slug');
}
/** Records each id once; a repeat fails at the repeat's path. */
function ids(kind: string) {
  const seen = new Set<string>();
  return (id: string, at: string) => { if (seen.has(id)) fail(at, `duplicate ${kind} ID "${id}"`); seen.add(id); };
}
function check(c: any, at: string) {
  const cmd = c && typeof c === 'object' && !Array.isArray(c) && Object.hasOwn(c, 'cmd');
  const keys = cmd ? ['cmd', 'expect'] : ['judgment'];
  if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).some(k => !keys.includes(k)) || (!cmd && !Object.hasOwn(c, 'judgment'))) {
    fail(at, 'expected {cmd, expect?} or {judgment}');
  }
  if (cmd) { str(c.cmd, `${at}.cmd`); if (c.expect !== undefined) str(c.expect, `${at}.expect`); }
  else str(c.judgment, `${at}.judgment`);
}

function decision(d: any, at: string) {
  object(d, ['id', 'question', 'options', 'recommended', 'reason', 'required', 'state', 'answer', 'rejected'],
    ['id', 'options', 'recommended', 'reason', 'required', 'state', 'rejected'], at);
  str(d.id, `${at}.id`); str(d.reason, `${at}.reason`);
  // A recorded decision (answered or kept) may lack a question and alternatives; an open one may not.
  const open = d.state === 'not-opened';
  if (open || d.question !== undefined) str(d.question, `${at}.question`);
  const values = ids('option');
  list(d.options, `${at}.options`, (o, oat) => {
    object(o, ['value', 'label'], ['value', 'label'], oat);
    str(o.value, `${oat}.value`); str(o.label, `${oat}.label`);
    values(o.value, `${oat}.value`);
  });
  if (d.options.length < (open ? 2 : 1)) fail(`${at}.options`, open ? 'expected at least 2 options' : 'expected at least 1 option');
  const option = (value: any, vat: string) => {
    if (!d.options.some((o: any) => o.value === value)) fail(vat, `${JSON.stringify(value)} is not an option`);
  };
  option(d.recommended, `${at}.recommended`);
  if (typeof d.required !== 'boolean') fail(`${at}.required`, 'expected boolean');
  oneOf(d.state, DECISION_STATES, `${at}.state`);
  if (d.state === 'answered') option(d.answer, `${at}.answer`);
  else if (d.answer !== undefined) fail(`${at}.answer`, `only an answered decision has an answer (state is ${d.state})`);
  const chosen = chosenValue(d);
  list(d.rejected, `${at}.rejected`, (r, rat) => {
    object(r, ['value', 'reason'], ['value'], rat);
    option(r.value, `${rat}.value`); if (r.reason !== undefined) str(r.reason, `${rat}.reason`);
    if (r.value === chosen) fail(`${rat}.value`, 'the chosen option cannot be rejected');
  });
}
const chosenValue = (d: Decision) => d.state === 'answered' ? d.answer : d.state === 'kept' ? d.recommended : undefined;

/** Every claim in the tree, depth first, in document order. */
function* walk(claims: Claim[]): Generator<Claim> {
  for (const c of claims) { yield c; yield* walk(c.children ?? []); }
}

/** Strict plan check. Throws a TypeError naming the JSON path; returns the plan unchanged. */
export function validate(plan: any): Plan {
  const p = plan;
  object(p, ['schemaVersion', 'id', 'title', 'version', 'supersedes', 'why', 'change', 'mustHold', 'gates', 'stoppedEarly',
    'claims', 'checks', 'openQuestions', 'units', 'authority', 'scope'],
  ['schemaVersion', 'id', 'title', 'version', 'supersedes', 'why', 'change', 'mustHold', 'gates',
    'claims', 'checks', 'openQuestions', 'units', 'authority', 'scope'], 'plan');
  if (p.schemaVersion !== 1) fail('schemaVersion', 'expected 1');
  slug(p.id, 'id'); str(p.title, 'title');
  if (!Number.isSafeInteger(p.version) || p.version < 1) fail('version', 'expected integer >= 1');
  if (p.supersedes !== null) str(p.supersedes, 'supersedes');
  list(p.why, 'why', (w, at) => { object(w, ['quote', 'from'], ['quote', 'from'], at); str(w.quote, `${at}.quote`); str(w.from, `${at}.from`); });
  object(p.change, ['before', 'after'], ['before', 'after'], 'change');
  str(p.change.before, 'change.before', false); str(p.change.after, 'change.after', false);
  strings(p.mustHold, 'mustHold');

  object(p.gates, GATE_KEYS, GATE_KEYS, 'gates');
  for (const key of GATE_KEYS) {
    const g = p.gates[key], at = `gates.${key}`;
    object(g, ['ready', 'evidence'], ['ready', 'evidence'], at);
    if (typeof g.ready !== 'boolean') fail(`${at}.ready`, 'expected boolean');
    str(g.evidence, `${at}.evidence`, g.ready);
  }
  if (p.stoppedEarly !== undefined) str(p.stoppedEarly, 'stoppedEarly');

  const claimId = ids('claim'), decisionId = ids('decision');
  const claims = (cs: any, at: string, level: number) => {
    if (!Array.isArray(cs)) fail(at, 'expected array');
    if (level > MAX_DEPTH && cs.length) fail(`${at}[0]`, `at most ${MAX_DEPTH} levels`);
    if (cs.length > MAX_CLAIMS) fail(`${at}[${MAX_CLAIMS}]`, level === 1 ? `at most ${MAX_CLAIMS} level-1 claims` : `at most ${MAX_CLAIMS} children`);
    list(cs, at, (c, cat) => {
      object(c, ['id', 'text', 'exhibit', 'decision', 'children'], ['id', 'text', 'exhibit'], cat);
      str(c.id, `${cat}.id`); claimId(c.id, `${cat}.id`); str(c.text, `${cat}.text`);
      const e = c.exhibit, eat = `${cat}.exhibit`;
      object(e, ['kind', 'src', 'lines', 'ref', 'body', 'sketch'], ['kind', 'sketch'], eat);
      oneOf(e.kind, EXHIBIT_KINDS, `${eat}.kind`);
      for (const k of ['src', 'lines', 'ref', 'body']) if (e[k] !== undefined) str(e[k], `${eat}.${k}`);
      if (e.src === undefined && e.body === undefined) fail(eat, 'expected src or body');
      if (typeof e.sketch !== 'boolean') fail(`${eat}.sketch`, 'expected boolean');
      if (c.decision !== undefined) { decision(c.decision, `${cat}.decision`); decisionId(c.decision.id, `${cat}.decision.id`); }
      if (c.children !== undefined) claims(c.children, `${cat}.children`, level + 1);
    });
  };
  claims(p.claims, 'claims', 1);

  const checkId = ids('check');
  list(p.checks, 'checks', (c, at) => {
    object(c, ['id', 'criterion', 'check'], ['id', 'criterion', 'check'], at);
    slug(c.id, `${at}.id`); checkId(c.id, `${at}.id`); str(c.criterion, `${at}.criterion`);
    check(c.check, `${at}.check`);
  });

  const questionId = ids('question');
  list(p.openQuestions, 'openQuestions', (q, at) => {
    object(q, ['id', 'question', 'gate', 'type', 'blockedBy'], ['id', 'question', 'gate', 'type'], at);
    str(q.id, `${at}.id`); questionId(q.id, `${at}.id`); str(q.question, `${at}.question`);
    oneOf(q.gate, GATE_KEYS, `${at}.gate`); oneOf(q.type, QUESTION_TYPES, `${at}.type`);
    if (q.blockedBy !== undefined) strings(q.blockedBy, `${at}.blockedBy`);
  });

  const unitId = ids('unit');
  const checkIds = new Set(p.checks.map((c: any) => c.id));
  const claimIds = new Set([...walk(p.claims)].map(c => c.id));
  list(p.units, 'units', (u, at) => {
    object(u, ['id', 'title', 'goal', 'risk', 'design', 'needs', 'checkIds', 'claimIds'], ['id', 'title', 'goal', 'risk', 'needs', 'checkIds', 'claimIds'], at);
    slug(u.id, `${at}.id`); unitId(u.id, `${at}.id`); str(u.title, `${at}.title`); str(u.goal, `${at}.goal`);
    oneOf(u.risk, RISKS, `${at}.risk`);
    if (u.design !== undefined) str(u.design, `${at}.design`);
    strings(u.needs, `${at}.needs`); strings(u.checkIds, `${at}.checkIds`); strings(u.claimIds, `${at}.claimIds`);
    u.checkIds.forEach((id: string, i: number) => { if (!checkIds.has(id)) fail(`${at}.checkIds[${i}]`, `unknown check "${id}"`); });
    u.claimIds.forEach((id: string, i: number) => { if (!claimIds.has(id)) fail(`${at}.claimIds[${i}]`, `unknown claim "${id}"`); });
  });
  const unitIds = new Set(p.units.map((u: any) => u.id));
  p.units.forEach((u: any, ui: number) => u.needs.forEach((id: string, i: number) => {
    if (!unitIds.has(id)) fail(`units[${ui}].needs[${i}]`, `unknown unit "${id}"`);
  }));

  object(p.authority, ['paths', 'commands', 'allowLocalCommit'], ['paths', 'commands', 'allowLocalCommit'], 'authority');
  strings(p.authority.paths, 'authority.paths'); strings(p.authority.commands, 'authority.commands');
  if (typeof p.authority.allowLocalCommit !== 'boolean') fail('authority.allowLocalCommit', 'expected boolean');

  const tiers = [...SCOPE_TIERS, 'notChanging', 'dropped'];
  object(p.scope, tiers, tiers, 'scope');
  for (const t of tiers) strings(p.scope[t], `scope.${t}`);
  return p;
}

/**
 * What the plan critics (agents/plan-critic.md) review: every id a finding
 * cites, without exhibits. goals are the level-1 claims' ids; claims are the
 * whole tree, depth first. Deterministic: same plan, same view.
 */
export function criticView(plan: Plan) {
  validate(plan);
  const claims = [...walk(plan.claims)];
  const label = (d: Decision, value: string) => d.options.find(o => o.value === value)!.label;
  return {
    id: plan.id, title: plan.title, version: plan.version,
    why: plan.why.map(w => w.quote),
    goals: plan.claims.map(c => c.id),
    claims: claims.map(c => ({ id: c.id, text: c.text })),
    decisions: claims.flatMap(({ id: claim, decision: d }) => d ? [{
      id: d.id, claim, ...(d.question === undefined ? {} : { question: d.question }), state: d.state,
      options: d.options.map(o => o.label), recommended: label(d, d.recommended),
      ...(d.answer === undefined ? {} : { answer: label(d, d.answer) }),
    }] : []),
    checks: plan.checks,
    units: plan.units.map(({ id, title, risk, needs, checkIds, claimIds }) => ({ id, title, risk, needs, checkIds, claimIds })),
    scope: plan.scope,
    gates: plan.gates,
    openQuestions: plan.openQuestions,
  };
}

/** Reads and validates a plan file. */
export function load(path: string): Plan {
  let raw;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { throw new TypeError(`${path}: ${(e as Error).message}`); }
  return validate(raw);
}

/** The file a version is kept as once a newer one replaces it. */
const versionFile = (version: number) => `plan.v${version}.json`;

/** The versioning primitive: a copy one version on, superseding this one. The input is untouched.
 * Applying a response to that copy is the caller's job (Phase 3.1). */
export function nextVersion(plan: Plan): Plan {
  validate(plan);
  return { ...structuredClone(plan), version: plan.version + 1, supersedes: versionFile(plan.version) };
}

/**
 * Approval: freezes the plan into the run contract. Pure and deterministic.
 * Refuses while a required decision is not-opened, or while a gate isn't ready
 * unless the plan says planning stopped early. Whatever else the brief needs
 * (a why, mustHold, a covered acceptance, authority for every check command)
 * is enforced by validateBrief itself.
 */
export function toRunContract(plan: Plan): RunContract {
  validate(plan);
  const decisions = [...walk(plan.claims)].flatMap(c => c.decision ? [c.decision] : []);
  const unanswered = decisions.filter(d => d.required && d.state === 'not-opened').map(d => d.id);
  const notReady = plan.stoppedEarly ? [] : GATE_KEYS.filter(k => !plan.gates[k].ready);
  if (unanswered.length || notReady.length) {
    throw new Error(`plan ${plan.id} v${plan.version} is not approvable: ${[
      unanswered.length && `required decisions not answered: ${unanswered.join(', ')}`,
      notReady.length && `gates not ready: ${notReady.join(', ')}`,
    ].filter(Boolean).join('; ')}`);
  }
  const label = (d: Decision, value: string | undefined) => d.options.find(o => o.value === value)!.label;
  const brief = validateBrief({
    schemaVersion: 1,
    id: plan.id,
    title: plan.title,
    revision: plan.version,
    why: plan.why.map(w => w.quote).join(' '),
    change: plan.change,
    mustHold: plan.mustHold,
    outOfScope: plan.scope.notChanging,
    decisions: decisions.filter(d => d.state !== 'not-opened').map(d => ({
      decision: d.question === undefined ? label(d, chosenValue(d)) : `${d.question} ${label(d, chosenValue(d))}`,
      reason: d.reason,
      ...(d.rejected.length ? { rejected: d.rejected.map(r => r.reason === undefined ? label(d, r.value) : `${label(d, r.value)} (${r.reason})`).join('; ') } : {}),
    })),
    acceptance: plan.checks,
    units: plan.units.map(u => ({
      id: u.id, title: u.title, goal: u.goal, risk: u.risk, needs: u.needs, acceptanceIds: u.checkIds,
      ...(u.design === undefined ? {} : { design: u.design }),
    })),
    authority: plan.authority,
  });
  return { brief, fingerprint: briefFingerprint(brief), plan: versionFile(plan.version) };
}
