import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { makeAgent, runContractEngine } from './engine-host.mjs';

const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const defaults = {
  scout: { verdict: 'GO', contextMap: '# map' },
  build: { result: 'BUILT', summary: 'built', filesChanged: ['src/a.js'], validation: 'PASS' },
  review: { verdict: 'PASS', findings: [] },
  fix: { result: 'FIXED' },
  commit: { result: 'COMMITTED', commitHash: 'child-sha' },
};
const args = (extra = {}, risk = 'low') => ({
  projectName: 'Native', projectDir: 'docs/ideation/native', strict: true,
  phases: [{ title: 'A:review#1', specPath: 'spec-phase-1.md', risk, files: ['src/a.js'] }],
  ...extra,
});
async function run(input = args(), controls = {}, responses = {}) {
  const calls = [];
  const spawn = async options => {
    calls.push(options);
    const stage = options.agent.split(':')[0];
    return responses[stage]
      ? await responses[stage](options)
      : { ok: true, data: defaults[stage], usage: { totalTokens: 7 } };
  };
  const summary = await runContractEngine(input, { spawn, pluginRoot, ...controls });
  return { summary, calls, stages: calls.map(c => c.agent.split(':')[0]) };
}

test('actual lifecycle ordering, callback inputs, and deterministic commit interception', async () => {
  const trace = [];
  const events = [];
  const { summary, stages } = await run(args(), {
    onEvent: event => { events.push(event); trace.push(`${event.type}:${event.stage}`); },
    beforeStage: async info => {
      trace.push(`before:${info.stage}`);
      assert.equal(info.label, info.options.agent);
      assert.equal(info.prompt, info.options.prompt);
      assert.equal(info.phase, 'Wave 1');
      assert.ok(info.label.includes('A:review#1'));
      if (info.stage === 'commit') {
        return { result: { result: 'COMMITTED', commitHash: 'host-sha', summary: 'host commit' } };
      }
    },
    afterStage: async info => {
      trace.push(`after:${info.stage}`);
      assert.equal(info.result.usage.totalTokens, 7);
      assert.equal(info.result.data, defaults[info.stage]);
    },
  });
  assert.deepEqual(stages, ['scout', 'build', 'review']);
  assert.equal(summary.results[0].commitHash, 'host-sha');
  assert.deepEqual(trace, ['scout', 'build', 'review', 'commit'].flatMap(stage => [
    `stage_start:${stage}`, `before:${stage}`,
    ...(stage === 'commit' ? [] : [`after:${stage}`]), `stage_complete:${stage}`,
  ]));
  assert.equal(events.at(-1).result.commitHash, 'host-sha');
});

test('controls reach every spawn and system prompt appends, including builder', async () => {
  const controller = new AbortController();
  const controls = {
    signal: controller.signal, cwd: '/isolated/workspace', model: 'provider/model',
    timeoutMs: 1234, maxTurns: 9, maxToolCalls: 12,
    extensionPaths: ['/trusted/policy.mjs'], systemPrompt: 'Immutable authority',
  };
  const { calls } = await run(args(), controls);
  for (const call of calls) {
    for (const key of Object.keys(controls).filter(k => k !== 'systemPrompt')) {
      assert.equal(call[key], controls[key]);
    }
    assert.ok(call.systemPrompt.endsWith('Immutable authority'));
    assert.ok(call.outputSchema.required.length);
    assert.match(call.prompt, /plain text in your final message/);
  }
  assert.match(calls[0].systemPrompt, /Scout — Codebase Exploration/);
  assert.equal(calls[1].systemPrompt, 'Immutable authority');
});

test('observational callback rejection cannot fail execution', async () => {
  const { summary } = await run(args(), { onEvent: async () => { throw Error('observer'); } });
  assert.equal(summary.completed.length, 1);
});

for (const callback of ['beforeStage', 'afterStage']) {
  test(`${callback} failure at scout is terminal even in non-strict mode`, async () => {
    const events = [];
    const { summary, stages } = await run(args({ strict: false }), {
      [callback]: async () => { throw Error('authority denied'); },
      onEvent: e => events.push(e),
    });
    assert.deepEqual(stages, callback === 'beforeStage' ? [] : ['scout']);
    assert.equal(summary.failed.length, 1);
    assert.match(summary.results[0].summary, /control_failed: authority denied/);
    assert.equal(events[1].type, 'stage_failed');
    assert.equal(events[1].stage, 'scout');
  });
}

for (const rejects of [false, true]) {
  test(`afterStage observes ${rejects ? 'rejected' : 'resolved'} spawn failure before failed event`, async () => {
    const trace = [];
    let failure;
    const { summary, stages } = await run(args(), {
      afterStage: info => {
        if (info.stage === 'build') { failure = info.result; trace.push('after'); }
      },
      onEvent: e => { if (e.stage === 'build') trace.push(e.type); },
    }, { build: () => {
      if (rejects) throw Error('child died');
      return { ok: false, kind: 'crashed', error: 'child died', usage: { totalTokens: 11 } };
    } });
    assert.equal(failure.ok, false);
    assert.equal(failure.error, 'child died');
    assert.deepEqual(trace, ['stage_start', 'after', 'stage_failed']);
    assert.deepEqual(stages, ['scout', 'build']);
    assert.match(summary.results[0].summary, /crashed: child died/);
  });
}

for (const boundary of ['pre', 'before', 'spawn', 'after']) {
  test(`abort at ${boundary} boundary yields typed failure and no later spawns`, async () => {
    const controller = new AbortController();
    if (boundary === 'pre') controller.abort();
    let after = 0;
    const { summary, stages } = await run(args({ strict: false }), {
      signal: controller.signal,
      beforeStage: () => { if (boundary === 'before') controller.abort(); },
      afterStage: () => { after++; if (boundary === 'after') controller.abort(); },
    }, { scout: async options => {
      assert.equal(options.signal, controller.signal);
      if (boundary === 'spawn') controller.abort();
      return { ok: true, data: defaults.scout };
    } });
    assert.deepEqual(stages, ['pre', 'before'].includes(boundary) ? [] : ['scout']);
    assert.equal(after, stages.length);
    assert.equal(summary.failed.length, 1);
    assert.match(summary.results[0].summary, /aborted/);
  });
}

test('review boundary hook failure cannot use non-strict validation-only fallback', async () => {
  const { summary, stages } = await run(args({ strict: false }), {
    beforeStage: info => { if (info.stage === 'review') throw Error('checks failed'); },
  });
  assert.deepEqual(stages, ['scout', 'build']);
  assert.equal(summary.failed.length, 1);
  assert.equal(summary.results[0].commitHash, null);
  assert.match(summary.results[0].summary, /control_failed: checks failed/);
});

test('abort while an asynchronous boundary hook waits prevents dispatch', async () => {
  const controller = new AbortController();
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = run(args(), {
    signal: controller.signal,
    beforeStage: async () => { entered(); await gate; },
  });
  await waiting;
  controller.abort();
  release();
  const { summary, calls } = await pending;
  assert.equal(calls.length, 0);
  assert.equal(summary.failed.length, 1);
});

test('invalid intercepted result fails closed without a commit spawn', async () => {
  const { summary, stages } = await run(args(), {
    beforeStage: info => info.stage === 'commit' ? { result: { result: 'COMMITTED', commitHash: 42 } } : undefined,
  });
  assert.deepEqual(stages, ['scout', 'build', 'review']);
  assert.match(summary.results[0].summary, /schema_invalid/);
  assert.equal(summary.failed.length, 1);
});

test('makeAgent also supports direct callers and retains legacy timeout default', async () => {
  let options;
  const agent = makeAgent({ spawn: async opts => { options = opts; return { ok: true, data: { result: 'ok' } }; } });
  assert.deepEqual(await agent('hello'), { result: 'ok' });
  assert.equal(options.timeoutMs, 0);
  assert.equal(options.systemPrompt, undefined);
});

for (const risk of ['low', 'medium', 'high', undefined, 'LOW', '']) {
  test(`adaptive omits scout only for exact explicit low risk (${String(risk)})`, async () => {
    const input = args({ executionMode: 'adaptive' });
    input.phases[0].risk = risk;
    const { summary, stages, calls } = await run(input);
    assert.deepEqual(stages, risk === 'low' ? ['build', 'review', 'commit'] : ['scout', 'build', 'review', 'commit']);
    assert.equal(summary.results[0].reviewStatus, 'passed');
    if (risk === 'low') {
      assert.match(calls[0].prompt, /read every "Pattern to follow" path and every modified file/);
      assert.doesNotMatch(calls[0].prompt, /scout stage FAILED/);
      assert.deepEqual(summary.results[0].warnings, []);
    }
  });
}

test('legacy explicit low-risk still scouts; adaptive unavailable reviewer never commits', async () => {
  assert.deepEqual((await run()).stages, ['scout', 'build', 'review', 'commit']);
  const { summary, stages } = await run(args({ executionMode: 'adaptive', strict: false }), {}, {
    review: () => ({ ok: false, kind: 'schema_invalid', error: 'missing verdict' }),
  });
  assert.deepEqual(stages, ['build', 'review']);
  assert.equal(summary.failed.length, 1);
});

for (const cap of [1, 2, 3]) {
  test(`review cap ${cap} bounds real reviews/fixes, never fixes or commits after cap`, async () => {
    const { summary, calls, stages } = await run(args({ maxReviewCycles: cap }), {}, {
      review: () => ({ ok: true, data: { verdict: 'FAIL', findings: ['must fix'] } }),
    });
    assert.equal(stages.filter(s => s === 'review').length, cap);
    assert.equal(stages.filter(s => s === 'fix').length, cap - 1);
    assert.equal(stages.at(-1), 'review');
    assert.equal(summary.results[0].reviewCycles, cap);
    assert.equal(summary.results[0].reviewStatus, 'failed');
    for (const call of calls.filter(c => /^(review|fix):/.test(c.agent))) {
      assert.match(call.prompt, new RegExp(`of ${cap}`));
    }
  });
}

test('a PASS on the configured last cycle commits with accurate cycle evidence', async () => {
  let reviews = 0;
  const { summary, calls, stages } = await run(args({ maxReviewCycles: 2 }), {}, {
    review: () => ({ ok: true, data: { verdict: ++reviews === 2 ? 'PASS' : 'FAIL', findings: ['fix'] } }),
  });
  assert.deepEqual(stages, ['scout', 'build', 'review', 'fix', 'review', 'commit']);
  assert.equal(summary.completed.length, 1);
  assert.equal(summary.results[0].reviewCycles, 2);
  assert.match(calls.at(-1).prompt, /PASS on cycle 2 of 2/);
});

for (const cap of [0, 4, 1.5, '2', null]) {
  test(`invalid review cap ${cap} fails before any spawn`, async () => {
    const { summary, calls } = await run(args({ maxReviewCycles: cap }));
    assert.match(summary.error, /maxReviewCycles/);
    assert.equal(calls.length, 0);
  });
}
