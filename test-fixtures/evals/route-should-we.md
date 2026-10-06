# Routing case: "should I even build X?"

**Expected depth**: `should we?`

**Overrule**: "short plan" → `short plan`

**Exercises**: R1 (turn 1), R3 (turn 3), R2 (the overrule variant).

## Setup

A scratch git repository with at least one commit, a clean working tree, and
**no** `docs/ideation/` directory. Record `git status --porcelain` (empty)
before turn 1. Start `/ideation` with turn 1 as its argument.

## Turns

### Turn 1: the request

> Should I even build a plugin marketplace for this app? I'm not sure anyone
> would use it, and it feels like a lot.

**Assert after this turn**:

- [ ] **R1**: the first reply states the `should we?` opening with a one-line
      reason (the question is whether, not how), and names the depths that
      would follow.
- [ ] It surfaces the silent assumptions and takes a position. No gate
      scoreboard, no intake sweep.
- [ ] Any lookup uses `Read`/`Glob`/`Grep` or a read-only Explore agent. No
      `Write`, `Edit` or `Bash` call is made.

### Turn 2: the evidence

> Two customers asked for it. Each would write one plugin, for their own use.

**Assert after this turn**:

- [ ] It argues for the minimum (two known plugins don't need a marketplace)
      until the user names a goal that justifies more.
- [ ] Still no `Write`, `Edit` or `Bash` call.

### Turn 3: the conclusion

> Fine. Then no, not a marketplace.

**Assert after this turn**:

- [ ] It states the conclusion in chat in four parts (the decision, its
      assumptions, the alternatives rejected, what's explicitly out), then
      stops. It doesn't start a depth.
- [ ] **R3**: no files were written. `git status --porcelain` prints nothing,
      and `test ! -e docs/ideation` succeeds.

### Overrule variant: replay turn 1, then

> short plan

**Assert after this turn**:

- [ ] **R2**: it ends the opening, switches to `short plan` in one line, and
      carries what the opening settled. Only from here may files appear, under
      `docs/ideation/<slug>/`.

## Passing

All assertions hold. This case is the guard for the opening's no-files rule:
in 0.x `allowed-tools` enforced it, and in 1.0 only the skill's rule does. A
single file written before the user picks a depth fails the case.
