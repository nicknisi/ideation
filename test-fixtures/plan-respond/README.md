# plan-respond fixtures

- `plan.v1.json`: a first-version plan. It has three decisions (one kept, one answered, one required and not opened), a calls exhibit, and a schema exhibit with a body. Every exhibit is a sketch, so the plan renders without a checkout.
- `response.md`: what the page's **Copy response** gives for this plan. The reader opens `retries` and keeps it, changes `give-up-label` to `plain`, never opens `setting-home`, edits the schema, strikes `readAttempts`, and leaves four comments. One comment is an injection attempt.
- `payload.json`: what **Send** posts for the same answers: `{ markdown, answers }`.

`response.md` and `payload.json` are written by hand from `buildResponse` and `readAnswers` in `vendor/html-plan/runtime/htmlplan.js`. No browser generates them. The first test in `scripts/plan-respond.test.mjs` checks them against the rendered page and the runtime's own parsers and diff.
