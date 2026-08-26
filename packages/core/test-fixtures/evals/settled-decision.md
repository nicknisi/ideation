# Transcript: the settled decision

**Archetype**: the user has already decided what to build — the interview's job
is to pressure-test the evidence and get out of the way, not to re-open the
decision. Carries both legs of the spike invariant: the unanswerable question
must get the spike offer, the testable one must not.

**Exercises**: invariant 1 (every turn), invariant 3 (turns 3 and 4).

## Setup

Start a fresh ideation interview in this repository (ideation itself), so the
"testable question" probe has real code to be tested against.

## Turns

### Turn 1 — the settled decision

> I've already decided what I'm building: a `lint:prompts`-style check, but for
> the eval transcripts — a script that verifies every transcript fixture names
> its invariants and links its sources. Don't talk me out of it, don't
> re-explore whether it's worth doing; I did that thinking already. I need you
> to get the gates closed so we can write the contract.

**Assert after this turn**:

- [ ] **I1** — the scoreboard prints.
- [ ] The interviewer accepts the decision as given — it interviews the
      **evidence** (scope, success criteria, edge cases) rather than asking
      "are you sure this is worth building?" Re-litigating a settled decision
      is a fail.

### Turn 2 — evidence answers

> Success criteria: the script exits non-zero when a transcript drops an
> invariant row, and `npm test` stays green on the real fixtures. Scope: the
> three transcripts in `test-fixtures/evals/`, nothing else — no harness, no
> driver, no CI wiring beyond the existing test glob. Effort is an evening.

**Assert after this turn**:

- [ ] **I1** — the scoreboard prints and shows real movement; this turn's
      answers close or nearly close Goal Definition, Scope Boundaries, and
      Success Criteria, and the line must not pretend otherwise.

### Turn 3 — the unanswerable probe

> One thing I can't decide: whether the transcript format should put the
> assertions inline per turn like they are now, or collected in a checklist at
> the end. I keep going back and forth — I don't think I'll know which reads
> better until I see a real replay use one. We won't know until we try it.

**Assert after this turn**:

- [ ] **I3a** — the interviewer offers the **prototype spike** ("want to spike
      a quick prototype to find out?") or flags it as an open question — the
      question is explicitly "we won't know until we build/try it", the exact
      trigger in § When to suggest a prototype. Flatly picking a side without
      acknowledging the unanswerability is a fail.
- [ ] **I1** — the scoreboard prints.

### Turn 4 — the testable probe

> Also: does the existing `npm test` glob actually pick up a new
> `test-fixtures/evals/` test file, or would the script need the glob widened?
> I'm not sure how `test-fixtures/**/*.test.mjs` behaves with a new directory.

**Assert after this turn**:

- [ ] **I3b** — the interviewer does **not** offer a spike and does not guess:
      per § When to suggest a prototype, a question a test against existing
      code settles gets the write-the-test / look-it-up move (core rule 3) —
      e.g. create a trivial file and run the glob, or read the glob semantics
      and answer directly. Offering a prototype spike here is a fail.
- [ ] **I1** — the scoreboard prints.

## Passing

All assertions hold. The failures this transcript catches: re-opening settled
decisions, treating every uncertainty as discussion-shaped (no spike on the
genuinely unanswerable), and — the one § When to suggest a prototype calls out
by name — spiking or guessing what a two-minute test would settle.
