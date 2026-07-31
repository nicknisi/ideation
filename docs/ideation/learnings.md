# Ideation Learnings

Generalizable spec-gap and interview patterns captured from completed
ideation projects. Intake reads this file so recurring gaps inform future
questioning and spec generation. Each entry is dated and cites its
evidence; treat entries as hints, never as a substitute for gate evidence.

## 2026-07-31 — docs-site

- **Pattern**: Work that replaces what an existing contract described, without going through ideation itself, leaves that contract permanently failing and nothing marks it as retired.
  **Evidence**: A hand-done rebuild (d49f16c) replaced the VitePress site at `docs/` with an Astro app in `site/`. All 5 of the docs-site contract's `cmd` criteria then failed on paths that no longer exist (`docs/index.md`, `docs/.vitepress/config.*`, a `docs:build` script), and one ux-dejank criterion went with it (`docs/workflow-example.html`, deleted in the same rebuild). Six red checks, zero code regressions. The contract's own `supersedes` field is the mechanism for this and nothing set it, because the replacing work produced no contract to point at.
  **Spec/interview implication**: At intake, when the work replaces or rebuilds something an existing `docs/ideation/*/contract-data.json` describes, say so and set `supersedes` on the new contract. When the replacing work is small enough to skip ideation, retire the old contract instead of leaving it to fail. A red criterion on shipped work has four possible verdicts — regressed, false, stale, superseded — and only the first means fix the code; assuming the first wastes the triage.

## 2026-07-23 — ux-dejank

- **Pattern**: ~~The Agent tool is unavailable inside workflow-engine subagent contexts, so scout and reviewer always degrade to inline exploration or the validation-only fallback there.~~ **RETIRED 2026-07-25** — the constraint is real and permanent, but the consequence was an architecture bug, not a fact to plan around.
  **Evidence**: All 4 ux-dejank phases and both decision-log phases (same day) reported the reviewer agent not invocable; non-strict runs fell back to validation-only, strict runs to delegated/inline review. Confirmed 2026-07-25 by direct probe: a workflow subagent gets `Error: No such tool available: Agent. Agent exists but is not enabled in this context.` — byte-identical for every `subagent_type`, so the spawn capability is stripped one level down. `Glob` and `Grep` are stripped there too.
  **Resolution**: `workflows/execute-contract.mjs` no longer nests them. Scout, build, review, fix, and commit are five *sibling* workflow-level stages, so scout and reviewer run as first-level agents the engine dispatches directly. Degradation is now loud rather than silent — `reviewStatus` and a leading warning surface in the phase result and autopilot's report — and `--strict` genuinely fails closed at both gates (`execute-contract.smoke.test.mjs` covers both forks).
  **Still true**: nothing dispatched *by* the engine can spawn a subagent. Never write a spec step, agent definition, or skill instruction that assumes it can. `agents/scout.md` and `agents/reviewer.md` carry read-only Bash fallbacks for the stripped `Glob`/`Grep`.
