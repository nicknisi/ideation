// Render plan data as an html-plan page: renderPlan maps a Plan onto
// html-plan's blocks (vendor/html-plan, references in its SOURCE.md), and
// packPlan runs the vendored pack.mjs over it, which lints the page, fills
// src= exhibits from the repo and inlines the runtime into one file.
//
// Usage: node scripts/plan-render.ts <plan.json> [-o out.html] [--root dir]
//
// Plan text is data, never markup. Every string is entity-escaped, except
// block sources, which go in a <script type="text/plain"> as html-plan wants
// (pack appends its own excerpt scripts to doc-calls, and the runtime reads the
// first one as the source). There, the only sequences that could end the
// script or a block early are broken: `</script`, `</doc-` and `<!--`.
//
// The field-guide token layer (plan-render.css) goes in as a <style>, not a
// <link>: pack inlines a linked stylesheet only from inside --root or the
// page's own folder, and this file lives in neither.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Claim, Decision, Exhibit, Plan } from '../schemas/plan.ts';
import { load } from './plan-data.ts';
import { isEntryPoint } from './verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PACK = resolve(here, '../vendor/html-plan/runtime/pack.mjs');
const css = readFileSync(join(here, 'plan-render.css'), 'utf8');

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const attrs = (a: Record<string, string | undefined>) =>
  Object.entries(a).filter(([, v]) => v !== undefined).map(([k, v]) => ` ${k}="${esc(v!)}"`).join('');
const ext = (path?: string) => path?.match(/\.(\w+)$/)?.[1];
const source = (s: string) => `<script type="text/plain">\n${s.replace(/<(\/script|\/doc-|!--)/gi, '<\\$1')}\n</script>`;

/**
 * One exhibit. A body is the block's own html-plan source, shown in the block
 * its kind names. An exhibit with only a src is shown as code (a schema as a
 * schema): pack fills it from the repo, unless it is a sketch, whose file does
 * not exist yet.
 */
function exhibit(e: Exhibit): string {
  const sketch = e.sketch ? ' · sketch' : '';
  const caption = e.sketch ? 'Sketch: this does not exist yet.' : 'This exists today.';
  if (e.body === undefined) {
    const tag = e.kind === 'schema' ? 'doc-schema' : 'doc-code';
    const lang = e.kind === 'schema' ? ext(e.src) ?? 'ts' : undefined;
    return e.sketch
      ? `<${tag}${attrs({ title: `${e.src}${sketch}`, lang })}>${source('Not written yet.')}</${tag}>`
      : `<${tag}${attrs({ src: e.src, lines: e.lines, ref: e.ref, lang })}></${tag}>`;
  }
  const body = source(e.body);
  switch (e.kind) {
    case 'code': return `<doc-code${attrs({ title: `${e.src ?? 'code'}${sketch}`, lang: ext(e.src) })}>${body}</doc-code>`;
    case 'schema': return `<doc-schema${attrs({ title: `${e.src ?? 'schema'}${sketch}`, lang: ext(e.src) ?? 'ts' })}>${body}</doc-schema>`;
    case 'machine': return `<doc-machine${attrs({ caption })}>${body}</doc-machine>`;
    case 'calls': return `<doc-calls${attrs({ caption })}>${body}</doc-calls>`;
    case 'mock': return `<doc-mock frame="none" w="440"${attrs({ caption })}><template><p style="margin:0;padding:12px 14px;white-space:pre-wrap;color:var(--ink);font:14px/1.5 var(--sans)">${esc(e.body)}</p></template></doc-mock>`;
  }
}

const label = (d: Decision, value: string) => d.options.find(o => o.value === value)!.label;

/** A decision as a doc-ask: the checked option is the plan's current position, with its state and any rejections. */
function ask(d: Decision): string {
  const checked = d.state === 'answered' ? d.answer! : d.recommended;
  const state = d.state === 'answered' ? `Answered: ${label(d, d.answer!)}.`
    : d.state === 'kept' ? 'Kept as recommended.'
    : d.required ? 'Not opened (required).' : 'Not opened.';
  const options = d.options.map(o => {
    const r = d.rejected.find(x => x.value === o.value);
    const note = r ? `<small>Rejected${r.reason ? `: ${esc(r.reason)}` : ''}</small>` : '';
    return `  <label><input${attrs({ type: 'radio', name: d.id, value: o.value })}${o.value === checked ? ' checked' : ''}> ${esc(o.label)}${note ? ` ${note}` : ''}</label>`;
  });
  return [`<doc-ask${attrs({ id: d.id })}>`, `  <p>${esc(d.question ?? label(d, checked))}</p>`, ...options,
    `  <p><b>${esc(state)}</b> ${esc(d.reason)}</p>`, '</doc-ask>'].join('\n');
}

function claim(c: Claim): string {
  return ['<doc-claim>', `<p>${esc(c.text)}</p>`, exhibit(c.exhibit), ...(c.decision ? [ask(c.decision)] : []),
    ...(c.children ?? []).map(claim), '</doc-claim>'].join('\n');
}

const SCOPE_LISTS = [['mvp', 'MVP'], ['full', 'Full'], ['stretch', 'Stretch'], ['future', 'Future'], ['notChanging', 'Not changing'], ['dropped', 'Dropped']] as const;

/** The aux="scope" branch: every scope list the plan has, in tier order. */
function scope(plan: Plan): string {
  const lists = SCOPE_LISTS.filter(([key]) => plan.scope[key].length).map(([key, name]) =>
    `<h4>${name}</h4>\n<ul>\n${plan.scope[key].map(i => `<li>${esc(i)}</li>`).join('\n')}\n</ul>`);
  return ['<doc-claim aux="scope">', '<p>Scope: what is in, what is not changing.</p>', ...lists, '</doc-claim>'].join('\n');
}

/**
 * Pure and deterministic: the same plan gives the same bytes. The <title>
 * carries the version because the runtime keeps a reader's answers, drafts and
 * strikes under the page's path and title, and a live page keeps its path
 * from version to version: a new version must not restore the last one's.
 */
export function renderPlan(plan: Plan): string {
  const via = (from: string) => /\.\w+$/.test(from) ? 'doc' : 'prompt';
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>${esc(plan.title)} · v${plan.version}</title>
<link rel="stylesheet" href="htmlplan.css">
<script src="htmlplan.js" defer></script>
<style data-plan-render>
${css}</style>
<body>
<header>
<h1>${esc(plan.title)}</h1>
<div class="meta"><span>${esc(plan.id)}</span><span>Version ${plan.version}</span>${plan.supersedes ? `<span>Supersedes ${esc(plan.supersedes)}</span>` : ''}</div>
${plan.why.length ? `<details class="thread"><summary>Why · ${plan.why.length} ${plan.why.length === 1 ? 'quote' : 'quotes'}</summary>
${plan.why.map(w => `<doc-quote${attrs({ via: via(w.from), from: w.from })}>${esc(w.quote)}</doc-quote>`).join('\n')}
</details>\n` : ''}</header>
<main>
<doc-plan>
${plan.claims.map(claim).join('\n')}
${scope(plan)}
</doc-plan>
</main>
</body>
</html>
`;
}

/** Packs a plan with the vendored pack.mjs: returns pack's report; throws it when pack refuses (any lint error). */
export function packPlan(plan: Plan, { out, root = process.cwd(), lintOnly = false }: { out?: string; root?: string; lintOnly?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'plan-render-'));
  try {
    const page = join(dir, 'plan.html');
    writeFileSync(page, renderPlan(plan));
    const args = [PACK, page, '--root', realpathSync(root), ...(lintOnly ? ['--lint-only'] : ['-o', resolve(out ?? 'plan.html')])];
    // pack is plain node with no browser; the timeout only bounds a wedged child.
    try { return execFileSync(process.execPath, args, { encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL' }); }
    catch (e: any) { throw new Error(`${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function main(argv: string[]): number {
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
  const out = flag('-o'), root = flag('--root');
  if (argv.length !== 1 || argv[0].startsWith('-')) { console.error('Usage: node scripts/plan-render.ts <plan.json> [-o out.html] [--root dir]'); return 2; }
  try { process.stdout.write(packPlan(load(argv[0]), { out: out ?? argv[0].replace(/\.json$/, '') + '.html', root })); return 0; }
  catch (e) { console.error((e as Error).message); return 1; }
}

if (isEntryPoint(import.meta.url)) process.exitCode = main(process.argv.slice(2));
