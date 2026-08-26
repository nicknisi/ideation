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

/**
 * Build the engine's `agent(prompt, opts)` global over a spawn backend.
 * `spawn` is pi-shared's runtime.spawn (or a test fake): it never rejects and
 * resolves a discriminated union. A failure kind becomes a THROW with the
 * kind prefixed, so the engine's safeAgent converts it into a typed stage
 * failure whose message preserves the kind (schema_invalid vs crashed is
 * load-bearing for the review loop's stale-FAIL semantics).
 */
export function makeAgent({ spawn, agentBodies }) {
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

    const res = await spawn(spawnOpts);
    if (!res.ok) throw new Error(`${res.kind}: ${res.error}`);
    // With outputSchema set, data is the validated object. A missing payload
    // (shouldn't happen — schema is always set by the engine) reads as null,
    // which safeAgent treats as a typed failure, never a success.
    return res.data ?? null;
  };
}

/**
 * Run the engine end to end. `pluginRoot` is the ideation package directory
 * (the one containing workflows/ and agents/). Returns the engine's summary:
 * { completed, noops, failed, skipped, results } (+ optional run-level error).
 */
export async function runContractEngine(args, { spawn, pluginRoot, onLog }) {
  const engine = loadEngine(
    readFileSync(join(pluginRoot, 'workflows', 'execute-contract.mjs'), 'utf8'),
  );
  const agentBodies = {
    scout: readAgentBody(pluginRoot, STAGE_AGENTS.scout.file),
    reviewer: readAgentBody(pluginRoot, STAGE_AGENTS.reviewer.file),
  };
  const agent = makeAgent({ spawn, agentBodies });
  const parallel = thunks => Promise.all(thunks.map(t => t()));
  const phase = title => onLog?.(`── ${title}`);
  const log = message => onLog?.(message);
  return engine(args, agent, parallel, phase, log);
}
