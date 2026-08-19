---
name: autopilot
description: Orchestrate full execution of an ideation project — reads the contract, builds an execution manifest, and runs all phases on the deterministic Workflow engine (parallel for independent phases, sequential for dependent ones). Auto-continues on success, gates on failure. Invoke only when the user explicitly asks to run an approved contract, or when an active /goal directs /ideation:autopilot.
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
- `strict: true` (express contracts only) makes the engine run each phase fail-closed, because no human reviewed the specs. The decision-point semantics live in **the gate-behavior table** (`${CLAUDE_PLUGIN_ROOT}/workflows/README.md`) — do not restate them here. Omit or set `false` for interactively approved contracts.
- Before invoking, sanity-check that every `prereqs` entry matches some phase `title` (or a `completedPhases` entry), and that no two phases share a `title`. If a title doesn't resolve or appears twice, it's a manifest bug — report it rather than dispatching a broken graph (the engine will otherwise throw "Unknown prereq" or "Duplicate phase title(s)").
- **`agentNames` (Claude Code only — omit in pi):** the engine dispatches scout/reviewer/builder stages by `agentType`, and Claude Code plugin-scopes those as `ideation:scout` / `ideation:reviewer` / `general-purpose` — these are the engine's defaults, so a CC manifest omits `agentNames` entirely. In pi, omit the field too, for a different reason: the pi engine host (`extensions/engine.ts`) doesn't use a name registry at all — it reads `agents/*.md` directly and passes each stage's tools and system prompt per spawn.

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

1. Call the engine with `args` set to the manifest object from Step 3 (pass it as an actual JSON value, **not** a stringified one). The invocation differs by harness — both run the same `workflows/execute-contract.mjs`:
   - **Claude Code:** call the **`Workflow`** tool with `scriptPath` set to the engine's absolute path (run `echo ${CLAUDE_PLUGIN_ROOT}/workflows/execute-contract.mjs` via `Bash` and confirm the file exists). The engine runs in the background and notifies on completion; watch progress with `/workflows`.
   - **pi:** call the **`run_ideation_contract`** tool (registered by the plugin's bundled `extensions/engine.ts`) with the manifest as its parameters. Synchronous — the summary comes back as the tool result, in this turn, ready for the failure gate in Step 5. The tool runs the same engine file with stage agents spawned on the first-party in-process runtime; there is no agent-registry step.
2. Tell the user before it starts: how many phases, how many already skipped, and that you'll pause only if a phase fails.
3. **Claude Code only: capture the returned `runId`** — you need it for same-session resume. In pi, resume is the git skip pre-pass (Step 2) plus re-invoking the tool.

**If the engine is unavailable** (the `Workflow` feature not enabled in this Claude Code, or the pi plugin's engine extension failed to load): degrade gracefully — tell the user, then walk the phases yourself in dependency order using `/ideation:execute-spec <specPath>` per phase (the contract's per-phase commands), committing each before the next. For express contracts, carry the `--strict` semantics into this path too (per the gate-behavior table in `${CLAUDE_PLUGIN_ROOT}/workflows/README.md`). This is the legacy manual path.

## Step 5: Handle the Summary

The engine returns `{ completed, noops, failed, skipped, results }` — plus an optional `error` field. Print all four buckets.

**If the summary carries `error`:** planning itself failed (dependency cycle, unknown prereq, duplicate phase title) — every bucket is empty and no phase ran. This is a run-level failure, never an empty success: report the `error` message verbatim and stop. Interactive: fix the manifest (the message names the offending titles) and re-run from Step 1. Unattended: report and halt — do not proceed to the Completion Report, and do not treat empty buckets as a finished run.

- **`noops` are done, not failed.** A NO-OP phase produced a genuinely empty diff (the repo already satisfies its spec) — review was skipped, nothing was committed, and dependents were not blocked. Treat `completed + noops` as the set needing no further work; re-dispatching a no-op phase loops forever.
- **Each entry in `results` carries `reviewStatus`** (`passed` / `validation-only` / `failed` / `skipped-empty-diff` / `not-run`), a `warnings` array that leads its `summary` string, and `reviewCycles`. Any `reviewStatus` other than `passed` on a committed phase means unreviewed or partially reviewed code landed — that must reach the Completion Report, never be collapsed into a bare PASS.
- **Effort tracks risk** (informational — the engine handles it): a phase with `risk: "high"` runs its build and fix stages at `effort: 'high'`; review always runs at `effort: 'high'`. `risk` comes straight from `contract-data.json`, so it is worth passing through accurately.

### Write the run record — before the failure gate

**When the summary carries no run-level `error` and its `results` array is non-empty**, write and render the run record *now*, ahead of the branching below. That ordering is the point: the failure gate's "Stop here" and unattended-halt branches never reach the Completion Report, and a failed walk-away run is the record most worth keeping. Do not move this into the report step — the reviewer findings, warnings, and `reviewStatus` values in `results` exist nowhere else once the run ends. (Nothing to record: a run-level `error` means no phase ran, and an empty `results` means every phase was already committed and skipped by Step 2 — no run to report either way, and the generator refuses both records by design.)

1. **Choose the stem.** `{projectDir}run-{date}.json` with today's date from `date +%Y-%m-%d` — read it, never recall it, because the `date` field below must match the stem. Both files live in the project directory, not elsewhere: the report links `contract.html` and the notes with relative hrefs. If that file exists, append `-2`, `-3`, … until one is free: one record per engine summary, so a within-session retry gets its own pair instead of overwriting the failed run it is retrying. The `.html` sibling takes the **same** stem. Remember both paths — the Completion Report re-renders these, not a freshly recomputed pair.
2. **Write the JSON** with exactly these nine top-level keys and no others. `${CLAUDE_PLUGIN_ROOT}/test-fixtures/run-report/run-record.json` is a complete worked example — read it once rather than guessing the nesting. Unknown keys are silently ignored, never reported, so an invented field (there is deliberately no `mode`) becomes a fact nobody ever sees:
   - `projectName`, `slug` — from `contract-data.json`; `date` — the same `YYYY-MM-DD` string as the stem.
   - `branch` — the branch Step 1 asserted, or `null` when the contract declared none. Never substitute `git branch --show-current`: the field means "the branch this contract declared", not "where the shell happens to be".
   - `baseBranch` — the repo's default branch, read from `git symbolic-ref --short refs/remotes/origin/HEAD` with the `origin/` prefix stripped; when that ref is unset, `main` if `git branch -l main` shows it exists, else `null`. The report renders its review command as `git diff {baseBranch}...{branch}`, so a wrong base is worse than none — `null` when `branch` is `null` or the base can't be established, and the report simply omits the command.
   - `strict` — the boolean you put in the Step 3 manifest.
   - `summary` — the engine's `{completed, noops, failed, skipped, results}` object **verbatim, never summarized, trimmed, or reordered**. The generator cross-checks every bucket against `results[]` and refuses any disagreement, so a "helpful" condensation is a hard error, not a nicety.
   - `verify: null` — verification has not run yet; the report renders an explicit "not run" state for it.
   - `notesFiles` — the **bare filenames** matching `{projectDir}implementation-notes-*.html` right now, `[]` when none. The report links them relative to itself, so a `docs/…` prefix or an absolute path renders a dead link, and a `://` anywhere fails validation outright.

   This skill has no `Write` tool, so write it with Bash and a **quoted** heredoc delimiter, with the closing delimiter at the start of its own line — phase summaries and findings routinely carry backticks, `$`, and literal markup, and an unquoted delimiter would let the shell expand them:

   ```bash
   cat > {recordPath} <<'JSON'
   {…the record…}
   JSON
   ```

3. **Render it** as its own Bash call — never `&&`-chained with the write, so a denial of one is visible and doesn't silently skip the other:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/run-report-gen.ts --input {recordPath} --output {htmlPath}
   ```

4. **If the generator rejects the record**, it prints every violation with its JSON path (`summary.results[2].reviewStatus: …`) and writes nothing. Fix the JSON against those indices and re-run — the errors name exactly what disagrees. Never bypass validation, and never hand-author the HTML: the generator is the only renderer and there is no fallback template. **If the command is denied by permissions**, print the exact `! node …` command so the user can render the record whenever they like, note the skipped render, and continue.
5. Then proceed to the gate below exactly as before. The JSON is already on disk, so neither a rejection nor a denial may block or delay the run's handling.

**If `failed` is empty** (and no `error`): proceed to the Completion Report.

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

- **Same session:** re-invoke the engine — in Claude Code, the `Workflow` tool with `resumeFromRunId: <runId>` and the same `scriptPath` (cached passing phases return instantly; only the failed/unreached phases re-run). In pi, call `run_ideation_contract` again with the same manifest — the Step 2 git pre-pass excludes everything already committed, so only what remains re-runs.
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

**Then enrich the run record** written in Step 5 — set its `verify` to `{ "line": "<the VERIFY line verbatim>", "exitCode": <the command's exit status> }`, using the integer status of that Bash call rather than a status inferred from the line's counts, and re-render the **same** stem with the same command:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/run-report-gen.ts --input {recordPath} --output {htmlPath}
```

The output overwrites in place, which is the intent: one record per run, re-rendered once verification has run. Leave `notesFiles` as written. When verification did not run at all — no `contract-data.json`, or the script was denied — leave `verify: null` and let the report say so; a fabricated VERIFY line is worse than an honest blank.

**Watched runs only:** `open {htmlPath}` for ambient visibility, as a separate Bash call from the render and never as an approval step. Unattended runs (a `/goal` wrapper, or any run with no interactive user) skip the open — never the write.

If all phases completed and verification passed:

```
All {N} phases complete. Run `git log --oneline -{N}` to see the commits.
```

### Learning Capture (watched runs only)

**Unattended runs explicitly skip this step** (a `/goal` wrapper, or any run
with no interactive user) — never prompt, never write
`docs/ideation/learnings.md`; the run's notes wait for the interview engine's
unmined-notes surfacing at the next interactive intake.

On a watched run, after the Completion Report, run the Learning Capture step —
aggregate this run's phase notes and apply the filter — per
`${CLAUDE_PLUGIN_ROOT}/references/learning-filter.md`, the single owner of the
procedure and the `learnings.md` lifecycle.

## Key Principles

1. **The engine orchestrates; the skill prepares and gates.** Wave planning, parallelism, and result handling are deterministic JS in `workflows/execute-contract.mjs`. This skill builds the `args`, runs the git pre-pass, and handles the human-in-the-loop moments the sandbox can't.
2. **No wave math, no `RESULT:` parsing here.** Pass `prereqs` through untouched; read the structured summary the engine returns.
3. **The contract is the source of truth** — phase order, dependencies, and spec paths all come from `contract-data.json` (`contract.md` Execution Plan as fallback).
4. **Subagents get clean contexts** — the engine runs each phase as five sibling agent stages (scout → build → review ⇄ fix → commit), each a fresh-context agent; the build stage runs execute-spec's build+verify halves as `--headless`, or `--headless --strict` when the manifest sets `strict` (semantics: the gate-behavior table in `workflows/README.md`). No phase inherits another's context.
5. **Gate on failures, not successes** — the happy path is fully hands-off; the engine runs everything still reachable and only the skill pauses, after the run, when something failed.
6. **Already-committed phases are durable** — each phase commits independently. The git pre-pass makes resume work across sessions; in Claude Code, `resumeFromRunId` makes it instant within a session.
