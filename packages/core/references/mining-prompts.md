# Mining Prompts

Single source for the shared mining-front-door prompt text. Both ports quote
these bodies verbatim: the pi port's `workflows/mining.js` loads this file at
runtime and interpolates it, and the Claude Code branch of
`references/interview-engine.md` § *Mine first (pi front door)* quotes the same
sections into its conversational flow. `test-fixtures/mining/prompt-drift.test.mjs`
asserts the three locations agree; a one-sided edit fails the build.

Each prompt body lives between a `<!-- prompt:NAME -->` / `<!-- /prompt:NAME -->`
pair so every consumer extracts the same bytes. The delimiters are HTML comments
and never render. Interpolation placeholders are doubled braces:

- `{{brief}}` — the problem / scope / constraints brief.
- `{{letter}}` — the candidate's letter (A, B, C).
- `{{scout}}` — the read-only scout pass output.
- `{{candidates}}` — the practical candidates, labelled and joined.
- `{{grail}}` — the holy-grail pass output.

Do not edit a body here without syncing the same bytes into `interview-engine.md`;
the drift test is the guard because prose drift is otherwise silent.

## Scout

<!-- prompt:scout -->
Ground the problem area in the ACTUAL code, read-only. Do not propose a
solution — map the terrain a solution would live in.

{{brief}}

Report: the files, modules, and existing patterns a change here would touch;
what already exists that could be extended or reused; and any constraint the
code imposes that the brief does not mention. Cite paths. Read only.
<!-- /prompt:scout -->

## Candidate

<!-- prompt:candidate -->
Propose ONE practical candidate solution (candidate {{letter}}) for the
problem below, grounded in the codebase map that follows. Practical means
buildable now, within our own code, without upstream changes to code we do not
own.

{{brief}}

--- Codebase map (read-only scout pass) ---
{{scout}}
--- end map ---

Return a short paragraph: the approach, what it touches, and why it is a
sensible practical option. One candidate only.
<!-- /prompt:candidate -->

## Holy grail

<!-- prompt:grail -->
Propose the HOLY-GRAIL solution for the problem below: the best possible
outcome ignoring effort and current constraints. Do not curb yourself to what
is buildable now — that is the advisor's job. Name the upstream or external
changes it would require if any.

{{brief}}

--- Codebase map (read-only scout pass) ---
{{scout}}
--- end map ---

Return a short paragraph.
<!-- /prompt:grail -->

## Advisor

<!-- prompt:advisor -->
You are the mining advisor. Rank the options below for PRACTICALITY and
SIMPLICITY, recommend exactly one, and declare your ignorance.

{{brief}}

--- Practical candidates ---
{{candidates}}

--- Holy grail ---
{{grail}}
--- end options ---

Rules:
- Curb any option that needs upstream changes to code we do not own: keep it in
  the list but mark its gist "UNIMPLEMENTABLE NOW — <why>" and never recommend
  it.
- Recommend the simplest option that actually solves the problem.
- Declare your ignorance: list every question you CANNOT answer from the code —
  goals, priorities, taste, success criteria. Tag each with the evidence gate
  it blocks (problem | goals | criteria | scope | consistency) and say why the
  code cannot answer it. An empty list is legal only when the code genuinely
  answers everything, which is rare.

Return JSON matching the provided schema:
{ options: [{id, title, gist}], recommended, why,
  rejections: [{id, reason}],
  ignorance: [{question, gate, whyNotAnswerable}] }
<!-- /prompt:advisor -->
