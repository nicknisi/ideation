/**
 * contract-gen drift tests.
 *
 * The rendered contract's "run model" section describes workflows/execute-
 * contract.mjs from a different file. That is duplicated knowledge, and this
 * repo already knows duplicated knowledge rots — wave-planner.test.mjs's
 * "engine mirror drift" suite exists for exactly that reason.
 *
 * The run model earns its place only by being literal. A diagram that
 * flatters the engine is worse than no diagram, because the reader calibrates
 * how much to trust an unattended run on it. Four values in the STAGES array
 * were wrong on the first pass (an invented `PARTIAL`, `READY` for the scout's
 * real `GO`, a nonexistent `git` agent type, and a missing `FAILED` commit
 * outcome) — all four were caught by hand. This suite is what catches the
 * fifth.
 *
 * contract-gen.ts is a CLI: importing it runs parseArgs and exits. So the
 * STAGES array is read out of the source text, the same way the planner's
 * drift suite reads function bodies.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const GEN = readFileSync(join(dir, 'contract-gen.ts'), 'utf8');
const ENGINE = readFileSync(
  join(dir, '..', 'workflows', 'execute-contract.mjs'),
  'utf8',
);

/** The `const STAGES: Stage[] = [ … ];` literal, as source text. */
function stagesBlock(src) {
  const start = src.indexOf('const STAGES: Stage[] = [');
  assert.notEqual(start, -1, 'STAGES array not found in contract-gen.ts');
  const end = src.indexOf('\n];', start);
  assert.notEqual(end, -1, 'STAGES array is not terminated by a column-0 "];"');
  return src.slice(start, end + 3);
}

const collect = (src, re) => [...src.matchAll(re)].map(m => m[1]);

/** Every string inside any `enum: [ … ]` in the engine. */
function engineEnumValues(src) {
  const out = new Set();
  for (const m of src.matchAll(/enum:\s*\[([^\]]*)\]/g)) {
    for (const v of m[1].matchAll(/'([^']+)'/g)) out.add(v[1]);
  }
  return out;
}

/** Every agentType the engine actually dispatches. */
const engineAgentTypes = src =>
  new Set(collect(src, /agentType:\s*'([^']+)'/g));

const stageAgents = block => collect(block, /agent:\s*'([^']+)'/g);
const stageOutcomes = block =>
  collect(block, /\['chip[\w-]*',\s*'([^']+)'\]/g);

describe('run model — outcome chips', () => {
  const BLOCK = stagesBlock(GEN);
  const ENUMS = engineEnumValues(ENGINE);

  it('the engine exposes result enums to check against', () => {
    // Guards the guard: if the engine stops using `enum: [...]` literals this
    // suite would silently pass on an empty set.
    assert.ok(
      ENUMS.size >= 10,
      `expected the engine to declare many enum values, found ${ENUMS.size}`,
    );
    for (const known of ['GO', 'HOLD', 'BUILT', 'NO-OP', 'FIXED', 'COMMITTED'])
      assert.ok(ENUMS.has(known), `engine should declare "${known}"`);
  });

  it('every chip the run model shows is a real engine enum member', () => {
    const outs = stageOutcomes(BLOCK);
    assert.ok(outs.length >= 8, `expected several outcome chips, got ${outs.length}`);
    const invented = outs.filter(o => !ENUMS.has(o));
    assert.deepEqual(
      invented,
      [],
      `the run model advertises outcomes the engine cannot produce: ${invented.join(', ')}. ` +
        'Every chip must be an enum member of a *_RESULT_SCHEMA in execute-contract.mjs.',
    );
  });

  it('rejects an invented outcome (negative control)', () => {
    // The exact bug this suite exists to catch: `PARTIAL` shipped once.
    const poisoned = BLOCK.replace("['chip-go', 'FIXED']", "['chip-go', 'PARTIAL']");
    assert.notEqual(poisoned, BLOCK, 'negative control did not modify the source');
    const invented = stageOutcomes(poisoned).filter(o => !ENUMS.has(o));
    assert.deepEqual(invented, ['PARTIAL']);
  });
});

describe('run model — agent types', () => {
  const BLOCK = stagesBlock(GEN);
  const TYPES = engineAgentTypes(ENGINE);

  it('the engine dispatches the agent types this checks against', () => {
    assert.ok(TYPES.has('ideation:scout'));
    assert.ok(TYPES.has('ideation:reviewer'));
    assert.ok(TYPES.has('general-purpose'));
  });

  it('every agent the run model names is one the engine dispatches', () => {
    const agents = stageAgents(BLOCK);
    assert.equal(agents.length, 5, 'expected one agent per stage');
    const fake = agents.filter(a => !TYPES.has(a));
    assert.deepEqual(
      fake,
      [],
      `the run model names agent types the engine never dispatches: ${fake.join(', ')}. ` +
        '"git" was one of these — the commit stage is a general-purpose agent running git.',
    );
  });
});

/** assert.match dumps the whole haystack on failure; these files are ~75kB. */
const has = (src, re, msg) => assert.ok(re.test(src), msg);

describe('run model — the review cycle cap', () => {
  it('the page and the engine agree on 3 cycles', () => {
    // The engine's loop bound, its prompt, and the diagram's caption are three
    // copies of one number.
    has(ENGINE, /while\s*\(\s*cycle\s*<=\s*3\s*\)/, 'engine loop is not <= 3');
    has(ENGINE, /cycle === 3/, 'engine break condition is not cycle === 3');
    // Lowercase in source; the caption is uppercased by CSS, not by the string.
    has(GEN, /3 cycles max/i, 'the loopback caption no longer states the cap');
    has(
      GEN,
      /cycle 3 stops here/i,
      'the Fix stage no longer states where the cap lands',
    );
  });
});

describe('run model — phase.files is described honestly', () => {
  it('the engine really does read phase.files in both places claimed', () => {
    has(
      ENGINE,
      /filesOf = new Map\(phases\.map\(p => \[p\.title, p\.files \?\? \[\]\]\)\)/,
      'wave serialisation no longer reads phase.files',
    );
    has(
      ENGINE,
      /const declared = phase\.files \?\? \[\]/,
      "the commit stage no longer falls back to the phase's declared files",
    );
    has(
      ENGINE,
      /phase\(s\) without declared files in a parallel wave/,
      'the engine no longer warns about fileless phases',
    );
  });

  it('the renderer can express the field the engine reads', () => {
    has(
      GEN,
      /files\?: string\[\]/,
      'Phase must carry `files` or contracts can never declare what the engine reads',
    );
  });
});
