# run-contract fixture

`manifest.json` is the engine manifest `/ideation:autopilot` builds (Step 1 and
Step 3) from the `run-contract.json` that `node scripts/plan-data.ts
run-contract` writes for `test-fixtures/plan/plan.json`, when that plan lives in
`docs/ideation/send-retry/`. The mapping is prompt-only, so this file is the
worked example of it:

- `projectName`, `slug`: the brief's `title` and `id`; `projectDir` is the plan folder.
- `strict`: always `true` for a run contract.
- one phase per brief unit, in brief order: `title` is the unit's title, `specPath`
  its packet (`unit-<id>.md` beside `plan.json`), `prereqs` the titles of the units
  it `needs`, `risk` unchanged, and `files` the packet's File Changes list (the
  brief's `authority.paths`).

`scripts/plan-data.test.mjs` writes the run contract for the plan fixture and
checks this manifest against it, so the example can't drift from what the CLI
writes. `TODO(4.2)`: autopilot reads plan data and unit packets directly.
