# Native Pi change workflow

The legacy Claude Code contract/autopilot and Pi engine behavior remain supported; in
Pi, that planning path runs as `/skill:ideation`, `/skill:autopilot` and so on. The
change workflow's front door is `/ideation`. Native workers require Pi SDK 0.87.1 or newer;
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
   confirmation summarizes the boundaries—the complete agreement and exact
   commands stay in the browser. Confirmation starts background work immediately.
   That already-reviewed page becomes the run's live page, retaining its annotations.
   With `@nicknisi/pi-artifacts` 1.6.0 or newer, the live draft page also shows
   **Approve in Pi**. It asks the owning Pi session to open that same confirmation;
   the terminal answer is still the approval. The button appears only while that
   session is listening, never on a saved file, and a request while a confirmation
   is already open, or for a change that is already running, is refused.
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

The explicit `plan`, `approve`, `status`, `review`, `pause`, `resume`, `stop`,
`accept`, `exit` and `motion` subcommands remain available; run controls take an
optional run ID. `/ideation <tab>` completes subcommands, then `motion on|off` and
run IDs. An explicit brief path remains supported for
power users. Pause waits for a safe boundary; stop waits for owned processes to
settle. Blocked runs can be set aside without deleting their work.

There are no time, token or attempt budgets. A run keeps going until it is ready for
review or you pause, stop or leave it. When checks fail, their output goes to the
fixer as findings, and every new attempt is told what went wrong last time. A scout's
doubts about an approved brief are handed to the builder instead of stopping the run.
It stops to ask only when it cannot make progress: an attempt that changed nothing and
failed exactly as before, three attempts in a row ending on the same failure, or a
model provider that keeps failing after spaced retries. **Resume** always
continues the same run in the same worktree. **Start fresh (new approval)** reuses the
agreement as a new revision in a new worktree; only after that approval is the prior
run set aside, and its worktree and work are retained. Token and cost usage are
recorded in the run for information and never stop it.

The model tool accepts `action: "prepare", brief: { ... }` as a typed object, not a
JSON-encoded string. The host stores an immutable canonical copy in the Git directory
and publishes the readable copy to `docs/ideation/<change-id>/`; neither the user nor
the model needs a temporary-file workaround. Existing `path` input is still supported.
Preparation never approves.

Uncommitted work never blocks approval. If the checkout has any, approval asks where
the run should start:

- **From the last commit** — your changes are left exactly where they are and are not
  part of the run.
- **Including your uncommitted files** — tracked edits, staged changes and untracked
  (non-ignored) files are snapshotted as the run's starting commit, built in a private
  Git index. Your files, index and HEAD are not touched, and the included files do not
  count against the approved paths.

The confirmation states the starting point, and the contract's run record keeps it.
The run's branch is created from that recorded starting point even if HEAD moves
afterwards. Local artifact previews and the change's own `docs/ideation/` files are
never treated as your uncommitted work.

Headless sessions cannot approve or accept. The model tool exposes only `prepare`,
`status`, `receipt`, `feedback`, `answer` and `exit`. Human artifact feedback is persisted
before a parent/coordinator follow-up. Model-authored feedback is inbox-only, avoiding
self-directed follow-up loops. Neither is permission or inserted into builder
instructions. Changed scope requires new explicit approval.

## Leaving ideation

You are never stuck in it. `/ideation exit` — or **Leave ideation**, always in the
`/ideation` menu — works from any state:

- a working run is stopped;
- if the run changed anything, you choose to **bring the work into your checkout**
  (its commits, uncommitted edits and new files arrive as ordinary uncommitted
  changes) or **keep it on its branch**; a patch that does not apply cleanly writes
  nothing and the work stays on the branch;
- the exact final state is kept under `refs/ideation/<run-id>/exit`, and the worktree
  is removed only after the work applied cleanly;
- the widget and status link go away, and a left run or draft never comes back on its
  own. The next `/ideation` starts something new.

You can also just tell the agent to leave ideation; the `ideation_change` tool's `exit`
action does the same and brings the work over.

After updating ideation, quit and restart Pi: `/reload` does not refresh every module.
A run that says Pi is running an out-of-date copy of ideation is telling you exactly
that; nothing is lost, and Resume works after the restart.

## Trust and durability

Exact approved shell commands may execute project scripts with host permissions.
This is a trusted-command/tool policy, **not an OS sandbox**. Review commands and
repository code before approval. Dependency manifests and protected internals remain
outside native authority. The host owns checks and local commits; hooks and signing
are not bypassed, and their processes stop when you pause or stop the run. Checks,
hooks and workers have no time limit of their own.
For Node/Bun projects, installed `node_modules` trees (including tracked workspace
packages' local dependency links) can be privately copied or reflinked into the
worktree after manifests and lockfiles match. No install command
or dependency change is silently authorized, and the worker cannot patch dependency
internals to make its checks pass. Other environment setup may need explicit work.

The documents are yours to keep. Each change gets `docs/ideation/<change-id>/` in the
checkout (or `<change-id>-change/` when a planning-path project already uses that
folder):

- `brief.json` — the agreement, rewritten on each revision;
- `contract.html` — the self-contained contract page, refreshed when the run changes
  state (draft, approved, running, ready for review, accepted, and so on);
- `receipt.json` — the source-bound record of units, checks and decisions, written
  once the run is ready for review and again on acceptance.

Nothing commits them. Commit them with the change if you want them in history, or
ignore `docs/ideation/` if you do not. Run state, immutable approval copies,
model/owner metadata, child artifacts, worktrees and live HTML views stay under the
Git common directory's `ideation/` and remain available after execution. Session exit,
reload or switch disposes feedback subscriptions and interrupts owned work. There is
no auto-restart daemon: inspect status and explicitly resume after reconciliation.
A previously approved run may be resumed in a headless host: the command waits for
settlement rather than detaching and letting the process exit. Briefs written before
budgets were removed still carry their old limit fields; they are accepted unchanged,
so existing approvals hold, and ignored. Status detects changed source on completed runs and shows stale
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

From 1.6.0, a subscriber may also accept page requests. Ideation accepts only
`approve`, on the live draft page, and answers it by opening its normal terminal
confirmation; anything that can reach the local server could send a request, so a
request is never treated as approval.

Without a service, a durable `file://` view is used. It updates on disk; refresh the
browser manually. No live transport or annotations are claimed in fallback mode.
Provider failure warns and exposes the local view; it never changes a run outcome or
turns failed approval into success. No additional server or dependencies are required.
