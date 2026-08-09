---
name: get-goal-prompt
description: "Generate a /goal command that runs an ideation project to completion UNATTENDED by driving /ideation:autopilot. The /goal string is owned by scripts/contract-gen.ts (--print-goal); this skill resolves the project's contract-data.json, prints the goal, and copies it to the clipboard. Use when the user says 'goal', 'run as goal', 'goal prompt', or wants to run the project long-haul/unattended rather than watching /ideation:autopilot interactively."
argument-hint: '[path/to/contract-data.json | path/to/contract.md]'
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
string has exactly one owner — `buildGoal()` in `${CLAUDE_PLUGIN_ROOT}/scripts/contract-gen.ts`,
printed by `--print-goal` — so this skill only resolves the project, prints, and copies.
**Never hand-author or template the /goal**; a second copy of that string is drift.
(The layered model — goal wrapper → autopilot → engine → execute-spec — is owned by
ideation SKILL.md § 5.4.)

1. **Resolve `contract-data.json` first** — it is the source of truth; `contract.md` is
   only a legacy fallback. Argument given: a `contract-data.json` path is used directly;
   a `contract.md` path means its sibling `contract-data.json`. No argument: glob
   `./docs/ideation/*/contract-data.json` and take the most recently modified. If the
   project has no `contract-data.json`, stop and say so — `--print-goal` consumes it,
   so the fix is re-running ideation, not hand-writing a goal.
2. **Already complete?** Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs <contract-data.json>`.
   Exit 0 → quote its final `VERIFY {slug}: …` line, tell the user the project is
   complete, and stop.
3. **Print the goal:** `node ${CLAUDE_PLUGIN_ROOT}/scripts/contract-gen.ts --input <contract-data.json> --print-goal`
   — an early exit that writes nothing (no lineage snapshot, no re-render). The output
   already carries the isolation-branch clause when the contract has `branch`, the
   background-workflow rule, and the verify.mjs-based done-when.
4. **Copy and show:** pipe the printed command to `pbcopy` (Linux: `xclip -selection clipboard`
   or `xsel --clipboard`), then print it so the user sees what they are about to paste.
5. **On a permission denial** of any command above: print the exact command for the user
   to run themselves (`! node …`) and stop. There is **no fallback template**.

Then remind the user: enable auto mode (`/auto`) so tool calls don't block each turn, and
confirm the engine is available (`Workflow` tool in Claude Code; in pi the plugin bundles
its engine extension, so nothing further is needed). One **caveat, not a gate** — and honestly labeled: this detail was derived from
Claude Code binary strings and could not be verified from this repo — `/goal` appears to
require a trusted workspace and may refuse to run when hooks are restricted. If the paste
is rejected, that is the likely reason; it is a property of the CLI session, not of this
project.
