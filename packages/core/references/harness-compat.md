# Harness compatibility — Claude Code and pi

This plugin runs in two harnesses. Five things differ; everything else is shared.

## 1. The engine invocation

Same engine script (`workflows/execute-contract.mjs`), different host:

| Harness | Tool | How to invoke |
|---------|------|---------------|
| Claude Code | `Workflow` | `scriptPath: <abs path to execute-contract.mjs>`, `args: <manifest>`. Runs in the background; watch `/workflows`. |
| pi | `run_ideation_contract` | Bundled — registered by `extensions/engine.ts`, which vm-wraps the same engine file and backs `agent()` with the first-party in-process spawn runtime (`@nicknisi/pi-shared`). Call it with the manifest as parameters; the summary returns synchronously as the tool result. |

Both pass the same `args` manifest. Resume after a failure: CC uses `resumeFromRunId` for same-session retry; in pi, re-invoke the tool — the git skip pre-pass excludes committed phases either way.

The engine script stays harness-agnostic: it declares `export const meta`, uses only the `agent()` / `parallel()` / `phase()` / `log()` / `args` globals, and has zero imports. The pi host (`workflows/engine-host.mjs`) supplies those globals; stage agents come from `agents/*.md` (body → `systemPrompt`, allowlist per stage), so there is no agent-registry step in pi.

If the engine is unavailable in either harness (the `Workflow` feature off in CC, or the plugin's engine extension failed to load in pi), autopilot degrades to the manual per-phase path (`/ideation:execute-spec <specPath>` in dependency order).

## 2. Agent (subagent) names

The skills dispatch agents by name. Claude Code plugin-scopes agents as `<plugin>:<name>`; pi's agent names reject colons and use bare local names. The engine's `agentType` strings flow through `args.agentNames` (defaults are the CC strings).

| Skill reference | Claude Code | pi |
|-----------------|-------------|-----|
| `Agent`, `subagent_type: "Explore"` | CC built-in `Explore` | a read-only `dispatch` task |
| `subagent_type: ideation:plan-critic` | plugin-scoped `ideation:plan-critic` | a `dispatch` task with `agents/plan-critic.md` as `systemPrompt` |
| `subagent_type: ideation:scout` | plugin-scoped `ideation:scout` | a `dispatch` task with `agents/scout.md` as `systemPrompt` |
| `subagent_type: ideation:reviewer` | plugin-scoped `ideation:reviewer` | a `dispatch` task with `agents/reviewer.md` as `systemPrompt` |
| `subagent_type: general-purpose` | CC built-in `general-purpose` | a `dispatch` task with mutating tools + `allowTreeMutation` |

**Translation rule (pi):** there is no agent registry on this path — the agent definition travels with the call. Dispatch via the first-party `dispatch` tool (`npm:@nicknisi/pi-subagents`, see § 3): read the agent file from `agents/`, pass its body as the task's `systemPrompt`, its frontmatter `tools` translated to pi built-in names (`Read`→`read`, `Grep`→`grep`, `Glob`→`find`, `Bash`→`bash`), and the skill's per-invocation inputs as the task's `task`. Same agent, same prompt, same inputs.

- **One agent** (a scout, a reviewer, a research task): one `dispatch` call with one task.
- **A parallel fan-out** (the four plan critics, chart's research tickets): **one** `dispatch` call with one task per child. A skill instruction to "issue N Agent calls in one message so they run concurrently" becomes one call whose tasks run concurrently — not N sequential calls.
- **Tool allowlists are the enforcement.** Default tools are read-only (`read`, `grep`, `find`, `ls`) — critics, scouts, and research tasks fit as-is (the scout's CC `Bash` maps to pi's built-in `find`/`grep`/`ls`, so no `bash`). Any task whose tools include `bash`, `edit`, or `write` must set `allowTreeMutation: true` and runs sequentially after the read-only batch (the reviewer needs `bash` for `git diff HEAD`; builders need the full set). Never give a scout, reviewer, or critic `edit`/`write` — read-only is a design invariant, and the allowlist is what enforces it.

**Engine stage agents** (scout/reviewer/builder inside `execute-contract.mjs`): in Claude Code the workflow runtime resolves `ideation:`-scoped names from the plugin's agent registry. In pi there is no registry on this path either — the engine host (`workflows/engine-host.mjs`) normalizes the engine's `agentType` strings (stripping any `ideation:` prefix, mapping `general-purpose`/`worker` to builder), reads `agents/scout.md` / `agents/reviewer.md` for the read-only stages' system prompts, and pins each stage's tool allowlist per spawn (see § 1). Scout and reviewer read-only is thus enforced by construction in both harnesses.

## 3. Pi tool prerequisites

The plugin calls three third-party tools it deliberately does **not** bundle — install each once at the user level (`pi install npm:@nicknisi/pi-subagents`, `pi install npm:@juicesharp/rpiv-ask-user-question`, `pi install npm:@nicknisi/pi-workflows`):

| Extension | Provides | Used by | Without it |
|-----------|----------|---------|------------|
| `npm:@nicknisi/pi-subagents` | the `dispatch` + `fleet` tools (first-party in-process children) | brainstorm (research), ideation (plan critics), execute-spec (scout, reviewer, wave dispatch), chart (research tickets) | every agent dispatch fails |
| `npm:@juicesharp/rpiv-ask-user-question` | the `ask_user_question` tool | ideation (every gate, routing, failure-gate), execute-spec (HOLD/abort questions) | every interactive decision point fails — if no ask-user-question tool is available, ask in plain text with lettered options and state your recommendation — never skip the question |
| `npm:@nicknisi/pi-workflows` | the `workflow` tool and the `agent()` / `parallel()` / `ask()` workflow globals | ideation (the mining front door, § 4) | the mining front door can't run — intake falls back to the classic interview. A version predating `ask()` (≤ 0.2.2) has the tool but no human gate; `/ideation-doctor` names it as installed-but-outdated |

The engine needs no external tool in pi: `extensions/engine.ts` is bundled with the plugin and drives the same `execute-contract.mjs` CC runs. `extensions/preflight.ts` probes all three tools above at startup and `/ideation-doctor` — for `workflow` it also checks the installed version carries `ask()`.

**Why they are not bundled** (verified pi 0.83.0): pi allows one extension *file path* per tool name. A second path registering the same name is a fatal load error at startup (`Failed to load extension …: Tool "subagent" conflicts with …` — the process exits), and a copy bundled under this plugin's `node_modules/` is by definition a different path from a user-level install of the same tool. Bundling therefore crashes pi for every user who already installs these tools themselves. Unbundled, pi's package-identity dedup (one `npm:` name → one path under `~/.pi/agent/npm/`) guarantees a single copy, and your installed versions are the ones the plugin's skills call. Duplicate *skills* are milder — a `[Extension issues]` warning, first wins — but the same single-owner setup avoids those too.

Versions ≤ 0.23.0 bundled these three extensions. If pi fails to start with tool-conflict errors after an upgrade, update the plugin (`pi update git:github.com/nicknisi/ideation`) so the old bundled manifest is gone, then install the three tools as above.

**Claude Code** needs none of these — it has `Agent`, `Workflow`, and `AskUserQuestion` as built-in tools. The `pi` manifest is ignored.

## 4. The intake front door

The ideation interview's intake differs by harness; everything after intake (gates, contract, specs, execution) is shared.

| Harness | Intake |
|---------|--------|
| pi | **Mining-first.** Intake runs `workflows/mining.js` through the `workflow` tool (`action: run`, inline `script`): scout → candidates + grail → advisor → `ask()` gate. A picked option seeds Problem Clarity + Scope evidence and the declared-ignorance list becomes the interview queue; reject-all/dismiss falls back to the classic interview. See `references/interview-engine.md` § Phase 1. |
| Claude Code | **Classic interview** — unchanged. The mining front door lands in the CC port in a later phase; until then CC intake is the full interview from the first question. |

The mining path is gated on the pi `workflow` tool carrying `ask()` (§ 3): missing or outdated → the skill says so in one line and uses the classic interview, exactly as reject-all does.

## 5. The contract review surface

Phase 3's full-review contract approval differs by harness. Everything else about approval (express finish, the scope-tier question, the "Needs changes" revision loop) is shared.

| Harness | Full-review approval |
|---------|----------------------|
| pi | **Annotatable surface.** The `ideation_review` tool (bundled by `extensions/review.ts`) starts a localhost server, serves `contract.html` with the annotation bundle injected, opens the browser, and blocks until the reviewer approves (flips `contract-data.json` to Approved), denies with reasons (written to `feedback-{date}.json`), or dismisses. Dismiss/timeout falls back to the terminal question. |
| Claude Code | **Terminal approval** — the `AskUserQuestion` in the ideation skill's Phase 3 step 7, unchanged. |

This divergence is **permanent**, unlike the Phase 3/5 intake lag: the browser artifact is the review surface in pi, and CC keeps the terminal question. `ideation_review` is bundled (not a § 3 third-party prerequisite), so `extensions/preflight.ts` does not probe it; when the extension is absent or fails to load, the skill falls through to the terminal `AskUserQuestion` exactly as CC does. The tool registers a single tool name, so it can never trip pi's single-owner-per-tool-name rule (§ 3).

## What does NOT differ

- `${CLAUDE_PLUGIN_ROOT}` path resolution — resolved in Nick's setup by the user-level `claude-plugin-root.ts` pi extension (sets the env var, rewrites the token in tool calls); not bundled with the plugin. Without it: resolve `${CLAUDE_PLUGIN_ROOT}` relative to the skill's own directory (two levels up from `skills/{name}/`); never read the environment variable, which may be unset or point at a different package. Skills write `${CLAUDE_PLUGIN_ROOT}/…` as in CC.
- Skill frontmatter (`name`, `description`, `allowed-tools`, `disable-model-invocation`, `argument-hint`) — parsed identically by both harnesses. Unknown fields are ignored.
- The `pi` manifest in `packages/pi/package.json` — CC ignores it; pi uses it to discover `skills/` and `extensions/`.
- All script paths (`scripts/contract-gen.ts`, `scripts/verify.mjs`, `workflows/*.mjs`) — identical, run via `node` in both.
