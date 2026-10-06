import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Loading the Pi extensions must not import @nicknisi/pi-shared: from this repo's
// tree it value-imports a second Pi bundle, which costs Pi seconds at startup.
// Every heavy specifier throws on import; engine.ts must not load engine-host.mjs
// either. Type-only imports are stripped, so they never resolve. typebox is
// stubbed, as in the other extension tests, so CI needs no install.
const HEAVY = ['@nicknisi/pi-shared', '@earendil-works/pi-coding-agent', '@earendil-works/pi-ai', '@earendil-works/pi-tui'];
let heavy = 'throw';
const stub = mode => 'data:text/javascript,' + encodeURIComponent(mode === 'throw'
  ? 'throw new Error("heavy dependency imported")'
  : 'globalThis.piSharedLoads = (globalThis.piSharedLoads ?? 0) + 1; export const createSubagentRuntime = o => ({ options: o });');
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (HEAVY.includes(specifier)) return { url: stub(heavy), shortCircuit: true };
  if (specifier === 'typebox') return { url: 'data:text/javascript,export const Type=new Proxy({}, {get:(_,k)=>(...args)=>({kind:k,args})})', shortCircuit: true };
  if (heavy === 'throw' && specifier.endsWith('engine-host.mjs') && context.parentURL?.includes('/extensions/engine.ts')) return { url: stub('throw'), shortCircuit: true };
  return next(specifier, context);
} });
test.after(() => hooks.deregister());

const fakePi = () => {
  const tools = {}, commands = {};
  return { tools, commands, on() {}, events: { on() {}, emit() {} }, registerTool: t => { tools[t.name] = t; }, registerCommand: (n, c) => { commands[n] = c; } };
};

test('every extension loads and registers without its heavy dependencies', async () => {
  const pi = fakePi();
  for (const name of ['preflight', 'engine', 'change']) (await import(`../extensions/${name}.ts`)).default(pi);
  assert.deepEqual(Object.keys(pi.tools).sort(), ['ideation_change', 'run_ideation_contract']);
  assert.deepEqual(Object.keys(pi.commands).sort(), ['ideation', 'ideation-doctor']);
  assert.equal(globalThis.piSharedLoads, undefined);
  // A failed deferred import is the tool's error, not a crash at load.
  await assert.rejects(pi.tools.run_ideation_contract.execute('id', {}, undefined, undefined, {}), /ideation: could not load the engine: heavy dependency imported/);
});

test('the deferred loaders import pi-shared once, on first use', async () => {
  heavy = 'load';
  const { loadEngineDeps } = await import('../extensions/engine.ts?first-use');
  const { loadPiShared } = await import('../extensions/change.ts?first-use');
  assert.equal(globalThis.piSharedLoads, undefined);
  assert.equal(loadEngineDeps(), loadEngineDeps());
  assert.equal(loadPiShared(), loadPiShared());
  const [[shared, host], again] = await Promise.all([loadEngineDeps(), loadPiShared()]);
  assert.equal(typeof host.runContractEngine, 'function');
  assert.equal(shared, again);
  assert.deepEqual(shared.createSubagentRuntime({ namespace: 'n' }), { options: { namespace: 'n' } });
  assert.equal(globalThis.piSharedLoads, 1);
});
