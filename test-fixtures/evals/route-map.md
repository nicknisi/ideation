# Routing case: a fog-of-war, multi-session effort

**Expected depth**: `map`

**Overrule**: "interview" → `interview`

**Exercises**: R1 (turn 1), R2 (turn 3).

## Setup

Any git repository standing in for a product with a database. Clean working
tree. Start `/ideation` with turn 1 as its argument.

## Turns

### Turn 1: the request

> We have to move the whole product from one self-hosted Postgres to a
> multi-region setup. I can't even see how to get there: replication, the ORM,
> billing's cron jobs, data-residency rules, and I don't know which of those
> decides the rest. This is weeks of decisions before anyone writes code.

**Assert after this turn**:

- [ ] **R1**: the first reply states the depth `map` with a one-line reason
      (the route itself is unknown and won't fit one session), and names how to
      overrule it.
- [ ] It starts by naming the destination: one question, with a recommended
      answer. No file is written before the destination is settled.

### Turn 2: the destination

> The destination is a decision, not a build: which multi-region topology we
> adopt, and what it costs billing and compliance. Code comes later.

**Assert after this turn**:

- [ ] It maps the frontier breadth first, across replication, the ORM, billing
      and residency, not deep on one thread.
- [ ] `docs/ideation/<slug>/plan.json` holds the map: each ticket is an
      `openQuestions` entry with `type`, `gate` and (when blocked)
      `blockedBy`. `units` is empty. The fog is named in gate evidence, not
      written as questions.
- [ ] Research questions go to read-only Explore agents, all in one message
      (one `dispatch` call in pi). No non-research question is resolved this
      session, and no approval is asked for.

### Turn 3: the overrule

> interview

**Assert after this turn**:

- [ ] **R2**: it switches to `interview` at once, says so in one line, and
      doesn't argue.
- [ ] The interview resumes in the same folder from the map's plan: its open
      questions and recorded decisions are carried, not re-asked.

## Passing

All assertions hold. Failures this case catches: an interview that tries to
hold weeks of decisions in one session, a map that writes units or resolves
several human questions at once, and a map kept outside plan data.
