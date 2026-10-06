import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { validateBrief } from './change-brief.mjs';

// Mirror only the TypeBox constructors used by registration so repository tests
// still run without installed Pi/TypeBox packages. Validate the real TypeBox
// serialization separately in the installed-Pi smoke.
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@nicknisi/pi-shared') return { url: 'data:text/javascript,export const createSubagentRuntime=()=>{throw new Error("not used")}', shortCircuit: true };
  if (specifier === 'typebox') return { url: 'data:text/javascript,' + encodeURIComponent(`export const Type={Object:(properties,options={})=>({type:'object',properties,...options}),Optional:s=>s,Unknown:()=>({}),Unsafe:s=>s,String:(options={})=>({type:'string',...options})};`), shortCircuit: true };
  return next(specifier, context);
} });
const { registerChange } = await import('../extensions/change.ts');
hooks.deregister();
let tool;
registerChange({ on() {}, registerCommand() {}, registerTool(t) { tool = t; } });
const fixture = JSON.parse(readFileSync(new URL('../test-fixtures/native-change/brief.json', import.meta.url), 'utf8'));

test('registered inline brief advertises an object, not unconstrained JSON that permits strings', () => {
  assert.throws(() => validateBrief(JSON.stringify(fixture)), /brief: expected object/);
  assert.equal(tool.parameters.properties.brief.type, 'object', 'model-facing brief must reject serialized JSON strings');
});

test('model sees the complete compact brief shape, including check variants and authority', () => {
  const brief = tool.parameters.properties.brief;
  assert.equal(brief.additionalProperties, false);
  for (const key of ['schemaVersion','id','title','revision','why','change','mustHold','acceptance','units','authority']) {
    assert.ok(brief.required.includes(key), `required ${key}`);
    assert.ok(brief.properties[key], `documented ${key}`);
  }
  assert.equal(brief.properties.change.properties.before.type, 'string');
  assert.equal(brief.properties.change.properties.after.type, 'string');
  const check = brief.properties.acceptance.items.properties.check;
  assert.ok(check.anyOf.some(s => s.properties.cmd));
  assert.ok(check.anyOf.some(s => s.properties.judgment));
  assert.ok(brief.properties.units.items.properties.acceptanceIds);
  assert.ok(brief.properties.authority.properties.commands.description.includes('exact'));
  assert.equal(tool.parameters.properties.path.type, 'string', 'existing file path mode stays supported');
});
