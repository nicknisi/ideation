# Context Map — Phase 4 (Whimsical workflow example)

**Verdict**: GO (inline exploration; `ideation:scout` agent unavailable in this
execution context — skill fallback used).

## Scope

- New `docs/workflow-example.html` — self-contained animated storybook of the
  0.19 one-door flow. Human-facing; nothing model-side reads it.
- `skills/ideation/SKILL.md` line 349: drop the `workflow-example.md` bundled-
  resources line (shared references list).
- `README.md`: link the page from the `## Example` section (the old walkthrough
  content lived there in condensed form; README never linked the md directly).
- Delete `references/workflow-example.md` (depicts pre-gate "confidence 96%"
  flow — factually stale since 0.14).

## Key Patterns (factual anchors for vignette copy — verified against shipped prose)

- Scoreboard (interview-engine.md:82): `Gates: {n}/5 ready — open: {labels}`;
  final form `Gates: 5/5 ready`. Printed after each answered question.
- Strawman (interview-engine.md:104-116): trigger = same gate not-ready after
  2–3 questions; question text "Direct questions aren't converging here. Here's
  a strawman of my current best guess — want to react to it instead?"; options
  React (Recommended) / Keep asking / Flag the gate. Reaction becomes evidence.
- Critics (SKILL.md step 4): four lenses — scope-creep, over-engineering,
  hidden-dependency, success-criteria; findings blocker/notable/nit; blockers
  folded in pre-render; digest line format
  `found N (B blockers folded in, M notables, dismissed X — reasons)`.
- Routing (SKILL.md step 7): ONE AskUserQuestion, two questions — scope tier
  (Full (Recommended)/MVP/Stretch) and "Approve the contract — and how should
  we finish?" (express finish / full review / Needs changes). Express
  recommended when all 5 gates went ready without early stop AND >half criteria
  carry `check` commands. Early-stopped interview omits express entirely.
- Express finish: isolation branch `ideation/{slug}`; phases commit there;
  completion lines = Branch + `git diff {default}...ideation/{slug}`; bad run =
  deleted branch, not revert.
- Execution: autopilot waves (overlap-serialized), per-phase
  scout → build → verify-review-fix (3-cycle max) → commit.
- Learning capture (execute-spec + learning-filter.md): interactive completions
  only; up to 3 candidates; ONE accept/edit/dismiss question; zero → silence;
  entry format `## {YYYY-MM-DD} — {project}` with Pattern/Evidence/Implication;
  intake attribution line
  `Applying learning from {project} ({date}): {one-clause why}`.

## Conventions

- Palette family: `scripts/contract-gen.css` — Command Deck. Dark #0a0f16 bg,
  cyan-teal accent (#56c8ea dark / #0a6d89 light), go/caution/danger trio, mono
  for structure + sans for prose, 4pt spacing. Light deck co-equal.
- Spec mandates `prefers-color-scheme` custom-property theming (not the
  generator's `light-dark()`), `prefers-reduced-motion` collapse via media
  query, base-visible sections with observer-added polish, zero external
  requests, system font stacks.
- `docs/ideation/` is gitignored — process artifacts (this file, implementation
  notes) stay out of the phase commit naturally.

## Dependencies

- Validation greps: `@keyframes` present; no `<script src=`/`<link href=`/
  `url(http`; no `workflow-example.md` string anywhere in skills/, references/,
  README.md after the sweep.
- Engine suites (unchanged by this phase): graph.test.mjs,
  wave-planner.test.mjs, execute-contract.smoke.test.mjs.

## Risks

- Depicting pre-0.19 flow — mitigated: all copy anchored to line-verified prose
  above.
- Whimsy over clarity — each vignette carries a one-line "in the flow" caption.
- Hidden-by-default content if JS fails — `.js` class added only when
  IntersectionObserver exists; all hiding scoped under `html.js` +
  `prefers-reduced-motion: no-preference`.
