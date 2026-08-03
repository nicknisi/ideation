# Interview Engine

Shared interview process for ideation skills. Read and execute all phases below before returning to the calling skill for artifact generation.

## Phase 1: Intake

Accept whatever the user provides — scattered thoughts, voice transcripts, bullet points, contradictions, topic jumping. **The mess is the input.**

Acknowledge receipt. State what looks strong and what looks weak. Take a position. Then begin the interview.

### Resume an existing project

Resume runs before the sweep, because it decides which gates get interviewed at all, and a resumed sweep is scoped to the open questions rather than to the whole brain dump.

**Trigger:** the user points ideation at an existing project (a path, a slug, or "resume {name}"). Absent that, run one **bounded** glob over `docs/ideation/*/contract-data.json`, match on directory name, and read only the file that matches. Same bounded style as the unmined-notes scan below. No match: fresh interview. More than one: `AskUserQuestion` to pick.

Read `gates.dimensions` and `openQuestions` from that file. Gates persisted as `ready` are not re-interviewed; their evidence stands. Announce in one line, no banner (same convention as the brainstorm and learning lines):

```
Resuming {projectName}: {n}/5 gates ready — {m} open questions
```

**Take only what is takeable.** An entry whose `blockedBy` ids have already closed is takeable now. A still-blocked entry stays unasked this session.

**Route by `type`:**

- **`research`**: dispatch an Explore agent, never a question to the user (core rule 3 already says this).
- **`prototype`**: the spike under "When to suggest a prototype".
- **`decision`**: `AskUserQuestion`, with your recommendation.
- **`task`**: print the precise checklist in the terminal, then `AskUserQuestion` offering "done, here is what happened" or "not yet, leave it open".

When a question closes, its answer becomes that gate's evidence and the entry is dropped. A closed `decision` question that turned an alternative down also produces a `decisions` entry, so the two arrays hand off to each other. A question that does not close stays, sharpened if this session sharpened it.

**The engine writes nothing here.** Closed and remaining questions are tracked internally alongside gate state, and the calling skill's Phase 3 persists them. Same division as the gate scoreboard.

A project already at 5/5 gates with no open questions has nothing to resume. Say so and send the user to the handoff instead of re-interviewing a finished contract.

### Intake sweep

**If the work touches an existing codebase**, fire a parallel exploration sweep at intake so your first question is already informed. Dispatch 2–3 `Agent` calls with `subagent_type: "Explore"` **in a single message** (so they run in parallel), covering:

1. **Project structure** — frameworks, languages, conventions in use.
2. **Adjacent code** — features similar to the brain dump's scope, abstractions you could extend, prior art to reuse.
3. **Test + feedback infrastructure** — test runners, dev servers, storybook, script harnesses. This feeds the infrastructure-to-playground mapping in `${CLAUDE_PLUGIN_ROOT}/references/feedback-loop-guide.md`.

While the sweep runs, acknowledge the brain dump and state what looks strong and weak — don't block on the agents. Weave their findings in as they return.

**Skip the sweep when greenfield** — there's no repo, or the brain dump is unrelated to the existing code. Exploring an unrelated codebase wastes tokens and slows the opener. **Also skip it when the repo is tiny**: if a handful of `Read` calls covers the whole codebase, read it inline — the sweep exists to compress exploration that wouldn't fit the opener, not to add ceremony to a three-file project.

**Cap at 3 sweep agents.** Scope each agent's prompt to the brain dump's stated area; beyond 3 agents, latency and token cost outrun the value for an interview opener. Sweep findings stay in conversation context — the "do not write exploration findings to files" rule below applies to the sweep too.

### Carry a brainstorm conclusion

When the current conversation already contains a brainstorm conclusion — a settled decision with its assumptions, rejected alternatives, and explicit exclusions, typically from `/ideation:brainstorm` — carry it as starting evidence instead of re-asking what it settled. Say so visibly at intake, one line, no banner (same convention as the learning line below):

```
Carrying brainstorm conclusion: {decision, one clause} — {n} rejected alternatives, {m} exclusions
```

The pieces map onto structures the contract already has:

- **Rejected alternatives** are `decisions` entries — `{decision, rejected, reason}` — captured now, at the moment they exist, not reconstructed later.
- **The settled problem** is Problem Clarity evidence when it's concrete (who, what, when, impact); cite the brainstorm as the artifact.
- **"Explicitly out"** items become `scope.outOfScope` with their reasons, covering Scope Boundaries' exclusion half; the in-scope tiers still need the interview.
- **Assumptions** are Consistency input — check later answers against them and surface contradictions.

**A brainstorm conclusion is the user's stated intent, not verified evidence.** It can seed a gate but cannot mark one `ready` on its own where the rubric demands an artifact. In practice: Problem Clarity is the only gate a strong conclusion plausibly closes by itself; Scope Boundaries arrives half-done (exclusions yes, tiers no); Goal Definition rarely survives the rubric's metric requirement; Success Criteria never does — a conversation about *whether* produces no runnable checks, so always interview for it. The rubric's "when unsure, not-ready" rule still governs. The payoff is a shorter interview aimed only at the open gates — never a skipped one.

### Read accumulated learnings

If `docs/ideation/learnings.md` exists, read it. It holds generalizable spec-gap and interview patterns captured from completed ideation projects (lifecycle: `${CLAUDE_PLUGIN_ROOT}/references/learning-filter.md`). Where a recorded pattern is relevant to this project's scope, apply it — ask the question it implies, or carry its spec implication into artifact generation — and **say so visibly at that moment**, one line, no banner:

```
Applying learning from {project} ({date}): {one-clause why}
```

Print the line whenever a learning shapes a question you ask or a spec implication you carry forward. Learnings inform questions; they never replace the evidence a gate requires, and entries are dated because codebases drift.

### Surface unmined notes

Unattended runs leave implementation notes behind that no capture step reviewed. At intake, run one **bounded** scan: a single glob over `docs/ideation/*/implementation-notes-*.html`, compared against `learnings.md`'s mtime — notes newer than the file are **unmined**; if `learnings.md` is absent, all notes count as unmined. Do not read note contents during the scan (one glob, one stat comparison — the intake opener must stay fast).

If unmined notes exist, offer **once** to mine them now: run them through the learning filter (`${CLAUDE_PLUGIN_ROOT}/references/learning-filter.md` — same accept/edit/dismiss review, up to 3 candidates), or skip. If the user skips, never re-offer within the session. Note contents are read only after the user accepts mining.

## Phase 2: Interview Loop

Interview the user relentlessly about every aspect of this plan until reaching shared understanding. Walk down each branch of the decision tree, resolving dependencies between decisions one by one.

### Open by surfacing the silent assumptions

A brain dump always admits more than one reading, and the failure mode is to silently pick one and interview as if it were settled. Before the first clarifying question, say back the interpretations you'd otherwise default to — scope (all of X vs. a slice), trigger (on-demand vs. scheduled vs. automatic), surface (the thing literally asked for vs. the adjacent thing they may mean) — and let the user correct them. This costs one turn and routinely saves three gates' worth of questions aimed at the wrong target. State the forks; don't ask permission to state them.

### State the destination in the opener

In the same turn as the forks above, give your read of what done looks like and which artifact gets handed off (a merged PR, a running service, a spec someone else implements from). State it rather than asking it, so the opener stays one turn. Left unsaid, the destination surfaces inside Success Criteria, gate 3 of 5, after two gates' worth of questions may have aimed at the wrong artifact. Whatever the user confirms or corrects lands as Success Criteria and Scope Boundaries evidence. It adds no gate.

This is a separate subsection from the forks on purpose, even though both land in one turn. `/ideation:brainstorm` borrows the forks section verbatim and has no gates to track and no artifact to hand back, so gate vocabulary inside that section would follow it into a conversation about whether to build at all.

### Core rules

1. **One focused question per turn by default.** Wait for the answer before asking the next question. Batch up to 4 questions in a single `AskUserQuestion` call **only when the questions are independent** — i.e., they target different gates and none depends on the answer to another. (`AskUserQuestion` supports 1–4 questions.) Never batch questions that chain logically; ask those one at a time so each answer informs the next.
2. **For each question, provide your recommended answer.** Frame it as: "Here's what I'd recommend — [position]. Do you agree, or would you change it?" This accelerates convergence and forces you to take positions.
3. **If a question can be answered by exploring the codebase, explore the codebase instead.** Don't ask the user what you can look up. First check the intake sweep findings (Phase 1) — they likely already hold the answer; don't re-explore what the sweep covered. If they don't, use `Agent` with `subagent_type: "Explore"` or direct `Glob`/`Grep`/`Read` to find the answer, then state what you found and move on.
4. **Use `AskUserQuestion` tool for every question.** Provide 2-4 options including your recommendation. Mark the recommended option with "(Recommended)".

### What to explore

When exploring the codebase during the interview, look for:

- Project structure, frameworks, languages, patterns in use
- Existing code related to the brain dump's scope
- Conventions — how similar features are implemented, what abstractions exist
- Testing patterns and infrastructure
- Feedback infrastructure — test runners, dev servers, storybook, API scripts. See `${CLAUDE_PLUGIN_ROOT}/references/feedback-loop-guide.md` for the infrastructure-to-playground mapping.

**Do not write exploration findings to files.** They're context for the interview, not artifacts. **This is not an exception:** an open question that blocks a gate is persisted state, and the engine still writes nothing — Phase 3 in the calling skill is what persists it (see "When a gate is blocked on work outside the interview" below). The line sits where it does because a finding is an answer nobody is waiting on, while an open question is the reason a gate is open, and the next session needs that to avoid re-interviewing from zero.

### Gate tracking

Track readiness internally across 5 evidence gates (each `ready` / `not-ready`, see `${CLAUDE_PLUGIN_ROOT}/references/confidence-rubric.md` for the gate question, evidence required, and ready-when criteria for each):

| Gate             | Question                                                                |
| ---------------- | ----------------------------------------------------------------------- |
| Problem Clarity  | Do I understand what problem we're solving, who has it, and why it matters? |
| Goal Definition  | Are the goals specific and measurable?                                  |
| Success Criteria | Can every stated goal be checked pass/fail today?                       |
| Scope Boundaries | Do I know what's in and out of scope?                                   |
| Consistency      | Are there contradictions I need resolved?                               |

**When unsure whether the evidence is sufficient, the gate is `not-ready`.** One extra question costs seconds; a bad contract costs hours.

**Scoreboard:** after each answered question, print one line from the gate state tracked above — `Gates: {n}/5 ready — open: {labels}` (e.g. `Gates: 3/5 ready — open: Success Criteria, Consistency`; when everything is ready, `Gates: 5/5 ready`). The scoreboard instruction lives only here in the engine — calling skills must not duplicate it.

When all 5 gates are `ready`, stop interviewing and generate the contract. There is no fixed question limit: keep asking until every gate is either `ready` or blocked on a written open question.

**A gate blocked on a written open question is a stopping point, not a gate to keep pushing on.** This is the terminal state that makes the first session possible. The session that writes an open question is by definition the one that cannot close that gate, so treating "all 5 ready" as the only exit would loop it on a gate nothing this session can resolve, and leave the resume path with no input. Stop when no gate can move: every remaining one is `ready` or blocked, and the blocked ones carry their question.

The user can also say "stop", "wrap up", or "that's enough" to end the interview early. Any gates still `not-ready` are recorded as such in the contract, each carrying the open question that would close it where one was written, per the subsection below.

### When a gate is blocked on work outside the interview

Sometimes a gate needs something the interview cannot produce: a fact nobody in the room has, something that must be built before it can be judged, a decision whose input does not exist yet, or work someone has to go do. Do not stamp the gate `not-ready` and move on. Write the open question.

**The test is whether you can phrase the question now, not whether you can answer it now.** Write only a question you could hand to someone else unchanged, precise enough that a different session acts on it without asking what you meant. Anything vaguer stays unwritten, and the gate is simply `not-ready` with its gap named in the evidence sentence. Do not pre-slice a hunch into several questions; one coarse patch may turn into several later, or into none.

Each question you write carries the gate it blocks, its type, and any open questions it waits on. The four types are this repo's own moves:

- **`research`**: closes via an Explore agent.
- **`prototype`**: closes via the spike below.
- **`decision`**: closes via an `AskUserQuestion`, once the missing input exists.
- **`task`**: closes via out-of-band work a human does.

**The gate stays `not-ready`.** An open question is the reason a gate is open, never a substitute for its evidence, the same rule that governs a carried brainstorm conclusion. (Stalled on articulation is the strawman below; "we'd have to build it to know" is the prototype spike; blocked on work the interview cannot do is this.)

The engine tracks these internally alongside gate state and writes no files. Phase 3 in the calling skill persists them.

### When to suggest a prototype

Some questions can't be answered by discussion — they need to be tried. When you hit a question where the answer is "we won't know until we build it" (e.g., "does this state model handle the edge cases?", "which of these layouts feels right?"), suggest a quick spike instead of leaving a gate not-ready:

```
Question: "This question is hard to answer in the abstract. Want to spike a quick prototype to find out?"
Options:
- "Yes, spike it now" — Build a quick throwaway prototype to answer the question, then resume the interview
- "No, make a decision and move on" — Pick the most defensible option and continue
- "Flag it for later" — Record it as an open question naming what would close it, per "When a gate is blocked on work outside the interview", and only if the question survives the sharpness test there
```

Which option carries `(Recommended)` comes from the shape of the question, and one shape means not offering it at all:

- **A test you could write today, against code that already exists, settles it.** Don't ask this question. Write the test, read the result, and move on: core rule 3 covers it, because a test is a way of looking something up. The spike and the guess are both worse than the answer.
- **The answer is visual or interaction-shaped**, or the thing being judged does not exist yet (the state-model example above is this: there is nothing to test until the model is built). Recommend the spike, because no amount of discussion produces the artifact being reacted to.
- **Neither.** Recommend deciding and moving on, and say which option you'd pick.

If the user chooses to spike, help them build the simplest possible throwaway that answers the question. When it does, fold the answer back into the interview and continue. The prototype itself is disposable — only the answer matters.

So read the shape before you offer this. The spike is the recommended move for one kind of question and the wrong move for the other, and where it fits, a 10-minute spike beats a 30-minute circular discussion.

### When to present a strawman

Some gates stall on articulation, not on unknowns. When the same gate is still `not-ready` after 2–3 questions — answers stay vague or contradict each other — the user likely can't state the intent directly but can react to a concrete wrong version. (If the blocker is instead "we'd have to build it to know," that's the prototype spike above, not this move.) Sketch the smallest concrete artifact that embodies your current best guess — a sample output, a config snippet, a 5-line interface, a one-paragraph behavior description — present it in the terminal, and ask:

```
Question: "Direct questions aren't converging here. Here's a strawman of my current best guess — want to react to it instead?"
Options:
- "React to this strawman" — Say what to keep, change, or kill; the reaction becomes the gate's evidence
- "Keep asking questions" — Continue with direct questions on this gate
- "Flag the gate and move on" — Record the gate as not-ready plus the open question that names what would close it, per "When a gate is blocked on work outside the interview"
```

Which option carries `(Recommended)` comes from what the gate is stalled on. A gate stalled on articulation recommends the strawman: the user can react to a concrete wrong version even when they cannot state the intent. Answers that are converging but incomplete recommend more direct questions instead.

If the user reacts, fold the reaction into the gate's evidence — what they kept, changed, or killed is the articulation the questions couldn't extract. The strawman itself is disposable; only the reaction matters.

So name the blocker before you offer this. When it is wording rather than unknowns, a 1-minute strawman sketch beats a fourth direct question, and costs far less than a prototype spike.

### What to challenge during the interview

- **Vague demand**: "Users want X" → "What evidence? Who specifically?"
- **Undefined terms**: "Better UX", "more intuitive" → "What does 'better' mean? Faster? Fewer clicks?"
- **Hypothetical users**: "Developers will love this" → Flag as a gap; the relevant gate stays not-ready.
- **Contradictions**: Surface them explicitly. "You said X earlier but now Y — which is it?"
- **Weak premises**: If the idea is weak, say it's weak and why. Don't soften.

### Banned phrases

- "That's an interesting approach" — take a position instead
- "There are many ways to think about this" — pick one and state why
- "You might want to consider..." — say "This is wrong because..." or "This works because..."
- "That could work" — say whether it WILL work based on evidence
- "I can see why you'd think that" — if the premise is weak, say so

### When to stop

The interview is complete when no gate can move this session: every gate is `ready` or blocked on a written open question, per "Gate tracking" above. It is also complete when the user says "stop", "wrap up", or "that's enough". A resumed interview is complete once every takeable open question has closed or been re-recorded, gates still open included: a question waiting on a blocked entry cannot close this session. **Return to the calling skill's next phase** (Phase 3) to begin artifact generation. Do not generate any artifacts within this interview engine — artifact generation is the calling skill's responsibility.
