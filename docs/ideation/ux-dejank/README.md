# Archive: the ux-dejank run (2026-07-23)

**A real run, unedited.** This directory is the complete artifact trail of one
actual ideation project: the plugin de-janking its own user experience,
planned by the very engine that executes plans — contract, specs, gate
evidence, and every implementation note, preserved exactly as the run produced
them. It is **dated history, not current documentation**: the prompts and
engine described here are the 0.19.0-era product and have since moved on.
Read it to see what a run looks like; read the README and `skills/` for what
the product looks like now.

## Why `verify` shows red on this contract

Running `node scripts/verify.mjs docs/ideation/ux-dejank/contract-data.json`
reports **3 failures out of 16 criteria**. All three are the check rot the
verifier's own header warns about — acceptance-time predicates the repo has
since moved past — not regressions introduced after the run:

- **[9] learning capture's behavioral contract** — fails on stale *content*,
  not a missing path. A later project (the codebase pride report) deliberately
  deduplicated the learning-capture sections in both execution skills down to
  pointers at `references/learning-filter.md`, so the phrases this criterion
  greps for no longer appear twice. The product improved past the criterion —
  this is the learning loop's own best lesson, caught by its own check.
- **[14] plugin version is 0.19.0** — the criterion pinned the version number
  of the release the run shipped. The test suites in the same check still
  pass; only the version pin is stale (the plugin is several releases ahead).
- **[15] `docs/workflow-example.html` exists** — a genuinely deleted path. The
  static docs page was replaced by the Astro site (`site/`), which renders the
  walkthrough from source instead.

The retire-vs-keep decision was made deliberately when these checks went red:
the contract is kept whole, reds and all, because an edited archive is just
another document that claims to be history.

## Walk it in order

1. [`contract.md`](contract.md) / [`contract.html`](contract.html) — the
   approved contract the interview produced (open the HTML; it is the
   interactive original).
2. [`contract-data.json`](contract-data.json) — the gate evidence, decisions,
   and success criteria behind it; still machine-checkable by
   `scripts/verify.mjs` (see the reds above).
3. [`spec-phase-1.md`](spec-phase-1.md) …
   [`spec-phase-4.md`](spec-phase-4.md) — the implementation specs the
   contract generated.
4. [`implementation-notes-phase-1.html`](implementation-notes-phase-1.html) …
   [`implementation-notes-phase-4.html`](implementation-notes-phase-4.html) —
   the gap decisions the builder logged while executing each spec.
5. [`context-map.md`](context-map.md) — the scout's readiness map from the
   run's final phase.

For the current product's explanation of what these artifacts are, see the
README's Example section; this archive is the Example section's "a real run,
unedited" link target.
