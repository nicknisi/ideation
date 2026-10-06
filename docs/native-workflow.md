# Native Pi change workflow

The legacy Claude Code contract/autopilot and Pi engine behavior remain supported.
The new front door is `/ideation`. Native workers require Pi SDK 0.87.1 or newer;
older local peer dependencies can reject newer Anthropic models even when the main
Pi application is current.

1. Open **`/ideation`**. With no existing change, planning starts from the current
   conversation—no redundant one-option menu or JSON form. The agent inspects the
   code and asks only unresolved questions. `/ideation plan <idea>` is also supported.
2. The agent prepares a compact brief and **opens its contract automatically**.
   The contract uses the existing `DESIGN.md` field-guide theme, before/after views,
   dependency SVGs and deliverable → check → evidence maps. Revisions update the same
   draft page. A persistent link stays visible in Pi.
3. Open `/ideation` to review, revise or approve. **`/ideation approve` remembers the
   prepared brief**, including after reload; there is no file path to copy. Its short
   confirmation summarizes boundaries and budgets—the complete agreement and exact
   commands stay in the browser. Confirmation starts background work immediately.
   That already-reviewed page becomes the run's live page, retaining its annotations.
4. During execution, `/ideation` offers the relevant controls. Pi's theme-aware widget
   shows the current stage, reviewed deliverables during implementation, and current
   objective evidence during final verification. Elapsed time is not a completion
   estimate; there is no timer-driven progress bar. Zero-value metadata is hidden.
   While work is live, the widget animates (spinner, a highlight on the active
   step, a shine along the already-filled rule). A step strip shows each
   deliverable; one sparkles once when its review passes, and ready-for-review
   twinkles briefly, then settles. Idle widgets never redraw, and motion never
   changes a count or fill. Turn it off with `/ideation motion off` (saved in
   `~/.pi/agent/ideation.json`), or with `PI_REDUCED_MOTION=1` / `IDEATION_MOTION=off`.
   The contract page uses the same "ink & press" vocabulary: a state stamp,
   inked arrows and checks, and a token on the edges into the running step.
5. At completion, review the contract's evidence. `/ideation accept` uses a short
   confirmation; human judgments are never automatically accepted. No merge, push,
   deployment or external publication happens automatically.

The explicit `status`, `pause`, `resume`, `stop`, and `review` commands remain
available, with an optional run ID. An explicit brief path remains supported for
power users. Pause waits for a safe boundary; stop waits for owned processes to
settle. Blocked runs can be set aside without deleting their work. Budgets remain
enforced; the menu does not offer an exhausted run as if it could simply continue.
For a blocked or interrupted run, **Start fresh (new approval)** reuses the agreement
in a new revision and asks for explicit approval of fresh budgets. Only after that
approval is the prior run set aside; its worktree and work are retained.

The model tool accepts `action: "prepare", brief: { ... }` as a typed object, not a
JSON-encoded string. The host stores the canonical JSON outside the source checkout;
neither the user nor the model needs a temporary-file workaround. Existing `path`
input is still supported. Preparation never approves. Source must be clean before
execution (local artifact previews are not source changes).

Headless sessions cannot approve or accept. The model tool exposes only `prepare`,
`status`, `receipt`, `feedback`, and `answer`. Human artifact feedback is persisted
before a parent/coordinator follow-up. Model-authored feedback is inbox-only, avoiding
self-directed follow-up loops. Neither is permission or inserted into builder
instructions. Changed scope requires new explicit approval.

## Trust and durability

Exact approved shell commands may execute project scripts with host permissions.
This is a trusted-command/tool policy, **not an OS sandbox**. Review commands and
repository code before approval. Dependency manifests and protected internals remain
outside native authority. The host owns checks and local commits; hooks and signing
are not bypassed, and their processes are subject to cancellation and timeouts.
For Node/Bun projects, installed `node_modules` trees (including tracked workspace
packages' local dependency links) can be privately copied or reflinked into the
worktree after manifests and lockfiles match. No install command
or dependency change is silently authorized, and the worker cannot patch dependency
internals to make its checks pass. Other environment setup may need explicit work.

State, immutable approval copies, model/owner metadata, child artifacts and HTML views
live under the Git common directory's `ideation/`, so previewing does not dirty the
source checkout. Receipts/worktrees remain available after execution. Session exit,
reload or switch disposes feedback subscriptions and interrupts owned work. There is
no auto-restart daemon: inspect status and explicitly resume after reconciliation.
A previously approved run may be resumed in a headless host: the command waits for
settlement rather than detaching and letting the process exit. Budgets and attempt
limits survive restart; an exhausted budget requires a new explicit decision, not
an automatic reset. Token usage is accounted between workers, so a running worker
can overshoot the remaining token budget; time, turn and tool-call limits still
bound that worker. Status detects changed source on completed runs and shows stale
evidence; acceptance always rechecks the actual source.

## Optional live artifacts

The service ships in [`@nicknisi/pi-artifacts`](https://www.npmjs.com/package/@nicknisi/pi-artifacts)
1.5.0 and later; install it alongside ideation to get live pages. Earlier versions
and setups without it fall back to local HTML snapshots.

A compatible `nicknisi.artifacts` service (API major 1) is discovered synchronously on
`plugin-services:v1:discover:nicknisi.artifacts`. Exactly one offer with own callable
`publish`, `subscribe`, and `answer` methods is accepted. This compatibility handshake
is not authentication or a security boundary; installed extensions are trusted.

The same deterministic artifact identity receives ordered, coalesced HTML updates
through completion. The persistent Pi link opens the approved agreement together
with live progress, evidence, work outcomes and the feedback inbox. The localhost
URL can change ports after a server restart; the artifact slug and local file
identity stay stable, and the Pi link is refreshed. The consumer never writes annotation/evidence sidecars. Questions use
`answer`, not page rewriting. Comments go only to the owning parent session.

Without a service, a durable `file://` view is used. It updates on disk; refresh the
browser manually. No live transport or annotations are claimed in fallback mode.
Provider failure warns and exposes the local view; it never changes a run outcome or
turns failed approval into success. No additional server or dependencies are required.
