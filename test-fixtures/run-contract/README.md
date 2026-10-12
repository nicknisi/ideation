# run-contract fixture

`manifest.json` is the engine manifest Claude Code's `/ideation:autopilot` runs
for `test-fixtures/plan/plan.json` once it is approved and lives in
`docs/ideation/send-retry/`: the output of `toManifest` in
`scripts/plan-data.ts`, which `node scripts/plan-data.ts manifest <folder>`
prints from the folder's `run-contract.json`. Autopilot uses it verbatim; this
file is the worked example of what it reads.

- `projectName`, `slug`: the brief's `title` and `id`; `projectDir` is the plan folder.
- `strict`, `packet`: always `true` for a run contract. The units are approved
  packets, built directly with the same prompts Pi's change runner uses, and no
  person reviewed the packets themselves. `hostCommits` is `false`: Claude
  Code's commit stage is an agent.
- one phase per brief unit, in brief order: `title` is the unit's title, `specPath`
  its packet (`unit-<id>.md` beside `plan.json`), `prereqs` the titles of the units
  it `needs`, `risk` unchanged, `files` the packet's File Changes list (the
  brief's `authority.paths`), and `trailer` the unit's commit reference
  (`Ideation-Unit: <plan id>/<unit id>`, `unitTrailer` in `scripts/verify.mjs`).
- `completedPhases`: the units whose trailer is already on the current branch
  (none here).

`scripts/plan-data.test.mjs` checks this file against `toManifest` and the
packets `run-contract` writes, so the example can't drift from the CLI.
