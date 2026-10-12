---
name: get-goal-prompt
description: "Generate a /goal command that runs an ideation project to completion UNATTENDED by driving /ideation:autopilot. The /goal string is owned by scripts/plan-goal.mjs; this skill resolves the project (an approved plan folder, or a 0.x contract), prints the goal, and copies it to the clipboard. Use when the user says 'goal', 'run as goal', 'goal prompt', or wants to run the project long-haul/unattended rather than watching /ideation:autopilot interactively."
argument-hint: '[path/to/project-folder | plan.json | run-contract.json | contract-data.json | contract.md]'
disable-model-invocation: true
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
---

# Generate /goal Command for Unattended Execution

## Arguments: $ARGUMENTS

Emit the `/goal` that drives `/ideation:autopilot` to completion unattended. The goal
string has exactly one owner — `buildGoal()` in `${CLAUDE_PLUGIN_ROOT}/scripts/plan-goal.mjs` —
so this skill only resolves the project, prints, and copies.
**Never hand-author or template the /goal**; a second copy of that string is drift.
(The layered model: the `/goal` is a durability wrapper that drives autopilot, which
drives the engine, which runs each unit's packet, or each 0.x phase's spec.)

1. **Resolve the project folder.** Argument given: a folder is used directly, and a file
   (`plan.json`, `run-contract.json`, `contract-data.json`, `contract.md`) means its folder
   (`contract.md` works only with `contract-data.json` beside it).
   No argument: glob `./docs/ideation/*/plan.json` and `./docs/ideation/*/contract-data.json`
   and take the folder most recently modified.
2. **Already complete?** Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs <folder>`.
   Exit 0 → quote its final `VERIFY {slug}: …` line, tell the user the project is
   complete, and stop.
3. **Print the goal:** `node ${CLAUDE_PLUGIN_ROOT}/scripts/plan-goal.mjs <folder>`. It writes
   nothing, and it reads the folder the way verify.mjs does:
   - **A 1.0 plan** gets a goal only once approved: `run-contract.json` must be beside
     `plan.json` and still match it. The goal runs `/ideation:autopilot` on the run
     contract, on branch `ideation/<plan id>`, and repairs only the implementation, never
     the approval.
   - **A migrated or 0.x folder** gets the goal its `contract-data.json` always had,
     carrying its isolation branch when it has one.
   Every goal carries the background-workflow rule and the verify.mjs-based done-when,
   whose `commits=N/N` is verify.mjs's own count.
   **If it refuses, show its message and stop.** The fix is never a hand-written goal:
   not approved, or changed after approval → approve the current plan through
   `/ideation`; unrunnable checks → fix them in the plan (or `contract-data.json`).
4. **Copy and show:** pipe the printed command to `pbcopy` (Linux: `xclip -selection clipboard`
   or `xsel --clipboard`), then print it so the user sees what they are about to paste.
5. **On a permission denial** of any command above: print the exact command for the user
   to run themselves (`! node …`) and stop. There is **no fallback template**.

Then remind the user: enable auto mode (`/auto`) so tool calls don't block each turn, and
confirm the engine is available (the `Workflow` tool in Claude Code). The goal targets
Claude Code's background `Workflow`; in Pi, an approved 1.0 plan doesn't need one,
because the change runner already runs it unattended. One **caveat, not a gate** — and honestly labeled: this detail was derived from
Claude Code binary strings and could not be verified from this repo — `/goal` appears to
require a trusted workspace and may refuse to run when hooks are restricted. If the paste
is rejected, that is the likely reason; it is a property of the CLI session, not of this
project.
