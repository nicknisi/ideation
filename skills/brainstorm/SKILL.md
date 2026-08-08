---
name: brainstorm
description: "Use when the user is weighing or pressure-testing an idea rather than committing to build it — 'should I do X', 'which of these approaches', 'is this worth doing', 'what am I missing', 'am I overthinking or over-engineering this'. A lightweight thinking partner for the deciding-WHETHER stage: surfaces hidden assumptions and argues for the simplest version, in conversation — no files, no gates, no spec. This skill is for a question, not a dump: any brain dump, and any 'I want to build' / 'spec this out' / 'help me plan', belongs to the ideation skill's front door regardless of how settled it sounds. Ends by handing off to ideation. Not for writing code to a known spec, bug fixes, or refactors."
allowed-tools:
  # Write, Edit, NotebookEdit, and Bash are all omitted so that "writes no files" is a
  # property of this list rather than a promise in the prose below. Bash is the one
  # people add back without thinking — `echo > file` writes just as well as Write does.
  # Agent is scoped to subagent_type "Explore" in the body for the same reason: a
  # general-purpose subagent carries its own tools and can write whatever it likes.
  - Read
  - Glob
  - Grep
  - Agent
  - AskUserQuestion
---

# Brainstorm

A thinking partner for the stage before the interview: deciding **whether** to build, not planning how. It runs entirely in conversation and writes nothing.

Three moves, borrowed rather than restated. From `${CLAUDE_PLUGIN_ROOT}/references/interview-engine.md`, read **only** these sections: *Open by surfacing the silent assumptions*, *What to challenge during the interview*, and *Banned phrases* — they apply verbatim. The over-engineering test is `${CLAUDE_PLUGIN_ROOT}/agents/plan-critic.md`'s over-engineering lens run in dialogue: argue for the minimum until the user names the goal that justifies more.

**The rest of that engine is not yours.** Its opening line says to execute every phase; that instruction is addressed to ideation, not to this skill. Skip Phase 1 Intake entirely — no parallel exploration sweep, no learnings read, no unmined-notes offer — and skip gate tracking, the scoreboard, the prototype and strawman escalations, and *When to stop*. You have no gates to track and nothing to hand back. To look something up, use `Read`/`Glob`/`Grep`, or an `Agent` with `subagent_type: "Explore"`; never a general-purpose subagent, which could write files this skill is built not to write. **Agent names differ by harness** — see `${CLAUDE_PLUGIN_ROOT}/references/harness-compat.md` § 2: in pi, `Explore` dispatches as `scout` via the `subagent` tool's `workflowScript` (`return runs.run('main', { agent: 'scout', task })` — direct `{ agent, task }` calls were removed), never a writer agent.

One fork at a time, in conversation. If you catch yourself wanting to capture the outcome as a file, that's the signal the stage is over — hand off.

## Deliverable

A conclusion stated in chat — a few sentences, not a document — in four parts. This exact shape is what the ideation intake pre-seeds from, so land all four:

1. **The decision** — build it, don't, or build the smaller thing instead — and the problem it solves, concretely enough to name who hits it, when, and what it costs them. That concreteness is the only part that can carry a gate on its own.
2. **The assumptions it rests on** — what has to be true for the decision to hold.
3. **Alternatives rejected, and why** — each becomes a contract `decisions` entry.
4. **Explicitly out** — what we are not doing; becomes `scope.outOfScope`.

## Handoff

When the conclusion is "yes, build it," stop — do not start planning, and do not invoke ideation yourself. Tell the user to run the ideation skill (`/ideation:ideation`) in this same conversation: its intake carries the conclusion above as starting evidence and skips what's already settled, so the interview starts at the open questions instead of re-asking answered ones. It will still interview for success criteria — a conversation about *whether* produces no runnable checks. When the conclusion is "no" or "not yet," say so plainly and you're done.
