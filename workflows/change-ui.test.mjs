import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalText, acceptanceText, safeUrl, chooseRun } from './change-ui.mjs';
import { validateBrief, briefFingerprint } from './change-brief.mjs';
const brief = validateBrief({schemaVersion:1,id:'demo',title:'Demo',revision:1,why:'why',change:{before:'before',after:'after'},mustHold:['invariant'],acceptance:[{id:'a',criterion:'works',check:{cmd:'node --test'}}],units:[{id:'u',title:'unit',goal:'goal',risk:'low',needs:[],acceptanceIds:['a']}],authority:{paths:['src/'],commands:['node --test']}});
test('safe contract links and compact authority summaries', () => {
  for(const url of ['javascript:alert(1)','http://a/\x1b','http://a/\n']) assert.throws(()=>safeUrl(url));
  const text=approvalText(brief); for(const x of ['Change: Demo','1 path(s)','1 exact command(s)','200,000 tokens','200 tool calls','not an OS sandbox']) assert.ok(text.includes(x), x);
});
test('approval summary stays bounded for a real-world brief instead of dumping its contents', () => {
  const large = structuredClone(brief);
  large.title = 'Full-screen installer with tasks, walkthrough, and tips';
  large.why = 'During a multi-minute agent run users cannot see what remains. '.repeat(40);
  large.change.before = large.change.after = large.why;
  large.mustHold = Array.from({ length: 15 }, (_, i) => `Invariant ${i}: ${large.why}`);
  large.acceptance = Array.from({ length: 12 }, (_, i) => ({ id: `check-${i}`, criterion: large.why, check: { cmd: `node --test tests/check-${i}.test.mjs` } }));
  large.authority.commands = large.acceptance.map(c => c.check.cmd);
  large.authority.paths = Array.from({ length: 20 }, (_, i) => `src/components/feature-${i}/`);
  const text = approvalText(large);
  const wrappedLines = text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 72)), 0);
  assert.ok(wrappedLines <= 12, `approval body consumed ${wrappedLines} rows before buttons`);
  assert.ok(text.length < 850, 'approval must summarize, not serialize');
  assert.ok(!text.includes('tests/check-11.test.mjs'), 'full commands belong in the opened contract');
  assert.match(text, /12/); assert.match(text, /20/);
});

test('final acceptance is a short decision, not a second wall of judgment text', () => {
  const b = structuredClone(brief);
  b.acceptance.push(...Array.from({ length: 20 }, (_, i) => ({ id: `judgment-${i}`, criterion: 'Visual quality', check: { judgment: 'Inspect all surfaces in the actual app. '.repeat(80) } })));
  const text = acceptanceText({ state: 'ready-for-review', brief: b, evidence: [], sourceRevision: 'revision' });
  assert.match(text, /Human judgments to accept: 20/);
  assert.ok(text.length < 600);
  assert.ok(!text.includes('Inspect all surfaces'), 'full judgments stay in the opened contract');
});

test('selection scopes repository and active owner, prefers unfinished latest', () => {
  const runs=[{id:'old',repoRoot:'/r',ownerId:null,state:'paused',updatedAt:1},{id:'done',repoRoot:'/r',state:'accepted',updatedAt:3},{id:'foreign',repoRoot:'/x',state:'running',updatedAt:4},{id:'other-owner',repoRoot:'/r',ownerId:'other',state:'running',updatedAt:5}];
  assert.equal(chooseRun(runs,'/r','me').id,'old');
});
// Native Node type stripping plus narrow dependency stubs: no Pi installation or model calls.
const hooks=registerHooks({resolve(specifier,context,next){
  if(specifier==='@nicknisi/pi-shared') return {url:'data:text/javascript,export const createSubagentRuntime=()=>{throw new Error("unexpected runtime")}',shortCircuit:true};
  if(specifier==='typebox') return {url:'data:text/javascript,export const Type=new Proxy({}, {get:(_,k)=>(...args)=>({kind:k,args})})',shortCircuit:true};
  return next(specifier,context);
}});
const {registerChange}=await import('../extensions/change.ts'); hooks.deregister();
test('mock Pi: model cannot approve, headless denied, confirmation cancellation and lifecycle cleanup', async t => {
  const root=await mkdtemp(join(tmpdir(),'ideation-front-')); t.after(()=>rm(root,{recursive:true,force:true}));
  const handlers={},commands={},tools={},notifications=[],sent=[],calls=[];
  let confirmation=false;
  const pi={on:(n,f)=>handlers[n]=f,registerCommand:(n,v)=>commands[n]=v,registerTool:v=>tools[v.name]=v,events:{emit(){}},appendEntry(){},sendUserMessage:(...x)=>sent.push(x),exec:async (_cmd,args)=>({code:0,stdout:args.includes('--show-toplevel')?root:join(root,'.git'),stderr:''})};
  const runner={status:async()=>[],dispose:async()=>calls.push('dispose'),approve:async()=>{calls.push('approve');throw new Error('dirty checkout');}};
  registerChange(pi,{createChangeRunner:opts=>{assert.equal(opts.ownerId,'owner');assert.equal(opts.repoRoot,root);return runner;},createSubagentRuntime:()=>({spawn:async()=>{throw new Error('no calls');}})});
  const ctx={cwd:root,hasUI:false,model:{provider:'p',id:'m'},sessionManager:{getSessionId:()=> 'owner'},ui:{notify:m=>notifications.push(m),setStatus(){},setWidget(){},confirm:async(_title,text)=>{assert.match(text,/tokens/);return confirmation;}}};
  await assert.rejects(commands.ideation.handler('approve b.json',ctx),/headless/);
  await assert.rejects(tools.ideation_change.execute('',{action:'approve'},null,null,ctx)); assert.equal(calls.includes('approve'),false);
  await writeFile(join(root,'b.json'),JSON.stringify(brief)); ctx.hasUI=true;
  await commands.ideation.handler('approve b.json',ctx); assert.equal(calls.includes('approve'),false);
  confirmation=true; await assert.rejects(commands.ideation.handler('approve b.json',ctx),/dirty checkout/);
  assert.equal(notifications.some(x=>x.includes('Approval recorded')),false);
  const preview=await tools.ideation_change.execute('',{action:'prepare',path:'b.json'},null,null,ctx);
  assert.match(preview.details.url,/\/\.git\/ideation\/views\//); assert.equal(preview.details.approved,false);
  await handlers.session_shutdown(); assert.equal(calls.at(-1),'dispose'); assert.equal(sent.length,0);
});
test('mock Pi: approved background model binding and feedback persistence before parent follow-up', async t => {
  const root=await mkdtemp(join(tmpdir(),'ideation-approved-')); t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(root,'brief.json'),JSON.stringify(brief));
  const handlers={},commands={},order=[]; let callback, options, settle, run;
  const done=new Promise(r=>settle=r);
  const service={publish:async()=>({slug:'stable',url:'http://localhost:1/stable',absPath:'/tmp/stable'}),subscribe:async x=>{callback=x.onFeedback;return ()=>order.push('unsubscribe');},answer:async()=>({ok:true})};
  const pi={on:(n,f)=>handlers[n]=f,registerCommand:(n,c)=>commands[n]=c,registerTool(){},appendEntry(){},events:{emit(n,x){if(n.includes('discover:')) x.offer({id:'nicknisi.artifacts',apiMajor:1,api:service});}},sendUserMessage:(m,o)=>{assert.equal(o.deliverAs,'followUp');order.push('parent');},exec:async(_c,args)=>({code:0,stdout:args.includes('--show-toplevel')?root:join(root,'.git')})};
  const runner={approve:async path=>{assert.match(path,/\.git\/ideation\/approvals/);await mkdir(join(root,'.git','ideation','runs','r'),{recursive:true});run={id:'r',repoRoot:root,brief,briefHash:briefFingerprint(brief),sequence:1,state:'ready',units:[],evidence:[]};return run;},status:async id=>id?run:[],start:async()=>{order.push('start');await options.spawn({prompt:'plan',cwd:'/workspace'});await done;return run;},recordFeedback:async(id,f)=>{assert.equal(id,'r');assert.equal(f.markdown,'note');order.push('persist');},dispose:async()=>{order.push('dispose');settle();}};
  registerChange(pi,{createChangeRunner:o=>{options=o;return runner;},createSubagentRuntime:o=>{assert.match(o.artifactsDir,/ideation\/children/);return {spawn:async o=>{assert.equal(o.model,'provider/model');assert.equal(o.cwd,'/workspace');order.push('spawn');}};}});
  const ctx={cwd:root,hasUI:true,model:{provider:'provider',id:'model'},sessionManager:{getSessionId:()=> 'session'},ui:{confirm:async()=>true,notify(){},setStatus(){},setWidget(){}}};
  await commands.ideation.handler('approve brief.json',ctx);
  while(!order.includes('spawn')) await new Promise(r=>setImmediate(r));
  assert.equal(await callback({slug:'stable',markdown:'note',annotationIds:['a']}),true);
  assert.ok(order.indexOf('persist')<order.indexOf('parent'));
  await handlers.session_shutdown(); assert.ok(order.includes('unsubscribe')); assert.ok(order.includes('dispose'));
  assert.equal(await callback({slug:'stable',markdown:'note',annotationIds:['a']}),false);
});
