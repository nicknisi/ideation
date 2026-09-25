import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArtifactConsumer, discoverArtifacts, validOffer, loopbackUrl, DISCOVER } from './change-artifacts.mjs';
const offer = api => ({ id: 'nicknisi.artifacts', apiMajor: 1, api });
const bus = offers => ({ emit(channel, request) { assert.equal(channel, DISCOVER); offers.forEach(request.offer); } });
const api = () => ({ publish: async () => ({ slug:'s',url:'http://localhost:1/s',absPath:'/tmp/s' }), answer:async () => ({ok:true}), subscribe:async () => () => {} });
test('exact service identity, major, own methods and ambiguity', () => {
  const a = api(); assert.equal(discoverArtifacts(bus([offer(a)])), a);
  assert.equal(discoverArtifacts(bus([])), null);
  assert.equal(validOffer(offer(Object.create(a))), false);
  for (const offers of [[{...offer(a),apiMajor:2}], [{...offer(a),id:'other'}], [offer(a),offer(a)]]) assert.throws(() => discoverArtifacts(bus(offers)));
});
async function fixture(t, options = {}) {
  const stateDir = await mkdtemp(join(tmpdir(),'ideation-view-'));
  const c = createArtifactConsumer({ stateDir, events:bus([]), ...options });
  t.after(async () => { await c.dispose(); await rm(stateDir,{recursive:true,force:true}); }); return c;
}
test('durable stable fallback and stale sequence rejection', async t => {
  const c = await fixture(t); const first = await c.update('run','first',{sequence:1});
  const last = await c.update('run','last',{sequence:3});
  await c.update('run','stale',{sequence:2});
  assert.equal(first.url,last.url); assert.equal(await readFile(new URL(last.url),'utf8'),'last');
});
test('ordered coalescing, same title, subscription feedback and answer without publication', async t => {
  const a = api(), calls = [], feedback = []; let callback, unsubscribed = 0, release;
  const gate = new Promise(r => release = r);
  a.publish = async x => { calls.push(x); if(calls.length===1) await gate; return {slug:'s',url:'http://localhost:1/s',absPath:'/tmp/s'}; };
  a.subscribe = async x => { callback=x.onFeedback; return () => unsubscribed++; };
  a.answer = async x => { assert.equal(x.annotationId,'q'); return {ok:true}; };
  const c = await fixture(t,{events:bus([offer(a)]),onFeedback:async (id,f) => {feedback.push([id,f]);return true;}});
  const first=c.update('run','one',{sequence:1});
  while(!calls.length) await new Promise(r => setImmediate(r));
  const second=c.update('run','two',{sequence:2}), third=c.update('run','three',{sequence:3});
  release(); await Promise.all([first,second,third]);
  assert.deepEqual(calls.map(x=>x.html),['one','three']); assert.equal(calls[0].title,calls[1].title);
  assert.equal(await callback({slug:'s',markdown:'comment',annotationIds:['q']}),true);
  assert.equal(feedback[0][0],'run'); await c.answer('run','q','answer'); assert.equal(calls.length,2);
  await c.dispose(); assert.equal(unsubscribed,1); assert.equal(await callback({slug:'s',markdown:'late',annotationIds:[]}),false);
});
test('provider invocation failure warns but preserves durable local view', async t => {
  const a=api(),warnings=[]; a.publish=async()=>{throw new Error('offline');};
  const c=await fixture(t,{events:bus([offer(a)]),warn:m=>warnings.push(m)});
  const result=await c.update('run','receipt'); assert.match(result.url,/^file:/); assert.equal(await readFile(new URL(result.url),'utf8'),'receipt'); assert.match(warnings[0],/offline/);
});
test('loopbackUrl accepts localhost/127/::1, rejects arbitrary remotes', () => {
  for (const u of ['http://localhost:1/s','http://127.0.0.1:9000/s','http://[::1]:8080/s','https://api.localhost/s','file:///tmp/s'])
    assert.equal(loopbackUrl(u), new URL(u).href);
  for (const u of ['http://evil.example.com/s','http://10.0.0.5/s','https://1.2.3.4/s'])
    assert.throws(() => loopbackUrl(u), /loopback/);
});
test('restart pins slug and absPath but accepts a moved loopback port', async t => {
  const stateDir = await mkdtemp(join(tmpdir(),'ideation-restart-'));
  t.after(() => rm(stateDir,{recursive:true,force:true}));
  const mk = url => ({ publish: async () => ({ slug:'stable', url, absPath:'/tmp/stable' }), subscribe: async () => () => {}, answer: async () => ({ok:true}) });
  const c1 = createArtifactConsumer({ stateDir, events: bus([offer(mk('http://localhost:1/stable'))]), onFeedback: async () => true });
  assert.equal((await c1.update('run','one',{sequence:1})).url, 'http://localhost:1/stable');
  await c1.dispose();
  const c2 = createArtifactConsumer({ stateDir, events: bus([offer(mk('http://127.0.0.1:9999/stable'))]), onFeedback: async () => true });
  t.after(() => c2.dispose());
  assert.equal((await c2.update('run','two',{sequence:2})).url, 'http://127.0.0.1:9999/stable');
  // A moved slug/absPath is a genuine identity change and must be rejected (local fallback).
  const warnings = [];
  const c3 = createArtifactConsumer({ stateDir, events: bus([offer(mk('http://localhost:2/moved'))]), warn: m => warnings.push(m), onFeedback: async () => true });
  t.after(() => c3.dispose());
  const moved = mk('http://localhost:2/moved'); moved.publish = async () => ({ slug:'other', url:'http://localhost:2/other', absPath:'/tmp/other' });
  const c4 = createArtifactConsumer({ stateDir, events: bus([offer(moved)]), warn: m => warnings.push(m), onFeedback: async () => true });
  t.after(() => c4.dispose());
  assert.match((await c4.update('run','three',{sequence:3})).url, /^file:/);
  assert.ok(warnings.some(w => /identity changed/.test(w)));
});
test('changed provider identity refreshes subscription and retires the stale callback', async t => {
  const stateDir = await mkdtemp(join(tmpdir(),'ideation-refresh-'));
  t.after(() => rm(stateDir,{recursive:true,force:true}));
  let cbOld, cbNew, unsubOld = 0, unsubNew = 0;
  const apiA = { publish: async () => ({ slug:'stable', url:'http://localhost:1/stable', absPath:'/tmp/stable' }), subscribe: async x => { cbOld = x.onFeedback; return () => unsubOld++; }, answer: async () => ({ok:true}) };
  const apiB = { publish: async () => ({ slug:'stable', url:'http://localhost:2/stable', absPath:'/tmp/stable' }), subscribe: async x => { cbNew = x.onFeedback; return () => unsubNew++; }, answer: async () => ({ok:true}) };
  let currentApi = apiA; const delivered = [];
  const events = { emit(channel, request) { assert.equal(channel, DISCOVER); request.offer(offer(currentApi)); } };
  const c = createArtifactConsumer({ stateDir, events, onFeedback: async (id, f) => { delivered.push(f.markdown); return true; } });
  t.after(() => c.dispose());
  await c.update('run','one',{sequence:1});
  assert.equal(await cbOld({slug:'stable',markdown:'first',annotationIds:['a']}), true);
  currentApi = apiB;
  await c.update('run','two',{sequence:2});
  assert.equal(unsubOld, 1);
  assert.equal(await cbOld({slug:'stable',markdown:'stale',annotationIds:['b']}), false); // retired callback is inert
  assert.equal(await cbNew({slug:'stable',markdown:'second',annotationIds:['c']}), true);
  assert.deepEqual(delivered, ['first','second']);
});
