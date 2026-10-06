# html-plan runtime (vendored)

The plan renderer (`scripts/plan-render.ts`) draws plan data as an html-plan
page and packs it with this runtime.

## Source

- Repository: https://github.com/anthropics/claude-plugins-community
- Commit: `f60f0454df3045f724c43c6346ec80bdcc3472b2`
- Path: `html-plan/skills/html-plan/runtime/`
- Fetched: 2026-10-06, by a shallow fetch of that commit

| file | sha256 as fetched |
|---|---|
| `htmlplan.css` | `f16d2c6aa08e5f275bceee96e38ec38f05dd0add91c4bb6636e8a0a8a4836a9e` |
| `htmlplan.js` | `4b5bcb3d7160c6170bc82c6f1809089d0faa890d2c7f7e8c9100ff6330478d42` |
| `pack.mjs` | `88ca711cfc4a3c37c9155357487763f75aa8a9cf1ebc789dfefe1542a38944df` |

## Licence

The runtime folder carries no licence file of its own. The plugin's
`html-plan/.claude-plugin/plugin.json` says `"license": "MIT"`, but the
repository's root `LICENSE` at that commit is the Apache License 2.0, and the
repository has no NOTICE file. `LICENSE` here is that root Apache-2.0 text,
copied verbatim (sha256
`cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`). No MIT
text is included.

## Local modifications

Each modified file carries a notice at its top, as Apache-2.0 §4(b) requires.
The original headers are kept. `htmlplan.css` and `pack.mjs` are unmodified.

### `htmlplan.js`: Send hook

Upstream ships a dormant Send path in `openResponse()`
(`const liveOn = false, send = null;`). Three changes make it live when a
host is present; nothing is restyled or renamed:

1. Line 1: a one-line modification notice, above the original header.
2. Before `globalThis.HtmlPlan = NW;`: a pure function `NW.planHost(w)`. If
   `w.__planRespond` is a function it returns `payload => w.__planRespond(payload)`;
   else, if the page is framed (`w.parent && w.parent !== w`), it returns
   `payload => w.parent.postMessage({ type: 'ideation:plan-respond', payload }, '*')`;
   else `null`. It sits in the DOM-free part of the file, so pack and the
   tests can load it without a document.
3. In `openResponse()`, the dormant line becomes
   `const host = NW.planHost(window), liveOn = !!host, send = liveOn ? <Send button> : null;`.
   Send calls `host({ markdown: r.md, answers: ans })`: the response markdown
   the sheet shows, and the form answers `readAnswers()` collected (control
   name → value). It then writes "Sent" into the sheet's existing
   `.nw-send-state` span. Upstream's own `liveOn` branches then make Send the
   primary button and Copy secondary, and switch the hint text.

With no host, `planHost` returns `null`, so `liveOn` is `false` and `send` is
`null`, exactly as upstream: only Copy response is offered.

### `htmlplan.js`: comment controls off

A page served by `@nicknisi/pi-artifacts` already carries that package's own
Review layer, which it injects into every served page and which 1.5.x has no
per-page way to leave out. So that such a page has one comment surface, a
page can turn html-plan's comment controls off with
`<meta name="htmlplan" content="no-comments">` (the same meta name and
token-list convention as upstream's `readonly`). Respond, Send, Copy,
decisions, schema edits and strikes are unchanged.

1. Line 1: the modification notice names this switch.
2. Above `openComment()`: `const noComments = () => !!$('meta[name="htmlplan"][content~="no-comments"]');`.
3. `openComment()` returns at once, and `commentable()` returns a no-op
   without adding its `+` button or click handler, when `noComments()`.
4. The code-line gutter (title and click) and the calls row's `✎ comment`
   button are only added when comments are on.
5. `buildResponse()` writes no `## Comments` section, and the bar's button
   reads Respond rather than Comment, when comments are off.

Without the meta, the runtime behaves exactly as before.
