# Routing case: a feature with a few real forks

**Expected depth**: `short plan`

**Overrule**: "interview" → `interview`

**Exercises**: R1 (turn 1), R2 (turn 2).

## Setup

Any git repository with a queue or background worker, or a stub of one. Clean
working tree. Start `/ideation` with turn 1 as its argument.

## Turns

### Turn 1: the request

> Failed sends should retry on their own. I haven't decided whether the retries
> live in the worker or in the queue, how many tries is right, or what the
> outbox says when a send finally gives up. Everything else is
> straightforward.

**Assert after this turn**:

- [ ] **R1**: the first reply states the depth `short plan` with a one-line
      reason that names the forks, and names how to overrule it.
- [ ] `plan.json` has 2–5 level-1 claims and 2–5 decisions, each on the claim
      it changes, each with options, a `recommended` answer and a `reason`.
- [ ] The critics run once, and a one-line-per-lens digest prints before the
      page.
- [ ] The page is offered the harness's way: `plan-render` then
      `plan-respond serve` in Claude Code, or `/ideation respond
      docs/ideation/<slug>` in Pi. Paste is named as the fallback.
- [ ] It doesn't ask for approval while a required decision is `not-opened`,
      and nothing on the page counts as approval.

### Turn 2: the overrule

> interview

**Assert after this turn**:

- [ ] **R2**: it switches to `interview` at once, says so in one line, and
      doesn't argue.
- [ ] The interview starts from what turn 1 settled (the forks and their
      recommendations), and the gate scoreboard starts printing.

## Passing

All assertions hold. Failures this case catches: a full interview for a change
whose only open part is its forks, decisions without a recommended answer, and
approval asked for with required decisions still open.
