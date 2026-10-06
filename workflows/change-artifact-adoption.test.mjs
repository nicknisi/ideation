import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArtifactConsumer, DISCOVER } from './change-artifacts.mjs';

test('approval adopts the already-open contract: same URL, comments route to run, identity survives restart', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'ideation-adoption-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const callbacks = new Map(), inbox = [];
  const api = {
    async publish({ title }) { return { slug: title, url: `http://127.0.0.1:9999/${title}.html`, absPath: `/project/.pi/artifacts/${title}.html` }; },
    async subscribe({ slug, onFeedback }) { callbacks.set(slug, onFeedback); return () => callbacks.delete(slug); },
    async answer() { return { ok: true }; },
  };
  const events = { emit(name, request) { if (name === DISCOVER) request.offer({ id: 'nicknisi.artifacts', apiMajor: 1, api }); } };
  const options = { stateDir, events, onFeedback: (id, f) => { inbox.push([id, f.markdown]); return true; } };
  let consumer = createArtifactConsumer(options);
  const draft = await consumer.update('approval-preview:first', '<h1>Draft</h1>', { sequence: Date.now() });
  const callback = callbacks.get(draft.slug);
  await consumer.adopt('run-one', 'approval-preview:first');
  const running = await consumer.update('run-one', '<h1>Running</h1>', { sequence: 1 });
  assert.equal(running.url, draft.url); assert.equal(running.localUrl, draft.localUrl);
  assert.match(await readFile(new URL(running.localUrl), 'utf8'), /Running/);
  await callback({ slug: draft.slug, markdown: 'Keep the scope', annotationIds: ['one'] });
  assert.deepEqual(inbox, [['run-one', 'Keep the scope']]);
  await consumer.dispose();
  consumer = createArtifactConsumer(options);
  const restored = await consumer.update('run-one', '<h1>Ready for review</h1>', { sequence: 10 });
  assert.equal(restored.url, draft.url); assert.equal(restored.localUrl, draft.localUrl);
  await consumer.dispose();
});

test('page requests carry only accepted actions and address the view that owns them now', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'ideation-requests-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const subscriptions = new Map(), requests = [];
  const api = {
    async publish({ title }) { return { slug: title, url: `http://127.0.0.1:9999/${title}.html`, absPath: `/project/.pi/artifacts/${title}.html` }; },
    async subscribe(input) { subscriptions.set(input.slug, input); return () => subscriptions.delete(input.slug); },
    async answer() { return { ok: true }; },
  };
  const events = { emit(name, request) { if (name === DISCOVER) request.offer({ id: 'nicknisi.artifacts', apiMajor: 1, api }); } };
  const consumer = createArtifactConsumer({ stateDir, events, onFeedback: () => true, actions: ['approve'], onRequest: (id, action) => { requests.push([id, action]); return true; } });
  t.after(() => consumer.dispose());
  const draft = await consumer.update('preview:one', '<h1>Draft</h1>', { sequence: Date.now() });
  const sub = subscriptions.get(draft.slug);
  assert.deepEqual(sub.actions, ['approve']);
  assert.equal(await sub.onRequest({ slug: draft.slug, action: 'approve' }), true);
  assert.equal(await sub.onRequest({ slug: draft.slug, action: 'merge' }), false, 'unlisted actions never reach the session');
  assert.equal(await sub.onRequest({ slug: 'someone-else', action: 'approve' }), false);
  await consumer.adopt('run-one', 'preview:one');
  await sub.onRequest({ slug: draft.slug, action: 'approve' });
  assert.deepEqual(requests, [['preview:one', 'approve'], ['run-one', 'approve']]);

  // Consumers that accept no requests subscribe exactly as before.
  const plain = createArtifactConsumer({ stateDir: join(stateDir, 'plain'), events, onFeedback: () => true });
  t.after(() => plain.dispose());
  const page = await plain.update('preview:two', '<h1>Plain</h1>', { sequence: Date.now() });
  assert.equal('actions' in subscriptions.get(page.slug), false);
});
