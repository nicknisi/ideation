export const meta = {
  name: 'execute-contract',
  description:
    'Execute an approved ideation contract: dispatch phases in dependency-ordered waves, each phase as scout → build → review → fix → commit sibling agent stages, and return a structured summary',
  phases: [{ title: 'Execute', detail: 'dependency-ordered phase waves' }],
};

/*
 * execute-contract — the deterministic phase-orchestration engine for ideation.
 *
 * Invoked by the /ideation:autopilot skill via the Workflow tool. The skill does
 * the things this sandboxed script CANNOT: it reads contract-data.json, runs the
 * git-log skip pre-pass, and owns interactive failure-gating + resume. This script
 * receives everything as `args`, plans topological waves, dispatches each phase as
 * a sequence of fresh-context sibling agents, and returns
 * { completed, noops, failed, skipped, results } for the skill to act on.
 *
 * Why a phase is FIVE agent stages and not one:
 *   A subagent running inside a dynamic Workflow cannot spawn subagents — the
 *   rejection is at the tool-gating layer ("No such tool available: Agent"), so
 *   `subagent_type` is never even parsed. The old dispatch handed one
 *   general-purpose agent the whole of /ideation:execute-spec, whose Scout and
 *   Review steps are Agent calls it could never make: every non-strict phase
 *   committed with zero review via the skill's validation-only fallback, and
 *   --strict — specified to fail closed when the reviewer is unavailable —
 *   improvised an inline review instead. The engine itself CAN call agent() with
 *   any registered agentType, so scout and reviewer become SIBLING stages one
 *   level deep. They were already designed for clean-context handoff through the
 *   filesystem and git (context-map.md; `git diff HEAD`), so nothing else moves.
 *
 * Design choices:
 *  - parallel() per wave with a full wave barrier, and deliberately NOT
 *    pipeline(). The old header claimed the barrier existed because skip
 *    propagation needs the whole prior wave's outcome; that was false — skips are
 *    per-edge and resolvable the moment one prereq fails. The real reason is that
 *    every stage below reads or writes the ONE working tree. Overlapping phase A's
 *    review with phase B's build hands the reviewer a `git diff HEAD` carrying B's
 *    half-finished edits, and A's commit stage would then stage them. The barrier
 *    is a working-tree lock, not a scheduling artifact. It also costs nothing:
 *    every contract observed to date is a linear chain of single-phase waves, so
 *    there is no cross-phase work to overlap.
 *    Scope: the barrier locks BETWEEN waves only. Inside one multi-phase wave,
 *    parallel() still overlaps A's review/fix with B's build for phases whose
 *    declared `files` do not intersect — see "Known limitation" in README.md.
 *    splitWavesByFileOverlap narrows that window; it does not close it.
 *  - Run everything still reachable; a failure only skips its dependents. The
 *    skill, not the engine, decides what to do about failures. This makes the
 *    engine safe to wrap in an unattended /goal.
 *  - Every stage goes through safeAgent(). A bare agent() call REJECTS on a
 *    crashed or schema-less return, and a rejection inside a parallel() thunk
 *    collapses the entire phase to a bare null — losing which stage died. safeAgent
 *    converts that into a typed stage failure so the summary still tells the truth.
 *  - Results are schema-validated, killing the old `RESULT: PASS` string-parsing.
 *
 * args: {
 *   projectName: string,
 *   slug: string,
 *   projectDir: string,
 *   strict?: boolean,            // fail closed on a scout HOLD or a verdict-less
 *                                // reviewer (express-approved contracts)
 *   phases: [{ title, specPath, prereqs: [titles], risk, files }],
 *   completedPhases?: [titles]   // already committed; excluded from dispatch
 * }
 *
 * KEEP IN SYNC: the four planner functions below are copied VERBATIM from
 * workflows/wave-planner.mjs (the unit-tested source of truth) — inlined because
 * the Workflow sandbox may not support relative imports. wave-planner.test.mjs
 * carries a drift test that fails when the bodies stop matching: paste, never
 * retype, and never "clean up" the copy.
 */

// ---------------------------------------------------------------------------
// Inlined planner logic (verbatim mirror of wave-planner.mjs)
// ---------------------------------------------------------------------------

function detectCycle(phases) {
  const prereqsOf = new Map(phases.map(p => [p.title, p.prereqs ?? []]));
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map(phases.map(p => [p.title, WHITE]));
  const stack = [];

  /** @param {string} title */
  function visit(title) {
    color.set(title, GRAY);
    stack.push(title);
    for (const dep of prereqsOf.get(title) ?? []) {
      // Unknown prereqs are not this function's concern; computeWaves validates them.
      if (!color.has(dep)) continue;
      const c = color.get(dep);
      if (c === GRAY) {
        // Found a back-edge: return the cycle slice.
        const start = stack.indexOf(dep);
        return stack.slice(start).concat(dep);
      }
      if (c === WHITE) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(title, BLACK);
    return null;
  }

  for (const p of phases) {
    if (color.get(p.title) === WHITE) {
      const found = visit(p.title);
      if (found) return found;
    }
  }
  return null;
}
function computeWaves(phases, completed = []) {
  if (phases.length === 0) return [];

  const titles = new Set(phases.map(p => p.title));

  // Validate prereq titles resolve.
  for (const p of phases) {
    for (const dep of p.prereqs ?? []) {
      if (!titles.has(dep) && !completed.includes(dep)) {
        throw new Error(
          `Unknown prereq "${dep}" referenced by phase "${p.title}" — no phase has that title.`,
        );
      }
    }
  }

  const cycle = detectCycle(phases);
  if (cycle) {
    throw new Error(`Dependency cycle detected: ${cycle.join(' → ')}`);
  }

  const satisfied = new Set(completed);
  const remaining = phases.filter(p => !satisfied.has(p.title));
  const waves = [];

  while (remaining.length > 0) {
    const ready = remaining.filter(p =>
      (p.prereqs ?? []).every(dep => satisfied.has(dep)),
    );
    if (ready.length === 0) {
      // Should be unreachable after cycle/unknown validation, but guard anyway.
      throw new Error(
        `Cannot resolve execution order — no phase is ready. Remaining: ${remaining
          .map(p => p.title)
          .join(', ')}`,
      );
    }
    waves.push(ready.map(p => p.title));
    for (const p of ready) satisfied.add(p.title);
    for (const p of ready) remaining.splice(remaining.indexOf(p), 1);
  }

  return waves;
}
function propagateSkips(phases, failedOrSkipped) {
  const skip = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of phases) {
      if (skip.has(p.title) || failedOrSkipped.has(p.title)) continue;
      const blocked = (p.prereqs ?? []).some(
        dep => failedOrSkipped.has(dep) || skip.has(dep),
      );
      if (blocked) {
        skip.add(p.title);
        changed = true;
      }
    }
  }
  return skip;
}
function splitWavesByFileOverlap(waves, phases) {
  const filesOf = new Map(phases.map(p => [p.title, p.files ?? []]));
  const result = [];

  for (const wave of waves) {
    if (wave.length <= 1) {
      result.push(wave);
      continue;
    }

    // subWaves[i].files is the union of files claimed by phases already in
    // sub-wave i; used for O(1)-ish intersection checks during assignment.
    const subWaves = [];

    for (const title of wave) {
      const files = filesOf.get(title) ?? [];
      let placed = false;

      for (const sub of subWaves) {
        const conflict = files.some(f => sub.files.has(f));
        if (!conflict) {
          sub.titles.push(title);
          for (const f of files) sub.files.add(f);
          placed = true;
          break;
        }
      }

      if (!placed) {
        subWaves.push({ titles: [title], files: new Set(files) });
      }
    }

    for (const sub of subWaves) result.push(sub.titles);
  }

  return result;
}
// ---------------------------------------------------------------------------
// Result contracts
// ---------------------------------------------------------------------------

/*
 * The engine's own per-phase return shape. Unlike the stage schemas below it is
 * never handed to an agent — the engine assembles it from the stage results, and
 * normalizePhaseResult() clamps it so a handler bug cannot mis-bucket a phase in
 * the skill's report.
 *
 * `reviewStatus` is the field that stops autopilot reporting a bare PASS for work
 * nothing reviewed: a phase can legitimately pass on validation alone, and the
 * skill has to be able to say so.
 */
const PHASE_RESULT_SCHEMA = {
  type: 'object',
  required: ['result', 'reviewStatus', 'summary'],
  additionalProperties: true,
  properties: {
    result: { enum: ['PASS', 'NO-OP', 'FAIL', 'SKIPPED'] },
    reviewStatus: {
      enum: [
        'passed', // reviewer ran and returned PASS (possibly after fix cycles)
        'validation-only', // reviewer never produced a verdict; committed on validation alone
        'failed', // reviewer ran and still returned FAIL at the cycle cap
        'skipped-empty-diff', // nothing to review — an honest no-op
        'not-run', // never reached review (strict scout HOLD, build failure, skip)
      ],
    },
    commitHash: { type: ['string', 'null'] },
    summary: { type: 'string' },
    findings: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
    reviewCycles: { type: 'number' },
  },
};

const PHASE_RESULTS = PHASE_RESULT_SCHEMA.properties.result.enum;
const REVIEW_STATUSES = PHASE_RESULT_SCHEMA.properties.reviewStatus.enum;

const SCOUT_RESULT_SCHEMA = {
  type: 'object',
  required: ['verdict', 'contextMap'],
  additionalProperties: true,
  properties: {
    verdict: { enum: ['GO', 'HOLD'] },
    gatesReady: { type: ['number', 'null'] },
    notReadyGates: { type: 'array', items: { type: 'string' } },
    contextMap: { type: 'string' },
  },
};

const BUILD_RESULT_SCHEMA = {
  type: 'object',
  required: ['result', 'summary'],
  additionalProperties: true,
  properties: {
    result: { enum: ['BUILT', 'NO-OP', 'FAIL'] },
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    patternFiles: { type: 'array', items: { type: 'string' } },
    validation: { enum: ['PASS', 'FAIL', 'NONE'] },
  },
};

const REVIEW_RESULT_SCHEMA = {
  type: 'object',
  required: ['verdict'],
  additionalProperties: true,
  properties: {
    verdict: { enum: ['PASS', 'FAIL'] },
    findings: { type: 'array', items: { type: 'string' } },
    blocking: { type: ['number', 'null'] },
    summary: { type: 'string' },
  },
};

const FIX_RESULT_SCHEMA = {
  type: 'object',
  required: ['result'],
  additionalProperties: true,
  properties: {
    result: { enum: ['FIXED', 'FAIL'] },
    summary: { type: 'string' },
    carried: { type: 'array', items: { type: 'string' } },
  },
};

const COMMIT_RESULT_SCHEMA = {
  type: 'object',
  required: ['result'],
  additionalProperties: true,
  properties: {
    result: { enum: ['COMMITTED', 'FAILED'] },
    commitHash: { type: ['string', 'null'] },
    summary: { type: 'string' },
  },
};

/** Loud enough to survive a skim of the skill's completion report. */
const UNREVIEWED =
  'WARNING — UNREVIEWED CODE COMMITTED:';

/*
 * Effort by declared risk. NEVER below the runtime default — an under-powered
 * build cascades skips into every dependent phase, which costs far more than the
 * tokens it saves — and never 'xhigh'. Only a high-risk phase gets a bump; every
 * other risk omits the option entirely and inherits the default.
 */
const EFFORT_BY_RISK = { high: 'high' };

function effortFor(risk) {
  const level = EFFORT_BY_RISK[String(risk ?? '').toLowerCase()];
  return level ? { effort: level } : {};
}

// ---------------------------------------------------------------------------
// Stage dispatch
// ---------------------------------------------------------------------------

/**
 * agent() that never rejects. A bare agent() call throws on a crashed or
 * schema-less return; inside a parallel() thunk that throw would discard the
 * whole phase. Returns { ok, value, error } instead. A null/undefined return
 * means the agent was skipped or errored mid-run — never treated as success.
 */
async function safeAgent(prompt, opts) {
  try {
    const value = await agent(prompt, opts);
    if (value == null) {
      return { ok: false, value: null, error: 'agent returned no result' };
    }
    return { ok: true, value, error: null };
  } catch (err) {
    return { ok: false, value: null, error: err?.message ?? String(err) };
  }
}

const dirOf = d => (!d ? '' : d.endsWith('/') ? d : `${d}/`);

function phaseNumberOf(phase, index) {
  const m = /spec-phase-(\d+)/.exec(phase.specPath ?? '');
  return m ? Number(m[1]) : index + 1;
}

/** Per-invocation inputs only — workflow, gates and format come from agents/scout.md. */
function scoutPrompt(phase, a, n, priorMapLikely) {
  const dir = dirOf(a.projectDir);
  return `Scout the codebase for one phase of the "${a.projectName}" ideation project.

Spec file path:    ${phase.specPath}
Project directory: ${dir}
Phase number:      ${n}
Prior context map: ${
    priorMapLikely
      ? `an earlier phase has already run, so ${dir}context-map.md very likely exists — read it and EXTEND it`
      : `no earlier phase has run for this project, so ${dir}context-map.md may not exist yet`
  }

Tooling note: Glob and Grep may not be available in this context. Use Bash
(\`rg\`, \`ls\`, \`find\`) for search if you have it; if you have neither, read the
paths the spec names directly and mark any gate you could not evidence
\`not-ready\` rather than guessing.

Return a JSON object (the StructuredOutput tool will be provided):
  - verdict:       "GO" or "HOLD", per your gate rule
  - gatesReady:    how many of the 5 gates are ready (0-5)
  - notReadyGates: the names of the gates that are not ready (empty if none)
  - contextMap:    the FULL context map, in your documented markdown format, as a
                   string. You cannot write files — a later stage persists this
                   verbatim to ${dir}context-map.md.

Do not ask the user anything.`;
}

function buildPrompt(phase, a, scout) {
  const flags = a.strict ? '--headless --strict' : '--headless';
  const dir = dirOf(a.projectDir);
  const holdNote =
    scout.available && scout.verdict === 'HOLD'
      ? `
5. The scout returned HOLD (${scout.gatesReady ?? '?'}/5 gates ready; not ready:
   ${(scout.notReadyGates ?? []).join(', ') || 'unspecified'}). You are proceeding
   anyway. Treat the missing context-map sections as unavailable — read those
   files directly — and watch the Risks section closely.
`
      : '';
  const mapBlock = scout.available
    ? `
--- CONTEXT MAP (write verbatim to ${dir}context-map.md) ---
${scout.contextMap}
--- END CONTEXT MAP ---
`
    : '';

  return `You are building one phase of the "${a.projectName}" ideation project.

Phase: "${phase.title}"${phase.risk ? ` (risk: ${phase.risk})` : ''}
Spec:  ${phase.specPath}

Run the execute-spec skill in headless mode against this spec:

    /ideation:execute-spec ${flags} ${phase.specPath}

ENGINE OVERRIDES — these supersede that skill wherever they differ. The scout and
reviewer it invokes are running as SIBLING stages of this workflow, not as your
subagents: you cannot spawn agents at all here (the Agent tool is not available)
and must not try.

1. SKIP the skill's "Scout Codebase" step. ${
    scout.available
      ? `The scout already ran (verdict ${scout.verdict}). BEFORE building, write the
   context map at the end of this prompt verbatim to ${dir}context-map.md — the
   scout is read-only and cannot write it itself. Then use its Key Patterns,
   Dependencies, Conventions and Risks instead of re-exploring.`
      : `The scout stage FAILED (${scout.error}), so take that step's fallback: explore
   inline — read every "Pattern to follow" path and every modified file, read
   analogues for new files, map the blast radius of each modified file, and read
   CLAUDE.md / README for conventions. Do not write ${dir}context-map.md.`
  }
2. STOP after the skill's "Verify" step. Do NOT run the Review cycle and do NOT
   commit — a sibling reviewer stage reviews your diff, and a later stage commits.
3. Leave every change UNSTAGED, and run \`git add -N <path>\` on every net-new file
   so \`git diff HEAD\` shows it to the reviewer. Without that, a phase whose only
   output is new files produces an empty diff, gets no review, and never lands.
4. Run the spec's Validation Commands and fix every failure before you return —
   validation failures are mechanical errors, not review findings.
${holdNote}
Return a JSON object (the StructuredOutput tool will be provided):
  - result:       "BUILT" if you changed the working tree; "NO-OP" if \`git diff HEAD\`
                  is empty after the \`git add -N\` pass once the process artifacts you
                  just wrote (${dir}context-map.md, ${dir}implementation-notes-*.html)
                  are excluded — they are not phase output, and in a repo that tracks
                  ${dir} they would otherwise mask a genuine no-op; "FAIL" if you could
                  not build
  - summary:      one or two sentences on what was implemented, or why it failed
  - filesChanged: every path you created or modified, exactly as git reports it,
                  EXCLUDING the process artifacts named above — the commit stage
                  stages this list by name and must not commit them
  - patternFiles: every "Pattern to follow" path you collected from the spec
                  (empty array if the spec names none)
  - validation:   "PASS", "FAIL", or "NONE" if the spec declares no validation commands

Do NOT ask the user anything and do NOT commit. If \`git add -N\` fails with an
index.lock error, wait briefly and retry up to 3 times.
${mapBlock}`;
}

/** Per-invocation inputs only — workflow, severities and format come from agents/reviewer.md. */
function reviewPrompt(phase, a, cycle, priorFindings, patternFiles) {
  const prior =
    cycle > 1
      ? `Prior findings (cycle ${cycle - 1}); entries prefixed [REFUTED: …] are ones the
builder declined to fix, with its evidence — re-examine each:
${priorFindings.map(f => `  ${f}`).join('\n') || '  (none carried forward)'}

`
      : '';
  return `Review the working-tree diff for one phase of the "${a.projectName}" ideation project.

Spec file path: ${phase.specPath}
Pattern files:  ${
    patternFiles.length > 0
      ? patternFiles.join(', ')
      : 'none collected — extract the "Pattern to follow" paths from the spec yourself'
  }
Cycle number:   ${cycle} of 3

${prior}Run \`git diff HEAD\` yourself — the builder left everything unstaged and
registered net-new files with \`git add -N\`.

Return a JSON object (the StructuredOutput tool will be provided):
  - verdict:  "PASS" (zero critical and zero high findings) or "FAIL"
  - findings: every finding as a string in your documented
              "severity/category file:line — description → action" form
  - blocking: how many findings are critical or high
  - summary:  2-3 sentences on implementation quality and commit readiness

Do not ask the user anything, and do not edit files.`;
}

function fixPrompt(phase, a, cycle, findings) {
  return `Fix review findings for one phase of the "${a.projectName}" ideation project.

Phase: "${phase.title}"
Spec:  ${phase.specPath}

Review cycle ${cycle} of 3 returned FAIL. Blocking findings:
${findings.map(f => `  ${f}`).join('\n') || '  (the reviewer reported FAIL without listing findings — re-read the diff against the spec)'}

For each finding, VERIFY BEFORE ACTING: read the target code, then apply its
\`→ action\`. The one exception is a finding the code demonstrably contradicts —
refute it once, with file:line evidence, logged as an implementation-notes entry,
and carry it forward as "[REFUTED: <evidence>] <finding>" so the reviewer either
withdraws it or restates it as maintained. Never refute the same finding twice.

Then re-run the spec's Validation Commands. Leave everything UNSTAGED, keep the
\`git add -N\` registration for every new file, and do NOT commit — a sibling
reviewer re-reviews your diff and a later stage commits. You cannot spawn
subagents (the Agent tool is not available here).

Return a JSON object (the StructuredOutput tool will be provided):
  - result:  "FIXED" if you applied or refuted every blocking finding and
             validation passes, else "FAIL"
  - summary: one or two sentences
  - carried: EVERY finding listed above, in the strings you received, with any you
             refuted prefixed "[REFUTED: <evidence>] ". The reviewer needs the full
             list to track which ones your fixes actually closed.

Do not ask the user anything.`;
}

function commitPrompt(phase, a, files, reviewCycles, reviewNote) {
  const dir = dirOf(a.projectDir);
  return `Commit one completed phase of the "${a.projectName}" ideation project.

Phase:  "${phase.title}"
Spec:   ${phase.specPath}
Review: ${reviewNote}

Stage these paths BY NAME — never \`git add -A\`:
${files.map(f => `  ${f}`).join('\n')}

Leave out process artifacts (${dir}context-map.md, ${dir}implementation-notes-*.html)
unless this project's conventions already track ${dir}. Commit following the
project's existing commit conventions${
    reviewCycles > 1
      ? `, and note "${reviewCycles} review cycles" in the body`
      : ''
  }.

The commit body MUST contain the spec path \`${phase.specPath}\` verbatim. This is
not a style preference: autopilot's resume pre-pass and \`scripts/verify.mjs\` both
grep commit bodies for exactly that string, so a phase committed without it reads
as never-committed — it gets re-dispatched on resume and can never satisfy a
\`/goal\`'s \`commits=N/N\` condition.

If \`git add\` or \`git commit\` fails with an index.lock error, wait briefly and
retry up to 3 times before reporting failure.

Return a JSON object (the StructuredOutput tool will be provided):
  - result:     "COMMITTED" or "FAILED"
  - commitHash: the commit SHA, or null
  - summary:    one sentence

Do not ask the user anything.`;
}

// ---------------------------------------------------------------------------
// Phase pipeline: scout → build → (review ⇄ fix)×3 → commit
// ---------------------------------------------------------------------------

async function runPhase(phase, a, index, phaseLabel, priorMapLikely) {
  const title = phase.title;
  const warnings = [];
  // Warnings lead every summary this phase produces — a scout HOLD or a missing
  // reviewer has to be visible in the skill's report, not just in the log.
  const fail = (summary, reviewStatus = 'not-run', extra = {}) => ({
    title,
    result: 'FAIL',
    reviewStatus,
    commitHash: null,
    summary: [...warnings, summary].join(' — '),
    findings: [],
    warnings,
    reviewCycles: 0,
    ...extra,
  });

  // --- 1. SCOUT ------------------------------------------------------------
  const scoutRes = await safeAgent(
    scoutPrompt(phase, a, phaseNumberOf(phase, index), priorMapLikely),
    {
      label: `scout:${title}`,
      phase: phaseLabel,
      agentType: agentNames.scout,
      schema: SCOUT_RESULT_SCHEMA,
    },
  );
  const scout = scoutRes.ok
    ? { available: true, ...scoutRes.value }
    : { available: false, error: scoutRes.error, verdict: null };

  if (!scout.available) {
    // execute-spec's rule for an *unavailable* scout is "warn and explore inline"
    // in both modes; only a HOLD *verdict* is a strict stop condition.
    warnings.push(
      `SCOUT UNAVAILABLE for "${title}" (${scout.error}) — the builder explored inline and no context map was written.`,
    );
    log(`WARN ${title}: scout stage failed (${scout.error}) — building with inline exploration`);
  } else if (scout.verdict === 'HOLD') {
    const gaps = (scout.notReadyGates ?? []).join(', ') || 'unspecified';
    if (a.strict) {
      log(`FAIL ${title}: scout HOLD under --strict (${gaps}) — not building`);
      return fail(
        `Scout HOLD (${scout.gatesReady ?? '?'}/5 gates ready; not ready: ${gaps}). --strict fails closed on an under-specified spec no human reviewed — nothing was built or committed.`,
      );
    }
    warnings.push(
      `SCOUT HOLD for "${title}" (${scout.gatesReady ?? '?'}/5 gates ready; not ready: ${gaps}) — built anyway per the headless default.`,
    );
    log(`WARN ${title}: scout HOLD (${gaps}) — proceeding (non-strict)`);
  }

  // --- 2. BUILD ------------------------------------------------------------
  const buildRes = await safeAgent(buildPrompt(phase, a, scout), {
    label: `build:${title}`,
    phase: phaseLabel,
    agentType: agentNames.builder,
    schema: BUILD_RESULT_SCHEMA,
    ...effortFor(phase.risk),
  });
  if (!buildRes.ok) {
    return fail(`Build stage produced no result (${buildRes.error}).`);
  }
  const build = buildRes.value;
  if (build.result === 'FAIL') {
    return fail(`Build failed: ${build.summary}`);
  }
  // execute-spec: "Fix any failure before review — validation failures are
  // mechanical errors." A builder that returns BUILT with failing validation is
  // schema-legal, so gate it here; otherwise a reviewer PASS commits code whose
  // type check or tests are red, including under --strict.
  if (build.validation === 'FAIL') {
    return fail(`Validation failed after build: ${build.summary}`);
  }
  if (build.result === 'NO-OP') {
    // execute-spec: an empty diff skips review entirely and reports a no-op. It
    // is not a failure, and forcing it to FAIL re-dispatches the phase forever.
    log(`NO-OP ${title} — empty diff, review skipped`);
    return {
      title,
      result: 'NO-OP',
      reviewStatus: 'skipped-empty-diff',
      commitHash: null,
      summary: [...warnings, `No-op: ${build.summary}`].join(' — '),
      findings: [],
      warnings,
      reviewCycles: 0,
    };
  }

  // --- 3. REVIEW ⇄ FIX (max 3 cycles, mirroring execute-spec) ---------------
  const patternFiles = build.patternFiles ?? [];
  let carried = [];
  let cycle = 1;
  let review = null;
  let reviewError = null;

  while (cycle <= 3) {
    const res = await safeAgent(
      reviewPrompt(phase, a, cycle, carried, patternFiles),
      {
        label: `review:${title}#${cycle}`,
        phase: phaseLabel,
        agentType: agentNames.reviewer,
        schema: REVIEW_RESULT_SCHEMA,
        // Always high, whatever the phase risk: review is where a miss is
        // expensive, and it is the only stage nothing downstream re-checks.
        effort: 'high',
      },
    );
    if (!res.ok || (res.value.verdict !== 'PASS' && res.value.verdict !== 'FAIL')) {
      reviewError = res.error ?? 'reviewer returned no verdict';
      break;
    }
    review = res.value;
    if (review.verdict === 'PASS' || cycle === 3) break;

    const fixRes = await safeAgent(
      fixPrompt(phase, a, cycle, review.findings ?? []),
      {
        label: `fix:${title}#${cycle}`,
        phase: phaseLabel,
        agentType: agentNames.builder,
        schema: FIX_RESULT_SCHEMA,
        ...effortFor(phase.risk),
      },
    );
    if (!fixRes.ok) {
      return fail(
        `Review cycle ${cycle} FAILED and the fix stage produced no result (${fixRes.error}). Nothing committed; changes left unstaged.`,
        'failed',
        { findings: review.findings ?? [], reviewCycles: cycle },
      );
    }
    // The reviewer tracks fixes against the whole prior cycle, not just the
    // leftovers — fall back to it if the fixer only returned its refutations.
    carried =
      (fixRes.value.carried ?? []).length > 0
        ? fixRes.value.carried
        : (review.findings ?? []);
    cycle++;
  }

  if (review === null) {
    // The reviewer crashed or never produced a verdict. This is the fork the
    // whole restructure exists for — make both branches visible in the result.
    if (a.strict) {
      log(`FAIL ${title}: reviewer unavailable under --strict — not committing`);
      return fail(
        `Reviewer unavailable (${reviewError}). --strict fails closed: unreviewed code from a spec no human reviewed does not land. Changes left unstaged. Validation: ${build.validation ?? 'unknown'}.`,
      );
    }
    warnings.push(
      `${UNREVIEWED} phase "${title}" is being committed with NO code review — the reviewer stage never produced a verdict (${reviewError}). Validation "${build.validation ?? 'unknown'}" is the ONLY evidence this phase is correct.`,
    );
    log(`WARN ${title}: reviewer unavailable (${reviewError}) — validation-only, committing (non-strict)`);
  } else if (review.verdict === 'FAIL') {
    const blocking = review.blocking ?? (review.findings ?? []).length;
    // reviewError set here means the loop stopped because a LATER cycle went
    // verdict-less, so this FAIL is the last standing verdict — say so, rather
    // than implying the reviewer looked again and held its ground.
    const stale = reviewError
      ? ` The re-review never returned a verdict (${reviewError}), so this FAIL stands unresolved.`
      : '';
    log(`FAIL ${title}: review still FAIL after ${cycle} cycle(s) — not committing`);
    return fail(
      `Review FAILED after ${cycle} cycle(s) with ${blocking} blocking finding(s).${stale} Headless runs do not commit at the cycle cap; changes left unstaged.`,
      'failed',
      { findings: review.findings ?? [], reviewCycles: cycle },
    );
  }

  // --- 4. COMMIT -----------------------------------------------------------
  const reviewStatus = review ? 'passed' : 'validation-only';
  const reviewCycles = review ? cycle : 0;
  const declared = phase.files ?? [];
  const files =
    (build.filesChanged ?? []).length > 0 ? build.filesChanged : declared;
  if (files.length === 0) {
    return fail(
      `Review ${reviewStatus}, but neither the builder nor the manifest named a file to stage — refusing to commit blind (never \`git add -A\`). Changes left unstaged.`,
      reviewStatus,
      { findings: review?.findings ?? [], reviewCycles },
    );
  }

  const commitRes = await safeAgent(
    commitPrompt(
      phase,
      a,
      files,
      reviewCycles,
      review
        ? `PASS on cycle ${reviewCycles} of 3`
        : 'NOT REVIEWED — validation-only fallback',
    ),
    {
      label: `commit:${title}`,
      phase: phaseLabel,
      agentType: agentNames.builder,
      schema: COMMIT_RESULT_SCHEMA,
    },
  );
  if (!commitRes.ok || commitRes.value.result !== 'COMMITTED') {
    return fail(
      `Review ${reviewStatus}, but the commit stage failed (${commitRes.error ?? commitRes.value?.summary ?? 'no result'}). Changes left unstaged.`,
      reviewStatus,
      { findings: review?.findings ?? [], reviewCycles },
    );
  }

  return {
    title,
    result: 'PASS',
    reviewStatus,
    commitHash: commitRes.value.commitHash ?? null,
    // Warnings lead the summary — a validation-only PASS must not read as a
    // clean PASS in the skill's report.
    summary: [...warnings, build.summary, review?.summary]
      .filter(Boolean)
      .join(' — '),
    findings: review?.findings ?? [],
    warnings,
    reviewCycles,
  };
}

/** Clamp to the documented enums so a handler bug cannot mis-bucket a phase. */
function normalizePhaseResult(r) {
  return {
    ...r,
    result: PHASE_RESULTS.includes(r.result) ? r.result : 'FAIL',
    reviewStatus: REVIEW_STATUSES.includes(r.reviewStatus)
      ? r.reviewStatus
      : 'not-run',
  };
}

function summarize(results) {
  const of = kind => results.filter(r => r.result === kind).map(r => r.title);
  return {
    completed: of('PASS'),
    noops: of('NO-OP'),
    failed: of('FAIL'),
    skipped: of('SKIPPED'),
    results,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Defensive: some Workflow runtimes deliver `args` as a JSON string rather than
// a parsed object. Normalize so `a.phases` resolves either way.
const a =
  typeof args === 'string'
    ? (() => {
        try {
          return JSON.parse(args);
        } catch {
          return {};
        }
      })()
    : (args ?? {});

// Agent type names differ by harness. Claude Code plugin-scopes them as
// `ideation:scout` / `ideation:reviewer` and ships a `general-purpose` builtin;
// pi's workflow agentType registry uses bare local names (`scout`, `reviewer`,
// `worker`) and rejects colons. Defaults are the CC strings so a manifest that
// omits `agentNames` is byte-identical to the old hardcoded behavior; pi passes
// `{ agentNames: { scout: 'scout', reviewer: 'reviewer', builder: 'worker' } }`
// in the autopilot manifest (Step 3). Each is overridable individually.
// `a` is optional-chained for the same reason `a?.phases` below is: a JSON-string
// `args` of "null" parses to null, and this runs before the diagnostic log().
const agentNames = {
  scout: a?.agentNames?.scout ?? 'ideation:scout',
  reviewer: a?.agentNames?.reviewer ?? 'ideation:reviewer',
  builder: a?.agentNames?.builder ?? 'general-purpose',
};
log(
  `args received as ${typeof args}; phases=${
    Array.isArray(a?.phases) ? a.phases.length : 'none'
  }`,
);

const phases = a?.phases ?? [];
if (phases.length === 0) {
  log('No phases supplied in args — nothing to execute.');
  return summarize([]);
}

const byTitle = new Map(phases.map(p => [p.title, p]));
const indexOfTitle = new Map(phases.map((p, i) => [p.title, i]));
const filesOf = new Map(phases.map(p => [p.title, p.files ?? []]));

// Prereq-ordered waves first, then split any wave whose phases share a declared
// file so they never run concurrently (avoids contaminated diffs / index races).
const prereqWaves = computeWaves(phases, a.completedPhases ?? []);

// Warn once if any multi-phase prereq wave contains a phase that declares no
// files — it is treated as parallel-safe, so an undeclared file race is invisible
// to the planner. (The commit-retry backstop in commitPrompt covers the rest.)
const fileless = new Set();
for (const wave of prereqWaves) {
  if (wave.length <= 1) continue;
  for (const t of wave) {
    if ((filesOf.get(t) ?? []).length === 0) fileless.add(t);
  }
}
if (fileless.size > 0) {
  log(
    `WARN: phase(s) without declared files in a parallel wave — treated as parallel-safe: ${[
      ...fileless,
    ].join(', ')}`,
  );
}

const waves = splitWavesByFileOverlap(prereqWaves, phases);

// Log each serialization the split introduced. A phase pushed into a later
// sub-wave (idx > 0) of its prereq wave was held back by a shared file with an
// earlier phase; name that blocker and the files they share.
for (const prereqWave of prereqWaves) {
  const subs = splitWavesByFileOverlap([prereqWave], phases);
  if (subs.length <= 1) continue;
  const subIndexOf = new Map();
  subs.forEach((sw, i) => sw.forEach(t => subIndexOf.set(t, i)));
  for (const t of prereqWave) {
    if (subIndexOf.get(t) === 0) continue;
    const myFiles = new Set(filesOf.get(t) ?? []);
    const blocker = prereqWave.find(
      o =>
        subIndexOf.get(o) < subIndexOf.get(t) &&
        (filesOf.get(o) ?? []).some(f => myFiles.has(f)),
    );
    const shared = (filesOf.get(blocker) ?? []).filter(f => myFiles.has(f));
    log(
      `Serialized "${t}" after "${blocker}" — shared files: ${shared.join(', ')}`,
    );
  }
}

log(
  `Planned ${waves.length} wave(s) for ${a.projectName}: ${waves
    .map((w, i) => `W${i + 1}[${w.join(', ')}]`)
    .join(' → ')}`,
);
if ((a.completedPhases ?? []).length > 0) {
  log(`Skipping already-committed: ${a.completedPhases.join(', ')}`);
}

const failedOrSkipped = new Set();
const results = [];
let waveNum = 0;

for (const wave of waves) {
  waveNum++;
  const phaseLabel = `Wave ${waveNum}`;
  phase(phaseLabel);

  const skips = propagateSkips(phases, failedOrSkipped);
  const toRun = wave.filter(t => !skips.has(t));

  for (const t of wave) {
    if (skips.has(t)) {
      results.push({
        title: t,
        result: 'SKIPPED',
        reviewStatus: 'not-run',
        commitHash: null,
        summary: 'blocked by an upstream failure',
        findings: [],
        warnings: [],
        reviewCycles: 0,
      });
      failedOrSkipped.add(t);
      log(`SKIP ${t} — blocked by upstream failure`);
    }
  }

  if (toRun.length === 0) continue;

  // The scout extends a prior context map when one exists; anything committed
  // before this wave (in this run or a previous one) means one probably does.
  const priorMapLikely =
    (a.completedPhases ?? []).length > 0 ||
    results.some(r => r.result === 'PASS' || r.result === 'NO-OP');

  const waveResults = await parallel(
    toRun.map(title => () =>
      runPhase(
        byTitle.get(title),
        a,
        indexOfTitle.get(title) ?? 0,
        phaseLabel,
        priorMapLikely,
      ),
    ),
  );

  waveResults.forEach((raw, i) => {
    const title = raw?.title ?? toRun[i];
    // Null = parallel() absorbed a throw runPhase did not catch. Never success.
    const r = normalizePhaseResult({
      title,
      result: 'FAIL',
      reviewStatus: 'not-run',
      commitHash: null,
      summary: 'phase produced no result (agent skipped or errored)',
      findings: [],
      warnings: [],
      reviewCycles: 0,
      ...(raw ?? {}),
    });
    results.push(r);
    if (r.result !== 'PASS' && r.result !== 'NO-OP') failedOrSkipped.add(r.title);
    log(
      `${r.result} ${r.title} [review: ${r.reviewStatus}]${
        r.commitHash ? ` (${r.commitHash})` : ''
      }`,
    );
    for (const w of r.warnings ?? []) log(w);
  });
}

const summary = summarize(results);
log(
  `Done: ${summary.completed.length} completed, ${summary.noops.length} no-op, ${summary.failed.length} failed, ${summary.skipped.length} skipped.`,
);
return summary;
