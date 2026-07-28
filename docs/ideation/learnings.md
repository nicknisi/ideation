# Ideation Learnings

Generalizable spec-gap and interview patterns captured from completed
ideation projects. Intake reads this file so recurring gaps inform future
questioning and spec generation. Each entry is dated and cites its
evidence; treat entries as hints, never as a substitute for gate evidence.

## 2026-07-23 — ux-dejank

- **Pattern**: ~~The Agent tool is unavailable inside workflow-engine subagent contexts, so scout and reviewer always degrade to inline exploration or the validation-only fallback there.~~ **RETIRED 2026-07-25** — the constraint is real and permanent, but the consequence was an architecture bug, not a fact to plan around.
  **Evidence**: All 4 ux-dejank phases and both decision-log phases (same day) reported the reviewer agent not invocable; non-strict runs fell back to validation-only, strict runs to delegated/inline review. Confirmed 2026-07-25 by direct probe: a workflow subagent gets `Error: No such tool available: Agent. Agent exists but is not enabled in this context.` — byte-identical for every `subagent_type`, so the spawn capability is stripped one level down. `Glob` and `Grep` are stripped there too.
  **Resolution**: `workflows/execute-contract.mjs` no longer nests them. Scout, build, review, fix, and commit are five *sibling* workflow-level stages, so scout and reviewer run as first-level agents the engine dispatches directly. Degradation is now loud rather than silent — `reviewStatus` and a leading warning surface in the phase result and autopilot's report — and `--strict` genuinely fails closed at both gates (`execute-contract.smoke.test.mjs` covers both forks).
  **Still true**: nothing dispatched *by* the engine can spawn a subagent. Never write a spec step, agent definition, or skill instruction that assumes it can. `agents/scout.md` and `agents/reviewer.md` carry read-only Bash fallbacks for the stripped `Glob`/`Grep`.
