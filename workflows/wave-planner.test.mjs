import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  computeWaves,
  detectCycle,
  planExecutionWaves,
  propagateSkips,
  splitWavesByFileOverlap,
} from './wave-planner.mjs';

/**
 * Helper: build a phase list from a {title: [prereqs]} map.
 * Only `title` and `prereqs` matter to the planner.
 */
function graph(map) {
  return Object.entries(map).map(([title, prereqs]) => ({ title, prereqs }));
}

/**
 * Helper: build a phase list from a {title: [files]} map. Used for overlap
 * tests where prereqs are irrelevant (the phases already share one wave).
 */
function filed(map) {
  return Object.entries(map).map(([title, files]) => ({
    title,
    prereqs: [],
    files,
  }));
}

describe('computeWaves', () => {
  it('returns no waves for an empty graph (smoke test)', () => {
    assert.deepEqual(computeWaves([]), []);
  });

  it('orders a linear chain into single-phase waves', () => {
    const phases = graph({ A: [], B: ['A'], C: ['B'], D: ['C'] });
    assert.deepEqual(computeWaves(phases), [['A'], ['B'], ['C'], ['D']]);
  });

  it('groups the middle of a diamond into one parallel wave', () => {
    // A -> {B, C} -> D   (D depends on both B and C)
    const phases = graph({ A: [], B: ['A'], C: ['A'], D: ['B', 'C'] });
    const waves = computeWaves(phases);
    assert.deepEqual(waves[0], ['A']);
    assert.deepEqual(new Set(waves[1]), new Set(['B', 'C']));
    assert.deepEqual(waves[2], ['D']);
    assert.equal(waves.length, 3);
  });

  it('puts fully independent phases in a single wave', () => {
    const phases = graph({ A: [], B: [], C: [], D: [] });
    const [wave, ...rest] = computeWaves(phases);
    assert.deepEqual(new Set(wave), new Set(['A', 'B', 'C', 'D']));
    assert.equal(rest.length, 0);
  });

  it('seeds satisfied prereqs from `completed` and excludes them from dispatch', () => {
    const phases = graph({ A: [], B: ['A'], C: ['A'], D: ['B', 'C'] });
    const waves = computeWaves(phases, ['A']);
    assert.deepEqual(new Set(waves[0]), new Set(['B', 'C']));
    assert.deepEqual(waves[1], ['D']);
    assert.equal(waves.length, 2);
    // A must never appear — it is already done.
    assert.ok(!waves.flat().includes('A'));
  });

  it('throws on a cycle', () => {
    const phases = graph({ A: ['B'], B: ['A'] });
    assert.throws(() => computeWaves(phases), /cycle/i);
  });

  it('throws on an unknown prereq title', () => {
    const phases = graph({ A: [], B: ['Nonexistent'] });
    assert.throws(() => computeWaves(phases), /unknown|unresolved|prereq/i);
  });
});

describe('propagateSkips', () => {
  it('returns an empty set when nothing failed', () => {
    const phases = graph({ A: [], B: ['A'] });
    assert.equal(propagateSkips(phases, new Set()).size, 0);
  });

  it('skips transitive dependents of a failed phase but not siblings', () => {
    // A -> {B, C} -> D (D depends on B and C). B fails.
    const phases = graph({ A: [], B: ['A'], C: ['A'], D: ['B', 'C'] });
    const skips = propagateSkips(phases, new Set(['B']));
    assert.ok(skips.has('D'), 'D depends on failed B → skipped');
    assert.ok(!skips.has('C'), 'C depends only on A → not skipped');
    assert.ok(
      !skips.has('B'),
      'the failed phase itself is not in the skip set',
    );
    assert.ok(!skips.has('A'));
  });

  it('propagates skips through a chain', () => {
    // A fails; B->A, C->B  =>  both B and C skip.
    const phases = graph({ A: [], B: ['A'], C: ['B'] });
    const skips = propagateSkips(phases, new Set(['A']));
    assert.deepEqual(new Set(skips), new Set(['B', 'C']));
  });
});

describe('detectCycle', () => {
  it('returns null for an acyclic graph', () => {
    const phases = graph({ A: [], B: ['A'], C: ['B'] });
    assert.equal(detectCycle(phases), null);
  });

  it('returns a cycle path when one exists', () => {
    const phases = graph({ A: ['C'], B: ['A'], C: ['B'] });
    const cycle = detectCycle(phases);
    assert.ok(
      Array.isArray(cycle) && cycle.length > 0,
      'returns the offending path',
    );
  });
});

describe('splitWavesByFileOverlap', () => {
  it('leaves single-phase waves untouched', () => {
    const phases = filed({ A: ['x'] });
    assert.deepEqual(splitWavesByFileOverlap([['A']], phases), [['A']]);
  });

  it('is identity when every phase has disjoint files', () => {
    const phases = filed({ A: ['a'], B: ['b'], C: ['c'] });
    assert.deepEqual(splitWavesByFileOverlap([['A', 'B', 'C']], phases), [
      ['A', 'B', 'C'],
    ]);
  });

  it('splits two phases that share a file into two sub-waves', () => {
    const phases = filed({ A: ['x'], B: ['x'] });
    assert.deepEqual(splitWavesByFileOverlap([['A', 'B']], phases), [
      ['A'],
      ['B'],
    ]);
  });

  it('greedy first-fit: A and C share a file, B is disjoint → [A, B], [C]', () => {
    const phases = filed({ A: ['x'], B: ['y'], C: ['x'] });
    assert.deepEqual(splitWavesByFileOverlap([['A', 'B', 'C']], phases), [
      ['A', 'B'],
      ['C'],
    ]);
  });

  it('fully serializes a wave where every phase shares one file', () => {
    const phases = filed({ A: ['x'], B: ['x'], C: ['x'] });
    assert.deepEqual(splitWavesByFileOverlap([['A', 'B', 'C']], phases), [
      ['A'],
      ['B'],
      ['C'],
    ]);
  });

  it('never serializes phases without files (parallel-safe by default)', () => {
    const phases = [
      { title: 'A', prereqs: [], files: [] },
      { title: 'B', prereqs: [] }, // absent files
      { title: 'C', prereqs: [], files: [] },
    ];
    assert.deepEqual(splitWavesByFileOverlap([['A', 'B', 'C']], phases), [
      ['A', 'B', 'C'],
    ]);
  });

  it('a file-less phase does not conflict with a file-bearing one', () => {
    const phases = [
      { title: 'A', prereqs: [], files: ['x'] },
      { title: 'B', prereqs: [] }, // no files → conflicts with nothing
    ];
    assert.deepEqual(splitWavesByFileOverlap([['A', 'B']], phases), [
      ['A', 'B'],
    ]);
  });

  it('splits each wave independently and preserves wave order', () => {
    const phases = filed({
      A: ['shared'],
      B: ['shared'],
      C: ['other'],
      D: ['other'],
    });
    // Two prereq waves: [A, B] and [C, D]. Each contains an overlapping pair.
    const waves = splitWavesByFileOverlap(
      [
        ['A', 'B'],
        ['C', 'D'],
      ],
      phases,
    );
    assert.deepEqual(waves, [['A'], ['B'], ['C'], ['D']]);
  });

  it('is deterministic — same input yields the same sub-wave order', () => {
    const phases = filed({ A: ['x'], B: ['y'], C: ['x'], D: ['y'] });
    const first = splitWavesByFileOverlap([['A', 'B', 'C', 'D']], phases);
    const second = splitWavesByFileOverlap([['A', 'B', 'C', 'D']], phases);
    assert.deepEqual(first, second);
    // A,C share x; B,D share y. First-fit: [A,B], [C,D].
    assert.deepEqual(first, [
      ['A', 'B'],
      ['C', 'D'],
    ]);
  });
});

describe('planExecutionWaves', () => {
  it('equals splitWavesByFileOverlap(computeWaves(p, c), p) — diamond', () => {
    const phases = [
      { title: 'A', prereqs: [], files: ['a'] },
      { title: 'B', prereqs: ['A'], files: ['shared'] },
      { title: 'C', prereqs: ['A'], files: ['shared'] },
      { title: 'D', prereqs: ['B', 'C'], files: ['d'] },
    ];
    const composed = planExecutionWaves(phases);
    const manual = splitWavesByFileOverlap(computeWaves(phases), phases);
    assert.deepEqual(composed, manual);
    // B and C are in the same prereq wave but share a file → serialized.
    assert.deepEqual(composed, [['A'], ['B'], ['C'], ['D']]);
  });

  it('honors completed phases the same way computeWaves does', () => {
    const phases = [
      { title: 'A', prereqs: [], files: ['a'] },
      { title: 'B', prereqs: ['A'], files: ['x'] },
      { title: 'C', prereqs: ['A'], files: ['y'] },
    ];
    const composed = planExecutionWaves(phases, ['A']);
    const manual = splitWavesByFileOverlap(computeWaves(phases, ['A']), phases);
    assert.deepEqual(composed, manual);
    // B and C have disjoint files → stay in one wave.
    assert.deepEqual(composed, [['B', 'C']]);
  });

  it('propagates planner errors (cycle)', () => {
    const phases = [
      { title: 'A', prereqs: ['B'] },
      { title: 'B', prereqs: ['A'] },
    ];
    assert.throws(() => planExecutionWaves(phases), /cycle/i);
  });
});

/**
 * execute-contract.mjs inlines these functions because the Workflow sandbox may
 * not support relative imports, so the "KEEP IN SYNC" comment in both files is
 * the only thing standing between this tested source and a silently divergent
 * copy running in production. It has already failed once: `computeWaves` drifted
 * to a brace-less `if (cycle) throw …`. This test is the enforcement.
 */
describe('engine mirror drift', () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const PLANNER = readFileSync(join(dir, 'wave-planner.mjs'), 'utf8');
  const ENGINE = readFileSync(join(dir, 'execute-contract.mjs'), 'utf8');

  /** The functions execute-contract.mjs is contracted to mirror verbatim. */
  const MIRRORED = [
    'detectCycle',
    'computeWaves',
    'propagateSkips',
    'splitWavesByFileOverlap',
  ];

  /** Source of `function name(…) { … }`, from the keyword to its column-0 `}`. */
  function extract(src, name) {
    const m = new RegExp(`^(?:export )?function ${name}\\(`, 'm').exec(src);
    if (!m) return null;
    const end = src.indexOf('\n}\n', m.index);
    if (end === -1) return null;
    return src.slice(m.index, end + 2).replace(/^export /, '');
  }

  /** Strip comments and collapse whitespace — formatting may differ, code may not. */
  const normalize = s =>
    s
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/\s+/g, ' ')
      .trim();

  for (const name of MIRRORED) {
    it(`${name} is identical in execute-contract.mjs`, () => {
      const source = extract(PLANNER, name);
      const mirror = extract(ENGINE, name);
      assert.ok(source, `could not extract ${name} from wave-planner.mjs`);
      assert.ok(mirror, `could not extract ${name} from execute-contract.mjs`);
      assert.equal(
        normalize(mirror),
        normalize(source),
        `${name} has drifted from wave-planner.mjs — copy it back verbatim`,
      );
    });
  }

  it('the engine mirrors these four and nothing else', () => {
    const exported = [...PLANNER.matchAll(/^export function (\w+)\(/gm)].map(
      m => m[1],
    );
    assert.deepEqual(
      exported.filter(n => extract(ENGINE, n) !== null).sort(),
      [...MIRRORED].sort(),
      'the engine inlines a planner function it does not use (or dropped one it does)',
    );
  });
});
