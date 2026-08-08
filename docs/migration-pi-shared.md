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
| `agent(prompt, { agentType, schema, effort })` | `runtime.spawn({ prompt, systemPrompt, tools, outputSchema, thinkingLevel })` | schemas must be translated to TypeBox (`TSchema`) — mechanical |
| `safeAgent` (never reject, typed failure) | built into `spawn` — returns `ok \| crashed \| empty \| schema_invalid \| aborted` | our stale-FAIL path needs `schema_invalid` distinct from schema-valid-FAIL; the runtime was designed to this requirement |
| Wave planner (`computeWaves`, `propagateSkips`, `splitWavesByFileOverlap`) | **imported directly** from `workflows/wave-planner.mjs` — the extension is not sandboxed, so no inlined copy, no drift test needed on the pi side | the inlined copy in execute-contract.mjs stays for CC and keeps its drift test |
| Wave barrier (working-tree lock) | run phases sequentially, or `sharesTree` stages (tree stages never overlap anything) | every contract observed to date is linear; the stricter global exclusion is safe. Parallel-overlap within a wave is the one behavioral regression — accepted for v1 |
| `parallel()` per wave | imperative `Promise.all` over `spawn()` (runtime caps concurrency at 4) | |
| Skip propagation (failure skips dependents only) | keep `propagateSkips` — plain function | |
| Review ⇄ fix loop (≤3 cycles, carried refutations, fix-between-never-after-last, stale-FAIL) | **does not fit `runWorkflow`** — see below. Keep `runReviewLoop` imperative over `runtime.spawn` | |
| Reviewer independence (fresh session, read-only, reviews `git diff HEAD`) | fresh hermetic spawn with `tools: ['read','grep','bash']`, same cwd | never `worktree: true` for review — an isolated reviewer sees an empty diff and vacuously passes |
| Result schemas (SCOUT/BUILD/REVIEW/FIX/COMMIT/PHASE_RESULT) | TypeBox `outputSchema` per spawn | |
| `effort: 'high'` for review, risk-based effort | `thinkingLevel` per spawn | |
| git-as-journal resume (commit bodies carry spec paths) | unchanged — outer-loop concern of the autopilot skill | `runWorkflow`'s `resumeFrom` is not used by the engine port |
| Engine invoked from the autopilot skill | autopilot calls the new extension tool with the manifest | replaces the read-file-into-`workflow`-tool dance |

## The one genuine gap: two-agent loops

`runWorkflow`'s `gate` re-spawns the **same** stage with feedback appended.
The review⇄fix loop is two **different** agents (reviewer, then builder-fixer)
with carried refutation state and a fix between cycles — it cannot be
expressed as a gate, and a static needs-DAG can't express "run fix only when
review returned verdict FAIL but the stage outcome was ok."

So the engine port drives `runtime.spawn()` imperatively (a near-verbatim
port of `runPhase`/`runReviewLoop`), not `runWorkflow`. Declarative specs
stay available for the shapes that fit (the critic fan-out is a foreach;
the intake sweep likewise). If `workflow.ts` later grows a cycle/loop
construct, revisiting is cheap.

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
   on dynamic-workflows). Reviewable on its own; every dispatch becomes
   first-party.
2. **PR B — engine extension**: `extensions/engine.ts` port of
   execute-contract (spawn-based, imports wave-planner), autopilot/execute-spec
   invocation swap, drop pi-dynamic-workflows from preflight + harness-compat,
   TypeBox schema translation, smoke test against the orchestration fixture.

## Open questions for pi-extensions

- Two-agent bounded loops: worth a `loop` construct in workflow.ts, or is
  "drive spawn imperatively" the intended answer for these? (Our loop
  semantics: max 3 cycles, fix between cycles never after last, carried
  refutations, verdict-less reviewer distinct from standing FAIL.)
- `dispatch` hard-caps at 8 tasks — fine for our fan-outs (4 critics, 2–3
  sweep agents, ≤ a handful of research tickets), noted so it doesn't
  surprise a future larger fan-out.
