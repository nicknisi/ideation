---
name: chart
description: "Use when an effort is too big for one agent session and the way from here to the destination isn't visible yet — the route itself is the unknown, not the build. Triggers on: 'this is huge and I can't even see how to get there,' 'too foggy to spec,' 'we need a map before we plan,' 'chart a route,' or any idea whose open decisions span more than one session before the way to a spec is clear. Charts a shared local map of decision tickets and resolves them one at a time (one per session, except research) until the way is clear — then hands off to /ideation:ideation to plan the build, or to whatever the destination names. Distinct from /ideation:brainstorm (deciding WHETHER, in conversation, no files) and /ideation:ideation (planning HOW, one contract, produces specs). Skip when the idea already fits a single ideation contract."
allowed-tools:
  - Read
  - Glob
  - Grep
  - Write
  - Edit
  - Bash
  - Agent
  - AskUserQuestion
---

# Chart

A loose idea has arrived — too big for one agent session, and wrapped in fog: the way from here to the **destination** isn't visible yet. Charting is about finding that way, not charging at the destination. This skill charts the way as a **shared map** of **decision tickets** in the repo, then works the tickets one at a time — questions whose resolution is a *decision*, not slices of a build to execute — until the route is clear.

The destination varies per effort, and naming it is the first act of charting — it shapes every ticket. It might be a spec to hand off to `/ideation:ideation`, a decision to lock before planning starts, or a change made in place like a data-structure migration. The map is domain-agnostic — engineering work, course content, whatever fits the shape.

This skill is the **upstream** of ideation. `/ideation:brainstorm` decides *whether* (one idea, in conversation, no files); `/ideation:ideation` plans *how* (decided to build, one contract, produces specs). Chart is for the case that breaks ideation's shape: the effort is so large or foggy that even the route to a single contract isn't visible — you can't yet hold the whole journey in one session. It builds a persistent, multi-session map instead, and hands off to ideation once the destination is sharp enough to spec.

## The map lives locally

There is no issue-tracker integration. The map is a markdown file and its tickets are markdown files, so the map is git-tracked, diffable, and editable by any session — the local-markdown tracker is the only tracker this skill supports.

```
docs/chart/{slug}/
  map.md                        # the map — the canonical index
  tickets/
    {ticket-slug}.md            # one file per ticket
```

The `{slug}` is kebab-cased from the destination, chosen when the map is created (the charting session names it, like ideation names its project).

## Plan, don't do

Chart is **planning** by default: each ticket resolves a decision, and the map is done when the way is clear — nothing left to decide before someone goes and does the thing. The pull to just do the work is usually the signal you've reached the edge of the map and it's time to hand off (to ideation, or to the destination's own doer). An effort can override this in its **Notes** — carrying execution into the map itself — but absent that, produce decisions, not deliverables.

## Refer by name

Every map and ticket has a **name** — its title, which doubles as its filename stem. In everything the human reads — narration, the map's Decisions-so-far — refer to it by that name, never by a bare filename or slug. A wall of `ticket-42.md, ticket-43.md` is illegible; names read at a glance. The filename doesn't vanish — a name wraps its link — but it rides _inside_ the name, never stands in for it.

## The Map

The map is `docs/chart/{slug}/map.md` — the canonical artifact. Its tickets are files in `tickets/`.

The map is an **index**, not a store. It lists the decisions made and points at the tickets that hold their detail; a decision lives in exactly one place — its ticket — so the map never restates it, only gists it and links.

Open tickets are **not** listed in the map body — they are the files in `tickets/` whose status is `open`. The frontier is found by reading the directory, not by maintaining a list that would drift.

### The map body

```markdown
# {Map name}

## Destination

<what reaching the end of this map looks like — the spec, decision, or change this effort is finding its way to. One or two lines; every session orients to it before choosing a ticket.>

## Notes

<domain; skills every session should consult; standing preferences for this effort — e.g. "hand off to /ideation:ideation once the route is clear", or "carry execution into the map (override of plan-don't-do)">

## Decisions so far

<!-- the index — one line per closed ticket: enough to judge relevance, then open the link for the detail the ticket holds -->

- [{closed ticket title}](tickets/{ticket-slug}.md) — <one-line gist of the answer>

## Not yet specified

<!-- see "Fog of war": in-scope fog you can't ticket yet; graduates as the frontier advances -->

## Out of scope

<!-- see "Out of scope": work ruled beyond the destination; closed, never graduates -->
```

### Tickets

Each ticket is a file `tickets/{ticket-slug}.md`. Its filename is its identity. Its body is the question, sized to one 100K-token agent session:

```markdown
# {Ticket title}

Type: research | prototype | grilling | task
Status: open | in-progress | closed
Claimed by: <session label or "you">   <!-- present only when in-progress -->
Blocked by: [{ticket title}](...)      <!-- omitted when takeable now -->

## Question

<the decision or investigation this ticket resolves>
```

A `chart:<type>` tag is recorded as the `Type:` line — one of `research`, `prototype`, `grilling`, `task` (see [Ticket Types](#ticket-types)).

**Claiming** uses the `Status` and `Claimed by` lines: a session **claims** a ticket by setting `Status: in-progress` and `Claimed by:` to itself **first**, before any work, so concurrent sessions skip it. An `open`, unclaimed ticket is unclaimed; an `in-progress` ticket is someone's claim.

**Blocking** uses the `Blocked by:` line — a body convention, since local markdown has no native dependency relationship. A ticket is **unblocked** when every ticket it lists in `Blocked by:` is `closed`; the **frontier** is the open, unblocked, unclaimed tickets — the edge of the known, found by scanning `tickets/`.

The answer isn't part of the body's Question — it's recorded on resolution (see [Work through the map](#work-through-the-map)). Assets created while resolving a ticket are linked from the ticket (a relative path or URL), not pasted in.

## Ticket Types

Every ticket is either **HITL** — human in the loop, worked _with_ a human who speaks for themselves — or **AFK**, driven by the agent alone. A HITL ticket only resolves through that live exchange; the agent never stands in for the human's side of it (a grilling agent that answers its own questions has broken this).

- **Research** (AFK): Reading documentation, third-party APIs, or local resources to surface a fact a decision waits on. Resolved by an `Agent` with `subagent_type: "Explore"` — never a question to the user. (Agent names differ by harness — see `${CLAUDE_PLUGIN_ROOT}/references/harness-compat.md` § 2: in pi, `Explore` dispatches as `scout` via the `subagent` tool's `workflowScript` (`return runs.run('main', { agent: 'scout', task })` — direct `{ agent, task }` calls were removed), never a writer agent.) Use when knowledge outside the current working directory is required.
- **Prototype** (HITL): Raise the fidelity of the discussion by making a cheap, rough, concrete artifact to react to — an outline, a rough take, a stub, or UI/logic code. Invoke the `/prototype` skill when available (the essentials plugin); otherwise produce the cheapest concrete artifact that surfaces the real question (a stub file, an ASCII mockup, a throwaway script) and link it from the ticket. Use when "how should it look" or "how should it behave" is the key question.
- **Grilling** (HITL): Conversation. The default case. Use the one-question-at-a-time grilling from `${CLAUDE_PLUGIN_ROOT}/references/interview-engine.md` — read **only** these sections: *Open by surfacing the silent assumptions*, *What to challenge during the interview*, and *Banned phrases*. Like `/ideation:brainstorm`, the rest of that engine is not yours (no intake sweep, no gate tracking, no scoreboard); you have no contract to converge to, only a decision to reach. Challenge vague demand, undefined terms, and hypothetical users until the decision is sharp.
- **Task** (HITL or AFK): Manual work that must happen before a _decision_ can be made — nothing to decide, prototype, or research, but the discussion is blocked until it's done. Signing up for a service so its API can be judged, provisioning access, moving data so its shape can be seen. This is the one type that _does_ rather than decides — and it earns its place by unblocking a decision, not by delivering the destination. The agent drives it alone where it can (AFK); otherwise it hands the human a precise checklist (HITL). Resolved when the work is done; the answer records what was done and any resulting facts (credentials location, new URLs, row counts) later tickets depend on.

## Fog of war

The map is _deliberately_ incomplete: don't chart what you can't yet see. Beyond the live tickets lies the **fog of war** — the dim view of decisions and investigations you can tell are coming but can't yet pin down, because they hang on questions still open. Resolving a ticket clears the fog ahead of it, graduating whatever's now specifiable into fresh tickets — one at a time, until the way to the destination is clear and no tickets remain.

The map's **Not yet specified** section is where that dim view is written down: the suspected question, the area to revisit later. It's the undiscovered frontier _toward_ the destination — everything here is in scope, just not sharp enough to ticket. Write as loosely or as fully as the view allows; it doubles as a signpost for the next session reading where the effort is headed.

**Fog or ticket?** The test is whether you can state the question precisely now — _not_ whether you can answer it now.

- **Ticket when** the question is already sharp — even if it's blocked and you can't act on it yet.
- **Not yet specified when** you can't yet phrase it that sharply. Don't pre-slice the fog into ticket-sized pieces: it's coarser than a ticket, and one patch may graduate into several tickets, or none, once the frontier reaches it.

**Not yet specified** excludes what's already decided (Decisions so far), what's already a live ticket, and what's out of scope (the next section).

## Out of scope

Fog only ever gathers _toward_ the destination. The destination fixes the scope, so work beyond it is **out of scope** — it isn't fog, and it doesn't belong in **Not yet specified**. It gets its own **Out of scope** section on the map: work you've consciously ruled out of _this_ effort. Scope, not sharpness, lands it here.

Out-of-scope work never graduates — the frontier stops at the destination — so it returns only if the destination is redrawn, and then as a fresh effort, not a resumption.

Ruling something out of scope is a scoping act, not a step on the route. When a ticket that already exists turns out to sit past the destination — mis-scoped in while charting, or exposed by a resolution — **close it** (a closed ticket is unambiguously off the frontier) and leave one line in the **Out of scope** section: the gist plus why it's out of scope, linking the closed ticket. It stays out of **Decisions so far**, which records the route actually walked — a scope boundary isn't a step on it.

## Invocation

Two modes. Either way, **never resolve more than one ticket per session** — with the exception of research tickets (which may be dispatched in parallel, AFK, and resolve in the same charting session).

### Chart the map

User invokes with a loose idea.

1. **Name the destination.** Run a `grilling` ticket's conversation (the interview-engine sections above) to pin down what this map is finding its way to — the spec, decision, or change. The destination fixes the scope, so it's settled first. If the destination is already "build X and I can already see the route," you don't need a map — point the user at `/ideation:ideation` (or `/ideation:brainstorm` if they're still weighing whether) and stop.
2. **Map the frontier.** Grill again, **breadth-first** this time: fan out across the whole space rather than deep on any one thread, surfacing the open decisions and the first steps takeable now. **If this surfaces no fog** — the way to the destination is already clear and the whole journey is small enough for one session — you don't need a map. Stop and point the user at `/ideation:ideation`.
3. **Create the map** at `docs/chart/{slug}/map.md`: Destination and Notes filled in (Notes should name the handoff target — usually `/ideation:ideation`), Decisions-so-far empty, the fog sketched into **Not yet specified**. Name the effort and state the path in one line (`Charting "{name}" → docs/chart/{slug}/`).
4. **Create the tickets you can specify now** as files in `tickets/` — then wire `Blocked by:` lines in a **second pass** (files need names before they can reference each other). Wiring sorts them into the frontier and the blocked; everything you can't yet specify stays in the fog — the **Not yet specified** section.
5. **Fire the research subagents.** For each `research` ticket you just created, spin up an `Agent` (`subagent_type: "Explore"`) to resolve it in parallel (in pi, one `subagent` call whose `workflowScript` `await`s a `runs.all` of them — see `${CLAUDE_PLUGIN_ROOT}/references/harness-compat.md` § 2), capturing its findings as a linked asset and posting the resolution on the ticket. Research is the only type that resolves in the charting session.
6. Stop — charting is one session's work; it hand-resolves nothing but research.

### Work through the map

User invokes with a map (path or slug). A ticket is **optional** — without one, you pick the next decision, not the user.

1. Load the **map** — `docs/chart/{slug}/map.md` — the low-res view, not every ticket body.
2. Choose the ticket. If the user named one, use it. Otherwise scan `tickets/` for the first frontier ticket (open, unblocked, unclaimed) in a stable order (filename). **Claim it**: set `Status: in-progress` and `Claimed by:` before any work.
3. Resolve it — **zoom as needed**: read the full body of any related or closed ticket on demand; invoke the skill the ticket's `Type:` names (the interview-engine sections for `grilling`, an `Explore` agent for `research`, `/prototype` for `prototype`). If in doubt, grill.
4. Record the resolution: append an **## Answer** section to the ticket with the decision (and link any asset), set `Status: closed`, and add one line to the map's **Decisions so far** linking the ticket.
5. Add newly-surfaced tickets (create-then-wire); graduate any fog the answer has made specifiable, clearing each graduated patch from **Not yet specified** so it lives only as its new ticket. If the answer reveals a ticket — this one or another — sits beyond the destination, **rule it out of scope** rather than resolving it on the route. If the decision invalidates other parts of the map, update or delete those tickets.

The user may run unblocked tickets in parallel, so expect other sessions to be editing `tickets/` and `map.md` concurrently — read the latest files each step, and don't clobber a `Claimed by:` that isn't yours.

## Handoff

When the frontier is empty — every ticket closed, **Not yet specified** either empty or fully graduated — the way is clear. That is the edge of the map: stop planning.

If the destination is a build, hand off to `/ideation:ideation`. State the handoff in the four-part shape ideation's intake pre-seeds from, so the interview starts at the open questions instead of re-asking answered ones:

1. **The destination** — what reaching the end looks like, concretely enough to name who it's for and what it costs them not to have it. The map's Destination line is the seed.
2. **The route** — the decisions the map walked (Decisions so far), as the assumptions the build rests on.
3. **Alternatives rejected** — each closed ticket's rejected branch becomes a contract `decisions` entry.
4. **Explicitly out** — the map's **Out of scope** section, as `scope.outOfScope`.

Tell the user to run `/ideation:ideation` in this same conversation; do not invoke it yourself. If the destination was a decision or an in-place change rather than a build, the map's closed tickets already hold the outcome — point the user at the doer (a person, a separate session, a migration script) and stop.