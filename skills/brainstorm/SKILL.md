---
name: brainstorm
description: "Run only when explicitly invoked. A thinking partner for deciding whether to build something at all: it surfaces hidden assumptions and argues for the simplest version, in conversation. It writes no files, and its tool list enforces that. It ends with a decision in chat and, if the answer is 'build it', points you to /ideation. This is /ideation's 'should we?' opening as its own command."
disable-model-invocation: true
allowed-tools:
  # Write, Edit, NotebookEdit and Bash are omitted so "writes no files" is a property of
  # this list, not a promise in the prose. Bash is the one people add back without
  # thinking: `echo > file` writes just as well as Write does. Agent is scoped to
  # subagent_type "Explore" in the body for the same reason.
  - Read
  - Glob
  - Grep
  - Agent
  - AskUserQuestion
---

# Brainstorm

This is `/ideation`'s "should we?" opening, run on its own. Follow *The "should we?" opening writes no files* in `${CLAUDE_PLUGIN_ROOT}/skills/ideation/SKILL.md` exactly: the same moves, the same four-part conclusion. Read only that section. The rest of that skill is not yours.

There is one difference. Do not start a depth yourself, because this skill cannot write plan data. When the conclusion is "build it", name the depth that fits in the same one-line form and tell the user to run `/ideation` in this conversation. It starts from your conclusion instead of asking those questions again. When the conclusion is "no" or "not yet", say so plainly and stop.

To look something up, use `Read`/`Glob`/`Grep` or an `Agent` with `subagent_type: "Explore"`, never a general-purpose agent. In pi, see `${CLAUDE_PLUGIN_ROOT}/references/harness-compat.md` § 2: use a read-only `dispatch` task, never one with `edit`, `write` or `bash`.
