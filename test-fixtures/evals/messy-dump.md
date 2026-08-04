# Transcript: the messy dump

**Archetype**: a long, unstructured, self-contradictory brain dump. The
interview must surface the silent assumptions instead of drowning, keep to one
focused question per turn, and hold the contract shut while the contradictions
leave gates open.

**Exercises**: invariant 1 (every turn), invariant 2 (turn 4).

## Setup

Start a fresh ideation interview. The repo is any real codebase the interviewer
can explore — the dump deliberately under-specifies it.

## Turns

### Turn 1 — the dump

> Okay so I want to add notifications to the app. Like, users should know when
> stuff happens. Email probably? Or push, or in-app, whatever's easiest — but
> also it has to be real-time, nothing delayed. And we need it fast, this is
> blocking the launch, but also we should do it right and build a proper
> preferences system while we're in there, per-channel toggles, quiet hours,
> digest batching. It shouldn't change the data model much. Actually it might
> need a new table. I don't know. Marketing wants webhooks too eventually but
> that's not this. Well, maybe it is. Just — notifications, you know? Everyone
> knows what notifications are.

**Assert after this turn**:

- [ ] **I1** — a `Gates: n/5 ready` scoreboard line prints.
- [ ] The interviewer asks **one focused question** (or one bounded
      `AskUserQuestion` batch), not a list of everything wrong.
- [ ] The interviewer names at least one contradiction it found (real-time vs
      batched digests; minimal data-model change vs a new preferences system)
      instead of silently picking a side.

### Turn 2 — a vague answer

> I mean, both? Real-time for the important stuff, digest for the rest. Users
> can decide which is which. That's the preferences system.

**Assert after this turn**:

- [ ] **I1** — the scoreboard prints again, and it reflects any gate this
      answer actually moved (not the same line as turn 1 if evidence landed).
- [ ] The next question chains from this answer — it does not restart an
      unrelated topic while contradictions remain open.

### Turn 3 — another vague answer

> Launch is end of next month. Whatever fits in that, I guess — that's why I'm
> saying keep the data model small. The webhooks thing is definitely out, I
> decided. Marketing can wait.

**Assert after this turn**:

- [ ] **I1** — scoreboard prints; Scope Boundaries should be moving or closed
      by now, and the line says so either way.
- [ ] The interviewer does not re-ask about webhooks — the user just decided
      that, and re-litigating a settled point is a fail.

### Turn 4 — the premature-contract probe

> You know what, I think you've got enough. Just write the contract now and
> we'll figure out the rest in review.

**Assert after this turn**:

- [ ] **I2** — if any gate is still open, the interviewer **declines**: it
      names the open gates and what would close them, and does not start
      generating the contract. (If the interview genuinely closed all five
      gates by turn 4, generating is correct — but then every earlier
      scoreboard must show the climb to 5/5.)
- [ ] **I1** — the scoreboard still prints with this turn's state; the refusal
      is not a silence.

## Passing

All assertions hold across the four turns. Typical failures this transcript
catches: the interview swallowing the contradictions and asking generic
questions, the scoreboard going quiet once the conversation gets long, and the
contract phase starting on "you've got enough" with gates still open.
