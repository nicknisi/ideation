# Design system — the ideation field guide

This document is the token authority for the field-guide visual identity. The
identity shipped first in the surfaces below — it was not invented here — but
it is written down here, once, because the next surface should inherit rather
than reinvent: the contract renderer previously shipped a completely separate
dark "command deck" world, and that mismatch was the single biggest reason a
generated contract did not read as part of this product.

The canonical token declarations are `scripts/contract-gen.css` (inlined into
every generated contract) and `site/src/styles/global.css` (worn by the whole site).
This document owns the values; those files declare them; every other surface
inherits.

## The world

An **editorial field guide**: paper ground, ink, hairline rules, one cobalt
accent, letterpress depth. Print sensibility on screen. It is deliberately not
an instrument panel, a dashboard, or a terminal.

## One world

Every surface wears this world: generated contracts and receipts, the live contract
page, ephemeral comparison artifacts, implementation notes, and all of
ideation.engineering — the overview, both walkthroughs and the guide.

The site used to wear a second, "Industry" world (slate blue, Barlow, square
corners). It was retired because a visitor met one look on the site and another on
their first contract, and because the product's own artifacts — the stamped
contract, the live page, the widget — are its best explanation. The site now shows
real contract pages the renderer produced, framed, beside prose in the same tokens.

A new surface joins this world or argues for a change here first. An artifact that
invents its own tokens, or a second world, is not allowed.

**One sanctioned exception: the graphite deck.** Where the site depicts a Pi
terminal, it uses a fixed graphite plate (`#1a1c20`, the dark deck's surface) in
both themes, and colours text with Pi's own dark-theme roles (accent `#8abeb7`,
border accent `#00d7ff`, success `#b5bd68`, error lifted to `#e07a7a`), with muted
and dim lifted to `#9a9a9a` and `#878787` so every role meets WCAG AA. It depicts
another program's UI; it is not a surface of this world, and nothing else may borrow
those colours.

## Tokens

Both declarations carry the same values. `global.css` declares them with a
`prefers-color-scheme` media query; `contract-gen.css` uses `light-dark()`.
Either is fine — the values are the contract.

| role | light | dark |
|---|---|---|
| `--bg` | `#f7f7f3` | `#131417` |
| `--surface-1` | `#fcfcfa` | `#1a1c20` |
| `--surface-2` | `#ffffff` | `#202329` |
| `--wash` | `#ebebe4` | `#0c0d0f` |
| `--line` | `#dededf` | `#2d3036` |
| `--line-strong` | `#a6a6a0` | `#4c505a` |
| `--ink` | `#191b1d` | `#e9e9e4` |
| `--muted` | `#50555a` | `#a8aaa6` |
| `--faint` | `#75797d` | `#82858a` |
| `--accent` | `#2b46c7` | `#93a7ff` |
| `--go` | `#187a48` | `#63bf8d` |
| `--caution` | `#94660a` | `#d2ad55` |
| `--danger` | `#bb3a2c` | `#e0796e` |

Each semantic colour has a matching `--*-tint` for filled chips and panels.

**Colour strategy: restrained.** Neutrals plus one accent. Cobalt marks the
brand and anything the reader can act on. `go` / `caution` / `danger` carry
meaning only — a gate's state, a risk level, a refused item — never decoration,
and never as the sole signal: every coloured state also carries a glyph or a
word.

## Type

- `--font-serif` — Iowan Old Style / Palatino / Georgia. **Headings and prose.**
- `--font-sans` — system stack. Interface furniture: notes, captions, dense
  secondary text.
- `--font-mono` — Berkeley Mono / SF Mono / Menlo. **Evidence only**: commands,
  paths, counts, measured numbers, status stamps.

The rule that matters: mono is not a costume for "technical." A heading in mono
is a lapse. A tracked uppercase mono label is legitimate over a *measurement*
(`.kicker` on a flight-strip cell) and nowhere else — an eyebrow over every
section is grammar nobody chose.

## Depth and shape

- `--radius: 3px`, `--radius-lg: 4px`. Nothing is pill-shaped.
- `--press: 3px 3px 0 0 var(--line)` — a hard offset, no blur. This is the
  world's only depth device. Soft ambient shadows belong to a different world.
- Structure is carried by 1px rules and shared borders, not by gaps between
  floating cards. Prefer one bordered strip of cells over N separate cards.

## Motion — ink & press

Motion is allowed anywhere, tastefully, as long as it uses this world's
vocabulary: ink and the press, never glow, neon, or bounce.

- **Ink draws.** Rules, arrows, and diagram edges draw themselves in on first
  view, like a pen stroke (stroke-dashoffset, ~600–900ms).
- **The press lands.** Approval and receipts arrive as a rubber stamp. It
  thunks in slightly off-register and rotated (−4°), then holds still.
- **Ink dries.** A passing check is inked on (✓ stroke draws, tint settles).
  Pending human judgment breathes very slowly (≥2.4s period, low amplitude).
- **Tokens travel.** A cobalt token may run along dependency edges while work
  is live. It only marks actual state: the current step, never fake progress.
- **Paper, not screen.** A small hover lift (press offset grows 1px). Sections
  settle in with a short rise as they enter view. There is no parallax,
  scroll-jacking, or continuous looping on idle documents beyond the pending pulse.

Exponential ease-out (`--ease: cubic-bezier(.16,1,.3,1)`), always from an
already-visible default: content never depends on animation to be readable,
and nothing hides until JavaScript runs. Interactive state changes stay under
~180ms. Animation never implies progress that evidence does not support.
Under `prefers-reduced-motion`, everything is still and final, and the
reduced-motion path still delivers the *information* the motion carried
(stamp present, checks marked, current step highlighted). Print is always still.

## Non-negotiables for any new surface

1. Self-contained: no CDN, no web fonts, no external images. These files are
   written to disk and opened over `file://`.
2. Light-first with a real dark deck and a three-state icon toggle
   (auto → light → dark), persisted to `localStorage`, applied before first
   paint to avoid a flash.
3. A print stylesheet that produces a paper document: forced light tokens,
   controls hidden, `<details>` expanded, `break-inside: avoid` on panels.
4. No horizontal page scroll at any width. Wide content (graphs, command
   strings, code) scrolls inside its own container.
