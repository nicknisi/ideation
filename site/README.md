# ideation.engineering

The plugin's public site. One design world, one deploy:

| Route                                  | Source                                        | What it is                                                                                          |
| -------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `/`                                    | `src/pages/index.astro`                       | The overview: two equal tracks (Pi / Claude Code) behind one switch, the launch video, install.       |
| `/walkthrough/pi/`                     | `src/pages/walkthrough/pi/index.astro`        | One invented change taken from `/ideation` to accept, with the product's real contract and widget.     |
| `/walkthrough/pi/contract/<state>.html`| `src/pages/walkthrough/pi/contract/[state].html.ts` | The real contract pages the Pi walkthrough frames: proposed, revised, running, ready, accepted. |
| `/walkthrough/`                        | `src/pages/walkthrough/index.astro`           | One invented feature — the bookmark garden — through all seven stages of the planning path.          |
| `/guide/`                              | `src/pages/guide.astro`                       | The command reference for both tracks, generated from the plugin's own source.                       |
| `/404`                                 | `src/pages/404.astro`                         | Not found.                                                                                            |

Every page uses `src/layouts/Site.astro` and `src/styles/global.css`.

## Local

```sh
pnpm install
pnpm dev            # http://localhost:4321
pnpm build          # → dist/
pnpm deploy:check   # validate wrangler.jsonc, no credentials needed
pnpm exec wrangler dev   # serve dist/ through the Workers runtime, with _headers
```

The repo root delegates, so `pnpm dev`, `pnpm build`, `pnpm deploy` and
`pnpm deploy:check` all work from one directory up too. Do not put an `index.html`
in `public/`: Vite special-cases it as an entry template, so `/` 404s in dev while
the build serves it fine.

## Deploying

Config is in `wrangler.jsonc` rather than dashboard state, so it is reviewable and can
be validated locally. There is no `main` worker script — this is a static assets
deploy, and Astro needs no Cloudflare adapter for it.

```sh
pnpm deploy         # astro build && wrangler deploy
```

`not_found_handling: "404-page"` serves `dist/404.html` for unknown paths.
`public/_headers` is copied to the output root: a `self`-only CSP plus the usual
hardening. Framing is `SAMEORIGIN`/`frame-ancestors 'self'` rather than `none`
because the Pi walkthrough frames its own contract pages; the site has no forms or
sessions to clickjack.

If you deploy through the **Pages** Git integration instead of `wrangler`, no config
file is required — set root directory `site`, build command `pnpm build`, output
`dist`, Node 24 in the dashboard. The custom domain is `ideation.engineering`;
`nicknisi.github.io/ideation/` still serves a redirect stub from `docs/index.html`.

## Why the build is also a test

The site does not restate the plugin's behaviour from memory. At build time it reads:

| Source | Read by | What it supplies |
| --- | --- | --- |
| `skills/*/SKILL.md` frontmatter | `src/lib/skills.ts` | Every planning command, argument hint and badge (whether Claude may start it, whether it can write files). |
| `references/confidence-rubric.md` | `src/lib/gates.ts` | The evidence gates, their questions and ready-when conditions. |
| `references/harness-compat.md` | `src/lib/harness.ts` | The harness tables in the guide. |
| `README.md` `## Installation` | `src/lib/install.ts` | Every install block, for both harnesses. |
| `extensions/change.ts` | `src/lib/pi.ts` | The `/ideation` subcommands, guided-menu labels, `ideation_change` actions and the notifications Pi shows. |
| `scripts/change-render.mjs`, `workflows/change-tui.mjs`, `workflows/change-ui.mjs`, `workflows/change-brief.mjs` | `src/lib/native.ts` | The Pi walkthrough's contract pages, widget frames and approval/acceptance dialogs, rendered by the product's own code from a fixture brief. |
| `.claude-plugin/plugin.json` | `src/lib/repo.ts` | The version badge. |

Only editorial judgement is authored: `src/data/commands.ts` (the planning commands'
order and prose), `src/data/pi.ts` (what each `/ideation` subcommand is for) and the
walkthrough fixture in `src/data/walkthrough/`.

The joins throw rather than rendering something false:

- a skill that ships with no entry in `commands.ts`, or an entry naming a skill that
  no longer ships;
- an `/ideation` subcommand or tool action with no entry in `data/pi.ts`, or an entry
  for one that no longer exists; a subcommand the dispatcher handles but the command
  description omits, or the reverse;
- an install section without the shape the page depends on;
- a walkthrough fixture that fails the real `validateBrief()`, a revision that does
  not revise, a ready run that does not verify every check, a widget role the
  adapter does not map, or any widget line wider than the columns it was rendered for;
- a rubric that stops having exactly five gates, because the guide says "five" in prose.

This repo has watched duplicated knowledge rot more than once — a run-model diagram
that shipped four wrong engine values, a site install block that kept naming a
package the plugin no longer needed. CI runs `pnpm build` for exactly this reason.

One derivation worth knowing about: an **absent** `allowed-tools` key means *every*
tool is available, not none. Treating absent as an empty list once rendered "writes
no files" beside the command that writes the entire contract.

### The Pi walkthrough's renders

`change-tui.mjs` takes its width helpers and theme by injection, so `src/lib/native.ts`
supplies a small adapter instead of pi-tui (which the site does not install): theme
roles become CSS classes on the graphite deck, and every line is checked against its
width. Contract pages are served as their own documents and framed; a frame opens at a
section by scrolling inside the frame after load, never with a `#fragment` (which
would scroll the parent page to the frame). The site's theme toggle writes the
contracts' own storage key and reloads the frames, so both follow one choice.

### The launch video

`public/media/ideation-launch.mp4` (and its poster, also the source of `public/og.png`)
is a rendered asset: 21 seconds, real widget frames, a fictional change. It was made
with the brag skill and Hyperframes from a composition kept outside this repository
(it embeds system fonts that cannot be redistributed). Re-render it when the widget,
the approval dialog or the stamps change; the dialog lines come from `approvalText()`.

## Design

One world: the field guide. `DESIGN.md` at the repo root owns the tokens; this site's
`global.css` and `scripts/contract-gen.css` declare them. Paper, ink, one cobalt
accent, serif display, hairline rules, 3px radii, the press offset as the only depth,
system fonts only, and no external requests of any kind.

Tailwind's default palette is cleared (`--color-*: initial`), so `bg-blue-500` is not
reachable; `@theme inline` keeps utilities pointing at the CSS variables, so the theme
toggle flips at runtime. The one sanctioned exception is the graphite deck that
depicts a Pi terminal, described in `DESIGN.md`.

Motion is "ink & press" and never required for reading:

- A pre-paint script sets `data-motion="on"` only when motion is welcome (not reduced
  motion, not print, IntersectionObserver available). Without it, everything is
  simply there.
- `data-settle`, `data-stamp`, `data-ink` and `data-wash` mark elements that settle,
  thunk in, draw or wash in once as they arrive; anything already above the fold
  counts as arrived. Print marks everything arrived.
- The walkthrough plates (the planning path's specimen, the Pi path's stamp) follow
  the step being read. Their geometry is cached on load and resize; nothing
  scroll-linked may read layout.
- The Pi widget animates from its real frames at Pi's 100ms rate, only while on
  screen. Live work loops at constant recorded state; the ready celebration plays
  once and settles.
