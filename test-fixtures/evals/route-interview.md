# Routing case: an ambiguous initiative

**Expected depth**: `interview`

**Overrule**: "short plan" → `short plan`

**Exercises**: R1 (turn 1), R2 (turn 3).

## Setup

Any product codebase with an onboarding flow, or a stub of one. Clean working
tree. Start `/ideation` with turn 1 as its argument.

## Turns

### Turn 1: the request

> We keep losing people during onboarding. I want to fix onboarding: maybe a
> checklist, maybe drip emails, maybe a guided tour. I'm honestly not sure
> what's broken.

**Assert after this turn**:

- [ ] **R1**: the first reply states the depth `interview` with a one-line
      reason (the problem isn't settled), and names how to overrule it.
- [ ] The opener surfaces the silent assumptions and states the destination,
      then asks **one** question with a recommended answer.
- [ ] The gate scoreboard prints (`Gates: n/5 ready — open: …`).
- [ ] No file is written yet: the plan is written only when no gate can move.

### Turn 2: a partial answer

> Most drop-off is between signing up and creating a first project. Support
> tickets say people don't know what a project is.

**Assert after this turn**:

- [ ] The scoreboard prints and reflects what moved (Problem Clarity, likely).
- [ ] The next question chains from this answer.

### Turn 3: the overrule

> short plan

**Assert after this turn**:

- [ ] **R2**: it switches to `short plan` at once, says so in one line, and
      names once what is skipped (the gates still without evidence), without
      arguing.
- [ ] The short plan carries turn 2's answer as evidence, and its
      `stoppedEarly` names the gates that weren't interviewed.

## Passing

All assertions hold. Failures this case catches: too little planning on an
ambiguous change (risk 10), an interview that writes files before its gates
stop moving, and a downward overrule that silently drops the gate evidence.
