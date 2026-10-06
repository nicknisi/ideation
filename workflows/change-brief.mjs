import { createHash } from 'node:crypto';
import { validateCheck as validateCheckUncached } from '../scripts/verify.mjs';
import { isProtectedPath } from './change-workspace.mjs';
// validateCheck spawns a blocking `sh -n` per command. Briefs are re-validated on
// every fingerprint and render, so an unchanged command is parsed once (bounded).
const checkResults = new Map();
function validateCheck(check) {
  const key = JSON.stringify(check);
  if (checkResults.has(key)) return checkResults.get(key);
  const result = validateCheckUncached(check);
  if (checkResults.size >= 512) checkResults.clear();
  checkResults.set(key, result);
  return result;
}

const AUTHORITY_BOUNDS = {
  maxDurationMs: [1800000, 1000, 86400000], maxStageMs: [300000, 1, 86400000],
  maxTokens: [200000, 1, Number.MAX_SAFE_INTEGER], maxAttempts: [2, 1, 3],
  maxReviewCycles: [3, 1, 3], maxTurns: [40, 1, 100], maxToolCalls: [200, 1, 1000],
};
const textSchema = { type: 'string', minLength: 1, pattern: '\\S' };
const slugSchema = { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' };
const stringsSchema = { type: 'array', items: textSchema };
const shape = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });

/** Model-facing JSON Schema, owned beside normalization and semantic validation.
 * Plain data keeps the portable core and its tests independent of Pi/TypeBox.
 * Cross-field rules (graph validity, command authorization, protected paths) are
 * still enforced by validateBrief; a schema is not execution permission.
 */
export const briefSchema = {
  ...shape({
    schemaVersion: { type: 'integer', const: 1 },
    id: { ...slugSchema, description: 'Stable lowercase kebab-case change ID.' },
    title: textSchema,
    revision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    why: textSchema,
    change: shape({ before: textSchema, after: textSchema }),
    mustHold: { ...stringsSchema, minItems: 1, description: 'Invariants the implementation must preserve.' },
    outOfScope: stringsSchema,
    delegated: { ...stringsSchema, description: 'Implementation choices explicitly delegated to the agent.' },
    decisions: { type: 'array', items: shape({ decision: textSchema, reason: textSchema, rejected: textSchema }, ['decision', 'reason']) },
    acceptance: {
      type: 'array', minItems: 1,
      items: shape({
        id: slugSchema,
        criterion: textSchema,
        check: {
          description: 'Either a command that asserts success by exiting 0, or a human judgment. Never both.',
          anyOf: [
            shape({ cmd: textSchema, expect: { ...textSchema, description: 'Explanatory expected outcome; assertions belong in cmd.' } }, ['cmd']),
            shape({ judgment: textSchema }),
          ],
        },
      }),
    },
    units: {
      type: 'array', minItems: 1,
      items: shape({
        id: slugSchema, title: textSchema, goal: textSchema,
        risk: { type: 'string', enum: ['low', 'medium', 'high'] },
        needs: { type: 'array', items: slugSchema, uniqueItems: true, description: 'Prerequisite unit IDs; defaults to none.' },
        acceptanceIds: { type: 'array', items: slugSchema, minItems: 1, uniqueItems: true, description: 'Acceptance IDs covered by this unit; every criterion must belong to a unit.' },
        design: { ...textSchema, description: 'Required for high-risk units: interfaces, compatibility and rollback considerations.' },
      }, ['id', 'title', 'goal', 'risk', 'acceptanceIds']),
    },
    executionMode: { type: 'string', enum: ['strict', 'adaptive'], default: 'strict' },
    authority: shape({
      paths: { ...stringsSchema, minItems: 1, uniqueItems: true, description: 'Exact repo-relative files or directory prefixes ending in /. Dot permits ordinary project files, never protected internals or dependency manifests.' },
      commands: { ...stringsSchema, uniqueItems: true, description: 'Allowed exact shell commands. Include every acceptance cmd verbatim. Approved scripts run with host permissions, not in an OS sandbox.' },
      allowLocalCommit: { type: 'boolean', default: true },
      ...Object.fromEntries(Object.entries(AUTHORITY_BOUNDS).map(([key, [value, minimum, maximum]]) => [key, {
        type: 'integer', default: value, minimum, maximum,
        ...(key === 'maxStageMs' ? { description: 'Must not exceed maxDurationMs; set both when changing the total duration.' } : key === 'maxTokens' ? { description: 'Scheduling budget checked between workers; one running worker can overshoot it. Per-worker time/turn/tool limits still apply.' } : {}),
      }])),
    }, ['paths']),
  }, ['schemaVersion', 'id', 'title', 'revision', 'why', 'change', 'mustHold', 'acceptance', 'units', 'authority']),
  description: 'Inline compact change brief as a JSON OBJECT, not a JSON-encoded string. Supply this or path, never both. Preparation does not authorize execution.',
};

const fail = (at, why) => { throw new TypeError(`${at}: ${why}`); };
function object(value, keys, at) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(at, 'expected object');
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${at}.${key}`, 'unknown field');
}
function text(value, at) {
  if (typeof value !== 'string' || !value.trim() || /\0/.test(value)) fail(at, 'expected nonempty string');
  return value;
}
function list(value, at, map, nonempty = false) {
  if (!Array.isArray(value) || (nonempty && !value.length)) fail(at, 'expected nonempty array');
  return Array.from(value, (v, i) => map(v, `${at}[${i}]`));
}
const strings = (value, at, required = false) => list(value === undefined && !required ? [] : value, at, text, required);
function id(value, at) {
  if (typeof value !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) fail(at, 'expected lowercase slug');
  return value;
}
function integer(value, fallback, min, max, at) {
  const n = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(n) || n < min || n > max) fail(at, `expected integer ${min}..${max}`);
  return n;
}
function unique(values, at) {
  if (new Set(values).size !== values.length) fail(at, 'duplicate IDs or values');
}
function path(value, at) {
  text(value, at);
  if (value === '.') return value;
  if (/^[\/]|^[A-Za-z]:|[\\\x00-\x1f\x7f]/.test(value) || value !== value.trim()) fail(at, 'expected ordinary repo-relative path');
  const parts = value.replace(/\/$/, '').split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) fail(at, 'invalid path segment');
  if (isProtectedPath(value)) fail(at, 'protected internals or dependency manifests are not writable');
  return value;
}

/** Strict compact schema. Does not mutate input or grant execution authority. */
export function validateBrief(raw) {
  object(raw, Object.keys(briefSchema.properties), 'brief');
  if (raw.schemaVersion !== 1) fail('schemaVersion', 'expected 1');
  const b = { schemaVersion: 1, id: id(raw.id, 'id'), title: text(raw.title, 'title'), revision: integer(raw.revision, undefined, 1, Number.MAX_SAFE_INTEGER, 'revision'), why: text(raw.why, 'why') };
  object(raw.change, ['before','after'], 'change');
  b.change = { before: text(raw.change.before, 'change.before'), after: text(raw.change.after, 'change.after') };
  b.mustHold = strings(raw.mustHold, 'mustHold', true);
  b.outOfScope = strings(raw.outOfScope, 'outOfScope');
  b.delegated = strings(raw.delegated, 'delegated');
  b.decisions = list(raw.decisions === undefined ? [] : raw.decisions, 'decisions', (d, at) => {
    object(d, ['decision','reason','rejected'], at);
    return { decision: text(d.decision, `${at}.decision`), reason: text(d.reason, `${at}.reason`), ...(d.rejected === undefined ? {} : { rejected: text(d.rejected, `${at}.rejected`) }) };
  });
  b.acceptance = list(raw.acceptance, 'acceptance', (c, at) => {
    object(c, ['id','criterion','check'], at);
    object(c.check, ['cmd','expect','judgment'], `${at}.check`);
    const check = c.check;
    let normalized;
    if (Object.hasOwn(check, 'judgment')) {
      if (Object.hasOwn(check, 'cmd') || Object.hasOwn(check, 'expect')) fail(at, 'judgment and command are exclusive');
      normalized = { judgment: text(check.judgment, `${at}.judgment`) };
    } else {
      normalized = { cmd: text(check.cmd, `${at}.cmd`), ...(check.expect === undefined ? {} : { expect: text(check.expect, `${at}.expect`) }) };
      const error = validateCheck(normalized);
      if (error) fail(at, error);
    }
    return { id: id(c.id, `${at}.id`), criterion: text(c.criterion, `${at}.criterion`), check: normalized };
  }, true);
  unique(b.acceptance.map(c => c.id), 'acceptance');
  b.units = list(raw.units, 'units', (u, at) => {
    object(u, ['id','title','goal','risk','needs','acceptanceIds','design'], at);
    if (!['low','medium','high'].includes(u.risk)) fail(at, 'invalid risk');
    const unit = { id: id(u.id, `${at}.id`), title: text(u.title, `${at}.title`), goal: text(u.goal, `${at}.goal`), risk: u.risk, needs: strings(u.needs, `${at}.needs`), acceptanceIds: strings(u.acceptanceIds, `${at}.acceptanceIds`, true) };
    if (u.design !== undefined || u.risk === 'high') unit.design = text(u.design, `${at}.design`);
    unique(unit.needs, `${at}.needs`); unique(unit.acceptanceIds, `${at}.acceptanceIds`);
    return unit;
  }, true);
  unique(b.units.map(u => u.id), 'units');
  const units = new Map(b.units.map(u => [u.id, u]));
  const criteria = new Set(b.acceptance.map(c => c.id));
  const associated = new Set();
  const visiting = new Set(), visited = new Set();
  function visit(u) {
    if (visiting.has(u.id)) fail('units', 'dependency cycle');
    if (visited.has(u.id)) return;
    visiting.add(u.id);
    for (const need of u.needs) {
      if (!units.has(need)) fail('units', `dangling dependency ${need}`);
      visit(units.get(need));
    }
    visiting.delete(u.id); visited.add(u.id);
  }
  for (const u of b.units) {
    visit(u);
    for (const ref of u.acceptanceIds) {
      if (!criteria.has(ref)) fail('units', `unknown acceptance ${ref}`);
      associated.add(ref);
    }
  }
  if (associated.size !== criteria.size) fail('acceptance', 'every criterion must belong to a unit');
  b.executionMode = raw.executionMode === undefined ? 'strict' : raw.executionMode;
  if (!['strict','adaptive'].includes(b.executionMode)) fail('executionMode', 'invalid mode');
  const a = raw.authority;
  object(a, Object.keys(briefSchema.properties.authority.properties), 'authority');
  b.authority = { paths: list(a.paths, 'authority.paths', path, true), commands: strings(a.commands, 'authority.commands') };
  unique(b.authority.paths, 'authority.paths'); unique(b.authority.commands, 'authority.commands');
  for (const cmd of b.authority.commands) {
    const error = validateCheck({ cmd }); if (error) fail('authority.commands', error);
  }
  for (const c of b.acceptance) if (c.check.cmd && !b.authority.commands.includes(c.check.cmd)) fail('authority.commands', `missing exact command for ${c.id}`);
  b.authority.allowLocalCommit = a.allowLocalCommit === undefined ? true : a.allowLocalCommit;
  if (typeof b.authority.allowLocalCommit !== 'boolean') fail('authority.allowLocalCommit', 'expected boolean');
  for (const [key, [fallback,min,max]] of Object.entries(AUTHORITY_BOUNDS)) b.authority[key] = integer(a[key], fallback, min, max, `authority.${key}`);
  if (b.authority.maxStageMs > b.authority.maxDurationMs) fail('authority.maxStageMs', 'must not exceed maxDurationMs');
  return b;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function briefFingerprint(brief) {
  return createHash('sha256').update(canonical(validateBrief(brief))).digest('hex');
}
const bullets = xs => xs.length ? xs.map(s => `- ${s}`).join('\n') : '- None.';
const fence = (s, language = '') => { const ticks = '`'.repeat(Math.max(3, ...[...s.matchAll(/`+/g)].map(m => m[0].length + 1))); return `${ticks}${language}\n${s}\n${ticks}`; };

/** JIT spec for the existing executor; only the selected unit is implemented. */
export function workPacket(brief, unit, { plan, sourceRevision } = {}) {
  const b = validateBrief(brief);
  const u = b.units.find(u => u.id === (typeof unit === 'string' ? unit : unit?.id));
  if (!u) fail('unit', 'not in brief');
  text(plan, 'plan'); text(sourceRevision, 'sourceRevision');
  const criteria = b.acceptance.filter(c => u.acceptanceIds.includes(c.id));
  return `# Implementation Spec: ${b.title} — ${u.title}\n\nBrief: ${b.id} · revision ${b.revision}\nBrief fingerprint: ${briefFingerprint(b)}\nSource revision: ${sourceRevision}\nUnit: ${u.id} · risk: ${u.risk} · mode: ${b.executionMode}\n\n## Change\n\n${b.why}\n\nBefore: ${b.change.before}\n\nAfter: ${b.change.after}\n\n## Technical Approach\n\n${u.goal}\n\n${u.design ?? 'Inspect current source and follow existing patterns.'}\n\n## Shared Invariants\n\n${bullets(b.mustHold)}\n\n## Out of Scope\n\n${bullets(b.outOfScope)}\n\n## Delegated Choices\n\n${bullets(b.delegated)}\n\n## Decisions Considered and Rejected\n\n${bullets(b.decisions.map(d => `${d.decision}: ${d.reason}${d.rejected ? ` Rejected: ${d.rejected}` : ''}`))}\n\n## Dependencies\n\n${bullets(u.needs)}\n\n## File Changes\n\nOnly within these exact files or trailing-slash directory prefixes ('.' means ordinary project files):\n${bullets(b.authority.paths)}\n\n## Implementation Details\n\n${plan}\n\n## Testing Requirements\n\n${bullets(criteria.map(c => `${c.id}: ${c.criterion}${c.check.judgment ? ` — Human judgment pending: ${c.check.judgment}` : ''}`))}\n\n## Validation Commands\n\n${criteria.filter(c => c.check.cmd).map(c => `${c.id}: ${c.check.expect ?? 'Must exit 0.'}\n${fence(c.check.cmd, 'sh')}`).join('\n\n') || 'No objective commands; human judgments remain pending.'}\n\n## Execution Boundary\n\nThe plan cannot widen authority. Inspect source before building; independent review remains required. Commands must assert success with exit 0; expected outcomes are explanatory, not executable assertions. Human judgments never automatically pass. Host owns staging and local commits; do not stage or commit from a child agent. Do not write scout maps, implementation notes, or other artifacts outside allowed paths. Never push, merge, deploy, publish, or modify protected internals or dependency manifests/lockfiles, even with high risk or broad paths. This tool policy is not an OS sandbox.\n\nExact allowed commands and budgets:\n${fence(JSON.stringify(b.authority, null, 2), 'json')}\n`;
}
