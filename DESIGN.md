# Design system — the ideation field guide

This document is the token authority for the field-guide visual identity. The
identity shipped first in the surfaces below — it was not invented here — but
it is written down here, once, because the next surface should inherit rather
than reinvent: the contract renderer previously shipped a completely separate
dark "command deck" world, and that mismatch was the single biggest reason a
generated contract did not read as part of this product.

The canonical token declarations are `scripts/contract-gen.css` (inlined into
every generated contract) and `site/src/styles/global.css` (worn by `/guide`).
This document owns the values; those files declare them; every other surface
inherits.

## The world

An **editorial field guide**: paper ground, ink, hairline rules, one cobalt
accent, letterpress depth. Print sensibility on screen. It is deliberately not
an instrument panel, a dashboard, or a terminal.

## Two worlds

The product ships two visual worlds, deliberately, and they never meet in one
document.

- **Field guide** (this document): generated contracts, `/guide`, ephemeral
  comparison artifacts, implementation notes. The world of product artifacts —
  documents a machine produces and a person reads, signs, or decides from.
- **Industry** (`site/src/styles/industry.css`): `/` and `/walkthrough`. A
  drafting table — slate-blue `#5980a6`, Barlow, square corners, registration
  marks. The marketing surface, explaining the product from the outside.

Two worlds coexist because a marketing surface and a product artifact answer
different questions. What is not allowed is a third world, or an artifact that
invents its own tokens: a new surface joins one of these two, or argues for a
change here first.

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

## Motion

One authored moment per surface, on entry, then stillness. Exponential ease-out
(`--ease: cubic-bezier(.16,1,.3,1)`), from an already-visible default — content
never depends on animation to be readable. State changes stay under ~180ms.
Everything collapses correctly under `prefers-reduced-motion`, and the
reduced-motion path must still deliver the *information* the motion carried.

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
