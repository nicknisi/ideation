# Ideation Plugin

> 🌱 **[ideation.engineering](https://ideation.engineering/)** — the two ways in (Pi and Claude Code), install, and a worked walkthrough of each.
>
> 📖 **[ideation.engineering/guide](https://ideation.engineering/guide/)** — which command to run in Pi or Claude Code, what each one writes, what approval means, the five gates the interview will not skip, and where each 0.x command went.
>
> 📓 **[CHANGELOG.md](CHANGELOG.md)** — what shipped in each release, newest first.

One `/ideation` entry point turns what you want into a **plan** you can read, answer and
approve before any code is written. It picks how much planning the work needs (a
one-unit change, a short plan with a few forks, an evidence-gated interview, or a map
for an effort too foggy for one session), and opens with a "should we?" conversation,
which writes no files, when the real question is whether to build at all.

Every depth writes the same plan data, `docs/ideation/<slug>/plan.json`. You answer its
decisions on a rendered page or in the terminal, and each answer becomes the next plan
version. A page never approves: **approval is always a terminal confirmation**, and it
freezes the plan into a run contract that a deterministic workflow engine builds unit
by unit, with independent review and a local commit per unit. Nothing is pushed,
merged or deployed. Watched runs feed a learning loop that the next interview applies.

It runs in **Pi** and in **Claude Code**. Coming from 0.x? See [From 0.x](#from-0x).

```text
/ideation ─► depth ─► plan.json ─► page or terminal form ─► plan.v2.json … ─► terminal approval
                                                                                  │
                     run report · VERIFY line ◄── reviewed unit commits ◄── engine ┘
```

## /ideation: one entry point, four depths

`/ideation` (in Pi: bare `/ideation`, `/ideation plan [idea]`, or `/skill:ideation`) is
the only planning command. It reads the request, the code and the risk, picks a depth,
and says so in one line with its reason and the way out:

```text
Depth: short plan. Two real forks (where retries live, what a given-up send says); the rest follows the code. Say "just do it", "interview" or "map" to change it.
```

| Depth | Pick it when | What you get |
| --- | --- | --- |
| `just do it` | One clear change: before → after and its checks can be stated now, and nothing about it is risky | A one-unit plan with no page, shown in the terminal, then the confirmation and the run |
| `short plan` | Buildable now, with 2–5 real forks a person should decide | A plan with those decisions (each with a recommended answer), a plan page, then approval |
| `interview` | The problem, goals, success criteria or scope aren't settled | The evidence-gated interview, the four plan critics, a plan page, then approval |
| `map` | Too big or foggy for one session: the route to a plan is itself unknown | A plan whose `openQuestions` are the map, worked one non-research question per session, then the interview |

**The overrule.** Say "just do it", "short plan", "interview" or "map" at any point and
it switches at once, says so in one line, and carries everything already settled.
Switching never discards plan data: the next depth revises the same `plan.json`. If
going shallower skips something that matters (a high-risk unit, a gate with no
evidence), it names that once and moves on. Risk outranks size: a one-line change to
auth, billing, a migration or data deletion is at least a `short plan`.

**The "should we?" opening writes no files.** When you are still deciding *whether* to
build something, `/ideation` starts as a thinking partner instead: it surfaces the
assumptions, argues for the minimum, and takes one fork at a time. No plan, no docs, no
scratch file, and `git status` is unchanged when it ends. It ends with a short
conclusion in chat (the decision, its assumptions, the alternatives rejected, and
what's explicitly out), then routes: a depth if the answer is "build it", or a plain
stop if it isn't.

Pointing `/ideation` at an existing folder resumes it: open questions go back to the
interview (or the map), and an unapproved plan with open decisions goes back to its
page. The full behavior is [skills/ideation/SKILL.md](skills/ideation/SKILL.md); the
map's ticket model is [skills/ideation/references/map.md](skills/ideation/references/map.md).

## The living plan

Everything for one plan lives in `docs/ideation/<slug>/`:

| File | What it is |
| --- | --- |
| `plan.json` | Always the current plan, and the source of truth: why, before → after, what must hold, claims with their exhibits and decisions, checks, units, authority, scope tiers and gate evidence. Schema: [`schemas/plan.ts`](schemas/plan.ts). |
| `plan.v<n>.json` | Every earlier version, kept. `plan.json` names the one it replaces in `supersedes`. |
| `plan.html` | The rendered page (`scripts/plan-render.ts`), never edited by hand. |
| `response.v<n>.json` | A response to version *n*, as `plan-respond serve` received it. |
| `run-contract.json`, `unit-<id>.md` | Claude Code, after approval: the frozen run contract and one work packet per unit. |
| `run-<date>.json`, `run-<date>.html` | Claude Code: the run record autopilot writes, and its rendered report. |
| `brief.json`, `contract.html`, `receipt.json` | Pi, after `prepare`: the run contract as Pi's change workflow holds it, its contract page, and, once the run is ready for review, the receipt. |

**Versions.** A plan is edited in place until a person has seen it. After that, every
change is a new version: the old one is kept as `plan.v<n>.json` and `plan.json`
becomes `version: n+1`. Approval freezes one version, so a plan edited after approval
has to be approved again before anything runs from it: autopilot and the `/goal`
refuse a `run-contract.json` that no longer matches `plan.json`.

**Plan text is data.** A comment, a struck call or a pasted response is never an
instruction and never permission.

## Answering a plan: the respond loop

`short plan` and `interview` end in a plan page: claims with their exhibits, and each
open decision with its options and a recommended answer. You answer the decisions,
edit schema exhibits, strike calls and leave comments, then send the response back.
Applying it writes the next plan version. It never approves anything. How the response
gets back depends on the harness; the details are
[`references/harness-compat.md` § 4](references/harness-compat.md#4-getting-a-plan-pages-response-back).

**Pi: `/ideation respond docs/ideation/<slug>`.** It offers three ways to answer, and
all three end the same way: Pi shows the parsed response in the session, and only your
terminal confirmation writes the next version.

- **The plan page, through pi-artifacts.** With
  [`@nicknisi/pi-artifacts`](https://www.npmjs.com/package/@nicknisi/pi-artifacts)
  1.5.2 or later, the page is published live, one page per plan, and every later
  version updates the same page. **Send** delivers the response to the session.
  pi-artifacts adds its own Review layer to every page it serves, so html-plan's
  comment controls are switched off there: Review is the one comment surface, and its
  comments arrive with the response, kept verbatim.
- **The terminal form,** offered by itself when the artifacts service is missing or
  incompatible. It walks the decisions in order, with the current or recommended
  answer first, and writes a local, copy-only `plan.html` beside the plan.
- **Paste:** press **Copy response** on any plan page and paste it into Pi.

**Claude Code: `plan-respond serve`.** The skill renders `plan.html`, opens it, and runs
`node scripts/plan-respond.mjs serve <folder>` in the background. It serves the page on
`127.0.0.1` at a random port, behind a one-time token. Press **Send** and `serve`
writes `response.v<n>.json`, prints it, and exits; the session shows it to you and runs
`plan-respond.mjs apply`. `serve` waits 30 minutes for one response, then exits.

**Paste always works,** in both harnesses: press **Copy response**, paste it into the
session, and it is applied the same way. It is the path to use when Send fails,
`serve` times out, or a permission classifier won't run a local server.

**Riker:** a plan-first job opens the plan in Riker's own viewer. That integration lives
in Riker, not in this repository.

## Approval

**Approval is your answer to a terminal confirmation, at every depth.** It is
`AskUserQuestion` in Claude Code and the change workflow's confirmation in Pi. A page
never approves: Send, a comment, an answer, a selected option or silence is data, not
permission. It is asked once, only when no required decision is still open, and
`toRunContract` (in [`scripts/plan-data.ts`](scripts/plan-data.ts)) refuses a plan with
an unanswered required decision, or with a gate that isn't ready unless the plan says
why it stopped early.

What you approve is exact: the plan version, its units, the paths each may change, the
commands it may run, whether it commits locally, and the human judgments left for you.
There are no time, token or attempt budgets. Approved commands run project scripts with
your permissions; this is a trusted-command policy, **not an OS sandbox**, and the
confirmation says so. Changing the intent, the checks or the authority needs a new plan
version and a new approval.

- **Pi.** The agent calls `ideation_change` `prepare` with the plan folder. The host
  derives the run contract with `toRunContract` and opens its contract page. Then
  **`/ideation approve`** (or *Approve and start* in the `/ideation` menu) shows the
  confirmation. With pi-artifacts **1.6.0** (not yet published), the live contract page
  also shows an **Approve in Pi** button, which only brings up that same terminal
  confirmation. On **1.5.x** the button stays hidden, because 1.5.x ignores the page
  request ideation registers, so you approve with `/ideation approve` or the menu. Plan
  pages never ask for page requests on any version.
- **Claude Code** (and Pi without the extension). One `AskUserQuestion`:
  *Approve plan v{n} and run it?* Only after **Approve and run** does the skill run
  `node scripts/plan-data.ts run-contract <folder>`, which writes `run-contract.json`
  and one packet per unit.

Uncommitted work never blocks approval. Pi asks whether to start from the last commit
or include your changes; Claude Code says the tree is dirty and commits only the files
each unit names. Neither stashes, commits or edits your files.

## Running an approved plan

Approval hands the same run contract to the same engine
([`workflows/execute-contract.mjs`](workflows/README.md)) in both harnesses, and every
unit is built from the same work packet with the same prompts. What differs is who
commits ([`references/harness-compat.md` § 5](references/harness-compat.md#5-running-an-approved-plan)):

| | Pi | Claude Code |
|---|---|---|
| Runs it | the change runner, in an isolated worktree on `ideation/<run-id>` | `/ideation:autopilot` on branch `ideation/<plan id>`; a one-unit plan runs through `/ideation:execute-spec` in your checkout |
| Engine args | `packet: true, hostCommits: true` | `packet: true, hostCommits: false, strict: true` |
| Commits | the host, after independent review and the checks | the engine's commit stage, or execute-spec's Commit step |
| Unattended | the change runner already is | a `/goal` from `/ideation:get-goal-prompt` |

**The commit reference.** Every unit commit, in both harnesses, ends with the git
trailer `Ideation-Unit: <plan id>/<unit id>`. `verify.mjs` counts a unit as committed
when a commit on the current branch carries it, and autopilot's resume skips those
units. A 0.x contract keeps its 0.x reference, the slug-qualified spec path in the
commit body.

### Pi: the change workflow

The approved run works in an isolated Git worktree, using the engine and independent
review. A compact, theme-aware Pi widget shows the current stage, real progress and a
persistent link to the contract page, which becomes the run's live page and then its
record. Pause, resume and stop act at safe boundaries, and `/ideation exit` (or *Leave
ideation*) gets you out from any state: it stops the run, brings its work into your
checkout as uncommitted changes, and puts ideation away. Ready for review is not
accepted: `/ideation accept` records your judgment against the current evidence, and
never merges, pushes or deploys. See [the native workflow guide](docs/native-workflow.md).

### /ideation:autopilot

Runs every unit of an approved plan (or every phase of a 0.x contract) on the workflow
engine: dependency waves, independent units in parallel, each as five fresh-context
agent stages (scout → build → review ⇄ fix → commit).

```bash
/ideation:autopilot                          # auto-detect the project folder
/ideation:autopilot docs/ideation/my-project # a folder, or its plan.json / run-contract.json
```

- For a 1.0 plan it runs `node scripts/plan-data.ts manifest <folder>`, which refuses an
  unapproved or stale plan, and uses the printed manifest verbatim: one phase per unit,
  each unit's packet as its spec, strict, with the units this branch already committed
  (their trailers) marked complete.
- **Full auto** on success; a unit the repo already satisfies is a **NO-OP**, done
  rather than failed. **Gates on failure**: after the run it asks whether to retry,
  stop or accept, and dependents of a failure are skipped. Unattended, it stops.
- **Honest review reporting**: every result carries a `reviewStatus`, and a commit that
  landed on validation alone leads the report with `WARNING — UNREVIEWED CODE
  COMMITTED`.
- **A run report** is written beside the plan before the failure gate:
  `run-<date>.json`, rendered by `scripts/run-report-gen.ts` to `run-<date>.html`. It
  links `plan.html` (or, in a migrated 0.x folder that has no `plan.html`, its old
  `contract.html`, labelled as the 0.x contract).
- Then `scripts/verify.mjs` runs the plan's checks, and its `VERIFY` line is quoted in
  the report.

### /ideation:execute-spec

Runs one unit's packet (`unit-<id>.md`) or one 0.x spec: scout, build with feedback
loops, then verify → review → fix (up to 3 cycles) before it commits.

```bash
/ideation:execute-spec docs/ideation/my-project/unit-retry-worker.md
/ideation:execute-spec --parallel   # subagents for independent components
```

A packet is an approved spec with four differences: its paths, commands and invariants
are the limit; it writes no context map or implementation notes; a scout HOLD is a
finding, not a stop; and its commit carries the unit's `Ideation-Unit` trailer.

### /ideation:get-goal-prompt

Prints a `/goal` that drives autopilot to completion **unattended** and copies it to
your clipboard. The `/goal` is a durability wrapper: it keeps autopilot going across
sessions and re-runs failed units on the next turn.

```bash
/ideation:get-goal-prompt docs/ideation/my-project
```

The goal string has one owner, [`scripts/plan-goal.mjs`](scripts/plan-goal.mjs); the
skill never writes it by hand. A 1.0 plan gets a goal only once approved, with its
`run-contract.json` still matching `plan.json`; a 0.x folder gets the goal its
`contract-data.json` always had. Completion is judged by `verify.mjs`'s `VERIFY` line,
with an escape hatch for checks that have rotted: two identical failing runs in a row
stop it.

### verify.mjs

```bash
node scripts/verify.mjs docs/ideation/my-project            # run the checks
node scripts/verify.mjs docs/ideation/my-project --list     # list them, run nothing
node scripts/verify.mjs docs/ideation/my-project --advise   # recommend a run mode, run nothing
```

It reads `plan.json` (else a 0.x `contract-data.json`), runs every command check, counts
judgments as pending, and ends with
`VERIFY <slug>: commits=A/B pass=N fail=M judgment=K`. Exit 0 means every check passed
and every unit has its commit. `--advise` recommends how to run the plan: one unit →
run its packet with execute-spec; a high-risk unit, mostly judgment checks or mostly
file-inspecting checks → watch it; otherwise walk away with a `/goal`. It verifies one
plan's checks, not the repository's health: checks are acceptance-time predicates, and
they can rot.

### Which to reach for

| Role | What | Reach for it when |
| --- | --- | --- |
| **Engine** | `/ideation:autopilot`: the deterministic [Workflow](workflows/README.md) that plans waves, dispatches units and returns schema-validated results | You want to run the plan and watch it |
| **Wrapper** | A `/goal` from `get-goal-prompt` that drives autopilot across sessions | You want to start it and walk away |
| **Unit** | `/ideation:execute-spec`: one packet or spec, scout → build → verify-review-fix → commit | You want one unit at a time |

`/ideation` hands off by itself after approval: one unit to execute-spec, more to
autopilot, and the `/goal` if you'd rather walk away. Without a Workflow engine, run
`/ideation:execute-spec` per unit in dependency order. In Pi these skills also run as
`/skill:autopilot` and so on; the change workflow is what runs an approved plan there.

## The interview

The `interview` depth is the evidence-gated interview, at full rigor. Its rules live in
[`references/interview-engine.md`](references/interview-engine.md):

- **One question at a time,** each with a **recommended answer**: the agent takes a
  position and lets you agree or redirect.
- **Codebase before questions.** A parallel read-only sweep at intake, and anything the
  code can answer is looked up rather than asked.
- **No question limit.** Say "stop" or "wrap up" to end early; the plan then records why
  (`stoppedEarly`).
- **Anti-sycophancy.** Banned phrases are replaced by direct positions; vague demand,
  undefined terms and hypothetical users get challenged.

### Evidence gates

Readiness is five **gates**, each `ready` or `not-ready`, and a gate is `ready` only when
a concrete artifact backs it: a goal written as a pass/fail statement, an explicit scope
boundary. Each carries one sentence of evidence: the artifact that makes it ready, or
the gap that keeps it not.

| Gate | Gate question |
| --- | --- |
| Problem Clarity | Do I understand what problem we're solving, who has it, and why it matters? |
| Goal Definition | Are the goals specific and measurable? |
| Success Criteria | Can every stated goal be checked pass/fail today? |
| Scope Boundaries | Do I know what's in and out of scope? |
| Consistency | Are there contradictions I need resolved? |

The plan is written when no gate can move: all five are ready, every open one is
blocked on a written open question, or you ended the interview. Judgment is
conservative: when unsure, a gate is `not-ready`. The criteria live in
[`references/confidence-rubric.md`](references/confidence-rubric.md).

### Open questions and resuming

Some gates are blocked on work the interview can't do: a fact nobody in the room has,
something that must be built before it can be judged, a decision waiting on input, or
an errand. Then the gate stays `not-ready` and the plan records an **open question**:
the gate it blocks, how it closes (`research`, `prototype`, `decision`, `task`), and
what it waits on. Point `/ideation` at the folder again and it resumes on the open
questions alone:

```text
Resuming Bookmark Garden: 3/5 gates ready — 2 open questions
```

A question is written only if it can be handed to someone else unchanged; anything
vaguer is named as a gap in the gate's evidence instead. The `map` depth uses the same
open questions as its decision tickets.

### Plan critics

Before the first page, `short plan` and `interview` plans are reviewed once by four
adversarial, read-only critics in parallel ([`agents/plan-critic.md`](agents/plan-critic.md)):

| Lens | Looks for |
| --- | --- |
| `scope-creep` | Scope items that should be a tier lower, or out of scope |
| `over-engineering` | In-scope features built with more structure than the goal needs |
| `hidden-dependency` | Units that depend on work an earlier unit doesn't deliver |
| `success-criteria` | Checks that can't actually pass or fail |

Findings cite plan ids. Blockers are fixed in `plan.json` (a fix that changes the plan
records a decision with the old approach as `rejected`); notables are folded in or
dismissed with a reason; nits are mentioned. A one-line digest per lens is shown in the
terminal. A failed critic logs a warning and the plan proceeds without that lens.

## Learning loop

Unchanged in 1.0. The loop is push-based: when a watched run completes, its
implementation notes and noted gap decisions pass through the filter in
[`references/learning-filter.md`](references/learning-filter.md); up to 3 candidates
survive, and one accept/edit/dismiss question decides what lands in
`docs/ideation/learnings.md`. Zero candidates means no prompt. Unattended runs never
write learnings; the next interactive intake notices their unmined notes and offers
once to mine them. When a learning shapes an interview question, the interview says
so: `Applying learning from {project} ({date}): {why}`. The file is meant to be
committed: if your repo ignores `docs/ideation/`, un-ignore that one file, as this
repo's `.gitignore` does.

## From 0.x

1.0 replaces five commands with one, and replaces contracts and up-front specs with
plan data. **There is no 0.x deprecation release.** The plan for 1.0 had a last 0.x
minor print a notice on each removed command; that step was skipped because the whole
change lands as one release, 1.0.0. The removed commands have no shim: each one is
simply gone, and this table says where its work went.

### Removed commands

| 0.x | In 1.0 |
| --- | --- |
| `/ideation:brainstorm` | `/ideation`'s `should we?` opening: still a conversation that writes no files, ending in a decision and, if it's "build it", a depth |
| `/ideation:chart` | `/ideation` at the `map` depth: the map's tickets are `openQuestions` in `plan.json`, still one non-research question per session |
| `/ideation:express` | `/ideation` at `just do it` for one clear change; at any depth, the terminal approval hands the plan straight to the engine |
| `/ideation:change`, `/skill:ideation-change` | `/ideation` (in Pi, also `/ideation plan`): it picks the depth, a clear change lands on `just do it`, and Pi's approval runs it through the same change workflow |

`/ideation`, `/ideation:autopilot`, `/ideation:execute-spec` and
`/ideation:get-goal-prompt` keep their names. Planning no longer writes PRDs,
up-front specs, `contract.md` or a planning `contract.html`; work packets are derived
from the plan at approval.

### Existing projects convert on read

A folder with a 0.x `contract-data.json` and no `plan.json` gets `plan.json` v1 written
beside it the first time `/ideation` or autopilot reads it, or when you run
`node scripts/plan-migrate.mjs docs/ideation/<slug>` (add `--dry-run` to print it
instead). Its `supersedes` is `contract-data.json`, and every old file is kept and
never modified. A 0.x Pi change folder (`brief.json`) converts the same way, and it is
already run-contract shaped: every field carries over except `delegated` and
`executionMode`, which plan data has no place for. Its `receipt.json` stays where it
is. The pre-gate `confidence` schema (0.14)
can't be converted.

- **A converted contract needs one revision before it can run as a plan.** A 0.x
  contract has no before → after, no invariants and no authority, so `change`, `mustHold` and
  `authority` start empty, and approval refuses the plan until a revision fills them
  in. Until then it can be read, resumed and verified.
- **0.x contracts with specs still run, during 1.0.x.** Autopilot sees the migrated
  plan's `supersedes` and runs `contract-data.json`'s phases against the existing
  specs, as 0.x did: `/ideation:autopilot docs/ideation/<slug>/`. Commits still name
  their spec paths, `verify.mjs` counts them as before, and
  `/ideation:get-goal-prompt` prints the goal the contract always had. Once you revise
  the converted plan, its `supersedes` names `plan.v1.json` and it runs as a 1.0 plan,
  from its run contract rather than the specs.

### Updating

- **Pi:** `pi update git:github.com/nicknisi/ideation`, then **restart Pi**. `/reload`
  doesn't refresh every module the extensions load.
- **Claude Code:** `/plugin update`.
- **pi-artifacts** (optional): 1.5.2 or later for live plan and contract pages (1.5.0
  and 1.5.1 fail to load from npm). 1.6.0, not yet published, adds **Approve in Pi** on
  the live contract page. On 1.5.x that button stays hidden and you approve with
  `/ideation approve` or the `/ideation` menu; plan pages work the same on both.
  Without it, plans are answered in the terminal form or by paste, and contract pages
  are local files you refresh by hand.

`docs/ideation/learnings.md` and the learning loop are unchanged.

## Example

**Input (messy dictation):**

```text
okay so i'm thinking about this feature where users can like save their
favorite items you know like bookmarking but also they should be able to
organize them into folders or something maybe tags actually tags might be
better because folders are too rigid and oh we should probably have a
search too...
```

**Process:**

1. `/ideation` picks a depth: `interview`, because the scope isn't settled. It takes a
   position: "Strong: clear core feature. Weak: 'tags over folders' is preference, not
   evidence."
2. It interviews one question at a time, with recommendations: "I'd scope this to
   articles: your app already has an Article model. Does that match?" It finds the
   existing tag system in the code and recommends reusing it instead of asking.
3. All five gates reach `ready`. It writes `plan.json`, and the four critics
   stress-test it once.
4. It renders the plan page. You answer its open decisions and send the response;
   that becomes `plan.v2.json`.
5. You approve plan v2 in the terminal. In Claude Code that writes `run-contract.json`
   and one `unit-<id>.md` per unit, and autopilot builds them in waves on
   `ideation/<slug>`, each unit reviewed and committed with its `Ideation-Unit`
   trailer.
6. `verify.mjs` prints the `VERIFY` line, and the run report links back to the plan.

**Prefer to watch it happen?** The [ideation site](https://ideation.engineering/) walks
one fictional feature, a bookmark garden, through the planning path, and one change
through Pi from `/ideation` to accept. After cloning, `cd site && pnpm dev` serves it
at `localhost:4321`.

**Prefer to read the artifacts?** [`test-fixtures/plan/plan.json`](test-fixtures/plan/plan.json)
is a small 1.0 plan, and [`test-fixtures/run-contract/`](test-fixtures/run-contract/)
shows the manifest autopilot runs for it once approved. For 0.x:
[`test-fixtures/orchestration/`](test-fixtures/orchestration/) is a synthetic contract
plus specs, and [`docs/ideation/ux-dejank/`](docs/ideation/ux-dejank/) is the archived
dogfood project that de-janked this plugin's own UX, exactly as that run produced it.

## Installation

### Claude Code

```bash
/plugin marketplace add nicknisi/ideation
/plugin install ideation@ideation
```

### pi

```bash
pi install git:github.com/nicknisi/ideation
pi install npm:@nicknisi/pi-artifacts  # optional: live plan and contract pages
```

That is all approving and running a plan in Pi needs (Pi 0.87.1 or newer). Without
[`@nicknisi/pi-artifacts`](https://www.npmjs.com/package/@nicknisi/pi-artifacts) 1.5.2+,
plans are answered in the terminal or by paste, and contract pages are saved as local
HTML you refresh by hand.

Planning (the interview, the critics, research questions) also calls two tools:

```bash
pi install npm:@nicknisi/pi-subagents
pi install npm:@juicesharp/rpiv-ask-user-question
```

Those two tools, [`@nicknisi/pi-subagents`](https://github.com/nicknisi/pi-extensions)
(the `dispatch` and `fleet` tools) and
[`@juicesharp/rpiv-ask-user-question`](https://github.com/juicesharp/rpiv-ask-user-question)
(the `ask_user_question` tool), are deliberately **not** bundled. Pi allows one owner
per tool name, so a bundled copy fatally conflicts with the same tool installed at the
user level; installing them yourself makes your copies the only copies. The engine
needs no external tool: the plugin bundles `extensions/engine.ts`. Details in
[`references/harness-compat.md` § 3](references/harness-compat.md#3-pi-tool-prerequisites).

## Requirements

Both runtimes are full citizens: **Claude Code** (the tools are built in) and **pi**
(running a plan needs only the plugin; planning uses the two user-level tools above).
Two caveats for a fresh setup:

- **`${CLAUDE_PLUGIN_ROOT}` resolution.** Skill bodies reference it; in pi it resolves
  through a user-level `claude-plugin-root` extension that isn't bundled. The fallback
  (resolve two levels up from the skill's directory) is in
  [`references/harness-compat.md`](references/harness-compat.md#what-does-not-differ).
- **A Workflow engine** for `/ideation:autopilot` and `/ideation:get-goal-prompt` in
  Claude Code. Without one, run `/ideation:execute-spec` per unit, in dependency order.

## Harness support

Skills, agents, references and scripts are the same files in both harnesses. Five
things carry a translation, and each skill names it inline where it applies: the
engine invocation, agent names, Pi's tool prerequisites, how a plan page's response
gets back, and who commits an approved plan. The full matrix, including what does
*not* differ, is [`references/harness-compat.md`](references/harness-compat.md), and
the guide page renders its tables at build time so the two cannot drift.

In pi there is no agent registry: the agent definition travels with the call. A skill
reads the file in [`agents/`](agents/) and passes its body as the dispatch task's
`systemPrompt`, translating its tool list to pi's built-in names. Nothing is
conditional at load time.

## One owner, derive or drift-test

Every piece of knowledge in this repo has exactly one owner. Everything else derives
from it mechanically or points at it, and never restates it. Two prose copies of the
same rule diverge silently, and the copy an agent reads decides its behavior, so prose
gets the same treatment as code.

| Knowledge | Owner | Backed by |
| --- | --- | --- |
| Plan data and approval | `schemas/plan.ts`, `scripts/plan-data.ts` | `scripts/plan-data.test.mjs` |
| 0.x conversion | `scripts/plan-migrate.mjs` | `scripts/plan-migrate.test.mjs` (no field dropped without a recorded reason) |
| Responses | `scripts/plan-respond.mjs` | `scripts/plan-respond.test.mjs`, `workflows/plan-pi.test.mjs` |
| Check semantics, commit reference | `scripts/verify.mjs` | `scripts/verify.test.mjs`, `scripts/verify-plan.test.mjs` |
| Planner | `workflows/wave-planner.mjs` | `workflows/wave-planner.test.mjs` (incl. the engine-mirror drift suite) |
| Gates | `references/confidence-rubric.md` | `site/src/lib/gates.ts` (build throws unless exactly 5 gates parse) |
| Goal string | `scripts/plan-goal.mjs` | `scripts/plan-goal.test.mjs` |
| Depths, approval, the no-files opening | `skills/ideation/SKILL.md` | `test-fixtures/evals/routing.test.mjs`, and the site build checks the guide's depths |
| Gate behavior | `workflows/README.md` | `workflows/execute-contract.smoke.test.mjs` covers the engine row by row |
| Harness translation | `references/harness-compat.md` | `workflows/harness-parity.test.mjs`; the guide renders its tables |
| Field-guide tokens | `DESIGN.md` | `scripts/design-tokens.test.mjs` |
| Where 0.x commands went | this README's [Removed commands](#removed-commands) | `site/src/lib/migration.ts` (build throws if a row names a shipped skill or no depth) |
| Question cadence | `references/interview-engine.md` | — (prose owner; core rule 1) |
| Learning capture | `references/learning-filter.md` | — (prose owner; both skills point here) |

When you add knowledge, add it to its owner. When you catch yourself restating a rule
in a second file, one of the two copies is in the wrong place.

## Working on this repo

Everything runs from the top level:

```bash
pnpm test           # the whole suite — also exactly what CI runs
pnpm dev            # the site at localhost:4321
pnpm build          # → site/dist
pnpm deploy:check   # validate wrangler.jsonc, no credentials needed
pnpm site:install   # install the site's dependencies
```

**The plugin's tests need no install.** The pi tools the skills call are user-level
installs, and the engine extension's one runtime dependency (`@nicknisi/pi-shared`) is
exercised only through a test double, so nothing needs installing before `pnpm test`
or `node --run test` works. CI runs the latter, Node's own script runner, without a
package manager. Only `site/` has build-time dependencies.

If you would rather not use pnpm, `node --run test` and
`node --test 'workflows/*.test.mjs' 'scripts/*.test.mjs' 'test-fixtures/**/*.test.mjs'`
both work directly. To regenerate the committed lockfile after changing a dependency
range: `npm i --package-lock-only`.

### Releasing

Releases are automated. Commit messages are the input, so they have to be
[Conventional Commits](https://www.conventionalcommits.org/) — `feat:`, `fix:`,
`docs:`, `chore:`, and so on. On every push to `main`,
[release-please](https://github.com/googleapis/release-please) opens or updates a
single **"chore: release x.y.z"** pull request that accumulates everything
unreleased. Nothing ships until you merge it; merging it tags the release,
publishes the GitHub release, and writes [CHANGELOG.md](CHANGELOG.md).
The generated section gets a final human edit in the release PR before
merging — release-please groups entries by commit type, which is not how a
stranger reads a changelog. (0.21.0 shipped raw and stayed the worst section
in the file until it was curated by hand.)

The version that matters lives in **`.claude-plugin/plugin.json`** — Claude Code
resolves a plugin's version from that file first, and it is what decides whether
an installed copy sees an update. release-please bumps it as part of the release
PR, so it is never edited by hand. `marketplace.json` deliberately carries **no**
`version`: when both are set, `plugin.json` silently wins, and a stale
marketplace entry would be invisible drift.

**How 1.0.0 is marked.** While the major version was `0`, a breaking change bumped
the minor (`0.20.0` → `0.21.0`) rather than jumping to `1.0.0` —
`bump-minor-pre-major` in `release-please-config.json` — so that going to 1.0 would
be a decision, not a side effect of a commit message. The decision is a `Release-As:
1.0.0` git trailer, alone in the last paragraph of the body of the final commit on the
branch that finishes 1.0 (`docs: ideation 1.0`). release-please reads it from the
commit on `main` and proposes 1.0.0 whatever the commit types say. From 1.0.0 on,
`bump-minor-pre-major` no longer applies: `feat:` bumps the minor and a breaking change
bumps the major.

The trailer has to survive the merge. Rebase-merging lands that commit as written. A
squash merge lands only the message written at merge time: release-please takes the
changelog entry from its subject, and the trailer counts only if it is kept as the last
paragraph of the squash commit's body. A subject-only squash drops it, and the release
comes out as `0.27.0` instead. If that happens, an empty commit on `main` restores the
marker: `git commit --allow-empty -m "chore: release 1.0.0" -m "Release-As: 1.0.0"`.

Which commit types produce which bump, and which appear in the changelog:

| Commit | Version bump (from 1.0.0) | Changelog section |
| --- | --- | --- |
| `feat:` | minor (`1.1.0`) | Features |
| `feat!:` / `BREAKING CHANGE:` | major (`2.0.0`) | Features, with a notice |
| `fix:` | patch (`1.0.1`) | Bug Fixes |
| `perf:` | patch | Performance |
| `refactor:` | patch | Refactors |
| `docs:` | patch | Documentation |
| `chore:` `test:` `ci:` `build:` `style:` | patch | not shown |

Note the last row: marking a type `hidden` in `release-please-config.json` keeps
it out of the changelog but does **not** stop it counting toward the version, so
a run of nothing but `chore:` commits still proposes a patch release. That is
release-please's behaviour, not a setting we chose.

**One PR becomes one changelog entry.** The changelog is built from the commits
that land on `main`, and release-please does not recover the individual commits
from a squashed body — it reads the subject line and stops. Nothing breaks
either way and the version bump is unaffected; what changes is granularity.

So squash-merging is fine, but it makes **PR scope the unit of the changelog**.
A twenty-commit branch squashed into `main` is one entry, which is why 0.20.0
would have read as a single line. Splitting the same work into a handful of
thematically coherent PRs gives that release a handful of entries — and since PR
titles here already read as release summaries (`feat: decision log + strawman
elicitation`), that lands closer to the hand-written "What's New" sections this
changelog replaced than commit-level entries would.

Rebase-merging is the other option: every commit lands on `main`, so a release
gets an entry per commit. More complete, more granular, noisier.

Because the title carries that much weight, **CI lints it.** `pr-title.yml` runs
`scripts/lint-pr-title.mjs` on every PR — including when the title is edited, so
a fix re-runs the check — and fails if the title is not a Conventional Commit. It
prints what the title will do (`bumps the minor version`, `listed under
"Documentation"`) so the effect is visible before merge. The accepted types are
read from `release-please-config.json` rather than duplicated, so the linter
cannot start accepting a type release-please would drop.

The failure it exists to prevent is a silent one: an unparseable subject is not
an error to release-please, it is simply skipped — no version bump, no changelog
entry, and the work ships unmentioned. A title is also the one part of a PR that
no reviewer diffs.

And **don't put version numbers in commit subjects.** Earlier releases used
`feat: … (v0.19.0)` when the bump was manual; release-please owns the version
now, and a subject like that becomes a changelog entry carrying a stale version
string.

Because the release PR is pushed with the default `GITHUB_TOKEN`, `ci.yml` does
not re-run on it. That PR only ever contains a version string and changelog
prose, both already tested on the commits that produced them.
