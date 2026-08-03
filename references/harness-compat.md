# Harness compatibility — Claude Code and pi

This plugin runs in two harnesses. Three things differ; everything else is shared.

## 1. The Workflow tool

Same engine script (`workflows/execute-contract.mjs`), different invocation parameter:

| Harness | Tool | How to invoke |
|---------|------|---------------|
| Claude Code | `Workflow` | `scriptPath: <abs path to execute-contract.mjs>`, `args: <manifest>`. Runs in the background; watch `/workflows`. |
| pi | `workflow` | No `scriptPath` parameter. `read` the file, pass its contents as `script` with `args`, and set `background: false` (you need the result synchronously for the failure gate). |

Both pass the same `args` manifest. `resumeFromRunId` works in both for same-session retry.

The engine is pi-dynamic-workflows-compatible: it declares `export const meta`, uses only the `agent()` / `parallel()` / `phase()` / `log()` / `args` globals that pi's workflow runtime injects, and has zero imports.

If the Workflow tool is unavailable in either harness, autopilot degrades to the manual per-phase path (`/ideation:execute-spec <specPath>` in dependency order).

## 2. Agent (subagent) names

The skills dispatch agents by name. Claude Code plugin-scopes agents as `<plugin>:<name>`; pi's agent names reject colons and use bare local names. The engine's `agentType` strings flow through `args.agentNames` (defaults are the CC strings).

| Skill reference | Claude Code | pi |
|-----------------|-------------|-----|
| `Agent`, `subagent_type: "Explore"` | CC built-in `Explore` | `scout` (or a registered `Explore` user agent) via the `subagent` tool |
| `subagent_type: ideation:plan-critic` | plugin-scoped `ideation:plan-critic` | `plan-critic` via `subagent` |
| `subagent_type: ideation:scout` | plugin-scoped `ideation:scout` | `scout` via `subagent` |
| `subagent_type: ideation:reviewer` | plugin-scoped `ideation:reviewer` | `reviewer` via `subagent` |
| `subagent_type: general-purpose` | CC built-in `general-purpose` | `worker` via `subagent` |

**Translation rule (pi):** drop the `ideation:` prefix; dispatch the bare local name via the `subagent` tool (the Claude Code compat shim maps `Agent` → `subagent`). Same agent, same prompt, same inputs.

**Engine `agentType` names** (scout/reviewer/builder stages inside `execute-contract.mjs`): the engine reads `args.agentNames` with CC defaults, so a CC manifest omits it. A pi manifest passes `{ "agentNames": { "scout": "scout", "reviewer": "reviewer", "builder": "worker" } }`. The agents must also be registered in pi's **workflow agent registry** (separate from pi-subagents' agent discovery) for the stages to bind their tools + prompts — the registry scans `<cwd>/.pi/agents/`, `~/.pi/agent/agents/`, and `~/.pi/agents/`, not package `agents/` dirs. An unregistered name still dispatches with a prose hint (`Act as workflow subagent type: scout`) but **loses its tool binding** — the read-only scout and reviewer run with full tools. The autopilot skill copies the agent files to `.pi/agents/` before invoking the engine to prevent this; see § 3.

## 3. Pi extension dependencies

The plugin declares three pi extensions as `dependencies` in `package.json` and loads them via the `pi` manifest, so a single `pi install git:github.com/nicknisi/ideation` brings them in — no separate install steps. Each registers a tool the skills call:

| Extension | Provides | Used by | Without it |
|-----------|----------|---------|------------|
| `npm:pi-subagents` | the `subagent` tool (the `Agent` shim maps to it) + agent discovery via the `pi-subagents` field | brainstorm (`Explore`), ideation (plan critics), execute-spec (scout, reviewer, wave dispatch) | every agent dispatch fails |
| `npm:@quintinshaw/pi-dynamic-workflows` | the `workflow` tool (the `Workflow` shim maps to it) | autopilot, express, get-goal-prompt | autopilot degrades to manual per-phase execution |
| `npm:@juicesharp/rpiv-ask-user-question` | the `ask_user_question` tool (the `AskUserQuestion` shim maps to it) | ideation (every gate, routing, failure-gate), execute-spec (HOLD/abort questions) | every interactive decision point fails |

If you already have any of these installed at the user level, the bundled copy loads alongside it — tools overwrite (same name), skills collide with a warning (first wins). You can remove the user-level install to avoid the redundancy.

**Claude Code** needs none of these — it has `Agent`, `Workflow`, and `AskUserQuestion` as built-in tools. The `dependencies` and `pi` manifest are ignored.

## What does NOT differ

- `${CLAUDE_PLUGIN_ROOT}` path resolution — a pi extension rewrites these in `read`/`bash` tool calls. Skills write `${CLAUDE_PLUGIN_ROOT}/…` as in CC.
- Skill frontmatter (`name`, `description`, `allowed-tools`, `disable-model-invocation`, `argument-hint`) — parsed identically by both harnesses. Unknown fields are ignored.
- The `pi` manifest in `package.json` — CC ignores it; pi uses it to load the three extension dependencies and discover `skills/`. The `pi-subagents` field (separate from the `pi` manifest) tells pi-subagents where to find `agents/`.
- All script paths (`scripts/contract-gen.ts`, `scripts/verify.mjs`, `workflows/*.mjs`) — identical, run via `node` in both.
