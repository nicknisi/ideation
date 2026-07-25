# Ideation execution engine (`workflows/`)

The deterministic phase-orchestration engine behind `/ideation:autopilot`. It is a
[dynamic Workflow](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code)
script — the `/ideation:autopilot` skill invokes it via the `Workflow` tool.

## Files

| File                              | Role                                                                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `execute-contract.mjs`            | The Workflow script. Plans dependency-ordered waves and dispatches each phase as five sibling agent stages.                 |
| `wave-planner.mjs`                | Pure planner logic (`detectCycle`, `computeWaves`, `propagateSkips`, `splitWavesByFileOverlap`, and the `planExecutionWaves` composition). Unit-tested source of truth. |
| `wave-planner.test.mjs`           | `node --test` unit tests for the planner, plus the engine-mirror drift test.                                                |
| `execute-contract.smoke.test.mjs` | `node --test` smoke test of the script body (stubbed agents).                                                               |

> **Four** planner functions — `detectCycle`, `computeWaves`, `propagateSkips`,
> `splitWavesByFileOverlap`, but not the `planExecutionWaves` composition, which
> only the CLI and non-engine callers use — are **inlined** into
> `execute-contract.mjs` (not imported) so the script loads regardless of whether
> the Workflow sandbox allows relative imports. `wave-planner.mjs` is the
> canonical, tested copy; paste, never retype. The `engine mirror drift` suite in
> `wave-planner.test.mjs` fails the build if the two diverge — it exists because
> they already had (`computeWaves` drifted to a brace-less `if (cycle) throw …`).

## Phase execution: five sibling agent stages

A subagent running inside a dynamic Workflow **cannot spawn subagents** — the
rejection is at the tool-gating layer (`No such tool available: Agent`), so
`subagent_type` is never parsed. That made the original design impossible: one
general-purpose agent ran all of `/ideation:execute-spec`, whose Scout and Review
steps are `Agent` calls. Every non-strict phase therefore committed with **zero
review** via the skill's validation-only fallback, and `--strict` improvised an
inline review instead of failing closed.

The engine itself *can* call `agent()` with any registered `agentType` one level
deep, so the scout and reviewer are now **siblings** of the builder, not its
descendants. They already hand off through the filesystem and git, so nothing
about their contracts changed.

| Stage      | `agentType`         | Gets                                                          | Returns                                                |
| ---------- | ------------------- | ------------------------------------------------------------- | -------------------------------------------------------- |
| **scout**  | `ideation:scout`    | spec path, project dir, phase number, prior-map hint          | `verdict` GO/HOLD, `gatesReady`, `notReadyGates`, `contextMap` |
| **build**  | `general-purpose`   | spec path, the scout's map text + verdict, the `--strict` flag | `result` BUILT/NO-OP/FAIL, `filesChanged`, `patternFiles`, `validation` |
| **review** | `ideation:reviewer` | spec path, pattern files, cycle number, prior findings        | `verdict` PASS/FAIL, `findings`, `blocking`            |
| **fix**    | `general-purpose`   | the blocking findings, cycle number                           | `result` FIXED/FAIL, `carried` (refutations)           |
| **commit** | `general-purpose`   | the files to stage by name, the review outcome                | `result` COMMITTED/FAILED, `commitHash`                |

- The scout is read-only, so the **builder** writes its map to
  `{projectDir}context-map.md` — the text travels in the build prompt.
- The builder must leave everything **unstaged** and run `git add -N` on every
  net-new file, or the reviewer's `git diff HEAD` misses them entirely.
- review ⇄ fix loops to a hard cap of **3 review cycles**, mirroring
  `execute-spec`'s Verify-Review-Fix contract. Headless runs never commit at the cap.
- Every stage goes through `safeAgent()`. A bare `agent()` call *rejects* on a
  crashed or schema-less return, and a rejection inside a `parallel()` thunk
  discards the whole phase; `safeAgent` turns it into a typed stage failure so the
  summary still says which stage died.

### Gate behavior

| Condition                              | Non-strict                                                     | `--strict`                            |
| -------------------------------------- | ---------------------------------------------------------------- | --------------------------------------- |
| Scout **HOLD**                         | build anyway; `SCOUT HOLD` warning leads the phase summary     | phase FAIL, nothing built or committed |
| Scout **unavailable** (crash/no result) | build with inline exploration; `SCOUT UNAVAILABLE` warning     | same — only a HOLD *verdict* is a strict stop |
| Reviewer **unavailable / no verdict**   | commit on validation alone, `reviewStatus: "validation-only"`, `WARNING — UNREVIEWED CODE COMMITTED` leading the summary | phase FAIL, nothing committed |
| Review FAIL at cycle 3                 | phase FAIL, nothing committed                                  | same                                    |
| Empty diff after `git add -N`          | `NO-OP` — review skipped, nothing committed, own bucket        | same                                    |

`reviewStatus` is what lets the skill report the truth instead of a bare PASS: a
validation-only PASS is still a PASS the human must be told about.

## Division of labor

The Workflow sandbox has **no filesystem/git access** and **cannot call
`AskUserQuestion`**. So responsibilities split:

| Concern                                     | Owner                       |
| ------------------------------------------- | --------------------------- |
| Read `contract-data.json`, build `args`     | `/ideation:autopilot` skill |
| `git log` skip pre-pass (`completedPhases`) | `/ideation:autopilot` skill |
| Plan waves, run the five phase stages, enforce the scout/review gates | this engine |
| Interactive failure-gating + resume         | `/ideation:autopilot` skill |

## `args` contract

The skill passes this object as the Workflow's `args` (an actual JSON value, not a
stringified one):

```jsonc
{
  "projectName": "Human-Readable Name",
  "slug": "kebab-slug",
  "projectDir": "docs/ideation/<slug>/",
  "strict": false, // optional; true → phases dispatch as execute-spec --headless --strict
  "phases": [
    {
      "title": "Phase title (must match prereq references exactly)",
      "specPath": "docs/ideation/<slug>/spec-phase-1.md",
      "prereqs": ["Other phase title", "..."], // titles that must finish first
      "risk": "low", // optional, display only
      "files": ["path/a.ts", "path/b.ts"], // optional; paths this phase touches
    },
  ],
  "completedPhases": ["Phase title", "..."], // already committed; excluded from dispatch
}
```

- **Edges are phase titles**, matching `contract-data.json`'s `execution.phases[].prereqs`.
- `completedPhases` seeds the planner's satisfied set so a resumed run only executes what remains.
- **`strict`** is optional. The `/ideation:autopilot` skill sets it to `true` when
  `contract-data.json` carries `approvalMode: "express"` (single-confirmation
  approval — no per-artifact human review). Strict phases fail **closed** where
  plain headless fails open: a scout HOLD or a crashed/verdict-less reviewer
  stops the phase as FAIL instead of proceeding or committing validation-only.
- **`files`** is optional. The `/ideation:autopilot` skill populates it by parsing
  each spec's **File Changes** tables. It declares the paths a phase touches so the
  engine can serialize file-conflicting phases (see below). Omitting it (or `[]`)
  reproduces the pre-`files` behavior exactly.

### Wave overlap serialization

After prereq-ordered wave planning, the engine runs a post-pass
(`splitWavesByFileOverlap`) that splits any wave whose phases declare an
**overlapping `files` entry** into sequential sub-waves. Two phases that would
otherwise run concurrently in the same wave but touch the same file are forced to
run one-after-another — otherwise they would contaminate each other's
`git diff HEAD` review and race on the git index at commit time.

- **Greedy first-fit, deterministic.** Phases are assigned to the first sub-wave
  with no file conflict, in input order. Wave sizes are tiny, so determinism
  matters more than optimal packing.
- **Phases without `files` are parallel-safe** — they conflict with nothing. The
  engine logs a `WARN` when a multi-phase wave contains a file-less phase, so the
  silent risk of an undeclared file overlap there is at least visible.
- **Over-serialization is accepted as the safe failure mode.** If many phases all
  touch one shared file (e.g. a README), they fully serialize — correctness over
  speed.
- **Undeclared-file races** (lockfiles, generated files a spec didn't list) are
  invisible to the planner; the commit stage's prompt carries a commit-retry
  instruction (retry on `index.lock` errors) as a backstop.

The pure planner exposes `planExecutionWaves(phases, completed)` (=
`splitWavesByFileOverlap(computeWaves(...), phases)`) and a CLI
(`node wave-planner.mjs plan '<json>'`) for non-JS consumers; the engine mirrors
the two composed functions but not the composition itself.

> **Known limitation — declared-file disjointness is not isolation.** The overlap
> split only prevents two same-wave phases from writing the same _declared_ file.
> But `git diff HEAD` and the specs' validation commands are **repo-global**: two
> concurrent phases with entirely disjoint files still see each other's edits in
> the diff their reviewers read, and a failing test from phase B still fails phase
> A's validation run. Real isolation needs one working tree per phase, which the
> Workflow sandbox cannot provide (see the decision records below). This is latent,
> not live: every contract executed to date is a linear chain of single-phase
> waves, so no two phases have ever built concurrently. Fix it before shipping a
> contract with a genuinely parallel wave.

### Decision records

- **No per-phase dependency-driven scheduler.** Replacing the wave barrier with a
  memoized per-phase DAG (each phase starting the instant its own prereqs land)
  buys nothing: every real contract is a linear chain, so there is never a phase
  waiting on an unrelated sibling. Do not re-propose it without run logs showing
  real idle time.
- **No worktree isolation.** `isolation: 'worktree'` cannot work here — the
  Workflow sandbox has no filesystem, so it can neither create the worktree nor
  perform the merge back.

## Return value

```jsonc
{
  "completed": ["Phase title", "..."], // result === "PASS"
  "noops": ["Phase title", "..."], // result === "NO-OP" — empty diff, nothing to commit
  "failed": ["Phase title", "..."], // result === "FAIL" (or null agent result)
  "skipped": ["Phase title", "..."], // blocked by an upstream failure
  "results": [
    {
      "title": "...",
      "result": "PASS|NO-OP|FAIL|SKIPPED",
      "reviewStatus": "passed|validation-only|failed|skipped-empty-diff|not-run",
      "commitHash": "sha|null",
      "summary": "...", // warnings lead this string — a validation-only PASS must not read clean
      "findings": ["..."],
      "warnings": ["..."],
      "reviewCycles": 1,
    },
  ],
}
```

**`noops` are done, not failed.** A phase whose spec the repo already satisfies
commits nothing; treating that as a failure re-dispatches it forever. Consumers
must count `completed + noops` as the phases that need no further work.

## Behavior notes

- **Run everything reachable.** A failed phase only skips its (transitive) dependents;
  independent phases still run. The skill decides what to do about failures afterward —
  this is what makes the engine safe to wrap in an unattended `/goal`.
- **`parallel()` per wave** with a full wave barrier, and deliberately **not**
  `pipeline()`. The barrier is a working-tree lock, not a scheduling artifact:
  overlapping phase A's review with phase B's build would hand A's reviewer a
  `git diff HEAD` full of B's half-finished edits, and A's commit stage would then
  stage them. (The old justification — "skip propagation needs the whole prior
  wave's outcome" — was simply false; skips are per-edge.) The runtime concurrency
  cap is `min(16, cores-2)`.
- **Schema-validated results** — no free-text `RESULT:` parsing.
- **Resume**: within-session via the `Workflow` tool's `resumeFromRunId` (driven by the
  skill); cross-session via the skill's `git log` pre-pass populating `completedPhases`.
- **Effort tracks risk.** A phase declaring `risk: "high"` dispatches its build and
  fix stages at `effort: 'high'`; every other risk omits the option and inherits the
  runtime default (never below it — an under-powered build cascades skips into every
  dependent). Review is always `effort: 'high'` regardless: it is the only stage
  nothing downstream re-checks.

## Testing

```bash
node --test 'workflows/*.test.mjs'
```

The planner tests cover the graph math and the engine-mirror drift check; the smoke
test runs the full script body with stubbed agents (wave ordering, parallel wave,
failure→skip, resume, null-guard, stage ordering, both scout gates, both reviewer
gates, the 3-cycle cap, and NO-OP bucketing). A live end-to-end run against a real
fixture is exercised by the orchestration test fixture (see
`../test-fixtures/orchestration/`).
