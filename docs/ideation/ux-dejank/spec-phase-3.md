# Implementation Spec: UX De-Jank & Learning Loop - Phase 3

**Contract**: ./contract.md
**Estimated Effort**: L

## Technical Approach

Make the learning loop push-based and delete the dead command. The entire learnings.md **lifecycle** — classification categories, the generalization filter with qualifying/disqualifying examples, the dedupe "Also seen in" amendment rule, retirement discipline, bootstrap header, and entry format — relocates from `skills/retro/SKILL.md` (its sole owner today) into a new shared reference, `references/learning-filter.md`, written once and invoked from two moments:

1. **Interactive completion** (execute-spec watch runs; autopilot watched runs): after the completion report, if the just-finished project produced implementation notes or note-worthy decisions, apply the filter; up to 3 candidates survive; **zero candidates → no prompt, no output** (silence is the contract); otherwise one `AskUserQuestion` offering accept/edit/dismiss per candidate, and accepted entries are written to `docs/ideation/learnings.md` per the lifecycle rules. Headless/unattended runs never prompt and never write.
2. **Intake** (interview engine): when a recorded learning shapes a question or a spec implication, say so visibly — one line: `Applying learning from {project} ({date}): {why}`. Additionally, a **bounded** scan (one glob over `docs/ideation/*/implementation-notes-*.html`, compared against learnings.md's mtime) surfaces notes left by unattended runs: if unmined notes exist, offer once to mine them now through the same filter. This preserves retro's coverage of headless-run notes that deleting the command would otherwise orphan.

Then the deletion sweep: `skills/retro/` removed; every reference updated — README (feature line, Retro section, diagram mentions), completion handoff lines in express/autopilot/execute-spec, and **both `.claude-plugin` manifest descriptions** (plugin.json and marketplace.json mirror each other). The gate scoreboard lands in the interview engine's gate-tracking section. Version bumps to 0.19.0.

## Decisions Considered and Rejected

_Carried from the contract; consult before making gap decisions._

- **Absorb retro into completion capture and intake attribution, then delete the command** — rejected: dropping the learning loop entirely, or keeping /ideation:retro as-is. Pull-based retro ceremonies are never used (field evidence); the mining discipline is sound — only trigger and visibility are broken.
- **The full learnings.md lifecycle relocates wholesale to the shared reference** — rejected: relocating only the filter and letting lifecycle rules die with the command. Retro is the sole producer and intake a format-dependent consumer; partial relocation lets the file rot with duplicates and stale entries.
- **The filter is written once, invoked at completion (bounded to the finished project) and intake (bounded scan)** — rejected: duplicating filter logic in execute-spec, autopilot, and the interview engine. Three hot-path copies would drift.
- **Zero qualifying candidates at completion produces no prompt and no output** — rejected: always showing the capture question. A mandatory prompt on clean runs recreates retro's empty-input fatigue.
- **Unattended runs never auto-capture; next interactive intake surfaces unmined notes** — rejected: auto-appending unreviewed learnings from headless completions. Silent file writes erode trust; capture always passes through accept/edit/dismiss.
- **The retro-reference sweep includes both .claude-plugin manifest descriptions** — rejected: sweeping only skills/, references/, README. Both manifests advertise /ideation:retro; without them the plugin ships describing a deleted command.

## Feedback Strategy

**Inner-loop command**: `test ! -e skills/retro && ! grep -rq 'ideation:retro' skills/ references/ README.md .claude-plugin/ && grep -qi 'also seen in' references/learning-filter.md && echo PASS`

**Playground**: The criterion grep battery; all changes are prose/manifest plus one file deletion.

**Why this approach**: No executable surface; the greps pin lifecycle presence, sweep completeness, and both invocation points.

## File Changes

### New Files

| File Path | Purpose |
| --- | --- |
| `references/learning-filter.md` | The relocated lifecycle: note categories, generalization filter (qualifying/disqualifying examples, the "would this change a future question or spec?" test), ≤3-candidate rule, silent-on-zero rule, dedupe "Also seen in" amendments, retirement discipline (verified, not guessed; delete outright), bootstrap header, dated entry format, "write nothing rather than noise" |

### Modified Files

| File Path | Changes |
| --- | --- |
| `skills/execute-spec/SKILL.md` | Interactive completion: filter invocation bounded to this project's notes, up to 3 candidates, silent on zero, one accept/edit/dismiss question, write per lifecycle; replace the `/ideation:retro` handoff line with nothing (capture is now inline) |
| `skills/autopilot/SKILL.md` | Same capture step appended to the Completion Report for watched runs (aggregate the run's phase notes); unattended runs explicitly skip; remove the retro pointer from the completion text |
| `references/interview-engine.md` | Intake: visible attribution line format; bounded unmined-notes scan + one-time mining offer; gate-tracking section gains the scoreboard: after each answered question, print one line — `Gates: {n}/5 ready — open: {labels}` (use the word "scoreboard" in the instruction) |
| `skills/express/SKILL.md` | Remove the `/ideation:retro` completion line (file is the thin alias after Phase 2 — this may be a no-op if Phase 2's rewrite already omitted it; verify with grep) |
| `skills/ideation/SKILL.md` | Remove any retro mentions (bundled-resources or handoff text) |
| `README.md` | Delete the Retro section; update line-3 description and any What's New/diagram references; describe the new capture flow in one short paragraph |
| `.claude-plugin/plugin.json` | Version → 0.19.0; description scrubbed of retro, updated for one-door flow + inline learning capture |
| `.claude-plugin/marketplace.json` | Description mirrored from plugin.json |

### Deleted Files

| File Path | Reason |
| --- | --- |
| `skills/retro/SKILL.md` (the whole `skills/retro/` dir) | Absorbed: lifecycle → learning-filter.md; trigger → completion capture + intake surfacing |

## Implementation Details

### Component 1: `references/learning-filter.md`

**Pattern to follow**: `skills/retro/SKILL.md` Steps 3–5 and Key Principles — this is a relocation with light re-framing, not a rewrite. Keep the qualifying/disqualifying examples verbatim; they are the filter's teeth.

**Key decisions**:

- Frame the reference as invocation-agnostic: "invoked at interactive completion (bounded to one project) or at intake (unmined-notes mining)" — the two callers pass different inputs through the same rules.
- The `## {YYYY-MM-DD} — {project}` entry format, bootstrap header, "Also seen in" dedupe, and verified-retirement rules move unchanged.
- Add the two new rules the contract pins: ≤3 candidates per capture moment; zero candidates → silence.

**Feedback loop**: none (reference doc); the criterion grep is the check.

### Component 2: Completion capture (execute-spec + autopilot)

**Pattern to follow**: the completion-report sections in each file; the accept/edit/dismiss shape mirrors AskUserQuestion usage elsewhere in the repo (options + Other for edits).

**Key decisions**:

- Gate on interactivity: `--headless` execute-spec runs and unattended autopilot runs skip capture entirely (their notes wait for intake surfacing).
- Bounding: only the just-finished project's `implementation-notes-phase-*.html` (and this run's noted gap-decisions) are input — never a repo-wide scan at completion.
- The question, when it fires, is ONE AskUserQuestion (multiSelect over candidates: selected = accept; "Other" = edit; none = dismiss), phrased with the candidate text inline. Include the phrases "up to 3" and "accept/edit/dismiss" in the instructions (criterion grep).

**Implementation steps**:

1. Append the capture step to execute-spec's interactive completion path; reference the filter file.
2. Same for autopilot's Completion Report (watched runs only).
3. Remove both files' retro handoff lines.
4. Run the behavioral greps.

### Component 3: Intake attribution + unmined surfacing + scoreboard (interview-engine.md)

**Pattern to follow**: the existing "Read accumulated learnings" intake paragraph (line ~27) and the gate-tracking section.

**Key decisions**:

- Attribution is one line at the moment a learning shapes something, not a banner: `Applying learning from {project} ({date}): {one-clause why}` — include the phrase "applying learning" (criterion grep).
- The unmined scan is a single glob + mtime comparison (`implementation-notes-*.html` newer than learnings.md, or any notes when learnings.md is absent); on hits, one offer — mine now (run the filter, same accept/edit/dismiss), or skip (never re-nag within the session). Include the word "unmined".
- Scoreboard: one line after each answer, from the same gate state the engine already tracks; the instruction lives ONLY here (criterion: absent from both SKILL.mds).

### Component 4: Deletion sweep + release

**Implementation steps**:

1. `git rm -r skills/retro`.
2. Sweep: `grep -rn 'retro' skills/ references/ README.md .claude-plugin/ workflows/` and update every hit that refers to the command (leave unrelated words like "retrospective" in research citations alone if any).
3. plugin.json: version 0.19.0 + description; mirror description to marketplace.json.
4. Full criterion battery.

## Testing Requirements

### Unit Tests

| Test File | Coverage |
| --- | --- |
| All three engine suites | Regression only — nothing here touches the engine |

### Manual Testing

- [ ] Read learning-filter.md against retro SKILL.md Steps 3–5: no lifecycle rule lost
- [ ] Dry-run read: a clean interactive completion produces zero learning output (silence verified in prose)
- [ ] Dry-run read: intake with an existing learnings.md attributes visibly; with orphaned notes, offers mining once

## Error Handling

| Error Scenario | Handling Strategy |
| --- | --- |
| learnings.md absent at capture time | Bootstrap with the header from the lifecycle reference (relocated retro rule) |
| learnings.md absent at intake scan | All notes count as unmined; offer once |
| Malformed prior learnings.md | Intake treats entries as hints only (existing rule); capture appends per format without parsing old entries beyond dedupe scan |

## Failure Modes

| Component | Failure Mode | Trigger | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| learning-filter.md | Lifecycle rule dropped in relocation | Paraphrasing Steps 3–5 | learnings.md rots (duplicates, stale entries) | Relocate verbatim where possible; manual diff read against retro |
| Completion capture | Prompt fatigue returns | Firing on zero candidates | The exact pathology being fixed, relocated | Silent-on-zero pinned in prose and in the filter reference |
| Intake scan | Unbounded cost | Scanning file contents instead of glob+mtime | Every interview opener slows | One glob, one stat comparison; contents read only after the user accepts mining |
| Sweep | Marketplace description drift | Editing plugin.json only | Store listing advertises deleted command | Mirror rule pinned; criterion greps .claude-plugin/ |
| Scoreboard | Duplicated into skill files | Adding it to SKILL.mds "for visibility" | Drift between three copies | Criterion asserts engine-only |

## Validation Commands

```bash
# Criteria 7-9: deletion + sweep + lifecycle
test ! -e skills/retro
! grep -rq 'ideation:retro' skills/ references/ README.md .claude-plugin/
grep -qi 'also seen in' references/learning-filter.md && grep -qi 'retire' references/learning-filter.md && grep -qi 'pattern' references/learning-filter.md

# Criteria 10-12: capture behavior + intake + scoreboard
grep -qiE 'accept/edit/dismiss|up to 3' skills/execute-spec/SKILL.md && grep -qiE 'accept/edit/dismiss|up to 3' skills/autopilot/SKILL.md
grep -qiE 'applying learning|unmined' references/interview-engine.md
grep -qi 'scoreboard' references/interview-engine.md && ! grep -riq 'scoreboard' skills/ideation/SKILL.md skills/express/SKILL.md

# Criterion 16: engine tests + version
node --test test-fixtures/orchestration/graph.test.mjs workflows/wave-planner.test.mjs workflows/execute-contract.smoke.test.mjs && grep -q '"version": "0.19.0"' .claude-plugin/plugin.json
```

## Rollout Considerations

- **Rollback plan**: branch deletion; retro's full text survives in git history if the loop ever needs re-litigating.
- Existing learnings.md files (none known) remain compatible — the entry format is unchanged.

## Open Items

None.

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
