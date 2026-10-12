# plan-migrate fixtures

Synthetic inputs for `scripts/plan-migrate.test.mjs`. The committed 0.x
contracts (`git ls-files '*contract-data.json'`) are the main inputs; this
folder adds what none of them has.

- `brief-only/`: a change workflow folder, `brief.json` plus its `receipt.json`
  and no `contract-data.json`. The brief carries both decision shapes (with and
  without `rejected`), a high-risk unit with a design, and fields the plan does
  not carry (`delegated`, `executionMode`), so the 1:1 round trip is tested
  apart from exactly those.

The test copies each folder to a temp directory before converting it; nothing
here ever gets a `plan.json`.
