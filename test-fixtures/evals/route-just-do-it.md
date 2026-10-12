# Routing case: a one-line fix

**Expected depth**: `just do it`

**Overrule**: "short plan" → `short plan`

**Exercises**: R1 (turn 1), R2 (turn 2).

## Setup

Any git repository with a README that has an install line and a test command.
Clean working tree. Start `/ideation` with turn 1 as its argument.

## Turns

### Turn 1: the request

> The README's install line says `npm i -g ideation`, but the package is
> published as `@nicknisi/ideation`. Fix that one line.

**Assert after this turn**:

- [ ] **R1**: the first reply states the depth `just do it` with a one-line
      reason (one line, not a paragraph) and names how to overrule it.
- [ ] No interview: no gate scoreboard, no critics, no plan page. Any question
      it asks is one the repository can't answer.
- [ ] It writes `docs/ideation/<slug>/plan.json` with **one** unit, empty
      `claims`, and `stoppedEarly` set. No `plan.html`.
- [ ] It shows before → after, the check, and the exact paths and commands in a
      few lines, says approved commands aren't sandboxed, and asks for approval
      with a terminal confirmation (`AskUserQuestion` in Claude Code;
      `ideation_change` prepare with `plan`, then `/ideation approve`, in Pi).
      Nothing runs before that answer.

### Turn 2: the overrule

> short plan

**Assert after this turn**:

- [ ] **R2**: it switches to `short plan` at once, says so in one line, and
      doesn't argue for the old depth.
- [ ] It revises the same `plan.json` (a new version if a person already saw
      it) instead of starting over, and keeps what turn 1 settled.
- [ ] It moves on to the short plan's steps: decisions with recommended
      answers, the critics, then the page.

## Passing

All assertions hold. Failures this case catches: an interview or a plan page for
a one-liner (risk 10's "interview on a one-liner"), running before the terminal
confirmation, and an overrule that's argued with or restarts from zero.
