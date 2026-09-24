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
