# ideation.engineering

The plugin's public site. Three pages, one deploy:

| Route          | Source                        | What it is                                                                  |
| -------------- | ----------------------------- | --------------------------------------------------------------------------- |
| `/`            | `src/pages/index.astro`       | The overview: the contract, the seven stages, what it refuses, install.       |
| `/walkthrough` | `src/pages/walkthrough.astro` | One invented feature — the bookmark garden — through all seven stages.        |
| `/guide`       | `src/pages/guide.astro`       | The command reference, generated from the plugin's own source.                |

`/` and `/walkthrough` share the **Industry** design system
(`src/styles/industry.css` + `src/layouts/Industry.astro`). `/guide` still wears
the older **field guide** world (`src/styles/global.css`). Both stylesheets
clear Tailwind's palette, so a page must import exactly one of them.

## Local

```sh
pnpm install
pnpm dev            # http://localhost:4321 — / and /guide/
pnpm build          # → dist/
pnpm deploy:check   # validate wrangler.jsonc, no credentials needed
pnpm exec wrangler dev   # serve dist/ through the Workers runtime, with _headers
```

The repo root delegates, so `pnpm dev`, `pnpm build`, `pnpm deploy` and
`pnpm deploy:check` all work from one directory up too.

`pnpm dev` and the build route identically. Every page is a real Astro route
now; the hand-written `src/pages/index.html` that used to serve `/` was retired
when the Industry pages landed. Do not put an `index.html` back in `public/` —
Vite special-cases it as an entry template, so `/` 404s in dev while the build
serves it fine.

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

Two systems live here, one per stylesheet, and they never meet in one document.

**Industry** (`src/styles/industry.css`) dresses `/` and `/walkthrough`: a
drafting table. Barlow Condensed headings over Barlow body, one slate-blue
accent, square corners everywhere, and registration marks at the corners of
every framed object (`src/components/Blueprint.astro`). Depth comes from the
frame, never from a shadow. Imported from a Claude Design project.

**Field guide** (`src/styles/global.css`) dresses `/guide`: paper ground, ink,
one cobalt accent, serif display, letterpress offset, 3px radii, graphite dark
deck.

Both clear Tailwind's default palette (`--color-*: initial`) so `bg-blue-500` is
not reachable; the only colours that exist are the system's own. `@theme inline`
keeps utilities pointing at the CSS variables, so the theme toggle flips at
runtime rather than being baked in at build time.

Two things about Industry are worth knowing before editing it:

- **`--spacing: 3.4px`.** The design system's tokens are `3.4px × n`, so feeding
  that base to Tailwind makes `p-4` *be* `--space-4` and `pt-8` *be* `--space-8`.
  The consequence is that every numeric utility is on that scale — `size-9` is
  30.6px, not 36px. Use explicit pixel values for fixed-size chrome.
- **Nothing scroll-linked may read layout.** The growth animations cache their
  geometry on load and resize and then run off `scrollY` alone, and one-shot
  reveals use an IntersectionObserver. A `getBoundingClientRect()` in a scroll
  handler forces a synchronous layout every frame, which is exactly what these
  pages must not do underneath a sticky `backdrop-filter` header.

Barlow is self-hosted in `public/fonts/` (latin subset, 5 faces, ~76 KB). The
site makes no external requests — that rule predates these pages and still holds.
