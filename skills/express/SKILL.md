---
name: express
description: "One-pass ideation for well-understood work: the exact same evidence-gated interview as ideation, then ONE consolidated confirmation (scope tier + run mode), then contract and specs generated without per-artifact approval loops and executed immediately on an isolation branch. Use when the user says 'express ideation', 'one-shot this', 'interview me then just build it', or wants planning that flows straight into execution without reviewing the contract. For exploratory or unfamiliar territory, prefer the full ideation skill — per-artifact review gates earn their keep there."
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

One pass: interview → one confirmation → generate → run. This skill reuses the
ideation skill's machinery and deletes only its approval ceremony — never the
interview, the critics, or the artifacts. Where this file is silent,
`${CLAUDE_PLUGIN_ROOT}/skills/ideation/SKILL.md` governs: follow its phases with
the overrides below (section references point into that file).

**Why this is safe to skip:** the interview is where intent gets captured,
question by question; the contract-review click was a restatement of answers the
user already gave. What replaces the skipped review is not nothing — it is the
plan critics (unchanged), one _informed_ confirmation carrying the
load-bearing content, fail-closed execution semantics (`--strict`), and an
isolation branch that moves human review to the end-state diff, where it is
real.

## Phase 0: Clean-tree check (before investing the interview)

Run `git status --porcelain`. If the working tree has uncommitted changes, stop
and ask now — before the interview, while the cost of stopping is one question,
not a completed interview. The user's uncommitted work would otherwise ride
along on phase commits. Options: they stash/commit first, they accept the risk,
or they abort. A clean tree proceeds silently.

## Phases 1–2: Interview (unchanged)

Read and follow `${CLAUDE_PLUGIN_ROOT}/references/interview-engine.md` — every
phase, exactly as the ideation skill does — and
`${CLAUDE_PLUGIN_ROOT}/references/confidence-rubric.md` for the evidence-gate
criteria. Nothing about express compresses the interview: no question limit, same
conservative gate judgment. Front-loaded elicitation is the human input that
replaces artifact review, so it carries _more_ weight here, not less.

## Preconditions (hard — checked when the interview ends)

Express proceeds only when both hold. When one fails, say which and why, then
hand off to the standard ideation flow at the equivalent point — never silently
downgrade.

1. **All 5 gates are `ready`.** An early-stopped interview ("wrap it up" with
   open gates) is disqualifying: the standard flow renders not-ready gates for a
   human to weigh before approving; express has no such reader, so a
   known-unresolved gate would be implemented headlessly. Route to ideation
   Phase 3, which records the open gates in a Draft contract.
2. **Most success criteria carry a `check` command.** Express is a walk-away run
   by design, and unattended execution can only trust what it verifies
   mechanically (ideation 5.4's verifiability rule). If a majority of criteria
   are judgment calls, offer two exits via `AskUserQuestion`: continue in the
   standard ideation flow (review gates restored), or stay express with the
   walk-away option disabled — Phase 4's Q2 must then **omit** that option, not
   merely de-recommend it.

## Phase 3: Plan without ceremony

This phase runs **only** ideation Phase 3 steps 3–4 (write `contract-data.json`,
then critics). Steps 5–7 (render, open, approval `AskUserQuestion`) are the
ceremony express deletes — do **not** run them here: rendering moves to Phase 5
step 3, and the sole approval is Phase 4. This override wins over the "where
silent, ideation governs" default.

1. State the project name and its kebab-case `slug` (ask only if genuinely
   ambiguous). Create `./docs/ideation/{slug}/`.
2. Write `contract-data.json` per ideation Phase 3 step 3 — same schema, field
   authority is `ContractData` in
   `${CLAUDE_PLUGIN_ROOT}/scripts/contract-gen.ts` — with three differences: set
   `"approvalMode": "express"`, set `"branch": "ideation/{slug}"` (autopilot
   re-asserts this checkout on every entry, so the isolation guarantee survives
   fresh sessions), and keep `"status": "Draft"` until the confirmation below
   passes.
3. **Fan out the four plan critics** exactly per ideation Phase 3 step 4 — same
   lenses, same single-message dispatch, same failure tolerance and run-once
   rule. Blocker triage changes in one way, because there is no approval loop to
   defer to:
   - Fixable blocker → revise `contract-data.json`, note the fix in the critic
     digest (presented in Phase 4).
   - Blocker exposing a **genuine unknown** → the one escape hatch: ask a
     targeted question (one per distinct unknown, not one total), then fold the
     answer in. Express skips ceremony, not unknowns.
   - `notable` / `nit` → per ideation.

## Phase 4: The one confirmation

The only artifact approval in the flow, so it must be informed — one high-stakes
gate a human actually reads beats four they rubber-stamp. Present in the
terminal (no browser artifact, no waiting):

1. **Done-when list first** — every success criterion with its `check` command
   verbatim, judgment calls marked. This is what every downstream verify/review
   cycle will certify against: the user is approving what "done" means.
2. **Scope tiers** — the MVP / Full / Stretch items, so the tier choice is made
   looking at the items it selects.
3. **Critic digest** — one line per lens, ideation step 7's format.

Then one `AskUserQuestion` call (two independent questions):

- **Q1 — "Scope tier?"**: "Full (Recommended)" / "MVP" / "Stretch". Answering is
  the approval; items outside the tier move to Future Considerations.
- **Q2 — "Run mode?"**:
  - "Watch it run (Recommended)" — execute now; execution-time gates stay
    interactive.
  - "Start it and walk away" — emits a `/goal` wrapper to paste. **Omit** this
    option if precondition 2 disabled it.
  - "Just generate the artifacts" — full generation (Phase 5), then no branch
    and no execution: hand off exactly per ideation 5.4. The contract keeps
    `approvalMode: "express"` and `branch`, so a later `/ideation:autopilot`
    run still gets the isolation branch and strict semantics.

State alongside the question, not as more questions: execution commits to branch
`ideation/{slug}`, and this is the **last artifact approval** — what remains are
execution-time gates only (autopilot's failure gate, or execute-spec's
escalations in a single-phase watch run), or nothing until completion on the
walk-away path. An "Other" answer naming problems = return to the interview loop
for whatever they name.

## Phase 5: Generate everything (no loops)

1. Finalize `contract-data.json`: `"status": "Approved"` (keep
   `"approvalMode": "express"` and `"branch"` — provenance and isolation:
   no per-artifact human review happened), chosen tier applied,
   `execution.phases` populated per ideation 4.2 (phasing criteria,
   small-project single-spec shortcut, template + delta for repeatable phases)
   and 5.1/5.2 (orchestration analysis, shared-file coordination note,
   `agentTeamPrompt` only if 2+ phases parallelize). Per the schema's field
   semantics, `prereqs` entries are phase **titles**.
2. **Generate specs** per ideation 4.4 — same templates and disciplines (minimum
   approach, "Pattern to follow" references, feedback loops per
   `${CLAUDE_PLUGIN_ROOT}/references/feedback-loop-guide.md`, failure modes).
   The Spec Feedback Quality self-review (ideation 4.5) is a **hard gate** here,
   not a presentation note: Weak → fix before proceeding. No human reviews these
   specs before execution. Skip PRDs entirely.
3. **Render the contract** per ideation Phase 3 step 5, adding
   `--md-output docs/ideation/{slug}/contract.md` so one generator invocation
   emits `contract.html` and `contract.md` together — never hand-author the
   md; the `**Approval**: Express` header line and Execution Plan render from
   `contract-data.json`, and autopilot's fallback parser and get-goal-prompt
   consume the result. The generator is the
   only renderer, never hand-write the HTML, generator and `open` as separate
   Bash calls. **Permission denial does not block express:** print the exact
   `! npx tsx …` command so the user can render the record whenever they like,
   note the skipped render in the digest, and continue — execution consumes
   `contract-data.json` and `contract.md`, not the HTML. If it did render, open
   it for ambient visibility, not approval.

If the run mode is "Just generate the artifacts", stop here and hand off per
ideation 5.4 (echo the per-phase and autopilot commands). Phase 6 does not run.

## Phase 6: Isolation branch, then run

1. Re-check the tree: `git status --porcelain` — changes **outside**
   `docs/ideation/{slug}/` are foreign (the artifacts you just wrote are
   expected, and untracked files travel with `git switch`). Foreign changes at
   this point mean the user worked mid-interview: stop and ask, same options as
   Phase 0.
2. Create or switch to the isolation branch (**watch routes**; on walk-away the
   switch is owned by the `/goal` — get-goal-prompt prepends it — so running it
   here too is a harmless re-assert):
   - **Branch doesn't exist:** `git switch -c ideation/{slug}`.
   - **Branch exists:** check it for prior phase commits
     (`git log --oneline ideation/{slug} --grep="{slug}"`). None → switch and
     proceed. Some → this is either a resume or a stale run; ask
     (`AskUserQuestion`): "Resume" (switch; autopilot's pre-pass skips
     committed phases), "Fresh run" (`git branch -D ideation/{slug}`, then
     create anew), or "Abort". A walk-away re-entry (no interactive user)
     defaults to Resume — that path's intended semantics.
   - Every phase commits here. Post-run review is the branch diff; a bad run is
     **deleted, not reverted** — autopilot's git-log skip pre-pass matches
     commit messages, so _reverted_ phase commits still register as complete on
     a re-run.
3. Route by phase count and run mode:
   - **Single phase, watch:** orchestration adds nothing (ideation 5.4) — Read
     and follow `${CLAUDE_PLUGIN_ROOT}/skills/execute-spec/SKILL.md` with the
     single spec path `docs/ideation/{slug}/spec.md` (the small-project shortcut
     emits a bare `spec.md`, no phase number), interactively, with **one
     override**: on reviewer
     failure/empty/no verdict, do NOT use the validation-only fallback —
     escalate via `AskUserQuestion` ("Retry review" / "Commit with validation
     only" / "Abort, leave unstaged"). That fallback is calibrated for
     human-reviewed specs; this spec had none.
   - **Multi-phase, watch:** Read
     `${CLAUDE_PLUGIN_ROOT}/skills/autopilot/SKILL.md` and execute it from its
     Step 1 with `docs/ideation/{slug}/contract.md` as the argument. (Its
     `disable-model-invocation` blocks Skill-tool triggering, not following its
     instructions — the same by-reference pattern execute-spec uses for
     autopilot's manifest format.) Autopilot reads `approvalMode: "express"`
     and `branch` from `contract-data.json`, re-asserts the checkout, and sets
     `strict: true` in the engine args, so phases dispatch as
     `/ideation:execute-spec --headless --strict` — scout HOLD stops instead of
     proceeding, and a crashed reviewer stops instead of committing
     validation-only.
   - **Walk away (any phase count):** follow
     `${CLAUDE_PLUGIN_ROOT}/skills/get-goal-prompt/SKILL.md` to build and copy
     the `/goal` (it prepends the branch switch when the contract carries
     `branch`), print the handoff lines below, then stop — the user pastes it.
     The run resumes past committed phases automatically on every re-entry.

## Completion / handoff lines

Three lines, delivered where the run ends: appended to autopilot's completion
report (multi-phase watch), to execute-spec's completion report (single-phase
watch), or printed alongside the copied `/goal` (walk-away — this session ends
before execution does):

1. Branch: `ideation/{slug}`
2. Review: `git diff {default-branch}...ideation/{slug}`
3. Next: `/ideation:retro docs/ideation/{slug}/`

## Key Principles

1. **The interview is the approval.** Express deletes ceremony after shared
   understanding, never the path to it.
2. **One informed gate beats four rubber stamps.** The confirmation leads with
   the check commands — approve what "done" means, not the essay.
3. **Artifacts are still written.** `contract-data.json`, `contract.md`, specs,
   and (permissions allowing) `contract.html` all exist for post-hoc review;
   express changes _when_ a human reads them, not whether they exist.
4. **Fail closed downstream.** `approvalMode: "express"` makes the engine run
   `--strict`, and the single-phase watch route replaces the reviewer-crash
   auto-commit with an escalation: ambiguity halts, and unreviewed code never
   commits silently. The fail-open headless defaults were calibrated for
   human-approved artifacts; express artifacts aren't.
5. **Blast radius is one branch — durably.** `branch` is recorded in
   `contract-data.json` and re-asserted by autopilot on every entry, so the
   isolation survives fresh sessions; review moves to the diff, where it
   actually happens.
6. **Scope guard.** For exploratory or unfamiliar work, recommend the full
   ideation flow instead — advisory, like every mature fast path.
