# Migration: first-party subagent runtime (@nicknisi/pi-shared)

Status: **in progress**. Working doc for the phase-4 migration off
`pi-subagents` (third-party) and `@quintinshaw/pi-dynamic-workflows` onto
Nick's first-party stack. Delete or fold into harness-compat.md when the
migration completes.

Published packages (verified 2026-08-08):

- `@nicknisi/pi-shared@0.2.0` — library: `createSubagentRuntime` (spawn) +
  `runWorkflow` (declarative engine). Not an extension; safe as a normal
  npm dependency of this package.
- `@nicknisi/pi-subagents@0.1.0` — pi extension: model-facing `dispatch`
  and `fleet` tools. User-installed (`pi install npm:@nicknisi/pi-subagents`).
- `@nicknisi/pi-codemode@0.1.0` — has `runWorkflow` injected; not needed
  by this migration (we drive the runtime programmatically).

## Target architecture

| Concern | Today (pi) | After migration |
|---|---|---|
| Skill-level fan-out (plan critics, intake sweep, chart research tickets, execute-spec scout/reviewer) | third-party `subagent` tool + `workflowScript` | `dispatch` tool from `@nicknisi/pi-subagents` |
| Engine (autopilot's execute-contract run) | `workflow` tool from `@quintinshaw/pi-dynamic-workflows` running `workflows/execute-contract.mjs` | ideation's own extension (`extensions/engine.ts`) registering a tool that drives `createSubagentRuntime` directly |
| Agent definitions (scout, reviewer, plan-critic) | pi-subagents manifest field + agent registry copy to `.pi/agents/` | `agents/*.md` bodies passed as `systemPrompt`, tools as `tools` allowlist — the .md files stay the single source of truth |
| `ask_user_question` | `@juicesharp/rpiv-ask-user-question` | unchanged — still third-party, still required |
| Claude Code path | built-in `Agent` / `Workflow` | unchanged |

CC is untouched by this migration: its built-ins stay, and
`workflows/execute-contract.mjs` remains the CC engine. The pi engine is a
separate port (see "The one genuine gap" below for why it's a port, not a
wrap).

## Mapping: execute-contract.mjs → pi-shared

| execute-contract concept | pi-shared construct | Notes |
|---|---|---|
| `agent(prompt, { agentType, schema, effort })` | `runtime.spawn({ prompt, systemPrompt, tools, outputSchema, thinkingLevel })` | plain JSON Schema passes `Value.Check` verbatim (verified against 0.2.0) — no TypeBox translation needed |
| `safeAgent` (never reject, typed failure) | built into `spawn` — returns `ok \| crashed \| empty \| schema_invalid \| aborted` | our stale-FAIL path needs `schema_invalid` distinct from schema-valid-FAIL; the runtime was designed to this requirement |
| Wave planner (`computeWaves`, `propagateSkips`, `splitWavesByFileOverlap`) | unchanged — the shim loads the engine file as-is, inlined planner included; the existing drift test against `workflows/wave-planner.mjs` keeps covering it | |
| Wave barrier (working-tree lock) | run phases sequentially, or `sharesTree` stages (tree stages never overlap anything) | every contract observed to date is linear; the stricter global exclusion is safe. Parallel-overlap within a wave is the one behavioral regression — accepted for v1 |
| `parallel()` per wave | imperative `Promise.all` over `spawn()` (runtime caps concurrency at 4) | |
| Skip propagation (failure skips dependents only) | unchanged — engine logic, exercised through the shim by `engine-host.test.mjs` | |
| Review ⇄ fix loop (≤3 cycles, carried refutations, fix-between-never-after-last, stale-FAIL) | unchanged — engine logic; the shim test asserts `schema_invalid` maps to the verdict-less path, not a standing FAIL | |
| Reviewer independence (fresh session, read-only, reviews `git diff HEAD`) | fresh hermetic spawn with `tools: ['read','grep','bash']`, same cwd | never `worktree: true` for review — an isolated reviewer sees an empty diff and vacuously passes |
| Result schemas (SCOUT/BUILD/REVIEW/FIX/COMMIT/PHASE_RESULT) | passed straight through as `outputSchema` | |
| `effort: 'high'` for review, risk-based effort | `thinkingLevel` per spawn | |
| git-as-journal resume (commit bodies carry spec paths) | unchanged — outer-loop concern of the autopilot skill | `runWorkflow`'s `resumeFrom` is not used |
| Engine invoked from the autopilot skill | autopilot calls the bundled `run_ideation_contract` tool with the manifest; synchronous result | replaces the read-file-into-`workflow`-tool dance AND the `.pi/agents/` registry copy step |

## The one genuine gap: two-agent loops

`runWorkflow`'s `gate` re-spawns the **same** stage with feedback appended.
The review⇄fix loop is two **different** agents (reviewer, then builder-fixer)
with carried refutation state and a fix between cycles — it cannot be
expressed as a gate, and a static needs-DAG can't express "run fix only when
review returned verdict FAIL but the stage outcome was ok."

So the engine migration does **not** use `runWorkflow`, and does not port the
engine either. Instead `workflows/engine-host.mjs` **vm-wraps the same
`execute-contract.mjs` body** (the exact pattern the smoke test uses) and
backs its `agent()` global with `runtime.spawn()`. The engine stays the
single source of truth for both harnesses — no port, no drift.
`extensions/engine.ts` is the thin wiring layer: it registers the
`run_ideation_contract` tool and creates the runtime. The shim is
dependency-free (spawn injected) so the test suite still needs no install.

If `workflow.ts` later grows a cycle/loop construct, a declarative re-write
becomes possible — the per-phase pipeline is the reference use case: two
alternating agent types, bounded at 3, carried state, "fix between cycles
never after last," verdict-less distinct from standing FAIL.

## Tool-name mapping (agent frontmatter → spawn allowlist)

`agents/*.md` use CC capitalized names; spawn allowlists use pi built-in
names. Skill text must translate:

| agents/*.md | spawn `tools` |
|---|---|
| `Read` | `read` |
| `Grep` | `grep` |
| `Glob` | `find` (closest built-in) |
| `Bash` | `bash` (note: allows mutation — reviewer/scout discipline stays prompt-level + read-only intent) |
| `Write`/`Edit` | `write`/`edit` |

- scout: `['Read','Glob','Grep','Bash']` → `['read','find','grep','bash']`
- reviewer: `['Read','Grep','Bash']` → `['read','grep','bash']`
- plan-critic: `['Read','Glob','Grep']` → `['read','find','grep']`
- builder (CC `general-purpose`) → `dispatch` default or explicit full set; engine spawns pass explicit `['read','grep','find','ls','bash','edit','write']`

## Dependency changes

- `package.json`: drop the `pi-subagents` manifest field (agent registry no
  longer used); no runtime dependency on the new stack for skill dispatch
  (user-installed extension), **add** `@nicknisi/pi-shared` as a real
  dependency for the engine extension.
- `extensions/preflight.ts`: capabilities become `dispatch`
  (`npm:@nicknisi/pi-subagents`) and `ask_user_question`
  (unchanged). The `workflow` check disappears when the engine extension
  lands (the tool is ours — always present). Until then it stays.
- `references/harness-compat.md`: § 2's interim workflowScript subsection is
  replaced wholesale; § 3's three-tool table becomes two rows.
- Site guide reads those tables — build after editing (the build is the
  drift check).

## PR plan

1. **PR A — dispatch migration** (skill-level): skills (ideation critics,
   brainstorm/chart Explore, execute-spec scout/reviewer), preflight,
   harness-compat § 2/§ 3, `package.json` manifest. Engine untouched (still
   on dynamic-workflows). **Merged as #25.**
2. **PR B — engine extension** (this section's implementation):
   `workflows/engine-host.mjs` (the vm-wrap shim, spawn injected) +
   `extensions/engine.ts` (the `run_ideation_contract` tool) +
   `workflows/engine-host.test.mjs` (real engine, fake spawn — covers the
   translation layer and the schema_invalid/stale-FAIL semantics).
   Autopilot calls the tool instead of the `workflow` tool; the
   `.pi/agents/` registry copy step is gone (the host reads `agents/*.md`
   directly); pi-dynamic-workflows is dropped from preflight, harness-compat,
   and the README. CC path untouched.

## Open questions for pi-extensions

- Two-agent bounded loops: worth a `loop` construct in workflow.ts, or is
  "drive spawn imperatively" the intended answer for these? (Our loop
  semantics: max 3 cycles, fix between cycles never after last, carried
  refutations, verdict-less reviewer distinct from standing FAIL.)
- `dispatch` hard-caps at 8 tasks — fine for our fan-outs (4 critics, 2–3
  sweep agents, ≤ a handful of research tickets), noted so it doesn't
  surprise a future larger fan-out.
