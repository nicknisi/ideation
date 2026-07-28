# ideation.engineering

The plugin's public site. Two pages, one deploy:

| Route    | Source                | What it is                                                         |
| -------- | --------------------- | ------------------------------------------------------------------ |
| `/`      | `public/index.html`   | The illustrated walkthrough. Hand-written, self-contained, served verbatim. |
| `/guide` | `src/pages/guide.astro` | The command reference, generated from the plugin's own source.    |

## Local

```sh
pnpm install
pnpm dev            # http://localhost:4321 — / and /guide/
pnpm build          # → dist/
pnpm deploy:check   # validate wrangler.jsonc, no credentials needed
pnpm exec wrangler dev   # serve dist/ through the Workers runtime, with _headers
```

`pnpm dev` and the build route identically. That was not free: the walkthrough
originally lived in `public/index.html`, which Vite special-cases as an entry
template, so `/` 404'd in dev while the build served it fine. Astro supports
plain `.html` files as pages, so it lives in `src/pages/index.html` and passes
through byte-identically.

## Deploying

Config is in `wrangler.jsonc` rather than dashboard state, so it is reviewable
and can be validated locally. There is no `main` worker script — this is a
static assets deploy, and Astro needs no Cloudflare adapter for it.

```sh
pnpm deploy         # astro build && wrangler deploy
```

`not_found_handling: "404-page"` serves `dist/404.html` for unknown paths.
`public/_headers` is copied to the output root and applies a CSP plus the usual
hardening; both Pages and Workers static assets honour it.

If you deploy through the **Pages** Git integration instead of `wrangler`, no
config file is required — set root directory `site`, build command `pnpm build`,
output `dist`, Node 24 in the dashboard.

The custom domain is `ideation.engineering`. `nicknisi.github.io/ideation/`
still serves a redirect stub from `docs/index.html` for anyone holding the old
URL.

Verified through the Workers runtime rather than assumed: `/` and `/guide/`
return 200, `/nope` returns 404 and renders the custom page, all five headers
arrive, and the CSP does not break the inline styles and scripts every page
here depends on.

## Why the build is also a test

`/guide` does not restate the plugin's behaviour from memory. It reads:

- **`skills/*/SKILL.md` frontmatter** for every command name, argument hint, and
  the two badges — whether Claude may start it (`disable-model-invocation`) and
  whether it can write files (`allowed-tools`).
- **`references/confidence-rubric.md`** for the five evidence gates, their
  questions, and their ready-when conditions.

Only editorial judgement is authored, in `src/data/commands.ts`: the order, the
situation each command answers, and what you walk away with.

The join throws rather than rendering something false:

- a skill that ships with no entry in `commands.ts` fails the build
- an entry naming a skill that no longer ships fails the build
- a rubric that stops having exactly five gates fails the build, because the
  page says "five" in prose

This repo has watched duplicated knowledge rot more than once — a run-model
diagram that shipped four wrong engine values, a field documented as dormant
whose producer had been specified in another skill all along, a `KEEP IN SYNC`
comment that demonstrably did not. A hand-maintained docs page would have been
next. CI runs `pnpm build` for exactly this reason.

One derivation worth knowing about, because it was wrong first time round: an
**absent** `allowed-tools` key means *every* tool is available, not none.
`ideation` is the only skill that omits it, and treating absent as an empty list
rendered "writes no files" beside the command that writes the entire contract.

## Design

The visual world is inherited, not invented — the tokens in
`src/styles/global.css` are copied verbatim from `public/index.html`: paper
ground, ink, one cobalt accent, serif display, letterpress offset, hairline
rules, 3px radii, graphite dark deck. Tailwind's default palette is cleared
(`--color-*: initial`) so `bg-blue-500` is not reachable; the only colours that
exist are the field guide's. `@theme inline` keeps utilities pointing at the CSS
variables, so the three-state theme toggle flips at runtime.
