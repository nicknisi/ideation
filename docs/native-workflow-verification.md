# Native workflow verification

Implementation and subsequent dogfood fixes verified locally on 2026-09-23–24.

## Automated checks

- `node --run test` in `~/Developer/ideation`: **469 passed**, including the original 218 tests.
- `pnpm exec vitest run packages/artifacts` in `~/Developer/pi-extensions`: **38 passed** on
  `main` (`@nicknisi/pi-artifacts` 1.5.0) and **42 passed** with page requests
  (nicknisi/pi-extensions#152).
- `pnpm exec tsgo --noEmit` in `~/Developer/pi-extensions`: passed.
- `pnpm exec oxlint packages/artifacts`: passed.
- `pnpm build` in `~/Developer/pi-extensions`: **34 packages built**.
- `git diff --check` in both repositories: passed.

The native tests cover strict brief validation, scoped child tools, actual temporary
Git worktrees and commits, hooks, cancellation of command process groups, stale
source/approval, runs that no budget can stop, lease ownership, interrupted recovery, no-op verification,
independent review, boundary pause/resume, rejection of model/headless approval,
artifact adoption, optional-provider fallback, URL changes on restart, feedback
routing, and escaped/stable contract markup. Fixtures disable commit signing only
inside their temporary repositories; production commits still honor user hooks
and signing configuration.

## Real-model smoke

A real Pi 0.87.1 SDK host loaded the new native extension and optional artifacts
extension with **no extension-loading errors**. It also invoked the native
`ideation_change prepare` tool directly using real Pi bindings: validation, the
canonical brief file, `approved: false`, and the live localhost URL were confirmed.

An isolated disposable Git repository was then run through the actual native
controller with **openai-codex/gpt-6-astra**. It changed only `src/value.txt` from
`before` to `after`, preserving its newline. The adaptive path ran a read-only
just-in-time planner, builder, fresh independent reviewer, host checks and a local
commit. It reached **ready-for-review**, not accepted or merged. Total reported
usage was **42,237 tokens**. The original checkout retained `before`.

The first live attempt exposed a missing planner JSON-output instruction. That
was fixed and a fresh bounded attempt completed. This is one integration smoke,
**not** a model benchmark or evidence of quality parity with the legacy workflow.
No real product backlog or destructive action was used.

## Live contract / feedback round trip

Using the actual artifacts provider, Pi event bus, native consumer, run storage,
renderer and localhost HTTP server:

1. Published an approval page with stable element anchors.
2. Saved a question through the HTTP annotations API.
3. Adopted that same page as the run page: the slug and URL did not change.
4. Submitted feedback and verified it appeared in the correct durable run inbox.
5. Confirmed feedback did not approve, resume or otherwise change run authority.
6. Answered the question and verified the underlying contract HTML was unchanged.
7. Updated the run page and confirmed the annotation and reply survived.

The provider suite also observes a real SSE `reload` event for the stable slug and
reads the updated HTML through that same URL.

## Dogfood fixes and visual checks

The first real user attempt exposed gaps that the initial fixture did not catch:

- The inline brief was exposed as an unconstrained tool parameter. It now has a
  complete object schema; real TypeBox validation and the actual installer brief
  confirm that objects work and JSON-encoded strings do not.
- A long agreement overflowed Pi's confirmation dialog. Both approval and final
  acceptance now use bounded summaries, with complete details in the browser.
- Bare approval required a path. Prepared briefs now restore from the active session
  branch; `/ideation` offers context-sensitive actions and never requires a path.
- The worker loaded local Pi SDK 0.84.1 while the parent ran 0.87.1. Its old Anthropic
  client was rejected. Peers and the lockfile now require 0.87.1+, and real Opus 5.5
  probes succeeded both without tools and with a policy-guarded read tool.
- Isolated worktrees lacked installed dependencies. Matching Node/Bun environments
  are now privately copied/reflinked, without running an unapproved install command.
- The new document had wrongly invented a green theme. It now inlines the canonical
  field-guide CSS and uses actual SVG dependencies and promise/check/evidence maps.
- The raw four-line status dump has been removed. Real Pi SDK binding invoked the
  new widget factory and tool-card renderers at 40/60/80/120 columns.
- Widget motion (the chosen "press & sparkle" treatment): 270 frames of a scripted
  run were rendered through the real widget, Pi's dark and light themes, and
  pi-tui width helpers, with no overflow at 80 columns. The widget now mounts once
  per session; the old path rebuilt it every second. Tests pin that frames never
  change counts or fills, that sparkles and the ready celebration fire once, and
  that reloads replay nothing. They also check that idle widgets never redraw.
- Rendering the real 12-criterion brief took ~1.6s and blocked Pi's event loop on
  every live update: `validateBrief()` spawned a synchronous `sh -n` per command,
  several times per render. Syntax results are now cached by check (bounded), and
  a render takes ~1.5ms after first validation.

The actual user's long brief was rendered and visually inspected at desktop width.
That check caught and corrected SVG/row alignment. A true 390-CSS-pixel iframe
viewport also reported 390 pixels of content width, with no horizontal overflow.
(The screenshot helper's bare Chrome window flag clamps layout to at least 500px;
its cropped 390px image is not a valid mobile viewport test.) Theme cycling and
print disclosure behavior are also covered by script-level tests.

New regression tests cover contextual planning/revision, one stable draft page,
fresh approvals, resume that always continues, cancellation of blocked runs while
retaining work, cancellation of Git staging filters and commit hooks without
bypassing signing, contradictory reviewer verdicts, and preservation of
the active run's approved model. Final focused review also added regressions for
changed original briefs during live paused resume, opening the correct agreement
when another draft exists, and pnpm package-local dependency snapshots.

## Second dogfood round (2026-09-24)

A real run in another repository exposed two more problems:

- **Approval refused a dirty checkout.** It now asks whether the run starts from the
  last commit or includes the uncommitted files. The included files are snapshotted
  through a private Git index; integration tests assert that the user's files, index
  and HEAD are byte-for-byte unchanged, that `.pi/artifacts/` and the change's own
  `docs/ideation/` folder are left out, and that a rename counts once.
- **A budget stopped the run after 2.6 minutes, before anything was built.** The
  agent had written `maxTokens: 90000`. The count included cached context re-read on
  every turn (212,670 counted; about 82,000 new input and output tokens; $1.11). All
  budgets are gone. Tests pin that elapsed time and missing usage never stop a run,
  that resume always continues, and that briefs carrying the old fields still
  validate with the same fingerprint.

The same round added `docs/ideation/<change-id>/` publishing (brief, contract,
receipt; never committed, never written into a planning-path project folder) and
**Approve in Pi**. For the latter, the built pi-artifacts service served a real
rendered contract, headless Chrome was driven over the DevTools protocol, and a real
click on the revealed button reached ideation's handler with the draft's view ID;
after disposal the page offered nothing. A 348-pixel frame caught the stamp's
entrance briefly scrolling the page sideways; the contract now clips horizontal
overflow.

## Verification limits

- TUI input was **not independently driven end-to-end**, and the Approve in Pi
  confirmation dialog itself is covered by command-handler tests rather than a
  live Pi terminal. Rendered documents were visually inspected, and actual Pi widget
  factories, HTTP/SSE behavior, and command handlers were tested separately.
  Final visual/usability acceptance remains a human judgment, not a unit-test claim.
- This is a trusted local tool policy, not an OS/network sandbox. Approved test
  commands can execute repository code with host permissions.
- There is no auto-restart daemon or automatic merge/push/deployment. Process
  interruption requires explicit reconciliation and resume.
- The compact-brief vs current-express empirical study proposed in the research
  artifact has **not** been run. The execution modes are available to evaluate;
  no productivity or reliability improvement is asserted yet.

## Try it locally

Both packages are already configured as local path installs in this environment.
After `/reload` (or a fresh Pi session) in your target repository:

```text
/ideation
/ideation approve
/ideation
```

Uncommitted work does not block approval. When the checkout has any, approval asks
whether the run starts from the last commit (leaving the changes alone) or includes
them as its starting point. Either way the workflow does not stash, commit or hide
existing user changes. The artifacts bridge is optional; without it, the
persistent link opens a local HTML snapshot that can be refreshed manually.
