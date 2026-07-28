---
name: autopilot
description: Orchestrate full execution of an ideation project — reads the contract, builds an execution manifest, and runs all phases on the deterministic Workflow engine (parallel for independent phases, sequential for dependent ones). Auto-continues on success, gates on failure. Use after ideation is complete and specs are approved.
disable-model-invocation: true
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - Workflow
  - Agent
  - AskUserQuestion
---

# Run Ideation Project

## Arguments: $ARGUMENTS

Orchestrate execution of all phases in an ideation project by driving the
deterministic **Workflow engine** at `${CLAUDE_PLUGIN_ROOT}/workflows/execute-contract.mjs`.

**This skill does the three things the sandboxed engine cannot:** read the
contract, run the `git log` skip pre-pass, and own interactive failure-gating +
resume. The engine does everything between — topological wave planning, parallel
dispatch, and schema-validated per-phase results. **You do not compute waves or
parse `RESULT:` text yourself — the engine returns a structured summary.**

**Parse arguments:**

- Optional: path to `contract.md` (e.g., `docs/ideation/my-project/contract.md`)
- If omitted, auto-detect by globbing `./docs/ideation/*/contract.md`
- If multiple contracts found, use `AskUserQuestion` to select one

## Step 1: Locate & Parse the Contract

1. Resolve the contract path (argument or glob). Derive the **project directory** from it — for `docs/ideation/my-project/contract.md`, that's `docs/ideation/my-project/`.
2. Read the sibling **`contract-data.json`** in that directory. Its `execution.phases` array already holds each phase's `title`, `specPath`, `prereqs`, and `risk` — this is the manifest. Also read `projectName`, `slug`, `approvalMode` (`"express"` = single-confirmation approval, no per-artifact human review — drives `strict` in Step 3), and `branch`.
3. **If `branch` is set, re-assert the checkout before anything else touches git:** `git branch --show-current` — if it differs, `git switch <branch>` (create with `git switch -c` if missing). This must happen **before** the Step 2 pre-pass: both the skip detection and the phase commits belong on the isolation branch, on every entry, including fresh-session re-runs where the user has since switched away. (Isolation-branch *semantics* — creation, resume-vs-fresh, delete-not-revert — are owned by ideation's Express finish path; this step only re-asserts the checkout.)
4. **Validate** each `specPath` exists. If any are missing, report which and ask the user whether to continue without them or abort.
5. **Fallback if `contract-data.json` is absent** (older projects with only `contract.md`): parse the `## Execution Plan` section of `contract.md` — phase titles, spec paths from the `/ideation:execute-spec <path>` lines, and blocking relationships from the dependency graph — and build the same phase list. Also read the header's `**Approval**` line: `Express` → treat as `approvalMode: "express"` (set `strict` in Step 3). If you cannot parse it, abort with guidance to re-run ideation.

## Step 2: Git Skip Pre-Pass

For each phase, run `git log --oneline -F --grep="<specPath>"` with the **full slug-qualified spec path** (e.g. `docs/ideation/<slug>/spec-phase-1.md`). That exact form only — a loose `--grep="<slug>"` false-positives on any commit that merely mentions the project, and a bare filename (`spec-phase-1.md`) collides across projects, since every ideation project has one. The grep is sound because `execute-spec`'s Commit section **requires** the slug-qualified `specPath` verbatim in every phase commit body. Treat a phase as complete only on a match; add each matched phase's **title** to a `completedPhases` list. Report what's being skipped:

```
Skipping "Phase title" (already committed: abc1234)
```

The engine excludes these from dispatch, so a resumed run only executes what remains.

## Step 3: Build the Engine `args`

Assemble the manifest exactly per `${CLAUDE_PLUGIN_ROOT}/workflows/README.md`:

```jsonc
{
  "projectName": "...",
  "slug": "...",
  "projectDir": "docs/ideation/<slug>/",
  "strict": false, // true when contract-data.json has approvalMode: "express"
  "phases": [
    {
      "title": "...",
      "specPath": "...",
      "prereqs": ["<other titles>"],
      "risk": "low",
      "files": ["path/a.ts", "path/b.ts"], // every path this phase declares it touches
    },
  ],
  "completedPhases": ["<titles from Step 2>"],
}
```

- `prereqs` are **phase titles** — pass `contract-data.json`'s values straight through; do not remap to indices.
- `strict: true` (express contracts only) makes the engine run each phase fail-closed, because no human reviewed the specs. The decision-point semantics live in **execute-spec's headless/strict resolution matrix** (`${CLAUDE_PLUGIN_ROOT}/skills/execute-spec/SKILL.md`) — do not restate them here. Omit or set `false` for interactively approved contracts.
- Before invoking, sanity-check that every `prereqs` entry matches some phase `title` (or a `completedPhases` entry). If a title doesn't resolve, it's a manifest bug — report it rather than dispatching a broken graph (the engine will otherwise throw "Unknown prereq").

### Populate `files` from each spec's File Changes table

The engine uses `files` to **serialize phases that would otherwise run in the same
wave but touch the same file** — without it, two same-wave phases can contaminate
each other's `git diff HEAD` review and race on the git index at commit time. So
for **each** phase, read its `specPath` and extract every path listed in the
spec's **File Changes** tables — New Files, Modified Files, and Deleted Files —
into that phase's `files` array. Pass the paths through verbatim (the specs in one
repo use consistent relative paths; no resolution or normalization).

- **Missing or unparseable File Changes section:** set `files: []` and **tell the
  user** that phase is being treated as parallel-safe (it will never be serialized
  against another phase, so an undeclared file overlap there could slip through).
  The engine also logs a warning when a multi-phase wave contains a file-less
  phase.
- `files` is **optional** for the engine — omitting it (or `[]`) is identical to
  the old behavior. Old manifests keep working unchanged.

## Step 4: Invoke the Engine

1. Resolve the engine's **absolute path** — run `echo "$CLAUDE_PLUGIN_ROOT/workflows/execute-contract.mjs"` via `Bash` and confirm the file exists.
2. Call the **`Workflow`** tool with `scriptPath` set to that absolute path and `args` set to the manifest object from Step 3 (pass it as an actual JSON value, **not** a stringified one).
3. Tell the user before it starts: how many phases, how many already skipped, and that you'll pause only if a phase fails.
4. **Capture the returned `runId`** — you need it for same-session resume.

The engine runs in the background and notifies on completion. Watch progress with `/workflows`.

**If the `Workflow` tool is unavailable** (feature not enabled in this Claude Code): degrade gracefully — tell the user, then walk the phases yourself in dependency order using `/ideation:execute-spec <specPath>` per phase (the contract's per-phase commands), committing each before the next. For express contracts, carry the `--strict` semantics into this path too (per execute-spec's resolution matrix). This is the legacy manual path.

## Step 5: Handle the Summary

The engine returns `{ completed, noops, failed, skipped, results }`. Print all four buckets.

- **`noops` are done, not failed.** A NO-OP phase produced a genuinely empty diff (the repo already satisfies its spec) — review was skipped, nothing was committed, and dependents were not blocked. Treat `completed + noops` as the set needing no further work; re-dispatching a no-op phase loops forever.
- **Each entry in `results` carries `reviewStatus`** (`passed` / `validation-only` / `failed` / `skipped-empty-diff` / `not-run`), a `warnings` array that leads its `summary` string, and `reviewCycles`. Any `reviewStatus` other than `passed` on a committed phase means unreviewed or partially reviewed code landed — that must reach the Completion Report, never be collapsed into a bare PASS.
- **Effort tracks risk** (informational — the engine handles it): a phase with `risk: "high"` runs its build and fix stages at `effort: 'high'`; review always runs at `effort: 'high'`. `risk` comes straight from `contract-data.json`, so it is worth passing through accurately.

**If `failed` is empty:** proceed to the Completion Report.

**If `failed` is non-empty:** this is the failure gate. Present it via `AskUserQuestion`:

```
Question: "Phase(s) {failed titles} failed. {one-line summary from results[].summary}. Dependent phases {skipped titles} were skipped. How to proceed?"
Options:
- "Retry failed phases" — Re-run the engine; it resumes from where it stopped.
- "Stop here" — Halt. Completed phases are already committed.
- "Accept and finish" — Treat failures as acknowledged; report and finish.
```

**Unattended** (driven by a `/goal` wrapper, or any run with no interactive user): do not block on `AskUserQuestion` — apply "Stop here" semantics: report the four buckets and halt. Completed phases are already committed and durable; retry belongs to whoever is driving (a `/goal` wrapper re-runs this skill, and the Step 2 git pre-pass resumes past everything committed).

**If "Retry failed phases":**

- **Same session:** re-invoke the `Workflow` tool with `resumeFromRunId: <runId>` (and the same `scriptPath`). Cached passing phases return instantly; only the failed/unreached phases re-run.
- **New session, or resume rejected:** simply re-run this skill from Step 1 — the Step 2 git pre-pass re-derives `completedPhases` from the commits, so already-committed phases are skipped regardless. This is the cross-session resume path.

**If "Stop here":** report completed vs. remaining and exit.

**If "Accept and finish":** include the unresolved findings in the Completion Report under "Acknowledged Issues" and finish.

## Completion Report

After the engine finishes (or execution stops), present a summary. **Warnings come first**: if any result has a non-empty `warnings` array or a `reviewStatus` other than `passed`/`skipped-empty-diff`, lead the report with them — a validation-only commit prints its `WARNING — UNREVIEWED CODE COMMITTED` line verbatim at the top, never a bare PASS. Reporting that truth is the point of `reviewStatus`.

```markdown
## Execution Complete

{⚠ one line per warning, verbatim from results[].warnings — omit the block only when there are none}

### Completed Phases

- {title} — {commitHash} (review: {reviewStatus}, {reviewCycles} cycle(s))

### No-Op Phases

- {title} — spec already satisfied; nothing to commit

### Skipped Phases

- {title} — blocked by failed {prereq}

### Failed Phases

- {title} — {summary}

### Summary

{N} of {M} phases completed successfully ({K} no-ops need no further work).
```

**Then verify the contract** (when `contract-data.json` exists): run `node ${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs {projectDir}/contract-data.json` and quote its final line — `VERIFY {slug}: commits=A/B pass=N fail=M judgment=K` — verbatim in the report. Exit 0 (fail=0 and commits=B/B) is the completion predicate; if the script cannot run, say "verification not run", never "Complete" on the engine summary alone. Scope caveat: it checks this one contract's acceptance criteria, not repo health.

If all phases completed and verification passed:

```
All {N} phases complete. Run `git log --oneline -{N}` to see the commits.
```

### Learning Capture (watched runs only)

**Unattended runs explicitly skip this step** (a `/goal` wrapper, or any run
with no interactive user) — never prompt, never write
`docs/ideation/learnings.md`; the run's notes wait for the interview engine's
unmined-notes surfacing at the next interactive intake.

On a watched run, after the Completion Report, aggregate this run's phase notes
— every `{projectDir}/implementation-notes-phase-*.html` the run produced — and
apply the learning filter in
`${CLAUDE_PLUGIN_ROOT}/references/learning-filter.md`, bounded to this project.
The filter yields **up to 3** candidates. Zero candidates → silence (no prompt,
no output). Otherwise ask ONE `AskUserQuestion` offering accept/edit/dismiss per
candidate (a single `multiSelect` question: selected = accept, "Other" = edit,
none = dismiss), and write accepted entries to `docs/ideation/learnings.md` per
the lifecycle rules in the filter reference.

## Key Principles

1. **The engine orchestrates; the skill prepares and gates.** Wave planning, parallelism, and result handling are deterministic JS in `workflows/execute-contract.mjs`. This skill builds the `args`, runs the git pre-pass, and handles the human-in-the-loop moments the sandbox can't.
2. **No wave math, no `RESULT:` parsing here.** Pass `prereqs` through untouched; read the structured summary the engine returns.
3. **The contract is the source of truth** — phase order, dependencies, and spec paths all come from `contract-data.json` (`contract.md` Execution Plan as fallback).
4. **Subagents get clean contexts** — the engine runs each phase as five sibling agent stages (scout → build → review ⇄ fix → commit), each a fresh-context agent; the build stage runs execute-spec's build+verify halves as `--headless`, or `--headless --strict` when the manifest sets `strict` (semantics: execute-spec's resolution matrix). No phase inherits another's context.
5. **Gate on failures, not successes** — the happy path is fully hands-off; the engine runs everything still reachable and only the skill pauses, after the run, when something failed.
6. **Already-committed phases are durable** — each phase commits independently. The git pre-pass makes resume work across sessions; `resumeFromRunId` makes it instant within a session.
