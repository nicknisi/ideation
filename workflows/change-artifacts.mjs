import { mkdir, writeFile, rename, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { safeUrl } from './change-ui.mjs';
export const ARTIFACT_SERVICE = 'nicknisi.artifacts';
export const DISCOVER = `plugin-services:v1:discover:${ARTIFACT_SERVICE}`;
export function validOffer(o) {
  return o?.id === ARTIFACT_SERVICE && o.apiMajor === 1 && o.api &&
    ['publish','answer','subscribe'].every(k => typeof Object.getOwnPropertyDescriptor(o.api, k)?.value === 'function');
}
export function discoverArtifacts(events) {
  const offers = []; let collecting = true;
  events.emit(DISCOVER, { offer(o) { if (collecting) offers.push(o); } });
  collecting = false;
  if (!offers.length) return null;
  if (offers.length !== 1 || !validOffer(offers[0])) throw new Error('Ambiguous or incompatible artifacts service');
  return offers[0].api;
}
const atomic = async (path, data) => { const tmp = `${path}.${randomUUID()}.tmp`; await writeFile(tmp, data); await rename(tmp, path); };
/** Provider URLs may move (e.g. a new port on restart) but must stay loopback: never
 * an arbitrary remote host that could exfiltrate a contract or receive answers. */
export function loopbackUrl(value) {
  const href = safeUrl(value);
  const url = new URL(href);
  if (url.protocol === 'file:') return href;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = host === 'localhost' || host.endsWith('.localhost') || host === '::1' ||
    host === '0:0:0:0:0:0:0:1' || /^127(?:\.\d{1,3}){3}$/.test(host);
  if (!loopback) throw new Error('Provider URL must be loopback (localhost/127.0.0.1/[::1])');
  return href;
}
/** One queue per durable view. Only HTML and our metadata are written, never annotation sidecars. */
export function createArtifactConsumer({ events, stateDir, onFeedback, warn = () => {} }) {
  const views = new Map(); let disposed = false;
  function view(id) {
    if (!views.has(id)) {
      const key = createHash('sha256').update(id).digest('hex');
      views.set(id, { id, key, title: `ideation-${key}`, tail: Promise.resolve(), sequence: -1 });
    }
    return views.get(id);
  }
  async function publish(v, item) {
    await mkdir(stateDir, { recursive: true });
    if (!v.bindingLoaded) {
      const binding = await readFile(join(stateDir, `${v.key}.binding.json`), 'utf8').then(JSON.parse).catch(() => null);
      if (binding && /^[a-f0-9]{64}$/.test(binding.key)) { v.key = binding.key; v.title = `ideation-${binding.key}`; }
      v.bindingLoaded = true;
    }
    const path = join(stateDir, `${v.key}.html`), meta = join(stateDir, `${v.key}.json`);
    await atomic(path, item.html);
    v.localUrl = pathToFileURL(path).href;
    if (!v.loaded) { v.saved = await readFile(meta, 'utf8').then(JSON.parse).catch(() => null); v.loaded = true; }
    v.url = v.saved?.url ?? v.localUrl;
    if (disposed) return;
    try {
      const api = discoverArtifacts(events);
      if (!api) { v.url = v.localUrl; return; }
      const result = await api.publish({ title: v.title, html: item.html, open: item.open });
      if (typeof result?.slug !== 'string' || !result.slug || typeof result.absPath !== 'string') throw new Error('Invalid publish response');
      // Slug and absPath fix artifact identity across restarts; only the loopback URL may move.
      const url = loopbackUrl(result.url);
      if (v.saved && (v.saved.slug !== result.slug || v.saved.absPath !== result.absPath)) throw new Error('Artifact identity changed');
      const previousApi = v.api;
      v.saved = { ...result, url }; v.url = url; v.api = api;
      await atomic(meta, JSON.stringify(v.saved));
      // A newly discovered provider instance invalidates the old subscription: retire it so
      // its callback can no longer deliver, then resubscribe against the current provider.
      if (v.unsubscribe && previousApi && previousApi !== api) {
        try { v.unsubscribe(); } catch {}
        v.unsubscribe = null; v.subToken = null;
      }
      if (!v.unsubscribe && onFeedback && !disposed) {
        const token = {};
        v.subToken = token;
        const unsubscribe = await api.subscribe({ slug: result.slug, onFeedback: async f => {
          if (disposed || v.subToken !== token || f?.slug !== result.slug || typeof f.markdown !== 'string' || !Array.isArray(f.annotationIds) || !f.annotationIds.every(x => typeof x === 'string')) return false;
          return onFeedback(v.id, f);
        } });
        if (typeof unsubscribe !== 'function') throw new Error('Invalid subscription');
        if (disposed || v.subToken !== token) unsubscribe(); else v.unsubscribe = unsubscribe;
      }
    } catch (e) { v.url = v.localUrl; warn(`Artifacts unavailable: ${e.message}. Local snapshot: ${v.localUrl}`); }
  }
  return {
    // The page reviewed for approval becomes the run's page, not a new tab or
    // slug. Existing annotations stay attached; callbacks now address the run.
    async adopt(runId, previewId) {
      if (disposed) throw new Error('Artifacts disposed');
      const preview = views.get(previewId);
      if (!preview) throw new Error('Approval preview is missing');
      if (views.has(runId)) throw new Error('Run already has an artifact view');
      await preview.tail;
      const runKey = createHash('sha256').update(runId).digest('hex');
      await atomic(join(stateDir, `${runKey}.binding.json`), JSON.stringify({ key: preview.key }));
      preview.id = runId; preview.sequence = -1; preview.bindingLoaded = true;
      views.delete(previewId); views.set(runId, preview);
    },
    update(id, html, { sequence = 0, open = false } = {}) {
      if (disposed) return Promise.reject(new Error('Artifacts disposed'));
      const v = view(id);
      if (sequence >= v.sequence) { v.sequence = sequence; v.pending = { html, open: Boolean(open || v.pending?.open) }; }
      v.tail = v.tail.catch(() => {}).then(async () => {
        if (!v.pending) return;
        const item = v.pending; v.pending = null;
        await publish(v, item);
      });
      return v.tail.then(() => ({ url: v.url, localUrl: v.localUrl, slug: v.saved?.slug }));
    },
    async answer(id, annotationId, content) {
      const v = view(id); await v.tail;
      if (disposed || !v.api || !v.saved) throw new Error('Live artifacts provider required');
      return v.api.answer({ slug: v.saved.slug, annotationId, content });
    },
    async dispose() {
      disposed = true;
      for (const v of views.values()) { try { v.unsubscribe?.(); } catch {} v.unsubscribe = null; v.subToken = null; }
      await Promise.allSettled([...views.values()].map(v => v.tail));
    },
  };
}
