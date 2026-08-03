import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/**
 * Smoke-test the execute-contract.mjs script BODY without the Workflow runtime
 * or real agent dispatch. We load the source, strip the module-level `meta`
 * export, wrap the remainder in an async function (as the runtime does so that
 * top-level await/return are legal), and inject stub globals. This exercises the
 * real wave loop + per-phase stage pipeline + skip propagation + summarize
 * integration — not just the planner functions in isolation.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  join(__dirname, 'execute-contract.mjs'),
  'utf8',
).replace(/export\s+const\s+meta\s*=/, 'const meta =');

/** Compile the script body into a callable async function with injected globals. */
function loadScript() {
  const wrapped = `(async function(args, agent, parallel, phase, log){\n${SRC}\n})`;
  return new vm.Script(wrapped, {
    filename: 'execute-contract.mjs',
  }).runInThisContext();
}

/** Build args for the canonical diamond: P1 → {P2, P3} → P4 (P4 depends on P3). */
function diamondArgs(completedPhases = []) {
  return {
    projectName: 'Smoke',
    slug: 'smoke',
    projectDir: 'docs/ideation/smoke/',
    completedPhases,
    phases: [
      { title: 'P1', specPath: 'p1.md', prereqs: [], risk: 'low' },
      { title: 'P2', specPath: 'p2.md', prereqs: ['P1'], risk: 'low' },
      { title: 'P3', specPath: 'p3.md', prereqs: ['P1'], risk: 'low' },
      { title: 'P4', specPath: 'p4.md', prereqs: ['P3'], risk: 'low' },
    ],
  };
}

function oneArgs(extra = {}) {
  return {
    projectName: 'Solo',
    slug: 'solo',
    projectDir: 'docs/ideation/solo/',
    completedPhases: [],
    phases: [{ title: 'Only', specPath: 'spec-phase-1.md', prereqs: [] }],
    ...extra,
  };
}

/** Happy-path reply for each stage, keyed by the label prefix the engine uses. */
const DEFAULTS = {
  scout: title => ({
    verdict: 'GO',
    gatesReady: 5,
    notReadyGates: [],
    contextMap: `# Context Map: ${title}`,
  }),
  build: title => ({
    result: 'BUILT',
    summary: `built ${title}`,
    filesChanged: [`src/${title}.ts`],
    patternFiles: [`src/pattern-${title}.ts`],
    validation: 'PASS',
  }),
  review: title => ({
    verdict: 'PASS',
    findings: [],
    blocking: 0,
    summary: `reviewed ${title}`,
  }),
  fix: title => ({ result: 'FIXED', summary: `fixed ${title}`, carried: [] }),
  commit: title => ({
    result: 'COMMITTED',
    commitHash: `sha-${title}`,
    summary: `committed ${title}`,
  }),
};

/**
 * Run the script with per-stage stub agents. `stubs[stage]` replaces that
 * stage's reply: return a value, return null (schema-less return), or throw.
 */
async function run(args, stubs = {}) {
  const run_ = loadScript();
  const calls = [];
  const waveSizes = [];
  const logs = [];

  const agent = async (prompt, opts) => {
    const [stage, rest] = opts.label.split(':');
    const [title, cycle] = rest.split('#');
    const call = {
      stage,
      title,
      cycle: cycle ? Number(cycle) : null,
      prompt,
      opts,
    };
    calls.push(call);
    return stubs[stage]
      ? stubs[stage](title, call)
      : DEFAULTS[stage](title, call);
  };

  // Mirror the runtime contract: parallel() awaits every thunk and absorbs a
  // rejected one into null rather than rejecting the whole wave.
  const parallel = async thunks => {
    waveSizes.push(thunks.length);
    return Promise.all(
      thunks.map(t => Promise.resolve().then(t).catch(() => null)),
    );
  };

  const summary = await run_(args, agent, parallel, () => {}, m => logs.push(m));
  return {
    summary,
    calls,
    waveSizes,
    logs,
    stages: calls.map(c => `${c.stage}:${c.title}`),
    dispatched: [...new Set(calls.map(c => c.title))],
    of: stage => calls.filter(c => c.stage === stage),
  };
}

const resultFor = (summary, title) =>
  summary.results.find(r => r.title === title);

describe('execute-contract — wave planning', () => {
  it('all phases pass → everything completed in dependency order', async () => {
    const { summary, waveSizes } = await run(diamondArgs());
    assert.deepEqual(
      new Set(summary.completed),
      new Set(['P1', 'P2', 'P3', 'P4']),
    );
    assert.equal(summary.failed.length, 0);
    assert.equal(summary.skipped.length, 0);
    // Wave 2 dispatches P2 and P3 together → a parallel wave of size 2.
    assert.ok(
      waveSizes.includes(2),
      `expected a wave of size 2, saw ${waveSizes}`,
    );
  });

  it('a failed phase skips its dependents but not its siblings', async () => {
    const { summary, dispatched } = await run(diamondArgs(), {
      build: title =>
        title === 'P3'
          ? { result: 'FAIL', summary: 'forced build failure' }
          : DEFAULTS.build(title),
    });
    assert.deepEqual(new Set(summary.completed), new Set(['P1', 'P2']));
    assert.deepEqual(summary.failed, ['P3']);
    assert.deepEqual(summary.skipped, ['P4']);
    // P4 must never reach any stage — it was skipped.
    assert.ok(!dispatched.includes('P4'), 'P4 should not be dispatched');
  });

  it('completedPhases are excluded from dispatch (resume)', async () => {
    const { summary, dispatched } = await run(diamondArgs(['P1', 'P2']));
    assert.ok(
      !dispatched.includes('P1') && !dispatched.includes('P2'),
      'committed phases not re-dispatched',
    );
    assert.deepEqual(new Set(dispatched), new Set(['P3', 'P4']));
    assert.deepEqual(new Set(summary.completed), new Set(['P3', 'P4']));
  });

  it('serializes two same-wave phases that share a declared file', async () => {
    // P2 and P3 are both ready after P1 (same prereq wave) and both touch foo.ts.
    // The overlap split must dispatch them in separate waves, not together.
    const { summary, waveSizes } = await run({
      projectName: 'Overlap',
      slug: 'overlap',
      projectDir: 'd/',
      completedPhases: [],
      phases: [
        { title: 'P1', specPath: 'p1.md', prereqs: [], files: ['p1.ts'] },
        { title: 'P2', specPath: 'p2.md', prereqs: ['P1'], files: ['foo.ts'] },
        { title: 'P3', specPath: 'p3.md', prereqs: ['P1'], files: ['foo.ts'] },
      ],
    });
    assert.deepEqual(new Set(summary.completed), new Set(['P1', 'P2', 'P3']));
    assert.ok(
      waveSizes.every(n => n === 1),
      `expected all single-phase waves, saw ${waveSizes}`,
    );
  });

  it('does NOT serialize same-wave phases with disjoint files', async () => {
    const { waveSizes } = await run({
      projectName: 'Disjoint',
      slug: 'disjoint',
      projectDir: 'd/',
      completedPhases: [],
      phases: [
        { title: 'P1', specPath: 'p1.md', prereqs: [], files: ['p1.ts'] },
        { title: 'P2', specPath: 'p2.md', prereqs: ['P1'], files: ['a.ts'] },
        { title: 'P3', specPath: 'p3.md', prereqs: ['P1'], files: ['b.ts'] },
      ],
    });
    assert.ok(
      waveSizes.includes(2),
      `expected P2+P3 to share a wave of size 2, saw ${waveSizes}`,
    );
  });

  it('manifests without files behave identically to before (regression guard)', async () => {
    const { summary, waveSizes } = await run(diamondArgs());
    assert.deepEqual(
      new Set(summary.completed),
      new Set(['P1', 'P2', 'P3', 'P4']),
    );
    assert.ok(
      waveSizes.includes(2),
      `expected the file-less diamond to keep its size-2 wave, saw ${waveSizes}`,
    );
  });

  it('empty phases → empty summary, no dispatch', async () => {
    const { summary, calls } = await run({
      projectName: 'E',
      slug: 'e',
      projectDir: 'd/',
      phases: [],
      completedPhases: [],
    });
    assert.deepEqual(summary, {
      completed: [],
      noops: [],
      failed: [],
      skipped: [],
      results: [],
    });
    assert.equal(calls.length, 0);
  });
});

describe('execute-contract — per-phase stage pipeline', () => {
  it('runs scout → build → review → commit as sibling agents, in that order', async () => {
    const { calls, stages } = await run(oneArgs());
    assert.deepEqual(stages, [
      'scout:Only',
      'build:Only',
      'review:Only',
      'commit:Only',
    ]);
    // Scout and reviewer are registered agent types, not general-purpose.
    assert.equal(calls[0].opts.agentType, 'ideation:scout');
    assert.equal(calls[1].opts.agentType, 'general-purpose');
    assert.equal(calls[2].opts.agentType, 'ideation:reviewer');
    assert.equal(calls[3].opts.agentType, 'general-purpose');
  });

  it('args.agentNames retargets every dispatched agentType (pi harness)', async () => {
    const { calls } = await run(
      oneArgs({
        agentNames: { scout: 'scout', reviewer: 'reviewer', builder: 'worker' },
      }),
    );
    assert.deepEqual(
      calls.map(c => c.opts.agentType),
      ['scout', 'worker', 'reviewer', 'worker'],
    );
  });

  it('a partial agentNames leaves the untouched stages on their defaults', async () => {
    // Every key is independent: overriding the builder must not silently
    // un-register the scout and reviewer, which is where read-only is enforced.
    const { calls } = await run(oneArgs({ agentNames: { builder: 'worker' } }));
    assert.deepEqual(
      calls.map(c => c.opts.agentType),
      ['ideation:scout', 'worker', 'ideation:reviewer', 'worker'],
    );
  });

  it('a JSON-string args of "null" degrades instead of throwing', async () => {
    // agentNames resolves before the diagnostic log(), so a non-object `a` there
    // would crash the run before anything could report why.
    const { summary, calls } = await run('null');
    assert.deepEqual(summary.completed, []);
    assert.equal(calls.length, 0);
  });

  it('hands the scout map to the builder, which must persist it and not commit', async () => {
    const { of } = await run(oneArgs());
    const build = of('build')[0].prompt;
    assert.match(build, /# Context Map: Only/);
    assert.match(build, /context-map\.md/);
    assert.match(build, /git add -N/);
    assert.match(build, /do NOT\s+commit/i);
    // The commit stage stages by name and is told never to use `git add -A`.
    const commit = of('commit')[0].prompt;
    assert.match(commit, /src\/Only\.ts/);
    assert.match(commit, /never `git add -A`/);
  });

  it('requires the slug-qualified spec path verbatim in the commit body', async () => {
    // Resume (autopilot's git-log pre-pass), scripts/verify.mjs's commits=N/N,
    // and the generated /goal's done-when all grep commit bodies for this exact
    // string. The build stage stops before execute-spec's Commit section, so if
    // the engine does not carry the requirement itself, nothing does — and every
    // engine-committed phase reads as never-committed.
    const specPath = 'docs/ideation/solo/spec-phase-1.md';
    const { of } = await run(
      oneArgs({ phases: [{ title: 'Only', specPath, prereqs: [] }] }),
    );
    const commit = of('commit')[0].prompt;
    assert.match(commit, /commit body MUST contain the spec path/i);
    assert.ok(
      commit.includes(specPath),
      'the commit prompt must name the spec path verbatim',
    );
  });

  it('fails the phase when the builder reports failing validation', async () => {
    // BUILT + validation FAIL is schema-legal; without a gate a reviewer PASS
    // would commit code whose type check or tests are red.
    const { summary } = await run(oneArgs(), {
      build: title => ({
        result: 'BUILT',
        summary: `built ${title}`,
        filesChanged: [`src/${title}.ts`],
        patternFiles: [],
        validation: 'FAIL',
      }),
    });
    assert.deepEqual(summary.failed, ['Only']);
    assert.deepEqual(summary.completed, []);
    assert.match(summary.results[0].summary, /[Vv]alidation failed/);
  });

  it('passes the builder-collected pattern files and cycle number to the reviewer', async () => {
    const { of } = await run(oneArgs());
    const review = of('review')[0].prompt;
    assert.match(review, /src\/pattern-Only\.ts/);
    assert.match(review, /Cycle number:\s+1 of 3/);
    assert.match(review, /git diff HEAD/);
  });

  it('strict args dispatch the builder with --headless --strict', async () => {
    const { of } = await run({ ...diamondArgs(), strict: true });
    const prompts = of('build').map(c => c.prompt);
    assert.ok(prompts.length > 0, 'expected dispatched phases');
    assert.ok(
      prompts.every(p => p.includes('--headless --strict')),
      'every build prompt should carry --headless --strict',
    );
  });

  it('non-strict args dispatch the builder with plain --headless', async () => {
    const { of } = await run(diamondArgs());
    const prompts = of('build').map(c => c.prompt);
    assert.ok(prompts.length > 0, 'expected dispatched phases');
    assert.ok(
      prompts.every(p => p.includes('--headless') && !p.includes('--strict')),
      'build prompts should carry --headless without --strict',
    );
  });

  it('effort tracks declared risk: high → high, anything else omitted; review always high', async () => {
    const { of } = await run({
      ...oneArgs(),
      phases: [
        { title: 'Hot', specPath: 'a.md', prereqs: [], risk: 'high' },
        { title: 'Cold', specPath: 'b.md', prereqs: [], risk: 'low' },
      ],
    });
    const build = Object.fromEntries(of('build').map(c => [c.title, c.opts]));
    assert.equal(build.Hot.effort, 'high');
    assert.ok(
      !('effort' in build.Cold),
      'a non-high-risk phase must inherit the default effort, not set one',
    );
    assert.ok(
      of('review').every(c => c.opts.effort === 'high'),
      'review is always high effort regardless of phase risk',
    );
  });
});

describe('execute-contract — scout gate', () => {
  it('non-strict scout HOLD builds anyway and says so in the summary', async () => {
    const { summary, stages } = await run(oneArgs(), {
      scout: () => ({
        verdict: 'HOLD',
        gatesReady: 2,
        notReadyGates: ['Test strategy', 'Edge case coverage'],
        contextMap: '# partial',
      }),
    });
    assert.deepEqual(summary.completed, ['Only']);
    assert.ok(stages.includes('build:Only'), 'HOLD must not block the build');
    const r = resultFor(summary, 'Only');
    assert.equal(r.reviewStatus, 'passed');
    assert.match(r.summary, /SCOUT HOLD/);
    assert.match(r.summary, /Test strategy/);
  });

  it('strict scout HOLD fails the phase without building', async () => {
    const { summary, stages } = await run(oneArgs({ strict: true }), {
      scout: () => ({
        verdict: 'HOLD',
        gatesReady: 2,
        notReadyGates: ['Scope clarity'],
        contextMap: '# partial',
      }),
    });
    assert.deepEqual(summary.failed, ['Only']);
    assert.deepEqual(stages, ['scout:Only'], 'nothing may run after a strict HOLD');
    const r = resultFor(summary, 'Only');
    assert.equal(r.reviewStatus, 'not-run');
    assert.match(r.summary, /Scout HOLD/);
  });

  it('an unavailable scout warns loudly and falls back to inline exploration', async () => {
    const { summary, of } = await run(oneArgs(), {
      scout: () => {
        throw new Error('agent type not registered');
      },
    });
    assert.deepEqual(summary.completed, ['Only']);
    const r = resultFor(summary, 'Only');
    assert.match(r.summary, /SCOUT UNAVAILABLE/);
    assert.match(of('build')[0].prompt, /explore\s+inline/i);
  });
});

describe('execute-contract — review gate', () => {
  it('review FAIL then PASS: fixes, re-reviews, commits, reports 2 cycles', async () => {
    let cycles = 0;
    const { summary, stages } = await run(oneArgs(), {
      review: () => {
        cycles++;
        return cycles === 1
          ? {
              verdict: 'FAIL',
              blocking: 1,
              findings: ['critical/logic a.ts:1 — broken → fix it'],
              summary: 'bad',
            }
          : { verdict: 'PASS', blocking: 0, findings: [], summary: 'good' };
      },
    });
    assert.deepEqual(stages, [
      'scout:Only',
      'build:Only',
      'review:Only',
      'fix:Only',
      'review:Only',
      'commit:Only',
    ]);
    assert.deepEqual(summary.completed, ['Only']);
    const r = resultFor(summary, 'Only');
    assert.equal(r.reviewStatus, 'passed');
    assert.equal(r.reviewCycles, 2);
  });

  it('review FAIL three times → FAIL, no commit', async () => {
    const { summary, stages, of } = await run(oneArgs(), {
      review: () => ({
        verdict: 'FAIL',
        blocking: 2,
        findings: ['critical/logic a.ts:1 — broken → fix it'],
        summary: 'still bad',
      }),
    });
    assert.deepEqual(summary.failed, ['Only']);
    assert.equal(of('review').length, 3, 'the cycle cap is 3 reviews');
    assert.equal(of('fix').length, 2, 'a fix runs between cycles, not after the last');
    assert.ok(!stages.includes('commit:Only'), 'a capped-out review must not commit');
    const r = resultFor(summary, 'Only');
    assert.equal(r.reviewStatus, 'failed');
    assert.equal(r.findings.length, 1);
  });

  it('carries the prior cycle findings into the re-review so fixes can be tracked', async () => {
    const finding = 'high/logic a.ts:1 — off by one → clamp it';
    let n = 0;
    const { of } = await run(oneArgs(), {
      review: () => {
        n++;
        return n === 1
          ? { verdict: 'FAIL', blocking: 1, findings: [finding], summary: 'bad' }
          : { verdict: 'PASS', blocking: 0, findings: [], summary: 'good' };
      },
      // A fixer that reports no refutations must not erase the prior cycle.
      fix: () => ({ result: 'FIXED', summary: 'fixed', carried: [] }),
    });
    assert.match(of('fix')[0].prompt, /off by one/);
    assert.match(of('review')[1].prompt, /Cycle number:\s+2 of 3/);
    assert.match(of('review')[1].prompt, /off by one/);
  });

  it('a reviewer that disappears mid-loop leaves the last FAIL standing, and says why', async () => {
    let n = 0;
    const { summary, stages } = await run(oneArgs(), {
      review: () => {
        n++;
        if (n === 1) {
          return {
            verdict: 'FAIL',
            blocking: 1,
            findings: ['critical/logic a.ts:1 — broken → fix it'],
            summary: 'bad',
          };
        }
        throw new Error('reviewer crashed');
      },
    });
    assert.deepEqual(summary.failed, ['Only']);
    assert.ok(!stages.includes('commit:Only'), 'an unresolved FAIL must not commit');
    const r = resultFor(summary, 'Only');
    assert.equal(r.reviewStatus, 'failed');
    assert.match(r.summary, /re-review never returned a verdict/);
  });

  it('non-strict verdict-less reviewer commits validation-only and SHOUTS about it', async () => {
    const { summary, stages } = await run(oneArgs(), {
      review: () => null, // schema-less / crashed return
    });
    assert.deepEqual(summary.completed, ['Only']);
    assert.ok(stages.includes('commit:Only'), 'non-strict still commits');
    const r = resultFor(summary, 'Only');
    assert.equal(r.reviewStatus, 'validation-only');
    assert.match(r.summary, /WARNING — UNREVIEWED CODE COMMITTED/);
    assert.match(r.warnings.join(' '), /never produced a verdict/);
  });

  it('strict verdict-less reviewer fails the phase and never commits', async () => {
    const { summary, stages } = await run(oneArgs({ strict: true }), {
      review: () => {
        throw new Error('reviewer crashed');
      },
    });
    assert.deepEqual(summary.failed, ['Only']);
    assert.ok(!stages.includes('commit:Only'), 'strict must not commit unreviewed code');
    const r = resultFor(summary, 'Only');
    assert.match(r.summary, /--strict fails closed/);
  });

  it('an empty diff is a NO-OP: review skipped, nothing committed, own bucket', async () => {
    const { summary, stages } = await run(oneArgs(), {
      build: () => ({
        result: 'NO-OP',
        summary: 'the repo already satisfies the spec',
        filesChanged: [],
        patternFiles: [],
        validation: 'PASS',
      }),
    });
    assert.deepEqual(summary.noops, ['Only']);
    assert.deepEqual(summary.completed, []);
    assert.deepEqual(summary.failed, []);
    assert.deepEqual(stages, ['scout:Only', 'build:Only']);
    assert.equal(resultFor(summary, 'Only').reviewStatus, 'skipped-empty-diff');
  });

  it('a NO-OP does not block dependents', async () => {
    const { summary } = await run(diamondArgs(), {
      build: title =>
        title === 'P1'
          ? { result: 'NO-OP', summary: 'nothing to do', filesChanged: [] }
          : DEFAULTS.build(title),
    });
    assert.deepEqual(summary.noops, ['P1']);
    assert.deepEqual(new Set(summary.completed), new Set(['P2', 'P3', 'P4']));
    assert.equal(summary.skipped.length, 0);
  });
});

describe('execute-contract — stage failures cannot kill the run', () => {
  it('a throwing stage becomes a typed FAIL and siblings still finish', async () => {
    const { summary } = await run(diamondArgs(), {
      commit: title => {
        if (title === 'P2') throw new Error('index.lock held');
        return DEFAULTS.commit(title);
      },
    });
    // The whole summary survives; only P2 fails, and it names the stage.
    assert.deepEqual(summary.failed, ['P2']);
    assert.deepEqual(new Set(summary.completed), new Set(['P1', 'P3', 'P4']));
    const r = resultFor(summary, 'P2');
    assert.match(r.summary, /commit stage failed/);
    assert.match(r.summary, /index\.lock held/);
    assert.equal(r.reviewStatus, 'passed');
  });

  it('a null build result is treated as FAIL, not success', async () => {
    const { summary } = await run(oneArgs(), { build: () => null });
    assert.deepEqual(summary.failed, ['Only']);
    assert.equal(summary.completed.length, 0);
    assert.match(resultFor(summary, 'Only').summary, /Build stage produced no result/);
  });

  it('every returned result carries the documented enums', async () => {
    const { summary } = await run(diamondArgs(), {
      build: title =>
        title === 'P3'
          ? { result: 'FAIL', summary: 'nope' }
          : DEFAULTS.build(title),
    });
    const RESULTS = new Set(['PASS', 'NO-OP', 'FAIL', 'SKIPPED']);
    const STATUSES = new Set([
      'passed',
      'validation-only',
      'failed',
      'skipped-empty-diff',
      'not-run',
    ]);
    for (const r of summary.results) {
      assert.ok(RESULTS.has(r.result), `bad result ${r.result}`);
      assert.ok(STATUSES.has(r.reviewStatus), `bad reviewStatus ${r.reviewStatus}`);
      assert.equal(typeof r.summary, 'string');
    }
    assert.equal(resultFor(summary, 'P4').reviewStatus, 'not-run');
  });
});
