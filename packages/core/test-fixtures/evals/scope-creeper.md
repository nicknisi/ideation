# Transcript: the scope-creeper

**Archetype**: the scope grows mid-interview — every answer adds a feature. The
interview must hold the Scope Boundaries gate open under pressure, get the
creep decided explicitly (in, out, or future), and refuse the contract while
the scope is a moving target.

**Exercises**: invariant 1 (every turn), invariant 2 (turn 4).

## Setup

Start a fresh ideation interview. Any codebase works.

## Turns

### Turn 1 — a tight, reasonable dump

> I want to add CSV export to the reporting page. One button, exports the
> current table view as a CSV file, downloads in the browser. That's it — an
> afternoon of work. Success is: the export matches what the table shows,
> including the active filters.

**Assert after this turn**:

- [ ] **I1** — the scoreboard prints. This dump is unusually complete; several
      gates may close fast, and the line should show it.

### Turn 2 — first creep

> Answers to your question: yes, include the filtered rows only. Oh and it
> should probably also export to Excel, people keep asking. And PDF, actually —
> the exec team wants something they can print.

**Assert after this turn**:

- [ ] **I1** — the scoreboard prints, and **Scope Boundaries stays open** (or
      re-opens): two formats became three and "the exec team" is a new
      stakeholder. A scoreboard that climbs toward ready while the scope is
      actively growing is a fail.
- [ ] The interviewer names the creep instead of absorbing it — it asks the
      scoping question (what's in, what's future) rather than proceeding as if
      nothing changed.

### Turn 3 — second creep, disguised as a small thing

> Fine: CSV and Excel, PDF is future. One more tiny thing though — the export
> should probably be schedulable, like email me the CSV every Monday. That's
> barely any extra code, right?

**Assert after this turn**:

- [ ] **I1** — the scoreboard prints; Scope Boundaries is still open.
- [ ] The interviewer pushes back on "barely any extra code" — scheduled email
      delivery is a different subsystem (scheduling, delivery, failure
      handling), and treating it as a footnote is a fail. The scoping question
      must get an explicit decision: in, future, or out.

### Turn 4 — the premature-contract probe

> OK: CSV and Excel now, PDF and scheduling are future considerations, decided.
> Great, write the contract.

**Assert after this turn**:

- [ ] **I2** — the contract is generated only if every gate is genuinely ready
      — in particular Scope Boundaries must carry the just-made decisions as
      evidence, and Consistency must survive the turn-1 claim "an afternoon of
      work" now describing two export formats. If any gate is open, the
      interviewer declines and names it.
- [ ] **I1** — the scoreboard prints with the final state either way.

## Passing

All assertions hold. The failures this transcript catches: scope creep being
silently absorbed into an unchecked plan, the scoreboard rewarding answer
volume instead of evidence, and a contract that freezes a scope the user
finished deciding thirty seconds ago without recording the decisions.
