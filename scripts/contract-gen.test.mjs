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
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const GEN = readFileSync(join(dir, 'contract-gen.ts'), 'utf8');
const ENGINE = readFileSync(
  join(dir, '..', 'workflows', 'execute-contract.mjs'),
  'utf8',
);
const AUTOPILOT = readFileSync(
  join(dir, '..', 'skills', 'autopilot', 'SKILL.md'),
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

/** Every agentType the engine actually dispatches.
 *
 *  The engine reads names from `agentNames` (defaults: ideation:scout,
 *  ideation:reviewer, general-purpose) and dispatches `agentNames.scout` etc.
 *  Resolve those references to their default strings so this stays a drift check
 *  against the contract-gen page, which documents the default (Claude Code) names.
 *  The regex must match the engine's actual `a?.agentNames?.<key>` syntax — if
 *  it ever stops matching, the assertion below fails loudly rather than
 *  silently falling back to the hardcoded defaults (which would let the page
 *  and the engine drift undetected). */
const engineAgentTypes = (src) => {
  const defaults = {
    scout: 'ideation:scout',
    reviewer: 'ideation:reviewer',
    builder: 'general-purpose',
  };
  const parsed = {};
  for (const m of src.matchAll(/(scout|reviewer|builder):\s*a\??\.agentNames\?\.\1\s*\?\?\s*'([^']+)'/g)) {
    parsed[m[1]] = m[2];
  }
  // The regex must find all three keys — if it doesn't, the engine's syntax
  // changed and this parser is stale. Fail loudly rather than mask the drift.
  const found = Object.keys(parsed).sort();
  const expected = ['builder', 'reviewer', 'scout'];
  assert.deepEqual(
    found,
    expected,
    `engineAgentTypes regex matched ${found.length}/3 agentNames defaults ` +
      `(${found.join(', ') || 'none'}). The engine's agentNames syntax changed; ` +
      `update the regex in contract-gen.test.mjs.`,
  );
  Object.assign(defaults, parsed);
  const out = new Set();
  for (const m of src.matchAll(/agentType:\s*agentNames\.(scout|reviewer|builder)/g)) {
    out.add(defaults[m[1]]);
  }
  return out;
};

const stageAgents = block => collect(block, /agent:\s*'([^']+)'/g);
const stageOutcomes = block =>
  collect(block, /\['chip[\w-]*',\s*'([^']+)'\]/g);

describe('malformed criteria — renderer and executor reject the same file', () => {
  // verify.mjs rejects malformed successCriteria at acceptance time; the
  // generator must reject them too, or it hands out a /goal whose done
  // condition (a verify run) can never be satisfied. Same predicate, one
  // owner: malformedCriterionError lives in verify.mjs.
  const GENPATH = join(dir, 'contract-gen.ts');

  function runGen(args) {
    const scratch = mkdtempSync(join(tmpdir(), 'contract-gen-malformed-'));
    const input = join(scratch, 'contract-data.json');
    writeFileSync(
      input,
      JSON.stringify({
        projectName: 'T',
        slug: 't',
        date: '2026-08-03',
        status: 'Draft',
        successCriteria: [null],
      }),
    );
    try {
      const r = spawnSync(process.execPath, [GENPATH, ...args(input, scratch)], {
        encoding: 'utf8',
      });
      return { code: r.status, err: r.stderr };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  it('render exits 1 naming the criterion index', () => {
    const { code, err } = runGen((input, scratch) => [
      '--input',
      input,
      '--output',
      join(scratch, 'contract.html'),
    ]);
    assert.equal(code, 1);
    assert.match(err, /successCriteria\[0\] is null/);
  });

  it('--print-goal exits 1 the same way — no goal for an unverifiable contract', () => {
    const { code, err } = runGen(input => ['--input', input, '--print-goal']);
    assert.equal(code, 1);
    assert.match(err, /successCriteria\[0\] is null/);
  });
});

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

  /**
   * The page tells the reader that autopilot derives `files` from the specs
   * even when the contract omits the field. That claim is only true while
   * autopilot's extraction step exists. It was missed once already — the
   * field was documented as dormant ("the interview is where that has to
   * change") when in fact the producer had been specified all along, in a
   * subsection of a different skill.
   */
  it('autopilot still derives files from the specs, as the page claims', () => {
    has(
      AUTOPILOT,
      /Populate `files` from each spec's File Changes table/,
      "autopilot no longer extracts files from the specs — the contract page's " +
        'wave rule claims it does, and would now be lying',
    );
    has(
      AUTOPILOT,
      /New Files, Modified Files, and Deleted Files/,
      'the File Changes tables autopilot reads are no longer named',
    );
    has(
      GEN,
      /autopilot (re-)?derives/i,
      'the wave rule no longer credits autopilot with deriving files',
    );
  });
});
