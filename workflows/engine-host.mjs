/**
 * engine-host.mjs — run execute-contract.mjs on any spawn backend.
 *
 * execute-contract.mjs is a Workflow-runtime script: a statement body with
 * injected globals (args, agent, parallel, phase, log), no imports. Claude
 * Code runs it via the Workflow tool. In pi, extensions/engine.ts runs it
 * through THIS host: the script body is vm-wrapped exactly like the smoke
 * test does, and `agent()` is backed by the first-party spawn runtime.
 *
 * Keeping the engine as the single source of truth for both harnesses is the
 * whole point — a pi-only port would drift from the CC engine within weeks.
 * This module deliberately imports nothing from pi or @nicknisi/pi-shared so
 * the test suite can exercise it without an install step: the spawn function
 * is injected.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// Same intentional brittleness as execute-contract.smoke.test.mjs: the strip
// matches the meta export's exact current form, and a changed shape fails
// LOUDLY at vm compile (stranded `export`) rather than silently no-opping.
const STRIP_META = /export\s+const\s+meta\s*=/;

/** Compile the engine script body into a callable with injected globals. */
/** Bumped when the runner/host hook contract changes. The runner checks it so a
 * Pi process holding an older copy of this module says "restart Pi" instead of
 * refusing every stage. */
export const HOST_HOOKS = 1;

export function loadEngine(scriptSrc) {
  const stripped = scriptSrc.replace(STRIP_META, 'const meta =');
  const wrapped = `(async function(args, agent, parallel, phase, log){\n${stripped}\n})`;
  return new vm.Script(wrapped, { filename: 'execute-contract.mjs' }).runInThisContext();
}

/**
 * Stage-agent definitions for the pi engine host. The engine's agentType
 * names (CC defaults 'ideation:scout' / 'ideation:reviewer' /
 * 'general-purpose', or bare overrides from args.agentNames) are normalized
 * to these keys. Tool allowlists are pi built-in names; the scout's CC Bash
 * (used for rg) is unnecessary — pi has grep/find/ls built in — so the scout
 * stays fully read-only here. The reviewer needs bash for `git diff HEAD`.
 */
export const STAGE_AGENTS = {
  scout: { file: 'agents/scout.md', tools: ['read', 'grep', 'find', 'ls'] },
  reviewer: { file: 'agents/reviewer.md', tools: ['read', 'grep', 'bash'] },
  builder: {
    file: null,
    tools: ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write'],
  },
};

/** The engine's prompts promise a StructuredOutput tool; spawn validates the
    final message instead. This suffix keeps the child honest without editing
    the shared engine prompts. */
const SCHEMA_SUFFIX =
  '\n\nReturn the JSON object as plain text in your final message — there is ' +
  'no StructuredOutput tool in this environment; the JSON is parsed and ' +
  'validated automatically.';

function normalizeAgentType(agentType) {
  const bare = String(agentType ?? 'builder').replace(/^ideation:/, '');
  if (bare === 'general-purpose' || bare === 'worker') return 'builder';
  return bare in STAGE_AGENTS ? bare : 'builder';
}

function readAgentBody(pluginRoot, file) {
  const src = readFileSync(join(pluginRoot, file), 'utf8');
  if (!src.startsWith('---')) return src;
  const end = src.indexOf('\n---', 3);
  return end === -1 ? src : src.slice(end + 4).trim();
}

/** Validate intercepted data against the stage schemas (the spawn backend
 * validates actual child output). These schemas use only these JSON keywords. */
function validStageResult(value, schema) {
  if (!schema) return value != null;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (!types.includes(type)) return false;
  }
  if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
  if (schema.properties && value && typeof value === 'object') {
    for (const [key, child] of Object.entries(schema.properties)) {
      if (Object.hasOwn(value, key) && !validStageResult(value[key], child)) return false;
    }
  }
  return !schema.items || value.every(item => validStageResult(item, schema.items));
}

/**
 * Build the engine's `agent(prompt, opts)` global over a spawn backend.
 * `spawn` is pi-shared's runtime.spawn (or a test fake): it never rejects and
 * resolves a discriminated union. A failure kind becomes a THROW with the
 * kind prefixed, so the engine's safeAgent converts it into a typed stage
 * failure whose message preserves the kind (schema_invalid vs crashed is
 * load-bearing for the review loop's stale-FAIL semantics).
 */
export function makeAgent({
  spawn, agentBodies = {}, onEvent, signal, cwd, model, timeoutMs,
  maxTurns, maxToolCalls, extensionPaths, systemPrompt, beforeStage, afterStage,
}) {
  // Correctness-hook failures are terminal even where legacy engine semantics
  // allow an unavailable scout or reviewer to fall back.
  let controlError;
  const checkControl = () => {
    if (controlError) throw controlError;
    if (signal?.aborted) throw new Error('aborted: stage cancelled');
  };
  const emit = async event => {
    try { await onEvent?.(event); } catch { /* observational only */ }
  };
  const hook = async (fn, info) => {
    try { return await fn?.(info); }
    catch (err) {
      controlError = new Error(`control_failed: ${err?.message ?? String(err)}`);
      throw controlError;
    }
  };
  return async function agent(prompt, opts = {}) {
    const type = normalizeAgentType(opts.agentType);
    const def = STAGE_AGENTS[type];
    const spawnOpts = {
      prompt: opts.schema ? prompt + SCHEMA_SUFFIX : prompt,
      agent: opts.label ?? type,
      tools: def.tools,
      // Long builds exceed spawn's 15-minute default; the old engine had no
      // per-stage timeout, so disable it for parity.
      timeoutMs: 0,
    };
    if (def.file && agentBodies[type]) spawnOpts.systemPrompt = agentBodies[type];
    if (opts.schema) spawnOpts.outputSchema = opts.schema;
    if (opts.effort) spawnOpts.thinkingLevel = opts.effort;

    for (const [key, value] of Object.entries({
      signal, cwd, model, timeoutMs, maxTurns, maxToolCalls, extensionPaths,
    })) {
      if (value !== undefined) spawnOpts[key] = value;
    }
    if (systemPrompt) {
      spawnOpts.systemPrompt = [spawnOpts.systemPrompt, systemPrompt]
        .filter(Boolean).join('\n\n');
    }
    const info = {
      stage: String(opts.label ?? type).split(':')[0],
      label: opts.label ?? type,
      phase: opts.phase,
      prompt: spawnOpts.prompt,
      options: spawnOpts,
    };
    try {
      checkControl();
      await emit({ type: 'stage_start', ...info });
      checkControl();
      const intercepted = await hook(beforeStage, info);
      // A boundary hook can wait for pause/resume; check again before spawning.
      checkControl();
      let value;
      if (intercepted && Object.hasOwn(intercepted, 'result')) {
        value = intercepted.result;
        if (!validStageResult(value, opts.schema)) {
          controlError = new Error('schema_invalid: intercepted stage result');
          throw controlError;
        }
      } else {
        let res;
        try {
          res = await spawn(spawnOpts);
        } catch (err) {
          // Backends normally resolve failures, but still account for a backend
          // that rejects. There is no fabricated token usage.
          res = { ok: false, kind: 'crashed', error: err?.message ?? String(err) };
        }
        await hook(afterStage, { ...info, result: res });
        checkControl();
        if (!res.ok) throw new Error(`${res.kind}: ${res.error}`);
        value = res.data ?? null;
      }
      if (value == null) throw new Error('agent returned no result');
      await emit({ type: 'stage_complete', ...info, result: value });
      checkControl();
      return value;
    } catch (err) {
      await emit({ type: 'stage_failed', ...info, error: err?.message ?? String(err) });
      throw err;
    }
  };
}

/**
 * Run the engine end to end. `pluginRoot` is the ideation package directory
 * (the one containing workflows/ and agents/). Returns the engine's summary:
 * { completed, noops, failed, skipped, results } (+ optional run-level error).
 */
export async function runContractEngine(args, { spawn, pluginRoot, onLog, ...controls }) {
  const engine = loadEngine(
    readFileSync(join(pluginRoot, 'workflows', 'execute-contract.mjs'), 'utf8'),
  );
  const agentBodies = {
    scout: readAgentBody(pluginRoot, STAGE_AGENTS.scout.file),
    reviewer: readAgentBody(pluginRoot, STAGE_AGENTS.reviewer.file),
  };
  const agent = makeAgent({ ...controls, spawn, agentBodies });
  const parallel = thunks => Promise.all(thunks.map(t => t()));
  const phase = title => onLog?.(`── ${title}`);
  const log = message => onLog?.(message);
  return engine(args, agent, parallel, phase, log);
}
