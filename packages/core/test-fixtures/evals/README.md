# Scenario eval fixture

Three recorded brain-dump transcripts for replaying through the ideation
interview, plus the behavioral-invariant checklist each replay asserts. This is
the interview's regression set: the transcripts cover the three archetypes the
codebase pride report named — the messy dump, the settled decision, the
scope-creeper — and the invariants are the behaviors that make the interview an
interview rather than a form.

## Why transcripts + a manual checklist, not an automated harness

The invariants assert **model behavior, not code**: whether the scoreboard
prints each turn, whether the contract is refused while gates are open, whether
the prototype spike is offered on the unanswerable question and withheld on the
testable one. A scripted driver (subagent or CLI) can feed the turns, but its
assertions would be a second model grading the first — a trustworthy "did the
interview offer the spike here?" needs a reader, and a grep for the spike's
wording false-passes on a quote and false-fails on a paraphrase. Automation was
considered and rejected for v1: the checklist below is the honest assertion.
Revisit only if a driver can assert these three invariants without judging
prose.

## How to run an eval

1. Start a fresh ideation interview (`/ideation` in either harness — the
   invariants live in `references/interview-engine.md`, shared by both).
2. Feed the transcript's user turns **verbatim, one turn at a time**. Answer
   the interviewer's questions only with the scripted follow-ups; if it asks
   something no scripted turn answers, pick the closest turn and note the
   deviation beside the assertion it affects.
3. After each turn, check that turn's assertions in the transcript. An
   assertion fails the eval — record the run date, the harness, and which
   invariant broke before changing either the prompts or the transcript.
4. The eval passes when every assertion in the transcript holds. There is no
   partial pass: these are invariants, not vibes.

## The three invariants

| # | Invariant | Source |
| --- | --- | --- |
| 1 | **Scoreboard every turn** — after each answered question the interview prints `Gates: {n}/5 ready — open: {labels}`; never two turns without one | `references/interview-engine.md` § Gate tracking |
| 2 | **Contract refused before gates close** — asked to "just write the contract" with gates open, the interview declines and names the open gates instead | `skills/ideation/SKILL.md` Phase 3 (proceed only when all 5 ready) |
| 3 | **Spike on the unanswerable, never on the testable** — a "we won't know until we build it" question gets the prototype-spike offer; a question a test against existing code settles gets the write-the-test move and **no** spike offer | `references/interview-engine.md` § When to suggest a prototype |

Each transcript names which invariants it exercises; invariant 1 is asserted on
every turn of every transcript.

## The transcripts

- [`messy-dump.md`](messy-dump.md) — unstructured, self-contradictory dump;
  probes invariants 1 and 2.
- [`settled-decision.md`](settled-decision.md) — the decision is already made;
  probes invariants 1 and 3 (both spike legs).
- [`scope-creeper.md`](scope-creeper.md) — the scope grows mid-interview;
  probes invariants 1 and 2, plus the scope gate staying open under pressure.
