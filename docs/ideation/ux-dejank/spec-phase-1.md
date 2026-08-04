# Implementation Spec: UX De-Jank & Learning Loop - Phase 1

**Contract**: ./contract.md
**Estimated Effort**: M

## Technical Approach

Teach `scripts/contract-gen.ts` to emit `contract.md` from `contract-data.json` via a new optional `--md-output <path>` flag, making the generator the single renderer for both contract representations. The Markdown mirrors the HTML's content in the structure the repo's existing hand-authored contracts use (see `test-fixtures/orchestration/contract.md` and `docs/ideation/decision-log/contract.md` as the canon): title heading, header lines (Created/Readiness/Status/Approval/Supersedes), Problem, Goals, Success Criteria checklist with inline checks, Scope Boundaries, Decisions Considered and Rejected, and an Execution Plan with dependency graph fence, strategy, and per-phase `/ideation:execute-spec` commands.

Parser compatibility is a **deliberate legacy contract**, not a live-consumer requirement: autopilot's fallback parser fires only when contract-data.json is absent, and get-goal-prompt uses contract.md as a glob locator plus name source. The structure is free at render time and keeps pre-JSON projects and json-deleted recovery working.

The lineage block needs rework in the same pass: its sibling-md mtime heuristic (`archive md only when mdMtime <= htmlMtime`) exists because hand-authored md was written after the html. When `--md-output` is active, the generator owns both files and archives them as a pair; without the flag, legacy behavior is unchanged.

Both skills' instructions then switch from hand-mirroring to the generator invocation. Keep the edit to `skills/express/SKILL.md` minimal (invocation lines only) — Phase 2 rewrites that file wholesale.

## Decisions Considered and Rejected

_Carried from the contract; consult before making gap decisions._

- **contract.md becomes generator output from contract-data.json** — rejected: continuing to hand-mirror from the template. Hand-mirroring is drift-prone (flagged by the plugin's own over-engineering critic); a generated md turns parser compatibility into a testable output contract.
- **Generated contract.md keeps full parser-compatible structure as a deliberate legacy compatibility contract** — rejected: a minimal human-readable md. The fallback parser never fires for generator-produced projects, but the structure is free, keeps pre-JSON projects working, and one smoke criterion is cheap.
- **Lineage archiving treats generator-emitted html+md as a pair archived together** — rejected: keeping the sibling-md mtime heuristic unchanged. With both files from one run, mtimes are near-equal and the comparison is meaningless.

## Feedback Strategy

**Inner-loop command**: `npx tsx scripts/contract-gen.ts --input test-fixtures/orchestration/contract-data.json --output /tmp/uxd.html --md-output /tmp/uxd.md && grep -q '## Execution Plan' /tmp/uxd.md`

**Playground**: Fixture rendering — the orchestration fixture (4 phases, 3 with prereqs, non-empty decisions) exercises every md section.

**Why this approach**: The renderer is the only executable surface; rendering the real fixture and grepping structure is a seconds-fast check.

## File Changes

### New Files

None.

### Modified Files

| File Path | Changes |
| --- | --- |
| `scripts/contract-gen.ts` | `--md-output` flag; `buildMarkdown(d)` renderer; lineage block reworked to archive html+md as a pair when the flag is active (legacy mtime heuristic preserved when absent); write md after the archive step alongside the html write |
| `skills/ideation/SKILL.md` | 5.2's re-render command gains `--md-output ./docs/ideation/{slug}/contract.md`; 5.3 rewritten: contract.md is generator output, never hand-authored (template reference removed from the generation path) |
| `skills/express/SKILL.md` | Generator invocation lines only: Phase 5 steps 3–4 collapse into one invocation emitting both files; delete the md-before-html ordering rule sentence |

### Deleted Files

None. (`skills/ideation/references/contract-template.md` survives this phase — it remains the format documentation and the fallback for generator-less environments; Phase 3 does not touch it either.)

## Implementation Details

### Component 1: `buildMarkdown(d)` + `--md-output` (contract-gen.ts)

**Pattern to follow**: the existing `buildX(d): string` section-builder convention composed in `generate()`; the md's target shape is `docs/ideation/decision-log/contract.md` (hand-authored canon from the 0.18.0 release).

**Overview**: A parallel composer producing Markdown, not a transform of the HTML. Plain string building; no escaping needed beyond what Markdown requires (the esc() helper is HTML-specific — do not reuse it).

**Key decisions**:

- Header block: `# {projectName} Contract`, then `**Created**`, `**Readiness**` (derived from gate dimensions: "All 5 gates ready" or "N gates open: {labels}"), `**Status**`, `**Approval**` (render `Express — single consolidated confirmation, no per-artifact review` when `approvalMode === "express"`, else `Interactive review`), `**Supersedes**`.
- Success criteria render as `- [ ] {criterion} — check: \`{check}\`` or `— judgment call: {criterion}` when no check.
- Decisions render as `- **{decision}** — rejected: {rejected}. {reason}` (omit the rejected clause when absent); section renders `None recorded.` when the array is empty or missing — mirroring the spec-template rule, absence must be explicit.
- Execution Plan: `### Dependency Graph` with the ASCII fence derived from `prereqs` (`(blocked by {title})` annotations), `**Strategy**`, numbered phases each with a fenced `/ideation:execute-spec {specPath}` block, and `### Agent Team Prompt` only when `agentTeamPrompt` exists.
- CLI: `--md-output` optional; absent → behavior identical to today (html only).

**Implementation steps**:

1. Add flag parsing next to the existing `--input`/`--output` handling.
2. Write `buildMarkdown(d)` with one small builder per section, composed in order.
3. Write the md file alongside the html write (after lineage).
4. Render the fixture; diff mentally against `test-fixtures/orchestration/contract.md` for structural parity.

**Feedback loop**:

- **Playground**: fixture renders to /tmp.
- **Experiment**: render (a) the orchestration fixture (phases + prereqs + decisions), (b) the docs-site fixture (no decisions → `None recorded.`; no approvalMode → `Interactive review`), (c) without `--md-output` (no md written, html byte-identical to today).
- **Check command**: the inner-loop command above, plus `grep -q '\*\*Approval\*\*' /tmp/uxd.md && grep -qi 'dependency graph' /tmp/uxd.md && grep -q 'blocked by' /tmp/uxd.md`

### Component 2: Lineage pair-archiving (contract-gen.ts)

**Pattern to follow**: the existing lineage block (currently ~lines 740–780; keyed off `data-contract-status="Draft"` regex and file mtimes).

**Overview**: When `--md-output` is passed and an Approved contract.html is being archived to `contract-{date}.html`, archive the sibling md to `contract-{date}.md` unconditionally (it is generator output from the same lineage); skip the mtime comparison. When the flag is absent, the existing heuristic is untouched.

**Key decisions**:

- Gate the new branch on the flag, not on file inspection — explicit intent beats heuristics.
- Draft-in-place replacement continues to replace both files with no snapshot.

**Implementation steps**:

1. Thread the md path into the lineage function.
2. Branch: flag present → pair-archive; absent → legacy heuristic.
3. Verify with a two-render sequence in /tmp: render Approved, render again with changed date, confirm both `-{date}` artifacts exist.

**Feedback loop**:

- **Playground**: /tmp two-render lineage sequence.
- **Experiment**: (a) Approved→Approved re-render archives html+md pair; (b) Draft→Draft replaces in place, no snapshots; (c) no-flag render of a dir containing a hand-authored md follows the old mtime rule.
- **Check command**: `ls /tmp/lineage-test/` shows the expected pair (scripted in the run, not committed).

### Component 3: Skill instruction updates (ideation 5.2/5.3, express Phase 5)

**Overview**: Replace hand-mirroring instructions with the generator invocation. The 5.3 section shrinks to: the generator emitted contract.md alongside the HTML in 5.2; never hand-author it. **Do not renumber any section** — autopilot and express cite ideation sections by number (e.g. "ideation 5.4"); 5.3 keeps its number with new content.

**Implementation steps**:

1. Edit ideation 5.2's command to include `--md-output`; rewrite 5.3's body.
2. Edit express Phase 5 steps 3–4: one invocation, both outputs; delete the ordering-rule sentence.
3. Run the criterion greps (`md-output` present in both files).

## Testing Requirements

### Unit Tests

| Test File | Coverage |
| --- | --- |
| `test-fixtures/orchestration/graph.test.mjs` | Regression: engine untouched by generator changes |
| `workflows/wave-planner.test.mjs` | Regression |
| `workflows/execute-contract.smoke.test.mjs` | Regression |

**Key test cases** (via render checks — no test harness exists for the generator and this phase doesn't add one):

- Fixture with decisions/prereqs/4 phases → all md sections present
- Fixture without decisions → `None recorded.`, `Interactive review`
- No `--md-output` → html byte-identical, no md written
- Lineage pair-archive on Approved re-render

### Manual Testing

- [ ] Read /tmp/uxd.md top to bottom next to `test-fixtures/orchestration/contract.md` — structural parity, no HTML artifacts leaking into md

## Error Handling

| Error Scenario | Handling Strategy |
| --- | --- |
| `--md-output` without `--input`/`--output` | Same argument-error path the script uses today |
| Unwritable md path | Let writeFileSync throw — consistent with the html path's behavior |
| Missing optional fields (approvalMode, decisions, agentTeamPrompt) | Render the documented defaults (`Interactive review`, `None recorded.`, omit section) — duck-typed input, never throw |

## Failure Modes

| Component | Failure Mode | Trigger | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| buildMarkdown | md drifts from html content | Sections added to one composer but not the other | The drift problem this phase exists to kill, relocated | Both composers consume the same `d`; keep section order identical; manual parity read |
| buildMarkdown | Broken fallback structure | Missing `(blocked by ...)` edges or Approval line | Fallback parser plans wrong waves; express contracts lose strict mode | Smoke-check greps cover title, Approval, graph, blocked-by, per-phase commands |
| Lineage | Pair-archive renames a hand-authored md | Flag passed in a dir with legacy hand-written md | User's md snapshotted under generator lineage | Acceptable: the flag declares generator ownership; document in --help text |
| Skill edits | Section renumbering | Careless restructure of 5.x | autopilot/express citations break | Content-only edits; keep numbering; grep 'ideation 5.4' consumers after edit |

## Validation Commands

```bash
# Criterion 1: generator emits md
npx tsx scripts/contract-gen.ts --input test-fixtures/orchestration/contract-data.json --output /tmp/uxd.html --md-output /tmp/uxd.md && grep -q '## Execution Plan' /tmp/uxd.md

# Criterion 2: smoke test (after the render above)
grep -qE '^# .+ Contract' /tmp/uxd.md && grep -q '\*\*Approval\*\*' /tmp/uxd.md && grep -qi 'dependency graph' /tmp/uxd.md && grep -q 'blocked by' /tmp/uxd.md && [ $(grep -c '/ideation:execute-spec ' /tmp/uxd.md) -ge 4 ] && grep -qi 'decisions considered' /tmp/uxd.md

# Criterion 4: both skills instruct the generator path
grep -qi 'md-output' skills/ideation/SKILL.md && grep -qi 'md-output' skills/express/SKILL.md

# Engine regression
node --test test-fixtures/orchestration/graph.test.mjs workflows/wave-planner.test.mjs workflows/execute-contract.smoke.test.mjs
```

## Rollout Considerations

- **Rollback plan**: single branch; a bad run is deleted, not reverted.
- Flag is opt-in; every existing invocation and old contract-data.json is unaffected.

## Open Items

None.

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
