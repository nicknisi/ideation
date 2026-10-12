// Load, validate and version plan data, and derive the frozen run contract
// (the change brief) from an approved plan. Validation follows
// workflows/change-brief.mjs: hand-written checks that throw a TypeError
// naming the JSON path, no validator framework.
//
// Usage:
//   node scripts/plan-data.ts critic-view <plan-folder>
//   node scripts/plan-data.ts run-contract <plan-folder>
//   node scripts/plan-data.ts manifest <plan-folder>
//
// critic-view prints what the plan critics review (criticView). run-contract
// is the Claude Code hand-off after approval: it writes run-contract.json
// (toRunContract) and one work packet per unit (unit-<id>.md, change-brief's
// workPacket) beside plan.json, for autopilot or execute-spec to run. Running
// it is not approval: skills/ideation runs it only after the user approved the
// plan in a terminal confirmation, and toRunContract still refuses a plan with
// an unanswered required decision or a gate that isn't ready. manifest prints
// the engine manifest autopilot runs for an approved plan (toManifest), with
// the units already committed on this branch (their trailers) as completed.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { briefFingerprint, validateBrief, workPacket } from '../workflows/change-brief.mjs';
import { commitBodies, hasTrailer, isEntryPoint, unitTrailer } from './verify.mjs';
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
/** Reader feedback: verbatim text, tagged with the version it was given on. */
function feedback(value: any, at: string) {
  list(value, at, (f, fat) => {
    object(f, ['version', 'text'], ['version', 'text'], fat);
    if (!Number.isSafeInteger(f.version) || f.version < 1) fail(`${fat}.version`, 'expected integer >= 1');
    str(f.text, `${fat}.text`);
  });
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
    'claims', 'checks', 'openQuestions', 'units', 'authority', 'scope', 'feedback'],
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
      object(c, ['id', 'text', 'exhibit', 'decision', 'children', 'feedback'], ['id', 'text', 'exhibit'], cat);
      str(c.id, `${cat}.id`); claimId(c.id, `${cat}.id`); str(c.text, `${cat}.text`);
      const e = c.exhibit, eat = `${cat}.exhibit`;
      object(e, ['kind', 'src', 'lines', 'ref', 'body', 'sketch'], ['kind', 'sketch'], eat);
      oneOf(e.kind, EXHIBIT_KINDS, `${eat}.kind`);
      for (const k of ['src', 'lines', 'ref', 'body']) if (e[k] !== undefined) str(e[k], `${eat}.${k}`);
      if (e.src === undefined && e.body === undefined) fail(eat, 'expected src or body');
      if (typeof e.sketch !== 'boolean') fail(`${eat}.sketch`, 'expected boolean');
      if (c.decision !== undefined) { decision(c.decision, `${cat}.decision`); decisionId(c.decision.id, `${cat}.decision.id`); }
      if (c.children !== undefined) claims(c.children, `${cat}.children`, level + 1);
      if (c.feedback !== undefined) feedback(c.feedback, `${cat}.feedback`);
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
  if (p.feedback !== undefined) feedback(p.feedback, 'feedback');
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
 * Applying a response to that copy is scripts/plan-respond.mjs's job. */
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

/** The packet's Implementation Details. Claude Code has no planner stage: the engine's scout and builder plan from current source. */
export const PACKET_PLAN = 'No plan was written ahead of this unit. Read the current source, then implement the goal above within the file changes below, and prove it with the validation commands.';

/** The packet file for a unit, beside plan.json; also the spec path its commit body names. */
export const packetFile = (unitId: string) => `unit-${unitId}.md`;

/**
 * Claude Code's hand-off after approval: writes run-contract.json and one
 * packet per unit beside plan.json. The packets come first, so a
 * run-contract.json on disk always has its packets. Throws (writing nothing)
 * when the plan is not approvable.
 */
export function writeRunContract(folder: string, sourceRevision: string) {
  const contract = toRunContract(load(join(folder, 'plan.json')));
  const packets = (contract.brief.units as { id: string }[]).map(u => {
    const path = join(folder, packetFile(u.id));
    writeFileSync(path, workPacket(contract.brief, u.id, { plan: PACKET_PLAN, sourceRevision }));
    return path;
  });
  const path = join(folder, 'run-contract.json');
  writeFileSync(path, JSON.stringify(contract, null, 2) + '\n');
  return { contract, path, packets };
}

/**
 * The run contract beside plan.json, once approved. Throws when there is none,
 * or when it no longer matches the plan: an edited plan is approved again
 * before anything runs from it.
 */
export function approvedRunContract(folder: string): RunContract {
  const path = join(folder, 'run-contract.json');
  if (!existsSync(path)) {
    throw new Error(`${folder} has no run-contract.json: the plan is not approved. Approve it in a terminal confirmation (skills/ideation's Approval), which writes run-contract.json.`);
  }
  const frozen = JSON.parse(readFileSync(path, 'utf8')) as RunContract;
  const plan = load(join(folder, 'plan.json'));
  if (frozen.fingerprint !== briefFingerprint(frozen.brief) || frozen.fingerprint !== toRunContract(plan).fingerprint) {
    throw new Error(`${path} no longer matches plan.json (v${plan.version}): the plan changed after approval. Approve the current version, which rewrites run-contract.json.`);
  }
  return frozen;
}

type Unit = { id: string; title: string; risk: string; needs: string[] };

/**
 * The engine manifest (workflows/README.md's args contract) Claude Code's
 * autopilot runs for an approved plan. Pure. Each unit is a phase whose spec is
 * its packet: packet, because the packets are approved; strict, because no
 * person reviewed the packets themselves; hostCommits off, because Claude
 * Code's commit stage is an agent, which adds each unit's trailer. `completed`
 * lists unit ids already committed.
 */
export function toManifest(contract: RunContract, projectDir: string, completed: string[] = []) {
  const brief = contract.brief as { id: string; title: string; units: Unit[]; authority: { paths: string[] } };
  const dir = projectDir.endsWith('/') ? projectDir : `${projectDir}/`;
  const titleOf = (id: string) => brief.units.find(u => u.id === id)!.title;
  return {
    projectName: brief.title, slug: brief.id, projectDir: dir, strict: true, packet: true, hostCommits: false,
    phases: brief.units.map(u => ({
      title: u.title, specPath: dir + packetFile(u.id), prereqs: u.needs.map(titleOf), risk: u.risk,
      files: brief.authority.paths, trailer: unitTrailer(brief.id, u.id),
    })),
    completedPhases: brief.units.filter(u => completed.includes(u.id)).map(u => u.title),
  };
}

/** toManifest for a plan folder: refuses an unapproved or stale plan and a missing
    packet, and reads which units this branch has committed from their trailers. */
export function manifestFor(folder: string, cwd = process.cwd()) {
  const contract = approvedRunContract(folder);
  const brief = contract.brief as { id: string; units: Unit[] };
  for (const u of brief.units) {
    if (!existsSync(join(folder, packetFile(u.id)))) throw new Error(`${join(folder, packetFile(u.id))} is missing: run run-contract again; never write a packet by hand.`);
  }
  const commits = commitBodies(folder);
  const completed = brief.units.filter(u => commits.some(c => hasTrailer(c.body, unitTrailer(brief.id, u.id)))).map(u => u.id);
  return toManifest(contract, relative(cwd, resolve(folder)) || '.', completed);
}

const USAGE = `Usage:
  node scripts/plan-data.ts critic-view <plan-folder>    print what the plan critics review
  node scripts/plan-data.ts run-contract <plan-folder>   write run-contract.json and unit packets
  node scripts/plan-data.ts manifest <plan-folder>       print the engine manifest for an approved plan
run-contract is not approval: run it only after the user approves the plan in the terminal.`;

function main(argv: string[]): number {
  const [command, folder, ...rest] = argv;
  if (!folder || rest.length || !['critic-view', 'run-contract', 'manifest'].includes(command)) { console.error(USAGE); return 2; }
  try {
    if (command === 'critic-view') { process.stdout.write(JSON.stringify(criticView(load(join(folder, 'plan.json'))), null, 2) + '\n'); return 0; }
    if (command === 'manifest') { process.stdout.write(JSON.stringify(manifestFor(folder), null, 2) + '\n'); return 0; }
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: folder, encoding: 'utf8' });
    const { contract, path, packets } = writeRunContract(folder, head.status === 0 ? head.stdout.trim() : 'unknown (not a git checkout)');
    console.log(`run contract: ${path} (${contract.brief.id} v${contract.brief.revision}, ${contract.fingerprint.slice(0, 12)})`);
    for (const p of packets) console.log(`packet: ${p}`);
    return 0;
  } catch (e) { console.error(`plan-data: ${(e as Error).message}`); return 1; }
}
if (isEntryPoint(import.meta.url)) process.exitCode = main(process.argv.slice(2));
