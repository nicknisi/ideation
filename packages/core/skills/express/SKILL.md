---
name: express
description: "One-pass ideation for well-understood work: a thin alias that pre-commits /ideation's post-interview routing to the express finish. Identical evidence-gated interview, one consolidated confirmation (scope tier + run mode), then contract and specs generated without per-artifact approval loops and executed immediately on an isolation branch. Use when the user says 'express ideation', 'one-shot this', 'interview me then just build it', or wants planning that flows straight into execution without reviewing the contract. For exploratory or unfamiliar territory, prefer the full ideation skill — per-artifact review gates earn their keep there."
disable-model-invocation: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - Agent
  - AskUserQuestion
  - Workflow
  - TaskCreate
  - TaskUpdate
  - TaskList
  - TaskGet
---

# Express Ideation

Express is a **pre-commit** of `/ideation`'s post-interview routing — same interview, same critics, same artifacts (`contract-data.json`, specs, generator-rendered `contract.html` + `contract.md` via `--md-output`); the only difference is that the express finish is chosen here, up front, instead of at the routing question.

1. **Clean-tree check — now, before the interview.** Run `git status --porcelain`. Uncommitted changes would ride along on phase commits, and stopping costs one question here, not a completed interview. Dirty tree → ask: stash/commit first, accept the risk, or abort. A clean tree proceeds silently.
2. **Run ideation.** Read and follow `${CLAUDE_PLUGIN_ROOT}/skills/ideation/SKILL.md` end to end with the routing question pre-answered to "Approve — express finish" (fold the run-mode question into the approval call, and skip the routing-time clean-tree check — it already ran above). Everything else — branch handling, resume semantics, strict fail-closed execution, completion lines — lives in ideation's Express finish path, the single owner of express semantics.
3. **Scope guard (advisory).** For exploratory or unfamiliar work, recommend the full `/ideation` flow instead — its evidence-derived routing recommendation makes the same call, with reasons.
