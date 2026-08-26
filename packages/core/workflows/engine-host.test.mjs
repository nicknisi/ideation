import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runContractEngine } from './engine-host.mjs';

/**
 * Exercise the pi engine host: the REAL execute-contract.mjs, run through the
 * shim with a fake spawn backend. The smoke test covers engine semantics with
 * an injected agent(); this suite covers the translation layer — agentType
 * normalization, tool allowlists, systemPrompt wiring, schema/effort mapping,
 * and the spawn-failure-kind → typed-stage-failure conversion the review
 * loop's stale-FAIL semantics depend on.
 */
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

const DEFAULTS = {
  scout: () => ({
    verdict: 'GO',
    gatesReady: 5,
    notReadyGates: [],
    contextMap: '# Context Map',
  }),
  build: title => ({
    result: 'BUILT',
    summary: `built ${title}`,
    filesChanged: [`src/${title}.ts`],
    patternFiles: [],
    validation: 'PASS',
  }),
  review: () => ({ verdict: 'PASS', findings: [], blocking: 0, summary: 'ok' }),
  fix: () => ({ result: 'FIXED', summary: 'fixed', carried: [] }),
  commit: title => ({
    result: 'COMMITTED',
    commitHash: `sha-${title}`,
    summary: 'committed',
  }),
};

const zeroUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

/**
 * Fake spawn: records every call, answers per-stage from DEFAULTS (or the
 * stub override), and mirrors the runtime contract — never rejects, returns
 * the discriminated union with `data` carrying the validated object.
 */
async function run(args, stubs = {}) {
  const calls = [];
  const spawn = async opts => {
    const [stage, rest] = opts.agent.split(':');
    const title = rest.split('#')[0];
    calls.push({ stage, title, opts });
    const stub = stubs[stage];
    const value = stub ? await stub(title, opts) : DEFAULTS[stage](title, opts);
    if (value && value.__fail) {
      return {
        ok: false,
        runId: 'fake',
        kind: value.__fail,
        error: value.__error ?? `forced ${value.__fail}`,
        text: '',
        usage: zeroUsage,
        durationMs: 1,
      };
    }
    return {
      ok: true,
      runId: 'fake',
      text: JSON.stringify(value),
      data: value,
      usage: zeroUsage,
      durationMs: 1,
    };
  };
  const logs = [];
  const summary = await runContractEngine(args, {
    spawn,
    pluginRoot: PLUGIN_ROOT,
    onLog: m => logs.push(m),
  });
  return { summary, calls, logs };
}

describe('engine-host — spawn translation', () => {
  it('runs the full diamond through the real engine', async () => {
    const { summary } = await run(diamondArgs());
    assert.deepEqual(
      new Set(summary.completed),
      new Set(['P1', 'P2', 'P3', 'P4']),
    );
    assert.equal(summary.failed.length, 0);
  });

  it('normalizes CC agentType names and applies per-stage tool allowlists', async () => {
    const { calls } = await run(diamondArgs());
    const scout = calls.find(c => c.stage === 'scout');
    const review = calls.find(c => c.stage === 'review');
    const build = calls.find(c => c.stage === 'build');
    // No agentNames in args → engine uses CC defaults (ideation:scout etc.);
    // the shim must strip the prefix. Builder = general-purpose → full tools.
    assert.deepEqual(scout.opts.tools, ['read', 'grep', 'find', 'ls']);
    assert.deepEqual(review.opts.tools, ['read', 'grep', 'bash']);
    assert.deepEqual(build.opts.tools, [
      'read',
      'grep',
      'find',
      'ls',
      'bash',
      'edit',
      'write',
    ]);
  });

  it('wires agent bodies as systemPrompt for scout/reviewer, none for builder', async () => {
    const { calls } = await run(diamondArgs());
    const scout = calls.find(c => c.stage === 'scout');
    const build = calls.find(c => c.stage === 'build');
    assert.match(scout.opts.systemPrompt, /Scout — Codebase Exploration/);
    assert.equal(build.opts.systemPrompt, undefined);
  });

  it('maps schema → outputSchema and effort → thinkingLevel', async () => {
    const { calls } = await run(diamondArgs());
    const review = calls.find(c => c.stage === 'review');
    assert.equal(review.opts.outputSchema.type, 'object');
    assert.deepEqual(review.opts.outputSchema.required, ['verdict']);
    // Review always runs high-effort, whatever the phase risk.
    assert.equal(review.opts.thinkingLevel, 'high');
    // Default-risk build carries no effort bump.
    const build = calls.find(c => c.stage === 'build');
    assert.equal(build.opts.thinkingLevel, undefined);
  });

  it('appends the no-StructuredOutput suffix when a schema is set', async () => {
    const { calls } = await run(diamondArgs());
    const scout = calls.find(c => c.stage === 'scout');
    assert.match(scout.opts.prompt, /no StructuredOutput tool/);
  });

  it('a crashed build spawn becomes a typed phase failure, and skips dependents', async () => {
    const { summary } = await run(diamondArgs(), {
      build: title =>
        title === 'P3'
          ? { __fail: 'crashed', __error: 'child died' }
          : DEFAULTS.build(title),
    });
    assert.deepEqual(summary.failed, ['P3']);
    assert.deepEqual(summary.skipped, ['P4']);
    const p3 = summary.results.find(r => r.title === 'P3');
    assert.match(p3.summary, /crashed: child died/);
  });

  it('schema_invalid on review is the verdict-less path, not a standing FAIL', async () => {
    // Non-strict: a reviewer that never produces a verdict commits
    // validation-only, loudly. This is the distinction the runtime's
    // schema_invalid kind exists to preserve.
    const { summary } = await run(diamondArgs(), {
      review: () => ({ __fail: 'schema_invalid', __error: 'no json' }),
    });
    const p1 = summary.results.find(r => r.title === 'P1');
    assert.equal(p1.result, 'PASS');
    assert.equal(p1.reviewStatus, 'validation-only');
    assert.match(p1.summary, /schema_invalid: no json/);
  });

  it('schema_invalid on review under strict fails closed — nothing commits', async () => {
    const { summary } = await run(
      { ...diamondArgs(), strict: true },
      { review: () => ({ __fail: 'schema_invalid', __error: 'no json' }) },
    );
    assert.equal(summary.completed.length, 0);
    // P1 fails closed; P2/P3/P4 are skipped by propagation, not failed.
    assert.deepEqual(summary.failed, ['P1']);
    assert.deepEqual(new Set(summary.skipped), new Set(['P2', 'P3', 'P4']));
    const p1 = summary.results.find(r => r.title === 'P1');
    assert.equal(p1.commitHash, null);
  });

  it('honors completedPhases (git-as-journal resume)', async () => {
    const { summary, calls } = await run(diamondArgs(['P1', 'P2']));
    const dispatched = new Set(calls.map(c => c.title));
    assert.ok(!dispatched.has('P1') && !dispatched.has('P2'));
    assert.deepEqual(new Set(summary.completed), new Set(['P3', 'P4']));
  });
});
