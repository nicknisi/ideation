---
name: ideation
description: "You MUST use this before building any new feature, planning a migration, designing a system, or turning a decided-on idea into a plan. Triggers on: feature requests, project ideas, brain dumps, 'help me plan,' 'spec this out,' 'interview me,' 'I want to build,' 'let's design,' or any unstructured idea you're ready to turn into code. Covers small single-spec projects through multi-phase initiatives. Runs a conversational interview, writes an interactive HTML contract, then generates implementation-ready Markdown specs. This is the planning-HOW stage: if the user is still deciding WHETHER to build — weighing options, pressure-testing a rough idea, 'should I…' — that's the lighter-weight /ideation:brainstorm skill, and ideation takes over once they've committed to build — its intake carries a brainstorm conclusion forward as starting evidence. Skip ONLY for well-defined implementation tasks (writing code to a known spec, fixing bugs, refactoring, explaining code)."
---

<what-to-do>

# Ideation

Transform unstructured brain dumps into implementation artifacts through a conversational interview that builds shared understanding before writing anything. HTML is for interactive decision-making (visualizations, comparisons, the contract); Markdown is for reference documents (specs, PRDs).

## Workflow

```
INTAKE → INTERVIEW LOOP → CONTRACT.HTML → PHASING → SPEC.MD GENERATION → HANDOFF
              ↓                  ↓             ↓             ↓                ↓
         Accept the mess    One question    Mission       Repeatable?      Phase track
                            at a time,      Brief with      ↓              + copy buttons
                            explore code    gates +      Template +        in contract
                            + show HTML     scope        per-phase
                            examples        tiers        deltas
```

## Phases 1-2: Interview

Read and follow `${CLAUDE_PLUGIN_ROOT}/references/interview-engine.md` for the full intake and interview loop; complete every phase there before Phase 3. Read `${CLAUDE_PLUGIN_ROOT}/references/confidence-rubric.md` for the evidence-gate criteria.

**Resumed project:** when the user points ideation at an existing `docs/ideation/{slug}/`, the engine's resume path runs ahead of the intake sweep (it decides which gates get interviewed at all): it reads persisted gate state and `openQuestions` from `contract-data.json`, leaves gates already `ready` alone, and interviews only the open questions whose blockers have closed. Each type dispatches to a move the engine already has: `research` to an `Agent` with `subagent_type: "Explore"` and never a question to the user, `prototype` to the spike, `decision` to an `AskUserQuestion` once the missing input exists, `task` to a checklist a human works through out of band. (Agent names differ by harness — see `${CLAUDE_PLUGIN_ROOT}/references/harness-compat.md` § 2.)

## Phase 3: Contract (HTML)

When no gate can move — all 5 `ready`, or every remaining gate blocked on a written open question (or the user ended the interview) — generate the contract. The all-ready path is the only one eligible for the express finish (step 7):

1. **Name the project yourself and say so** — the interview just produced the evidence for every gate, so the name is inferable; kebab-case it into the `slug`. State it in one line (`Calling this "{name}" → docs/ideation/{slug}/`) rather than asking. The user corrects it in passing if it's wrong, and a rename here costs one `git mv` before anything references the slug. Ask only when the brain dump genuinely covers two separable projects and the split decides what gets built.
2. Create `./docs/ideation/{slug}/`. (**Resumed project:** the slug and directory already exist. Reuse both, don't re-name the project, and let the generator's lineage rules handle the re-render: a Draft is replaced in place, an Approved contract is snapshotted to `contract-{date}.html` with the supersedes link set.)
3. **Write `contract-data.json`** there. The schema is the types in `${CLAUDE_PLUGIN_ROOT}/scripts/contract-gen.ts` — read them when unsure; the generator also validates at render time and rejects a malformed file naming the exact criterion, before writing anything. Minimal shape:

   ```json
   {
     "projectName": "Human-Readable Name",
     "slug": "kebab-case-name",
     "date": "YYYY-MM-DD",
     "status": "Draft",
     "gates": {
       "dimensions": [
         { "key": "problem", "label": "Problem Clarity", "status": "ready", "evidence": "One sentence citing the artifact" }
       ]
     },
     "problem": ["paragraph"],
     "goals": ["Measurable goal"],
     "successCriteria": [
       { "criterion": "Pass/fail criterion", "check": { "cmd": "npx vitest run src/auth", "expect": "exits 0" } },
       { "criterion": "Judgment-only criterion", "check": { "judgment": "who looks at what" } }
     ],
     "scope": {
       "mvp": [{ "item": "Core feature", "reason": "Why it's MVP" }],
       "outOfScope": [{ "item": "Excluded item", "reason": "Why excluded" }]
     },
     "decisions": [{ "decision": "What was chosen", "rejected": "The alternative", "reason": "Why it lost" }],
     "openQuestions": [{ "id": "idp-token-ttl", "question": "What TTL does the identity provider allow?", "gate": "criteria", "type": "research" }],
     "execution": {
       "strategy": "Sequential",
       "phases": [{ "title": "Phase name", "risk": "low", "blocking": true, "specPath": "docs/ideation/slug/spec-phase-1.md", "notes": "What this phase covers" }]
     }
   }
   ```

   Semantics no schema can express: the five gate `dimensions` are exactly the rubric's gates with their canonical keys/labels (`${CLAUDE_PLUGIN_ROOT}/references/confidence-rubric.md`) — a real file carries all five, each with one-sentence `evidence`; proceed only when all 5 are `ready`, recording not-ready gates only on an early-stopped interview. Write `openQuestions` only when the interview left a gate open on work it couldn't do itself: one entry per question the engine wrote, each `gate` matching a `dimensions` key, and `blockedBy` carrying the ids of other entries, omitted entirely when the question is takeable now. A resumed interview drops the entries it closed and rewrites that gate's evidence to cite what closed them. An open question never marks a gate `ready`; it is the reason the gate is open. **`check` is a union**: `{cmd, expect}` whenever a command can verify the criterion — `scripts/verify.mjs` executes every `cmd` at acceptance time — or `{judgment}` naming who looks at what (rendered with a visible "judgment call" tag, printed but never counted by verify; the success-criteria critic challenges any judgment where a command is plausible). Never author the legacy plain-string check form. Record each `decisions` entry **at the moment** the user rejects an alternative, not reconstructed later; `rejected` is optional when no concrete alternative was on the table. `scope.full`/`stretch`/`future` and `supersedes` are optional; phase fields also allow `kind: "gate"` (human checkpoint) and `prereqs` (phase titles). Two top-level fields belong to the express finish and are written only when step 7's routing chooses it: `approvalMode` (`"express"`) and `branch` (isolation branch autopilot re-asserts). `status` stays `"Draft"` here — run commands appear when Phase 5 flips it to `"Approved"`.

4. **Fan out the plan critics** (before rendering — fixing a blocker is a one-line JSON edit at this stage, not a regenerate loop). Issue all four `Agent` calls in one message so they run concurrently: `subagent_type: ideation:plan-critic`, prompt = per-invocation inputs only (`contract-data.json` path, project directory, and the **lens** — one of `scope-creep`, `over-engineering`, `hidden-dependency`, `success-criteria`); workflow/format/read-only `tools` come from the registered definition and are platform-enforced. **Agent names differ by harness** — see `${CLAUDE_PLUGIN_ROOT}/references/harness-compat.md` § 2: in pi, issue **one** `dispatch` call with four tasks, each carrying the lens in its `task`, the body of `${CLAUDE_PLUGIN_ROOT}/agents/plan-critic.md` as `systemPrompt`, and the default read-only tools. Same agent, same prompt, same lens.

   Act on findings: each `blocker` → revise `contract-data.json` to resolve it (re-tier a scope item, add a phase prereq, rewrite a criterion); if a blocker exposes a genuine unknown rather than a fixable defect, return to the interview loop for that gate. Each `notable` → fold in if clearly right, else carry to the digest with a one-line dismissal. `nit` → digest mention only. Every critic-blocker fix that changes the plan also appends a `decisions` entry recording what changed and what the pre-fix approach was — otherwise critic-driven revisions evaporate after the transient digest.

   **Failure tolerance:** a failed critic or an unregistered `ideation:plan-critic` (older Claude Code) → warn, proceed without that lens, note the gap in the digest. Critics amplify quality; never block the contract on a critic failure. **Run-once rule:** critics run exactly once per contract — re-run only if a revision changes goals or scope _fundamentally_, not for wording. The "Needs changes" approval loop does **not** re-trigger them.

5. **Run the generator** (it handles lineage — an existing **Approved** `contract.html` is renamed to `contract-{date}.html` with the supersedes link set; a Draft is replaced in place, so interview revisions and the Draft→Approved flip don't accumulate snapshots):

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/contract-gen.ts \
     --input ./docs/ideation/{slug}/contract-data.json \
     --output ./docs/ideation/{slug}/contract.html
   ```

   (Plain `node` works on Node ≥ 22.18 via type stripping; `npx --yes tsx` remains a fallback on older Node — but `npx` is denied in unattended runs, so prefer `node`.) After the `Generated …` line the generator prints **`{N} criteria ({M} cmd, {K} judgment)`** — capture it; the routing steps below read this count instead of eyeballing the criteria. The generator is the **only** renderer for `contract.html`. There is no fallback template — never hand-write the contract HTML or "render it from a template" if the generator can't run. **If the command is denied by permissions** (common when the plugin root is outside the current repo — the classifier flags an out-of-repo script as untrusted code), do not work around the denial and do not hand-render — the denial message may say you "may attempt other tools to accomplish this goal"; for this step that does not apply, since any other tool means hand-authoring the contract. Instead show the user the exact command and ask them to run it themselves by typing `! node …` in the prompt, then continue once `contract.html` exists. Run the generator and `open` as **separate** Bash calls — never chained with `&&` — so a denial of one is visible and doesn't silently skip the other.

6. Open it: `open ./docs/ideation/{slug}/contract.html` (macOS) or `xdg-open` (Linux).
7. **Present the Critic digest and a contract summary, then ask for approval and routing in one call.** Only ask once `contract.html` was actually generated and opened — never ask the user to approve a contract they haven't seen. Present in the terminal, in order:
   - **Critic digest** — one line per lens: `found N (B blockers folded in, M notables, dismissed X — reasons)`; note any skipped lens; if all four returned SOUND, say so.
   - **Summary block** — counts, not tables: quote the generator's printed `{N} criteria ({M} cmd, {K} judgment)` line; then the top checks (up to 3) verbatim; then scope tier counts (`{a} MVP · {b} Full · {c} Stretch · {d} out of scope`). Do **not** render the full criteria table in the terminal — the opened contract shows every criterion with its check; point the user at it for the detail.
   - **Routing recommendation** — derived from the interview's evidence, with the reason named in the option description. Recommend the **express finish** when all 5 gates went ready without an early stop AND the generator's count has `cmd > judgment`; anything else, recommend **full review** and say why in one line, citing the count (e.g. "9 criteria (3 cmd, 6 judgment) — unattended verification can't certify them", or "the interview ended early with Scope not-ready"). The user always chooses.

   Then ONE `AskUserQuestion` call carrying two independent questions (when the routing answer was pre-committed by the `/ideation:express` alias, ask the Express finish path's run-mode question in its place, keeping the one consolidated confirmation):

   ```
   Question 1: "Which scope tier should we target?"
   Options:
   - "Full (Recommended)" - Build MVP + Full tiers
   - "MVP" - Ship the minimum viable version first
   - "Stretch" - Include MVP + Full + Stretch tiers

   Question 2: "Approve the contract — and how should we finish?"
   Options:
   - "Approve — express finish" - One-pass finish: specs generate with no further approval questions and execute immediately on an isolation branch. {reason, when recommended}
   - "Approve — full review" - Interactive review continues: spec approval, then the handoff menu. {reason, when recommended}
   - "Needs changes" - Some parts need revision before approving
   ```

   **Early-stopped interview:** when the user ended the interview with not-ready gates, **omit** the express-finish option entirely — don't merely de-recommend it. The full path records not-ready gates for a human to weigh during review; an express finish would implement a known-unresolved gate headlessly. A contract carrying `openQuestions` is omitted the same way — an open question exists only where a gate is open. Say what that gate now holds (the open questions naming what would close it, plus what each one waits on) and how to pick it up: point ideation at `docs/ideation/{slug}/` and the interview resumes on the open questions alone. Open questions are contract-level state read at review; they do not travel into specs.

   The approved tier determines what goes into specs; items outside it move to "Future Considerations". **If "Needs changes":** revise (fundamental misunderstanding → back to the interview loop; otherwise edit `contract-data.json`, re-run the generator, re-open) and re-ask both questions, iterating until approved. **Do not proceed until explicitly approved.** On "Approve — full review", continue to Phase 4. On "Approve — express finish", follow the **Express finish** path below.

### Express finish

The fast path chosen at step 7 (or pre-committed by the `/ideation:express` alias). It deletes the remaining approval ceremony, never the artifacts: contract, specs, `contract.html`, and `contract.md` are all still written — the express finish changes _when_ a human reads them, not whether they exist. State alongside the run-mode question, not as more questions: execution commits to branch `ideation/{slug}`, and this is the **last artifact approval** — what remains are execution-time gates only (autopilot's failure gate, or execute-spec's escalations in a single-phase watch run), or nothing until completion on the walk-away path.

1. **Clean-tree check — at routing time, not before the interview.** Run `git status --porcelain`. The user's uncommitted changes would otherwise ride along on phase commits. Dirty tree → ask via `AskUserQuestion`: they stash/commit first, they accept the risk, or they abort. A clean tree proceeds silently. (The `/ideation:express` alias runs this check at intake instead — don't repeat it here.)
2. **Mark the contract express.** In `contract-data.json`, set `"approvalMode": "express"` and `"branch": "ideation/{slug}"` (autopilot re-asserts this checkout on every entry, so the isolation guarantee survives fresh sessions), and apply the chosen tier.
3. **Run mode** — one `AskUserQuestion` (skip if it was already folded into step 7's call by the alias). Which option carries `(Recommended)` comes from the advisor, never from this file — run `node ${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs ./docs/ideation/{slug}/contract-data.json --advise` and follow § 5.4's rule for reading it, including the two session-level overlays it can't see:
   - "Watch it run" — execute now; execution-time gates stay interactive.
   - "Start it and walk away" — emits a `/goal` wrapper to paste. **Omit** this option when the advisor reports `watch` for a verifiability reason (judgment-dominant criteria, or mostly file-inspecting checks) — a walk-away run can only trust what `scripts/verify.mjs` mechanically verifies, and would complete phases nothing checked. A `watch` caused by a high-risk phase is a recommendation, not an exclusion: keep the option, and say which phase drove it.
   - "Just generate the artifacts" — full generation, then no branch and no execution: hand off exactly per 5.4. The contract keeps `approvalMode: "express"` and `branch`, so a later `/ideation:autopilot` run still gets the isolation branch and strict semantics.
4. **Generate everything (no loops).** Run 4.2's phasing (small-project shortcut, template + delta for repeatable phases; skip PRDs entirely), then 4.4's specs — same templates and disciplines. The Spec Feedback Quality self-review (4.5) is a **hard gate** here, not a presentation note: Weak → fix before proceeding; there is **no spec approval question** — no human reviews these specs before execution. Then 5.1/5.2: orchestration analysis, `"status": "Approved"` (keep `approvalMode` and `branch` — provenance and isolation: no per-artifact human review happened), execution plan populated, and the 5.2 re-render emitting `contract.html` and `contract.md` together. **Permission denial does not block the express finish:** print the exact `! node …` command so the user can render the record whenever they like, note the skipped render, and continue — execution consumes `contract-data.json` and `contract.md`, not the HTML. If it did render, open it for ambient visibility, not approval. Skip 5.4's menu. **"Just generate the artifacts" stops here:** hand off per 5.4 (echo the per-phase and autopilot commands); the remaining steps do not run.
5. **Isolation branch.** Re-check the tree: changes **outside** `docs/ideation/{slug}/` are foreign (the artifacts just written are expected, and untracked files travel with `git switch`) — foreign changes mean the user worked mid-flow: stop and ask, same options as the clean-tree check above. Then create or switch (**watch routes**; on walk-away the `/goal` carries the branch clause itself — `contract-gen`'s `buildGoal` includes it when the contract has `branch` — so running the switch here too is a harmless re-assert):
   - **Branch doesn't exist:** `git switch -c ideation/{slug}`.
   - **Branch exists:** check it for prior phase commits (`git log --oneline ideation/{slug} -F --grep="docs/ideation/{slug}/"` — phase commit bodies carry the slug-qualified spec path, so this fixed-string match doesn't false-positive on commits that merely mention the project). None → switch and proceed. Some → this is either a resume or a stale run; ask (`AskUserQuestion`): "Resume" (switch; autopilot's pre-pass skips committed phases), "Fresh run" (`git branch -D ideation/{slug}`, then create anew), or "Abort". A walk-away re-entry (no interactive user) defaults to Resume — that path's intended semantics.
   - Every phase commits here. Post-run review is the branch diff; a bad run is **deleted, not reverted** — autopilot's git-log skip pre-pass matches commit messages, so _reverted_ phase commits still register as complete on a re-run.
6. **Dispatch** by phase count and run mode:
   - **Single phase, watch:** orchestration adds nothing (5.4) — read and follow `${CLAUDE_PLUGIN_ROOT}/skills/execute-spec/SKILL.md` with the single spec path `docs/ideation/{slug}/spec.md` (the small-project shortcut emits a bare `spec.md`, no phase number), interactively, with **one override**: on reviewer failure/empty/no verdict, do NOT use the validation-only fallback — escalate via `AskUserQuestion` ("Retry review" / "Commit with validation only" / "Abort, leave unstaged"). That fallback is calibrated for human-reviewed specs; this spec had none.
   - **Multi-phase, watch:** read `${CLAUDE_PLUGIN_ROOT}/skills/autopilot/SKILL.md` and execute it from its Step 1 with `docs/ideation/{slug}/contract.md` as the argument. (Its `disable-model-invocation` blocks Skill-tool triggering, not following its instructions.) Autopilot reads `approvalMode: "express"` and `branch` from `contract-data.json`, re-asserts the checkout, and sets `strict: true` in the engine args, so phases run fail-closed per the gate-behavior table in `${CLAUDE_PLUGIN_ROOT}/workflows/README.md` — a scout HOLD or a crashed reviewer stops the phase; nothing commits without review. Unreviewed code never commits silently: strict stops it, and even non-strict runs mark it `reviewStatus: "validation-only"` with a warning autopilot's report must lead with.
   - **Walk away (any phase count):** follow `${CLAUDE_PLUGIN_ROOT}/skills/get-goal-prompt/SKILL.md` to build and copy the `/goal` (the string comes from `contract-gen --print-goal`, which includes the branch clause when the contract carries `branch` and judges completion by `scripts/verify.mjs`'s VERIFY line), print the completion lines below, then stop — the user pastes it. The run resumes past committed phases automatically on every re-entry.
7. **Completion lines** — two lines, delivered where the run ends (appended to autopilot's completion report on multi-phase watch, to execute-spec's on single-phase watch, or printed alongside the copied `/goal` on walk-away — that session ends before execution does; watch routes then run their own learning-capture step, and walk-away notes surface at the next interactive intake):
   1. Branch: `ideation/{slug}`
   2. Review: `git diff {default-branch}...ideation/{slug}`

</what-to-do>

<supporting-info>

## Phase 4: Phasing & Specification

After approval, determine phases and generate Markdown specs. PRDs are optional.

### 4.1 Choose Workflow

**Default to specs; don't ask.** The contract defines what, the specs define how, and a PRD layer between them only earns its place when someone outside this conversation has to sign off. Generate PRDs (§ 4.3) only when the interview actually surfaced that need — a named stakeholder, an approval step, a handoff to a team that won't read specs. When it did, say you're adding the layer and why, in one line; you are not asking permission for a step the evidence already called for.

### 4.2 Determine Phases

Break scope into logical implementation phases.

**Small-project shortcut:** if the scope fits one phase (1-3 components, fewer than ~10 files), skip phasing — generate a single `spec.md` (no phase number) and go straight to handoff.

**Phasing criteria** (multi-phase): dependencies (build-order), risk (high-risk early), value delivery (benefit after each phase), complexity (balanced effort). Typical: Phase 1 core/infrastructure, Phase 2+ features/integrations, Phase N future considerations.

**Detect repeatable patterns:** 3+ phases with the same structure but different inputs (e.g., "add SDK support for {language}") change how specs are generated (see 4.4).

### 4.3 Generate PRDs (only when § 4.1's stakeholder need appeared)

Read `${CLAUDE_PLUGIN_ROOT}/skills/ideation/references/prd-template.md`, then generate `prd-phase-{n}.md` per phase: overview/rationale, user stories, functional requirements (grouped), non-functional requirements, dependencies (prerequisites and outputs), acceptance criteria. Review via `AskUserQuestion`, iterating until approved:

```
Question: "Do these PRD phases look correct?"
Options:
- "Approved" - Phases and requirements look good, proceed to specs
- "Adjust phases" - Need to move features between phases
- "Missing requirements" - Some requirements are missing or unclear
- "Start over" - Need to revisit the contract
```

### 4.4 Generate Implementation Specs

Read `${CLAUDE_PLUGIN_ROOT}/skills/ideation/references/spec-template.md`, then generate specs **lazily** — only when a phase's details are resolved.

**Standard phases** (each unique): a full `spec-phase-{n}.md` with technical approach, feedback strategy (inner-loop command, playground, rationale), file changes (table with new/modified/deleted), implementation details (per-component, each with a playground → experiment → check-command loop), testing requirements (table), failure modes (table: component, failure, trigger, impact, mitigation), validation commands.

- **Prefer the minimum approach:** the technical approach should be the simplest implementation that meets the phase's success criteria — no speculative abstractions, no configurability or error handling for cases the contract doesn't raise. If a design would make a senior engineer say "overcomplicated," cut it back; when added structure genuinely earns its keep, name the criterion that justifies it. (Scope minimalism is the `over-engineering` critic's job at the contract stage; this is its implementation-stage companion.)
- **Reference existing code:** where the interview found relevant patterns, add "Pattern to follow: `path/to/file.ts`" to implementation details.
- **Feedback loops:** match the mechanism to the component — data layers use tests, UI uses a dev server, APIs use curl scripts, config/types skip loops. See `${CLAUDE_PLUGIN_ROOT}/references/feedback-loop-guide.md` for the full mapping.
- **Failure modes:** for each non-trivial component, name how it fails — data shadows (nil/empty/stale), edge cases (concurrency, oversized input, missing permissions). Trivial components (config, types, constants) skip this.
- **Carry the decision log:** populate each spec's Decisions Considered and Rejected section with the phase-relevant entries from the contract's `decisions` array; when relevance is unclear, include all of them. A contract with zero decisions yields `None recorded.` — the section is the only copy the spec's consumers ever see, so never omit it.

**Repeatable phases** (3+ share a structure): don't generate N near-identical specs. Generate one full template — `spec-template-{pattern-name}.md` with placeholders for the variable parts — plus lightweight `spec-phase-{n}.md` deltas containing only the phase-specific inputs, deviations from the template, phase-specific concerns, and a reference: "Follow `spec-template-{pattern-name}.md` with the inputs below".

### 4.5 Present Specs for Review

**First, self-review feedback-loop quality** against the Spec Feedback Quality checklist in `${CLAUDE_PLUGIN_ROOT}/references/confidence-rubric.md`: **Strong** (all iterative components have loops, inner-loop command defined, trivial ones skipped) → present as-is; **Adequate** (minor gaps) → present with a note; **Weak** (no Feedback Strategy, or complex components missing loops) → fix the gaps before presenting. Then `AskUserQuestion`, iterating until approved:

```
Question: "Do these specs look correct? (Review them in your browser)"
Options:
- "Approved" - Specs look good, proceed to execution handoff
- "Adjust approach" - Implementation strategy needs changes
- "Missing components" - Some files or steps are missing
- "Revisit phases" - Phase breakdown needs restructuring
```

## Phase 5: Execution Handoff

After specs are approved, update the contract with the execution plan and emit Markdown for `/ideation:execute-spec`.

### 5.1 Analyze Orchestration Strategy

Do **not** create tasks here — they are ephemeral and lost on a fresh session; each `/ideation:execute-spec` creates its own. Analyze the phase dependency graph: 2+ phases sharing a single blocker (e.g., all blocked only by Phase 1) are **parallelizable**; a linear chain is **sequential**; mixed graphs have both.

| Pattern                       | Recommendation                                                                |
| ----------------------------- | ----------------------------------------------------------------------------- |
| All phases sequential (chain) | **Sequential execution** — the engine runs one wave at a time                 |
| 2+ independent phases         | **Parallel waves** — the Workflow engine dispatches them concurrently         |
| Mixed dependencies            | **Hybrid** — the engine sequences the dependent chain and parallelizes the independent group |

### 5.2 Update Contract Data with Execution Plan

Update `contract-data.json` with the final plan and re-run `contract-gen.ts` so the contract is self-contained:

- **Status** — set `"status": "Approved"`. This is what unlocks the run UI: Draft contracts render the phase track as a plan preview with an "awaiting approval" note; Approved contracts render First Move, the autopilot bar, and per-phase copy commands.
- **Phase Track** — populate `execution.phases` (titles, risk, blockers, spec paths, notes, human gates); the CLI renders the risk-colored track.
- **Execution Commands** — the CLI renders copy buttons for `/ideation:autopilot` and each `/ideation:execute-spec`.

Re-render with both outputs — one invocation emits `contract.html` and `contract.md` together (same rules as Phase 3 step 5: the generator is the only renderer, and its permission-denial handling applies):

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/contract-gen.ts \
  --input ./docs/ideation/{slug}/contract-data.json \
  --output ./docs/ideation/{slug}/contract.html \
  --md-output ./docs/ideation/{slug}/contract.md
```

Shared-file coordination is the engine's job, not the contract's: autopilot populates each phase's `files` from the specs' File Changes tables and the engine serializes overlapping waves. Re-open the regenerated contract.

### 5.3 Generate Contract Markdown

`contract.md` is generator output — the `--md-output` flag in 5.2's invocation already emitted it alongside the HTML, rendered from `contract-data.json`. **Never hand-author it.** The generated structure is what autopilot's fallback parser (when `contract-data.json` is absent) consumes: the `**Approval**` header line, the Dependency Graph's `(blocked by …)` annotations, and the per-phase `/ideation:execute-spec` lines. Specs and PRDs are already Markdown.

### 5.4 Present Handoff Summary

Present a brief summary, then **recommend one entry point** — don't hand over an undifferentiated menu. Always include:

```
Ideation complete. Artifacts written to `./docs/ideation/{project-name}/`.
Open contract.html to review the full plan — the phase graph, the run model, scope, and how completion is decided.
```

Then apply the decision rule:

- **Single phase:** recommend the one spec directly, no question:
  > Your next step: `/ideation:execute-spec docs/ideation/{project-name}/spec.md`
  > _(One phase — orchestration adds nothing.)_
- **Multi-phase:** ask exactly one question — whether they'll watch or walk away:

  ```
  Question: "How do you want to run this?"
  Options:
  - "Watch it run now" — /ideation:autopilot runs the phases on its Workflow engine while you watch.
  - "Start it and walk away" — get a /goal that drives autopilot to completion unattended, recovering from failures.
  - "I'll run phases myself" — run each /ideation:execute-spec manually.
  ```

  **Do not hardcode which option is recommended — ask the advisor.** Run:

  ```bash
  node ${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs ./docs/ideation/{slug}/contract-data.json --advise
  ```

  It runs nothing and writes nothing. It prints `RUNMODE {slug}: {mode} …` — `watch`, `walk-away`, or `run-spec` — followed by the reasons. Mark **that** option `(Recommended)`, and quote the advisor's deciding reason verbatim in its description so the user can disagree with the actual argument. `run-spec` means the orchestration question shouldn't be asked at all (single phase — recommend the one spec, per the rule above).

  The advisor weighs what a script can see: phase count, `risk: high` phases, the cmd-vs-judgment split, and how many `cmd` checks only inspect files rather than running anything. **Two facts it cannot see are yours to overlay**, and both only ever *remove* the walk-away option, never add it:

  - **The engine is unavailable** in this harness (the `Workflow` feature not enabled in Claude Code, or the plugin's bundled engine extension failed to load in pi) → autopilot's engine can't run. Recommend "I'll run phases myself".
  - **This session can't start a `/goal`** — it needs a trusted workspace and refuses when hooks are restricted. Discovering that at paste time, after the interview and the approval, is the worst moment for it. Signals: `/goal` errored earlier this session, or the user has said the workspace is untrusted. Then drop walk-away and say so in one line. **This is a caveat, not a verified mechanism** — it came from Claude Code binary strings and could not be confirmed from this repo, so never block on a negative check; when in doubt keep the option and let the paste fail with an explanation.

  If the advisor can't run (permission denial), say so and fall back to recommending "Watch it run now" — the conservative choice, and name it as a fallback rather than a recommendation.

  Then echo the exact command for their choice:
  - Watch now → `/ideation:autopilot docs/ideation/{project-name}/contract.md`
  - Walk away → `run /ideation:get-goal-prompt docs/ideation/{project-name}/contract.md, then paste the /goal it copies`
  - Manually → the per-phase `/ideation:execute-spec` commands in dependency order

**The layered model** (state once if helpful): `/ideation:autopilot` is the deterministic Workflow **engine**; the `/goal` is a durability **wrapper** that drives it unattended; `/ideation:execute-spec` is the per-phase **unit** all of them call. Graph shape doesn't change which entry point to recommend — the engine handles parallelism internally — so route on phase count, attended-vs-unattended, and whether the contract's checks make unattended verification trustworthy.

</supporting-info>

## Output Artifacts

All written to `./docs/ideation/{project-name}/`:

```
_comparison.html                   # Ephemeral decision aid (deleted after choice is made)
contract-data.json                 # Machine-readable contract (source of truth; consumed by autopilot)
contract.html                      # the contract (for review)
contract.md                        # Plain contract (autopilot fallback when contract-data.json is absent)
prd-phase-1.md                     # Phase 1 requirements (only if PRDs chosen)
...
spec-phase-1.md                    # Implementation spec (for execute-spec)
spec-template-{pattern}.md         # Shared template for repeatable phases (if applicable)
spec-phase-{n}.md                  # Per-phase delta or full spec
...
```

## Bundled Resources

**Shared references** (plugin root):

- `interview-engine.md` — interview engine (Phases 1-2)
- `confidence-rubric.md` — evidence-gate criteria for readiness and spec feedback quality
- `feedback-loop-guide.md` — component-type mapping and design criteria for spec feedback loops

**Skill references** — these live at `${CLAUDE_PLUGIN_ROOT}/skills/ideation/references/`, a different base from the shared refs above; bare `references/...` mentions in this file resolve there. HTML (interactive): `references/html-guide.md` (components, constraints — for ephemeral comparison artifacts only; `contract.html` comes exclusively from `scripts/contract-gen.ts`; tokens are owned by `DESIGN.md`). Markdown: `references/prd-template.md`, `references/spec-template.md`.

**Examples** (filled-in artifacts for a bookmark feature — reference for tone, structure, detail): `examples/contract-example.md`, `examples/prd-example.md`, `examples/spec-example.md`.

## Decision Aids: Previews First, HTML When Visual

During the interview and phasing, comparisons help the user decide. **Default to `AskUserQuestion` previews; escalate to ephemeral HTML only when the decision hinges on something a monospace preview can't show.**

`AskUserQuestion`'s per-option `preview` field renders side-by-side in a monospace box (markdown) — the default routing, since it keeps the decision inline with no file to write or clean up. Use it for ASCII layout mockups, code snippets (signature/config/schema per option), dependency-flow or phasing sketches, and compact pros/cons blocks. By stage: interview examples → ASCII mockups; architecture comparisons → structure + trade-offs per approach; phasing strategies → core-first vs. risk-first vs. value-first as dependency-flow sketches; orchestration strategy → sequential vs. parallel vs. hybrid as ASCII timelines.

**Constraints:** previews are **single-select only** — never combine with `multiSelect` (drop previews and rely on labels + descriptions, or escalate to HTML). Keep them **comparative** — a preview earns its place only when seeing options side-by-side changes the choice; otherwise skip it.

**Escalate to ephemeral HTML** only when a monospace box can't render the deciding factor: real visual design (color, typography, spacing), interactive behavior (sliders, toggles, hover), or side-by-side rendered (not sketched) artifacts. Workflow: write `_comparison.html` (prefix `_` marks it ephemeral) using `references/html-guide.md` components, show each option as a card/column (name, description, trade-offs, visual where apt), `open` it, ask via `AskUserQuestion` referencing the browser view, then delete it after the choice. Genuine visual mockups still use this path — the contract HTML does not; it comes only from the generator.

**When NOT to use a decision aid:** simple yes/no, choices where the recommended option is clearly best, or anything faster to explain in text.

## Important Notes

- **HTML is for interactive artifacts only** (contract, ephemeral visualizations); specs and PRDs are Markdown.
- **Read templates before writing:** `references/html-guide.md` before any ephemeral HTML, `references/spec-template.md` before specs. `contract.html` is generator output — never hand-written.
- **Use `AskUserQuestion` for all questions and approvals** — one at a time, with your recommended answer.
- **Judge gates conservatively** — when unsure the evidence is sufficient, the gate is not-ready. No fixed question limit.
- **Open HTML artifacts** after writing (`open` / `xdg-open`).
- **Create files lazily** — only when decisions are locked.
- **Small projects don't need phases** — 1-3 components → single spec. Template + delta for repeatable phases.
- **Specs must stand alone** — implementable without re-reading PRDs or the contract.
- **Express variant** — `/ideation:express` (`skills/express/SKILL.md`) is a thin pre-commit alias: it runs the clean-tree check at intake, then follows this skill with the routing question pre-answered to the express finish. This file is the single owner of express semantics (step 7's routing plus the Express finish path); the alias carries no section or step references, so restructuring here never breaks it.
