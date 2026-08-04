# Implementation Spec: UX De-Jank & Learning Loop - Phase 4

**Contract**: ./contract.md
**Estimated Effort**: M

## Technical Approach

Replace `references/workflow-example.md` with `docs/workflow-example.html` — a self-contained, animated, deliberately whimsical end-to-end walkthrough of the 0.19 one-door flow, built for humans (linked from the README), not for model consumption. This is a taste-critical artifact: it should feel like a tiny illustrated storybook of the pipeline, not a rendered slide deck.

The page walks one fictional feature (pick something charming and concrete — e.g. "a bookmark garden") through the full flow as sequential, scroll-revealed vignettes: the messy brain dump → the interview (questions landing one at a time, the gate scoreboard ticking `2/5… 3/5… 5/5`, one strawman moment where a sketch gets a "no, more like this" reaction) → the four critics descending on the draft contract (give each lens a visual persona — magnifier for scope-creep, wrench for over-engineering, tangled thread for hidden-dependency, checkmark gavel for success-criteria) → the routing fork (express finish vs full review, with the recommendation reasoning visible) → execution waves committing phase by phase → the completion moment proposing two learnings, one accepted → the next interview visibly applying it. The loop closing IS the punchline: the last vignette echoes the first with the learning applied.

All CSS/JS inline, zero external requests (no fonts, no CDNs, no images — draw with CSS/inline SVG). Animations are CSS-first (`@keyframes`, scroll-driven reveals via IntersectionObserver in a small inline script), respectful of `prefers-reduced-motion`, and theme-aware (`prefers-color-scheme` for light/dark). Target: opens instantly from the file system via `open docs/workflow-example.html`.

## Decisions Considered and Rejected

_Carried from the contract; consult before making gap decisions._

- **The workflow example becomes a self-contained animated HTML page replacing references/workflow-example.md** — rejected: rewriting the markdown walkthrough in place. The walkthrough is human-facing and no skill instruction reads the md file; resource lists must drop the dangling reference.
- **/ideation is the one door; express is a thin pre-commit alias** (context for the content) — the page must depict the post-interview routing fork as the flow's centerpiece, not the old two-command choice.
- **Zero qualifying candidates at completion produces no prompt** (context for the content) — the learning-capture vignette must show the prompt because candidates exist, not as an always-on step.

## Feedback Strategy

**Inner-loop command**: `open docs/workflow-example.html`

**Playground**: The browser — reload after each vignette is added; check both color schemes (macOS: System Settings appearance toggle, or DevTools emulation).

**Why this approach**: A visual artifact's only meaningful check is looking at it; the greps below only pin self-containment and animation presence.

## File Changes

### New Files

| File Path | Purpose |
| --- | --- |
| `docs/workflow-example.html` | The animated walkthrough (single file, everything inline) |

### Modified Files

| File Path | Changes |
| --- | --- |
| `skills/ideation/SKILL.md` | Bundled Resources: drop the workflow-example.md line (add a "human-facing walkthrough: docs/workflow-example.html" note only if the section's grain fits) |
| `README.md` | Link the example page where the old walkthrough was referenced |

### Deleted Files

| File Path | Reason |
| --- | --- |
| `references/workflow-example.md` | Superseded by the HTML page; nothing model-facing reads it |

## Implementation Details

### Component 1: The page

**Pattern to follow**: none in-repo — this is a from-scratch creative artifact. Honor the repo's existing contract.html aesthetic (check `scripts/contract-gen.css` for its palette/tokens) enough to feel like family, then exceed it in playfulness.

**Overview**: One HTML file, ~8 scroll vignettes, each a `<section>` revealed by IntersectionObserver adding a class; within sections, CSS keyframe loops animate the persistent characters (gate pips, critic personas, phase commits).

**Key decisions**:

- Structure: sticky progress rail (the 5 gate pips doubling as page progress), vignette sections, a closing "run it yourself" footer with the two commands (`/ideation` and `/ideation:express`).
- Whimsy budget: personas, easing, micro-copy ("the critics have OPINIONS") — but the flow depicted must be **accurate to 0.19 behavior**; every UI moment shown (scoreboard line, routing question, capture question) mirrors the real prose shipped in Phases 1–3. Read the final SKILL.md/interview-engine.md text before writing the vignette copy.
- `prefers-reduced-motion: reduce` → all keyframe/transition animation collapses to static reveals (media query, not JS).
- Theme-aware via `prefers-color-scheme` with CSS custom properties; both themes checked before done.
- No external requests of any kind: no `<script src=`, no `<link href=`, no `url(http…)`, no web fonts. System font stack.

**Implementation steps**:

1. Read the shipped Phase 1–3 artifacts (ideation SKILL.md step 7, interview-engine scoreboard/attribution text, learning-filter capture shape) so the depicted flow is factual.
2. Skeleton: sections + progress rail + reveal observer + reduced-motion and dark-mode plumbing.
3. Vignettes in order; keep each one's animation self-contained.
4. Micro-copy pass: every vignette caption earns a smile without obscuring what's happening.
5. Both-themes + reduced-motion + file:// checks.

**Feedback loop**:

- **Playground**: browser reload per vignette.
- **Experiment**: check at narrow (375px) and wide (1440px) widths; dark and light; reduced-motion on and off; total file size sanity (< ~200KB since everything is inline text).
- **Check command**: `grep -qi '@keyframes' docs/workflow-example.html && ! grep -qiE '<script src=|<link [^>]*href=|url\(http' docs/workflow-example.html`

### Component 2: Reference sweep

**Implementation steps**:

1. `git rm references/workflow-example.md`.
2. `grep -rn 'workflow-example' skills/ references/ README.md .claude-plugin/` — update every hit to the new path or remove.
3. Run the criterion grep.

## Testing Requirements

### Unit Tests

None — static artifact. Engine suites unaffected.

### Manual Testing

- [ ] Page opens from file://, animates, and reads top-to-bottom as a story
- [ ] Dark mode and light mode both look intentional
- [ ] `prefers-reduced-motion` yields a fully readable static page
- [ ] Every depicted UI moment matches the shipped 0.19 prose (scoreboard wording, routing options, capture question shape)
- [ ] No horizontal scroll at 375px width

## Error Handling

| Error Scenario | Handling Strategy |
| --- | --- |
| JS disabled | IntersectionObserver reveals degrade: all sections visible by default, observer only adds polish (progressive enhancement — base state is visible, not hidden) |

## Failure Modes

| Component | Failure Mode | Trigger | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| Page | Depicts the pre-0.19 flow | Writing vignettes from memory instead of the shipped prose | The showcase teaches the old jank | Implementation step 1 mandates reading the final artifacts first |
| Page | Hidden-by-default sections | Reveal pattern hides content when JS fails | Blank page over file:// edge cases | Base-visible + enhancement-only observer |
| Page | Whimsy over clarity | Decoration outpacing information | Fun but useless walkthrough | Each vignette must answer "what happened in the flow here?" in one caption line |
| Sweep | Dangling md references | Missing a resource-list mention | Docs point at a deleted file | Criterion grep covers skills/, references/, README |

## Validation Commands

```bash
# Criterion 13: exists, animates, self-contained, no dangling md references
test -f docs/workflow-example.html && grep -qi '@keyframes' docs/workflow-example.html && ! grep -qi '<script src=' docs/workflow-example.html && ! grep -riq 'workflow-example.md' skills/ references/ README.md

# Engine regression (unchanged, cheap)
node --test test-fixtures/orchestration/graph.test.mjs workflows/wave-planner.test.mjs workflows/execute-contract.smoke.test.mjs
```

## Rollout Considerations

- **Rollback plan**: branch deletion; the md's text survives in git history.
- README links the page; consider a GitHub Pages link later (out of scope).

## Open Items

None.

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
