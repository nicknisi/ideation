# Open questions fixture

A synthetic ideation project that exercises the `openQuestions` renderers in
`../../scripts/contract-gen.ts` (`buildOpenQuestions` for HTML,
`mdOpenQuestions` for Markdown). The content is throwaway; the **shape** is the
point.

## Why this is not part of the orchestration fixture

`../orchestration/contract-data.json` is `Approved` with all five gates `ready`.
An open question is, by definition, the reason a gate did **not** close
(`../../references/interview-engine.md`, "When a gate is blocked on work outside
the interview"), so those two states cannot coexist. Putting open questions there
would make the repo's only example of the shape teach the one combination the
design forbids, and `graph.test.mjs` plus `wave-planner.test.mjs` both assert on
that file, so relaxing its gates to make the shape legal is not available either.

So this fixture is `Draft`, with four gates `not-ready`, each naming the question
that blocks it.

## What each entry covers

| id | type | blocking shape |
| --- | --- | --- |
| `runtime-step-timeout` | `research` | takeable now, no `blockedBy` |
| `resume-line-readability` | `prototype` | takeable now, no `blockedBy` |
| `exit-code-vs-crash` | `task` | blocked by one entry |
| `skip-vs-fail-accounting` | `decision` | blocked by two present entries **and one stale id** |

The stale id (`already-closed-elsewhere`) is the load-bearing part. The interview
engine drops a question from the array when it closes and never scrubs that id
out of the entries pointing at it, so a `blockedBy` naming something absent is
the normal steady state rather than corrupt data. Both renderers resolve
`blockedBy` against the ids actually present (`stillBlocking`), which is what
keeps a question whose blockers have all closed from rendering as still blocked.

Delete the stale id and the fixture stops testing the only case that regresses
silently.

## Running it

CI runs `verify.mjs` against this fixture rather than just rendering it, because
the fixture's own success criterion is what asserts the stale-id path:

```bash
node scripts/verify.mjs test-fixtures/open-questions/contract-data.json
```

`execution.phases` is deliberately empty. A Draft with open gates has no
execution plan yet, and phase wiring belongs to the orchestration fixture.
