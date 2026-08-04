# Implementation Spec: UX De-Jank & Learning Loop - Phase 2

**Contract**: ./contract.md
**Estimated Effort**: L

## Technical Approach

Move the ceremony decision to where the information exists. `/ideation` keeps its identical interview; when all gates resolve, the flow renders the contract, runs the critics, and then — at the approval moment — presents a **summary confirmation** and a **routing choice**: finish express-style (one consolidated confirmation, isolation branch, immediate strict execution) or continue with full interactive review (spec approval, handoff menu). The recommendation between the two is derived from evidence: all 5 gates ready without an early stop AND a majority of success criteria carrying `check` commands favors the express finish; anything else favors full review, stated with the reason.

Ideation's SKILL.md becomes the **single owner of express semantics**: the branch/approvalMode/strict/run-mode machinery currently living in `skills/express/SKILL.md`'s Phases 0 and 3–6 moves into ideation's express-route path. `skills/express/SKILL.md` collapses to a thin pre-commit pointer (~15–25 lines): run /ideation with the routing question pre-answered to the express finish and the clean-tree check performed at intake. No section-number citations into ideation may remain in the alias — that coupling is the tax this phase eliminates, and a criterion greps for its absence.

**Hard constraints**: (1) ideation Phase 3's existing steps keep their numbers — the routing behavior lands inside the existing approval step (step 7), not as a new numbered step; (2) section numbers 4.x/5.x are stable — autopilot and execute-spec cite "ideation 5.4" and the spec-carry rule cites 4.4.

## Decisions Considered and Rejected

_Carried from the contract; consult before making gap decisions._

- **Move the ceremony choice to a post-interview routing recommendation** — rejected: keeping the pre-interview ideation-vs-express fork. Gate confidence and criteria verifiability are the routing inputs and they only exist after the interview.
- **Express alias is a thin pointer (~10–20 lines) into /ideation's routing path** — rejected: keeping express as a parallel skill file overriding ideation sections by reference. The parallel file's only remaining function is pre-answering one question, while its section coupling taxes every future ideation edit.
- **In the /ideation path the clean-tree check runs at routing time, not before the interview** — rejected: running the express Phase 0 tree check before every /ideation interview. A clean tree is only needed if the user routes to immediate isolated execution.
- **Express-style confirmation becomes a terminal summary with detail in the rendered contract** — rejected: the full criteria table and digest inline in the terminal. The gate stays informed via counts, top checks, and one line per critic lens.

## Feedback Strategy

**Inner-loop command**: `grep -qiE 'recommend.*(express|full review)' skills/ideation/SKILL.md && ! grep -qE 'Phase 3 step [0-9]|steps 3.4' skills/express/SKILL.md && echo PASS`

**Playground**: The criterion grep battery plus dry-run read-throughs — all changes are skill prose; the "renders correctly" test is a coherent read.

**Why this approach**: No executable surface; the greps pin the structural requirements and the judgment criterion covers flow quality.

## File Changes

### New Files

None.

### Modified Files

| File Path | Changes |
| --- | --- |
| `skills/ideation/SKILL.md` | Step 7 rewritten: summary confirmation (criteria counts, top 3 checks, one line per critic lens — full table lives in the opened contract) + routing question with evidence-derived recommendation; new "Express finish" subsection inside Phase 3/5 carrying the absorbed express semantics (contract-data gains `approvalMode`/`branch`, single tier+run-mode confirmation, clean-tree check at routing, autopilot dispatch with strict, completion/handoff lines); Phase 5 full-review path unchanged |
| `skills/express/SKILL.md` | Rewritten top to bottom as the thin pre-commit alias; frontmatter description updated to say it pre-commits /ideation's routing; body: clean-tree check at intake, then follow ideation with routing pre-answered; scope guard advisory retained (recommend full review for exploratory work); zero step-number citations |

### Deleted Files

None (the express file survives, thin).

## Implementation Details

### Component 1: Routing + summary confirmation in ideation step 7

**Pattern to follow**: express 0.18.0's Phase 4 ("the one confirmation") for the informed-gate content; the digest format already in ideation step 7.

**Overview**: Step 7 becomes: (1) critic digest, one line per lens; (2) summary block — `N criteria (M with checks, K judgment)`, the top 3 checks verbatim, scope tier counts; (3) one `AskUserQuestion` with tier and route. The phrase "one line per lens" and "top checks" must appear in the instructions (criterion grep).

**Key decisions**:

- Routing options: "Approve — express finish" / "Approve — full review" / "Needs changes"; tier asked in the same call (two independent questions, one call — AskUserQuestion supports up to 4).
- Recommendation heuristic stated in the skill: express finish recommended when all 5 gates went ready without an early stop AND >50% of criteria carry checks; otherwise full review, with the reason named in the option description. The user always chooses.
- The full criteria table is explicitly NOT rendered in the terminal — the instruction says to point at the opened contract for detail.

**Implementation steps**:

1. Rewrite step 7 (content only, number preserved).
2. Add the express-finish path: on that route, set `approvalMode: "express"` and `branch: "ideation/{slug}"` in contract-data.json, run the clean-tree check (stash/accept/abort options), then proceed directly to Phase 4.2 phasing → 4.4 specs (hard-gated self-review, no spec approval question) → 5.1/5.2 → autopilot dispatch with strict semantics — mirroring express 0.18.0 Phases 5–6 including the run-mode question (watch / walk away / artifacts only) and completion lines.
3. Verify section-number stability: `grep -n 'ideation 5.4\|Phase 3 step' skills/autopilot/SKILL.md skills/execute-spec/SKILL.md` — citations still resolve.

**Feedback loop**:

- **Playground**: dry-run read of Phase 3→5 as an executor would follow it, on both routes.
- **Experiment**: trace three scenarios — clean express-recommended, judgment-heavy full-review-recommended, early-stopped interview (express finish must be unavailable: not-ready gates require the full path's human review).
- **Check command**: the inner-loop grep battery.

### Component 2: Express as thin alias

**Pattern to follow**: none in-repo — this is deliberately the smallest skill file in the plugin.

**Overview**: Frontmatter (name, description, argument-hint, disable-model-invocation preserved) plus a body of roughly: "Express pre-commits /ideation's routing. Run the clean-tree check now (before the interview — stopping costs one question here, not a completed interview). Then read and follow `skills/ideation/SKILL.md` with the routing question pre-answered to 'Approve — express finish'. Recommend the full flow instead for exploratory or unfamiliar work (advisory)."

**Key decisions**:

- The alias references the ideation SKILL.md by path, never by section or step number (criterion: `! grep -qE 'Phase 3 step [0-9]|steps 3.4'`).
- `mise en place` details (branch existence handling, resume semantics) live in ideation's express-finish path, not the alias — one owner.

**Implementation steps**:

1. Rewrite the file; target under ~30 lines including frontmatter.
2. Run the no-step-citation grep and the `pre-commit` grep.

## Testing Requirements

### Unit Tests

None — no executable surface. Engine suites re-run as regression (nothing here touches them).

### Manual Testing

- [ ] Dry-run read: /ideation with an express-recommended outcome reads coherently start to finish, including branch/strict semantics
- [ ] Dry-run read: the alias file, then ideation, replicates today's express behavior with the tree check first
- [ ] Confirm no orphaned references: nothing else in the repo cites express SKILL.md sections that no longer exist (`grep -rn 'express/SKILL.md' skills/ references/ README.md workflows/`)

## Error Handling

| Error Scenario | Handling Strategy |
| --- | --- |
| Early-stopped interview reaching routing | Express finish option omitted (not de-recommended) — not-ready gates need the full path's human review; instruction states this |
| Dirty tree at express-finish routing | Same options as express 0.18.0 Phase 0: stash/commit first, accept risk, or abort |
| Majority-judgment criteria on the express route | Walk-away run-mode option omitted, mirroring express 0.18.0 precondition 2 |

## Failure Modes

| Component | Failure Mode | Trigger | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| Step 7 rewrite | Renumbering | Routing added as new step | Consumers citing ideation sections break | Content lands inside step 7; verification grep in step 3 of Component 1 |
| Semantics absorption | Behavior drift from express 0.18.0 | Paraphrasing instead of porting the strict/fail-closed rules | Express-routed runs commit unreviewed code on reviewer crash | Port the fail-closed language verbatim from express 0.18.0 Phases 5–6; the run-mode/strict/branch rules are load-bearing |
| Thin alias | Alias too thin | Omitting the pre-interview tree check or the scope-guard advisory | Walk-away pre-commitment loses its safety properties | Alias keeps exactly those two behaviors; everything else delegates |
| Docs | README still describes the old two-door model | Phase 2 ships without README edits | Users follow stale docs | Acceptable within this phase — Phase 3 owns README; note it in implementation notes if observed |

## Validation Commands

```bash
# Criterion 5: routing recommendation present
grep -qiE 'recommend.*(express|full review)' skills/ideation/SKILL.md

# Criterion 6: alias declares pre-commit
grep -qi 'pre-commit' skills/express/SKILL.md

# Criterion 10 (shared with phase 3's confirmation work): summary form
grep -qiE 'one line per lens|top checks' skills/ideation/SKILL.md

# Criterion 15: coupling structurally gone
! grep -qE 'Phase 3 step [0-9]|steps 3.4' skills/express/SKILL.md

# Consumers' citations still resolve
grep -n 'ideation 5.4' skills/autopilot/SKILL.md skills/execute-spec/SKILL.md || true

# Engine regression
node --test test-fixtures/orchestration/graph.test.mjs workflows/wave-planner.test.mjs workflows/execute-contract.smoke.test.mjs
```

## Rollout Considerations

- **Rollback plan**: branch deletion.
- The alias keeps the `/ideation:express` name so existing muscle memory and docs links survive; behavior is equivalent by construction.

## Open Items

None.

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
