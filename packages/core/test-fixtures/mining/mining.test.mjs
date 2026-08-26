import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/**
 * Smoke-test the mining.js script BODY without the pi-workflows runtime or real
 * agent dispatch. Same idiom as workflows/execute-contract.smoke.test.mjs: load
 * the source, strip the module-level `meta` export, wrap the remainder in an
 * async function (so top-level await/return are legal), and inject stub globals
 * — args, agent, parallel, ask, log. The script's logic (option ordering, gate
 * outcomes, ignorance plumbing) is pure orchestration over those globals, so
 * stubbing them gives a deterministic, offline loop.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  join(__dirname, '..', '..', '..', 'pi', 'workflows', 'mining.js'),
  'utf8',
  // Intentionally brittle: strips `export const meta =` in its exact current
  // form only. If the meta export's shape changes, the strip silently no-ops
  // and the vm compile below fails LOUDLY on the stranded `export` — that loud
  // failure is the point. Do not loosen this regex.
).replace(/export\s+const\s+meta\s*=/, 'const meta =');

/** Compile the script body into a callable async function with injected globals. */
function loadScript() {
  const wrapped = `(async function(args, agent, parallel, ask, log){\n${SRC}\n})`;
  return new vm.Script(wrapped, { filename: 'mining.js' }).runInThisContext();
}

const ARGS = {
  problem: 'Intake asks too many questions the code could answer',
  scope: 'the pi front door',
  constraints: 'no upstream changes',
};

/** An advisor stub with 3 options + 2 ignorance entries; recommended is 'b',
    which is deliberately NOT first in the options array so the ordering test
    proves the script reorders it to the front. */
const advisorDefault = () => ({
  options: [
    { id: 'a', title: 'Option A', gist: 'the first practical one' },
    { id: 'b', title: 'Option B', gist: 'the recommended one' },
    { id: 'c', title: 'Option C', gist: 'the third one' },
  ],
  recommended: 'b',
  why: 'B is the simplest that solves it.',
  rejections: [{ id: 'c', reason: 'needs upstream changes' }],
  ignorance: [
    { question: 'What is the target metric?', gate: 'goals', whyNotAnswerable: 'not in the code' },
    { question: 'What counts as success?', gate: 'criteria', whyNotAnswerable: 'taste call' },
  ],
});

/** Per-stage stub replies keyed by the label prefix the script uses. */
const DEFAULTS = {
  'mining:scout': () => 'scout map: touches packages/pi/workflows',
  'mining:candidate': letter => `candidate ${letter}: a practical approach`,
  'mining:grail': () => 'grail: the unconstrained ideal',
  'mining:advisor': advisorDefault,
};

/**
 * Run the script with stubbed globals. `opts.advisor` overrides the advisor
 * reply; `opts.answer` is what ask() returns (a value, or a function of the
 * ask payload). ask() calls are recorded so ordering can be asserted.
 */
async function run(opts = {}) {
  const run_ = loadScript();
  const askCalls = [];
  const logs = [];

  const agent = async (_prompt, o) => {
    const label = o.label;
    if (label === 'mining:scout') return DEFAULTS['mining:scout']();
    if (label.startsWith('mining:candidate:')) {
      return DEFAULTS['mining:candidate'](label.split(':')[2]);
    }
    if (label === 'mining:grail') return DEFAULTS['mining:grail']();
    if (label === 'mining:advisor') {
      return (opts.advisor ?? advisorDefault)();
    }
    throw new Error(`unexpected agent label ${label}`);
  };

  const parallel = async thunks => Promise.all(thunks.map(t => t()));

  const ask = async payload => {
    askCalls.push(payload);
    return typeof opts.answer === 'function' ? opts.answer(payload) : opts.answer;
  };

  const result = await run_(ARGS, agent, parallel, ask, m => logs.push(m));
  return { result, askCalls, logs };
}

const OUTCOMES = new Set(['picked', 'rejected-all', 'dismissed']);

describe('mining — picked path', () => {
  it('returns decided:true with the picked choice and picked outcome', async () => {
    const { result } = await run({ answer: 'b' });
    assert.equal(result.decided, true);
    assert.equal(result.choice.id, 'b');
    assert.equal(result.miningOutcome, 'picked');
    assert.ok(result.options.length >= 3, 'at least three options are returned');
  });

  it('plumbs the advisor ignorance list through unchanged', async () => {
    const { result } = await run({ answer: 'b' });
    assert.equal(result.ignorance.length, 2);
    assert.deepEqual(
      result.ignorance.map(q => q.gate),
      ['goals', 'criteria'],
    );
  });
});

describe('mining — reject-all path', () => {
  it('returns decided:false, options intact, rejected-all outcome', async () => {
    const { result } = await run({ answer: '__reject_all__' });
    assert.equal(result.decided, false);
    assert.equal(result.miningOutcome, 'rejected-all');
    assert.equal(result.choice, undefined, 'no plan is written on reject-all');
    assert.ok(result.options.length >= 3, 'options are still returned');
  });
});

describe('mining — dismissed path', () => {
  it('ask() returning undefined is a dismissal', async () => {
    const { result } = await run({ answer: undefined });
    assert.equal(result.decided, false);
    assert.equal(result.miningOutcome, 'dismissed');
    assert.equal(result.choice, undefined);
  });

  it('an id matching no option is a dismissal, not a silent pick', async () => {
    const { result } = await run({ answer: 'nonexistent' });
    assert.equal(result.decided, false);
    assert.equal(result.miningOutcome, 'dismissed');
  });
});

describe('mining — advisor ordering', () => {
  it('recommended option sorts first and reject-all is always last', async () => {
    const { askCalls } = await run({ answer: 'b' });
    assert.equal(askCalls.length, 1, 'the gate is asked exactly once');
    const options = askCalls[0].options;
    assert.equal(options[0].id, 'b', 'recommended option must be first');
    assert.match(options[0].label, /recommended/i);
    assert.equal(
      options[options.length - 1].id,
      '__reject_all__',
      'reject-all must be the last option',
    );
  });
});

describe('mining — gate-outcome enum on every path', () => {
  it('every return path carries a valid miningOutcome', async () => {
    for (const answer of ['b', '__reject_all__', undefined, 'ghost']) {
      const { result } = await run({ answer });
      assert.ok(
        OUTCOMES.has(result.miningOutcome),
        `bad miningOutcome ${result.miningOutcome} for answer ${answer}`,
      );
    }
  });

  it('an empty ignorance list is legal and passes through', async () => {
    const emptyIgnorance = () => ({ ...advisorDefault(), ignorance: [] });
    const { result } = await run({ answer: 'b', advisor: emptyIgnorance });
    assert.equal(result.decided, true);
    assert.deepEqual(result.ignorance, []);
  });
});
