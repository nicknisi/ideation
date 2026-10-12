## Are specs outdated? A qualified opinion

First, the boundaries of what I can say. I have not inspected the ideation repository, and I have not benchmarked Astra, Fable 5.1, or any other model against each other. Everything I assert below about the current system comes from your description: ideation interviews until problem, goals, acceptance, scope, and consistency are clear; emits contract artifacts in JSON/HTML/MD plus mandatory implementation specs with file tables, component recipes, tests, and failure modes; runs scout-build-review-fix-commit; Express drops the approval ceremony but keeps the artifacts; there are already command/judgment acceptance checks, strict execution, commit-based resume, and run reports. Everything else is opinion, and I'll flag where it's opinion resting on weak ground.

### The short answer

Specs are not outdated. *Implementation specs* are increasingly a liability, and the field has been conflating the two for about two years.

The dogma of spec-driven development (SDD) — write the file table, the component recipe, the test list, then let the agent execute — was a rational response to models that lost the thread mid-task, invented APIs, and couldn't hold a codebase in their head. The recipe was a prosthetic for weak planning and weak recall. As models get better at scouting a codebase and sequencing their own work, that prosthetic starts costing more than it returns: it's written before the agent has read the code, it goes stale the moment the scout phase learns something the interview didn't know, and it invites a failure mode where the agent obeys the recipe over the codebase.

What does *not* get cheaper with model capability is the information the model cannot derive from the repository: what you actually want, what must never change, how you'll know it's done, and what the agent is permitted to touch. That's intent, invariants, acceptance, and authorization. Those aren't "specs" in the SDD sense. They're a contract, and they remain the highest-leverage thing a human produces.

### Distinguish the four from the recipe

- **Intent** — the problem and why now. This is the thing that lets an agent make a good call when the recipe is wrong, which it will be.
- **Invariants** — what must remain true: API compatibility, performance envelopes, "don't touch billing," style constraints. These are cheap to state and catastrophic to omit.
- **Acceptance** — how you'll judge done. You already have command-based and judgment-based acceptance checks; that machinery is, in my view, the most durable part of what you've built.
- **Authorization** — blast radius: which paths, which dependencies, whether migrations or public interfaces are in scope.

Everything else — file tables, component recipes, ordered steps — is a recipe. Recipes should be produced by the agent, at execution time, as a *plan it shows you*, not as an artifact you author and freeze. The scout phase already exists; the plan should come out of it, not precede it.

### A minimal brief

If I were designing the artifact for the hands-off mode you describe, it would be one Markdown file, ideally under a screen:

```
# <title>
## Change    — one paragraph: what will be different when this lands
## Why       — the problem; what breaks or is missed today
## Must hold — invariants, 2–6 bullets
## Done when — acceptance checks, each tagged command|judgment
## Allowed   — paths / deps / interfaces in scope; explicit out-of-scope
## Open      — anything the interview didn't resolve (agent decides, logs)
```

That's the contract. JSON stays as the machine form for your acceptance runner and resume logic; HTML I'd drop unless someone outside the loop consumes it. The "Open" section matters: it makes the agent's discretion explicit rather than hidden inside a recipe that pretends to have resolved everything.

The run report then becomes the second half of the story — the "what I actually did and why it differs" — and the pair (brief + report) replaces the spec as the record. That's compact, change/why-focused, and fits native Pi states: brief authored, direction agreed, executing, checks passing/failing, report ready.

### When detailed specs still help

I don't think the recipe is always wrong. It earns its keep when:

1. **The change spans sessions or agents** and the recipe is the coordination medium. Commit-based resume helps but doesn't carry rationale.
2. **The architecture is novel** to the codebase — a new subsystem with no existing pattern to scout. Here the recipe is a design document, and a human should read it *before* execution.
3. **Cost of a wrong direction is high** — schema migrations, public API, security-sensitive paths. You want the plan surfaced and approved even in hands-off mode.
4. **Trust is low** — a new codebase, a model you haven't run in this repo before, or a task the interview flagged as ambiguous.

Notice these are properties of the *task*, not a global setting. Which leads to:

### Adaptive review

Rather than Express-vs-full as a user-selected mode, make the depth of both planning and review a function of a risk estimate computed from the brief and the scout: number of files touched, whether paths in the "Allowed" section include anything the repo marks sensitive, whether acceptance is mostly judgment-based (less verifiable) versus command-based, and whether the agent's plan diverges from the brief's Change section. Low risk: no plan surfaced, run, report. Medium: surface a plan summary with a timeout-to-proceed. High: pause for approval on the plan, and require a second review pass. Hands-off after agreeing direction is preserved; the system just decides how much to show you, and you tune the thresholds.

### Failure modes — of dogma and of this proposal

The SDD dogma fails by **over-specification**: the agent implements a stale recipe, the codebase drifts under it, and the elaborate artifact gives false confidence. It also fails on **human cost** — nobody reads the fourth file table, so the review step becomes theater, which is presumably what motivated Express.

But the compact-brief proposal has its own traps, and I'd rather name them than sell you the design:

- **Invariants are undersupplied.** People are bad at stating what must not change until it changes. A brief with an empty "Must hold" is worse than a recipe, because it looks complete.
- **Judgment-based acceptance drifts.** Without concrete recipes, the agent's interpretation of "done" can satisfy the letter of a judgment check while missing the intent. Mitigation: require at least one command-based check, or one that fails on the current codebase before work begins.
- **Discretion hides decisions.** An agent that fills "Open" items silently makes architectural calls you'd want to see. The run report has to surface every decision made under discretion, not just diffs.
- **Resume loses rationale.** Commit-based resume tells you where the agent is, not why it chose that path. If the plan isn't an artifact, mid-run state is opaque.
- **Adaptive review is only as good as the risk signal.** A miscalibrated estimator that under-flags will teach you it's safe right up until it isn't.

### An empirical comparison you can actually run

Don't compare models; compare *artifact regimes* on your own work. Take twenty to thirty real tasks from your backlog, stratified by size and risk. Run each under (A) full spec with recipes, (B) minimal brief with agent-generated plan, and (C) minimal brief plus adaptive review. Measure: acceptance-check pass rate on first run, number of fix iterations, human minutes spent authoring and reviewing, count of invariant violations found *after* acceptance (the important one), and how often the plan diverged from the brief in ways you'd have rejected. Blind the review where possible. Thirty tasks won't give statistical certainty, but it will show whether the recipe is buying pass rate or just consuming your afternoon.

### Bottom line

Specs as contracts — intent, invariants, acceptance, authorization — are more important, not less, as agents get more capable, because they're the only channel for information the agent can't infer. Specs as recipes should migrate from artifacts you write to plans the agent proposes, surfaced with depth proportional to risk. Keep the acceptance machinery and run reports you have; shrink the authored artifact; make the plan ephemeral but the decisions logged. And treat the whole thing as a hypothesis until the comparison above tells you otherwise.