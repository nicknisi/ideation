# UX De-Jank & Learning Loop Contract

**Created**: 2026-07-23
**Readiness**: All 5 gates ready
**Status**: Approved
**Approval**: Interactive review
**Supersedes**: None

## Problem Statement

The plugin's entry surface forces the ceremony decision before the information exists: users choose /ideation:ideation vs /ideation:express before the interview, yet the interview is identical in both and gate confidence plus criteria verifiability — the exact inputs for that choice — only exist after it. Six user-facing skills compound the surface-area problem.

The contract exists in three representations, one of them hand-authored: contract-data.json renders contract.html mechanically, but contract.md is hand-mirrored by the model, inviting drift. The plugin's own over-engineering critic flagged the unread third copy.

The interview gives no progress feedback, making interviews feel unbounded. The express confirmation has the opposite problem: a wall of terminal text duplicating what the rendered contract already shows.

The learning loop is structurally dead: /ideation:retro is pull-based, empty-input-prone, and silently consumed. Field evidence is decisive — every adopted mechanism moved capture off the user, and Cursor removed its approval-gated equivalent entirely. learnings.md has never been created in this repo.

## Goals

1. /ideation is the single default front door: identical interview, then a post-interview routing recommendation (express-style single confirmation vs full interactive review) derived from gate evidence and criteria verifiability; /ideation:express survives as a pre-commit alias.
2. contract.md becomes generator output rendered from contract-data.json alongside contract.html, preserving the structure autopilot's fallback parser and get-goal-prompt consume.
3. The interview shows a one-line gate scoreboard after each answer, inherited by both skills from the shared engine.
4. The express-style confirmation is a terminal summary with full detail in the rendered contract.
5. The learning loop goes push-based: interactive completions propose up to 3 candidate learnings (accept/edit/dismiss, silent on zero), intake visibly attributes applied learnings and surfaces unmined notes, and /ideation:retro is deleted with all references updated.

## Success Criteria

- [ ] Generator emits contract.md from contract-data.json alongside the HTML — check: `npx tsx scripts/contract-gen.ts --input test-fixtures/orchestration/contract-data.json --output /tmp/uxd.html --md-output /tmp/uxd.md && grep -q '## Execution Plan' /tmp/uxd.md — exits 0`
- [ ] Generated contract.md smoke test (after the render above): title heading, Approval header line, dependency-graph fence, per-phase execute-spec lines, decision log — check: `grep -qE '^# .+ Contract' /tmp/uxd.md && grep -q '\*\*Approval\*\*' /tmp/uxd.md && grep -qi 'dependency graph' /tmp/uxd.md && grep -q 'blocked by' /tmp/uxd.md && [ $(grep -c '/ideation:execute-spec ' /tmp/uxd.md) -ge 4 ] && grep -qi 'decisions considered' /tmp/uxd.md — exits 0`
- [ ] Both skills instruct generating contract.md via the generator — check: `grep -qi 'md-output' skills/ideation/SKILL.md && grep -qi 'md-output' skills/express/SKILL.md — exits 0`
- [ ] Ideation SKILL.md contains the post-interview routing step — check: `grep -qiE 'recommend.*(express|full review)' skills/ideation/SKILL.md — exits 0`
- [ ] Express SKILL.md is a thin pre-commit alias — check: `grep -qi 'pre-commit' skills/express/SKILL.md — exits 0`
- [ ] Gate scoreboard lives in the shared engine only — check: `grep -qi 'scoreboard' references/interview-engine.md && ! grep -riq 'scoreboard' skills/ideation/SKILL.md skills/express/SKILL.md — exits 0`
- [ ] /ideation:retro is deleted — check: `test ! -e skills/retro — exits 0`
- [ ] No dangling retro references including plugin manifests — check: `! grep -rq 'ideation:retro' skills/ references/ README.md .claude-plugin/ — exits 0`
- [ ] Learning capture carries its behavioral contract in both execution skills — check: `grep -qiE 'accept/edit/dismiss|up to 3' skills/execute-spec/SKILL.md && grep -qiE 'accept/edit/dismiss|up to 3' skills/autopilot/SKILL.md — exits 0`
- [ ] Confirmation instruction describes the summary form — check: `grep -qiE 'one line per lens|top checks' skills/ideation/SKILL.md — exits 0`
- [ ] Intake attributes applied learnings and surfaces unmined notes — check: `grep -qiE 'applying learning|unmined' references/interview-engine.md — exits 0`
- [ ] Shared learning-filter reference carries the full lifecycle — check: `grep -qi 'also seen in' references/learning-filter.md && grep -qi 'retire' references/learning-filter.md && grep -qi 'pattern' references/learning-filter.md — exits 0`
- [ ] No step-number citations into ideation remain in the express alias — check: `! grep -qE 'Phase 3 step [0-9]|steps 3.4' skills/express/SKILL.md — exits 0`
- [ ] Animated HTML workflow example exists, self-contained, animated — check: `test -f docs/workflow-example.html && grep -qi '@keyframes' docs/workflow-example.html && ! grep -qi '<script src=' docs/workflow-example.html && ! grep -riq 'workflow-example.md' skills/ references/ README.md — exits 0`
- [ ] Engine test suites pass and plugin version is 0.19.0 — check: `node --test test-fixtures/orchestration/graph.test.mjs workflows/wave-planner.test.mjs workflows/execute-contract.smoke.test.mjs && grep -q '"version": "0.19.0"' .claude-plugin/plugin.json — exits 0`
- [ ] Routing recommendation and scoreboard read naturally; trimmed confirmation carries the load-bearing content; workflow example is genuinely detailed, fun, whimsical — judgment call: manual read-through

## Scope Boundaries

### In Scope

- contract-gen.ts `--md-output` with lineage pair-archiving; both skills switch to generator invocation
- Post-interview routing in ideation (owner of express semantics); express as thin pre-commit alias; clean-tree check at routing time
- Learning-loop absorb: shared learning-filter.md lifecycle reference, silent-on-zero completion capture, intake attribution + bounded unmined surfacing, retro deleted with full sweep including both manifests
- Gate scoreboard in the shared engine; tighter summary confirmation
- README/docs updates; version 0.19.0
- Animated self-contained HTML workflow example replacing workflow-example.md

### Out of Scope

- New agents, phases, or roles — this project reduces surface, never adds
- Auto-writing learnings without user approval — capture always passes accept/edit/dismiss
- Changes to plan-critic, scout, or reviewer agents — 0.18.0's pipeline is outside this blast radius
- External memory-system integration — the plugin stays portable and file-based
- Deleting or renaming execute-spec, autopilot, or get-goal-prompt — the surface problem is the planning fork, not the execution stack

### Future Considerations

- AskUserQuestion previews for the routing choice
- Session-metrics-style stats on learning reuse

## Decisions Considered and Rejected

- **Absorb retro into completion capture and intake attribution, then delete the command** — rejected: dropping the loop entirely, or keeping retro as-is. Pull-based retro is never used; only its trigger and visibility are broken.
- **Keep /ideation:express as a pre-commit alias** — rejected: deleting the command. Zero migration cost, preserves upfront walk-away commitment.
- **Post-interview routing recommendation** — rejected: the pre-interview fork. The routing inputs only exist after the interview.
- **contract.md becomes generator output** — rejected: hand-mirroring. Drift-prone; generated md makes compatibility testable.
- **Clean-tree check at routing time in the /ideation path** — rejected: pre-interview check. Only needed when routing to isolated execution.
- **Unattended runs never auto-capture; next intake surfaces unmined notes** — rejected: auto-appending unreviewed learnings. Silent writes erode trust.
- **Summary-form confirmation** — rejected: inline criteria table. The rendered contract already shows the detail.
- **Express alias is a thin pointer; ideation solely owns express semantics** — rejected: parallel skill file with section references. The coupling taxes every future edit.
- **Learning filter written once in a shared reference, invoked at two moments** — rejected: three inline copies. Hot-path copies drift.
- **Silent on zero candidates** — rejected: always prompting. Would recreate retro's empty-input fatigue.
- **Retro sweep includes both .claude-plugin manifests** — rejected: narrower sweep. The store listing would advertise a deleted command.
- **Full learnings.md lifecycle relocates wholesale** — rejected: filter-only relocation. Partial relocation lets the file rot.
- **Generated md keeps full parser-compatible structure as a legacy contract** — rejected: minimal md. Free at render time; keeps pre-JSON projects working.
- **Lineage archives generator-emitted html+md as a pair** — rejected: keeping the mtime heuristic. Near-equal mtimes make it meaningless.
- **Workflow example becomes a self-contained animated HTML page** — rejected: rewriting the markdown. Human-facing; nothing model-side reads the md.

## Execution Plan

_Added during Phase 5 handoff. Pick up this contract cold and know exactly how to execute._

### Dependency Graph

```
Phase 1: Generator emits contract.md
  └── Phase 2: Post-interview routing  (blocked by Phase 1)
        └── Phase 3: Learning loop and polish  (blocked by Phase 2)
              └── Phase 4: Whimsical workflow example  (blocked by Phase 3)
```

### Execution Steps

**Run the project** (recommended) — autopilot reads this contract, plans dependency waves, runs everything reachable, and gates on failure:

```bash
/ideation:autopilot docs/ideation/ux-dejank/contract.md
```

**Or run phases manually** in dependency order:

**Strategy**: Sequential

1. **Phase 1** — Generator emits contract.md _(blocking)_

   ```bash
   /ideation:execute-spec docs/ideation/ux-dejank/spec-phase-1.md
   ```

2. **Phase 2** — Post-interview routing _(blocked by Phase 1)_

   ```bash
   /ideation:execute-spec docs/ideation/ux-dejank/spec-phase-2.md
   ```

3. **Phase 3** — Learning loop and polish _(blocked by Phase 2)_

   ```bash
   /ideation:execute-spec docs/ideation/ux-dejank/spec-phase-3.md
   ```

4. **Phase 4** — Whimsical workflow example _(blocked by Phase 3)_

   ```bash
   /ideation:execute-spec docs/ideation/ux-dejank/spec-phase-4.md
   ```

---

_This contract was generated from brain dump input. Review and approve before proceeding to specification._
