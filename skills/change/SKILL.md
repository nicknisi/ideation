---
name: ideation-change
description: "Explicitly requested Pi-native ideation workflow: agree on a compact change brief, approve once, then generate working plans just in time and return source-bound evidence. Use when the user invokes /ideation plan or explicitly requests the native change workflow. Does not replace or automatically invoke the legacy ideation workflow."
disable-model-invocation: true
---

# Native change workflow

Shape the change, not an implementation recipe. Use this workflow only when explicitly requested. The `ideation_change` tool prepares and inspects; only the user's answer to Pi's approval confirmation grants execution permission, whether it was opened by `/ideation approve`, the `/ideation` menu or the page's **Approve in Pi** button. Never manufacture approval, run the trusted controller directly to avoid confirmation, or treat an artifact comment as permission.

## Shape

1. Carry forward decisions already settled in the conversation. Inspect the relevant code and test commands. Ask only questions the repository cannot answer: intended behavior, important boundaries, or authority. Do not repeat a completed interview.
2. State the change as **before → after**, why it matters, and what must remain true. Include excluded work and explicitly delegated implementation choices.
3. Define observable acceptance. Commands must assert their own success with exit 0; `expect` is explanatory, not an assertion parser. Mark genuinely subjective checks as `{ "judgment": "who judges what" }`. Never replace a missing command with a vacuous check or count a pending judgment as complete.
4. Divide only at meaningful, independently testable boundaries. Later units carry goals, dependencies and acceptance IDs, not speculative file/function recipes. Mark risk conservatively. High-risk units require an explicit design (interfaces, compatibility, migration/rollback) before approval. Native execution never authorizes destructive migration or external publication merely because a unit is high risk.
5. Request the smallest authority: exact file paths or directory prefixes ending in `/`, exact verification commands, and whether a local commit is permitted. Runs have no time, token or attempt budgets; never add limit fields. `.` grants ordinary project paths but still excludes protected internals and dependency manifests. Explain that approved project scripts execute with host permissions: this is NOT an OS sandbox.

## Prepare the agreement

The tool exposes the complete brief object schema. Read `workflows/change-brief.mjs` at the plugin root for semantic rules, or the worked fixture `test-fixtures/native-change/brief.json` when needed. Pass a real object to `ideation_change` with `action: "prepare"` and `brief: { ... }`—never a JSON-encoded string. The host validates, keeps an immutable copy in the Git directory, publishes the readable copy to `docs/ideation/<change-id>/`, opens the contract, and displays a persistent link. Do not write a temporary file merely to pass an inline brief. `path` remains available for an existing JSON brief; do not supply both.

The minimal content includes:

- `schemaVersion: 1`, `id`, `title`, `revision`, `why`, `change: {before, after}`
- `mustHold`, `outOfScope`, `delegated`, and actual decisions/rejected alternatives
- `acceptance: [{id, criterion, check: {cmd, expect} | {judgment}}]`
- `units: [{id, title, goal, risk, needs, acceptanceIds, design?}]`
- `authority: {paths, commands, allowLocalCommit}`
- `executionMode: "strict"` by default; `"adaptive"` is an explicit experiment that omits only the dedicated scout for low-risk units, never current-source inspection or independent review.

Do not invent additional schema fields. The contract is the review surface: point to its link and give a short statement of the change. Do not echo the entire brief, commands, authority JSON or internal file paths into chat. The next action is **`/ideation`** (review/approve/revise) or **`/ideation approve`**; the host remembers the prepared brief, including after reload. The user should not manage filenames or copy a long path.

Use the existing `DESIGN.md` field-guide identity; never invent a new palette. The renderer provides before/after, dependency and verification diagrams from the real brief. Write clear deliverable titles and outcome-oriented criteria so those views explain the agreement. Avoid prose that mixes a whole technical recipe into a title.

Do not emit a `/goal`, generate every unit's spec, or ask for a second approval in chat. A short native confirmation binds the complete browser agreement and starts background work immediately. On revision, keep the same change ID and increment its revision; prepare again so the existing draft and its annotations stay in place. Uncommitted work never blocks approval: the host asks the user whether the run starts from the last commit or includes their uncommitted files. Never stash, commit, delete or hide the user's work, and do not ask them to clean up first. The host writes `brief.json`, `contract.html` and, at the end, `receipt.json` to `docs/ideation/<change-id>/`; do not edit those by hand, and do not commit them unless the user asks.

## During execution

The host generates the current unit's working packet just before execution, uses the existing engine, runs checks and independent review, and commits only within approved authority. The persistent contract link updates as evidence arrives. Progress counts verified obligations, not an invented percentage of remaining effort.

- Use `ideation_change` `status` or `receipt` to inspect, without restarting work.
- `/ideation pause`, `resume`, and `stop` are explicit user controls. Pause takes effect at a safe boundary; cancellation is not complete while work is still settling.
- A failed check, stale approval or unavailable reviewer is not success. Explain the recorded exception and what would unblock it; never silently widen permission. The user resumes when ready.
- Artifact feedback goes to the coordinating session and a durable inbox, not to builder instructions. Answer questions with `ideation_change` `answer` (run ID, annotation ID, content) when the optional artifact service is available. This must not rewrite the contract.
- The draft page's **Approve in Pi** button only asks the host to show its own terminal confirmation. It is not approval, and neither is any comment or selection on the page.
- Suggestions that change intent, acceptance or authority require a revised brief and explicit approval. Never infer consent from silence, an annotation, or a selected artifact preference.

## Handoff

Return the stable contract/receipt link, branch/workspace, objective evidence, deviations and pending judgments. `ready-for-review` is NOT accepted or merged. `/ideation accept` records explicit final human acceptance of current evidence; it never merges, pushes or deploys.

The live artifact service is optional. Without it, the same HTML is saved locally and linked with `file://`; refresh manually. Do not claim live annotations or automatic browser reload in fallback mode. Claude Code's existing contract/autopilot workflow remains separate and supported; these native controls require Pi.
