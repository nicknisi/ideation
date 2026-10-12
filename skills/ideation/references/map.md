# The map depth

For an effort that won't fit in one agent session, where the route from here to the **destination** isn't visible yet. The map finds that route. It doesn't charge at the destination. It is plan data in `docs/ideation/<slug>/plan.json`, worked over as many sessions as the fog takes, until the route is clear and the map hands off to the interview.

## Plan, don't do

The map plans by default. Each question resolves a *decision*, not a slice of the build, and the map is done when nothing is left to decide before someone does the work. The pull to just do the work usually means you've reached the edge of the map and it's time to hand off. Map questions are never units: `units` stays empty until the interview writes them.

## The map in plan data

| The map's | In `plan.json` |
| --- | --- |
| Destination: what reaching the end looks like | `title`, the first `why` quote, and `change.after` (what is true at the end, even when the end is a decision rather than a build) |
| A decision ticket | one `openQuestions` entry: `id`, a `question` precise enough to hand to another session unchanged, its `type`, the `gate` it blocks, and `blockedBy` |
| Decisions so far | a closed question is removed. Its answer becomes that gate's evidence, and a choice that turned an alternative down becomes a decision on the claim it changes (`answered`, with `rejected` and the reason) |
| Not yet specified (the fog) | the gap named in a not-ready gate's evidence sentence. It is never an `openQuestions` entry |
| Out of scope | `scope.notChanging`, each with a few words on why |

Level-1 claims say what the destination lets someone do or see, as far as the map can tell yet. Keep them few and sketchy (`sketch: true`). The map sets `stoppedEarly: "map: the route is still open"` and never asks for approval.

## Question types

Every question is either HITL (worked *with* a person, who speaks for themselves) or AFK (driven by the agent alone). A HITL question only resolves through that live exchange. The agent never answers its own question.

- **`research`** (AFK): reading docs, third-party APIs or local resources to surface a fact a decision waits on. It resolves through an `Agent` with `subagent_type: "Explore"` and is never a question to the user (in pi, a read-only `dispatch` task: `${CLAUDE_PLUGIN_ROOT}/references/harness-compat.md` § 2).
- **`prototype`** (HITL): make a cheap, rough artifact to react to (an outline, a stub, an ASCII mockup, a throwaway script) when "how should it look or behave" is the question. The interview engine's prototype spike.
- **`decision`** (HITL): the default. One question at a time, with your recommendation, using only *Open by surfacing the silent assumptions*, *What to challenge during the interview* and *Banned phrases* from `${CLAUDE_PLUGIN_ROOT}/references/interview-engine.md`. There are no gates to track mid-question. The aim is one sharp decision.
- **`task`** (HITL or AFK): work that must happen before a decision can be made, such as signing up for a service, getting access, or moving data so its shape can be seen. The agent does it alone where it can. Otherwise it prints a precise checklist. The answer records what was done and any facts later questions depend on.

## Fog or question?

The map is deliberately incomplete. The test is whether you can **phrase** the question precisely now, not whether you can answer it now.

- **A question** when it is already sharp, even if it is blocked.
- **Fog** when you can't phrase it that sharply yet. Name the gap in the gate's evidence and leave it. Don't pre-slice fog into question-sized pieces: one patch may become several questions later, or none.

Resolving a question clears the fog ahead of it. Turn whatever is now phrasable into new questions, and drop that gap from the evidence.

## Out of scope

Fog only gathers *toward* the destination. Work beyond it is out of scope: it goes in `scope.notChanging` and never comes back unless the destination is redrawn. When an existing question turns out to sit past the destination, remove it and add the one-line `notChanging` entry. It is a scope boundary, not a decision on the route.

## Two invocations

Never resolve more than one non-research question per session. Research questions may run in parallel in any session.

**Chart the map** (a loose idea):

1. **Name the destination** in a `decision` conversation. It fixes the scope, so settle it first. If you can already see the route ("build X"), there is no fog: switch to `interview` and say so.
2. **Map the frontier, breadth first.** Fan out across the whole space, not deep on one thread. If no fog appears and the journey fits one session, switch to `interview`.
3. **Write `plan.json`**: destination, the questions you can phrase now (wire `blockedBy` in a second pass, once every id exists), the fog as gate evidence, and out-of-scope items. Name it in one line (`Mapping "{name}" → docs/ideation/{slug}/`).
4. **Fire the research agents**, one per `research` question, all at once (in pi, one `dispatch` call with one read-only task each). Fold each answer in as described above.
5. **Open the page.** The user reads the map there, not in the JSON: the unblocked questions (the frontier), the blocked ones and what blocks them, and the gates. Open it the way the respond loop does (the skill's *The page and the respond loop*): in Pi, ask the user to run `/ideation respond docs/ideation/<slug>`; in Claude Code, render it with `plan-render.ts` and `open` it. The page approves nothing, and the map's decisions are still asked in the terminal.
6. **Stop.** Charting is one session's work, and it resolves nothing but research.

**Work the map** (a folder, with or without a named question):

1. Read `plan.json`.
2. Pick the question: the one named, or else the first in the **frontier**. The frontier is every question whose `blockedBy` ids are all gone (closed), in array order.
3. Resolve it by its type, reading related plan data as you need it.
4. Record the answer by removing the question, updating the gate's evidence, and adding a decision if one was chosen. Write it as a new plan version (the skill's versions rule).
5. Add newly phrasable questions, clear the fog they came from, rule out of scope whatever has turned out to be beyond the destination, and update or remove questions the answer has made wrong.
6. Open the page on the new version, as in charting.

## Hand-off

When no question is left and no gate evidence names fog, the route is clear. If the destination is a build, switch to `interview` in the same folder. The map's plan is its starting evidence: the destination seeds Problem Clarity, the decisions made are already recorded with their rejected alternatives, and `notChanging` is the exclusion half of Scope Boundaries. The interview starts at the gates that are still open, and it always interviews for success criteria. If the destination was a decision or an in-place change rather than a build, the plan's decisions already hold the outcome: point the user at whoever does the work, and stop.
