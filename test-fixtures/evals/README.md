# Scenario eval fixture

Recorded transcripts for replaying through `/ideation`, each with the
behavioral-invariant checklist it asserts. Two sets:

- **Interview transcripts** (three): brain dumps replayed through the
  `interview` depth. They cover the three archetypes the codebase pride report
  named — the messy dump, the settled decision, the scope-creeper — and the
  invariants are the behaviors that make the interview an interview rather than
  a form.
- **Routing cases** (five): one request per route, asserting that `/ideation`
  picks the expected depth, says why in one line, and switches when the user
  overrules it in a word. One of them guards the "should we?" opening's
  no-files rule.

## Why transcripts + a manual checklist, not an automated harness

The invariants assert **model behavior, not code**: whether the scoreboard
prints each turn, whether the plan is refused while gates are open, whether
the prototype spike is offered on the unanswerable question and withheld on the
testable one, whether a depth was picked for the right reason. A scripted
driver (subagent or CLI) can feed the turns, but its assertions would be a
second model grading the first — a trustworthy "did the interview offer the
spike here?" needs a reader, and a grep for the spike's wording false-passes on
a quote and false-fails on a paraphrase. Automation was considered and rejected
for v1: the checklist below is the honest assertion. Revisit only if a driver
can assert these invariants without judging prose.

One test does run under `npm test`: `routing.test.mjs` checks the routing
cases' **structure** only. Every case names an expected depth from the skill's
own vocabulary (the table under *Pick the depth* in `skills/ideation/SKILL.md`),
every depth and the opening has a case, every case carries R1 and R2 and an
overrule to a different depth, the opening's case carries R3, and the skill
states the opening's no-files rule as a heading. It reads no model output and
judges no prose.

## How to run an eval

1. Start `/ideation` in either harness with the transcript's first turn. For an
   interview transcript, if it picks another depth, overrule it with
   "interview" and note that beside turn 1.
2. Feed the transcript's user turns **verbatim, one turn at a time**. Answer
   the interviewer's questions only with the scripted follow-ups; if it asks
   something no scripted turn answers, pick the closest turn and note the
   deviation beside the assertion it affects.
3. After each turn, check that turn's assertions in the transcript. An
   assertion fails the eval — record the run date, the harness, and which
   invariant broke before changing either the prompts or the transcript.
4. The eval passes when every assertion in the transcript holds. There is no
   partial pass: these are invariants, not vibes.

## The interview invariants

| # | Invariant | Source |
| --- | --- | --- |
| 1 | **Scoreboard every turn** — after each answered question the interview prints `Gates: {n}/5 ready — open: {labels}`; never two turns without one | `references/interview-engine.md` § Gate tracking |
| 2 | **Plan refused before gates close** — asked to "just write the contract" (or the plan) with gates open, the interview declines and names the open gates instead | `skills/ideation/SKILL.md`, the interview depth (the plan is written only when no gate can move) |
| 3 | **Spike on the unanswerable, never on the testable** — a "we won't know until we build it" question gets the prototype-spike offer; a question a test against existing code settles gets the write-the-test move and **no** spike offer | `references/interview-engine.md` § When to suggest a prototype |

Each transcript names which invariants it exercises; invariant 1 is asserted on
every turn of every transcript.

## The interview transcripts

- [`messy-dump.md`](messy-dump.md) — unstructured, self-contradictory dump;
  probes invariants 1 and 2.
- [`settled-decision.md`](settled-decision.md) — the decision is already made;
  probes invariants 1 and 3 (both spike legs).
- [`scope-creeper.md`](scope-creeper.md) — the scope grows mid-interview;
  probes invariants 1 and 2, plus the scope gate staying open under pressure.

## The routing invariants

| # | Invariant | Source |
| --- | --- | --- |
| R1 | **Depth stated with a one-line reason** — the first reply names the expected depth (or the opening), gives its reason in one line, and names the way out | `skills/ideation/SKILL.md` § Pick the depth |
| R2 | **A one-word overrule switches depth** — "just do it", "short plan", "interview" or "map" switches at once, in one line, carrying what was settled, without arguing | `skills/ideation/SKILL.md` § Pick the depth (the overrule) |
| R3 | **The opening writes no files** — when the "should we?" opening ends, `git status --porcelain` prints nothing and `docs/ideation/` does not exist | `skills/ideation/SKILL.md`, the opening's no-files rule |

Each case states its **Expected depth** and its **Overrule** (the one word and
the depth it must switch to) at the top.

## The routing cases

- [`route-just-do-it.md`](route-just-do-it.md) — a one-line fix → `just do it`.
- [`route-short-plan.md`](route-short-plan.md) — a feature with three forks →
  `short plan`.
- [`route-interview.md`](route-interview.md) — an ambiguous initiative →
  `interview`.
- [`route-map.md`](route-map.md) — a multi-session effort whose route is fog →
  `map`.
- [`route-should-we.md`](route-should-we.md) — "should I even build X?" → the
  `should we?` opening, which writes no files (R3).
