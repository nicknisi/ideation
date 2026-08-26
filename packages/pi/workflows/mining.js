export const meta = {
  name: 'ideation-mining',
  description:
    'Mine the model, gate on the human, return the choice + declared ignorance',
};

/*
 * mining — the pi front door's mining pass for ideation intake.
 *
 * The ideation skill runs this through the pi-workflows `workflow` tool
 * (`action: run`, inline `script`), which supplies the `agent()`, `parallel()`,
 * and `ask()` human-gate globals (shipped in @nicknisi/pi-workflows, phase 2).
 * There is no saved-workflow install step and no new pi tool: the skill reads
 * this file and passes it inline.
 *
 * Adapted from packages/workflows/examples/autoplan.js (pi-extensions, #107) —
 * the advisor + ask() gate version, not the older judge version. Gen 2's mining
 * never writes a plan (autoplan's plan-writer stage is dropped): the contract
 * flow owns planning. Mining's job is to hand the intake a picked option plus
 * the declared-ignorance list that becomes the interview's question queue.
 *
 * Prompt text is NOT embedded here: the four prompt bodies live once in
 * references/mining-prompts.md (the single source the CC port quotes too), and
 * the ideation skill reads that file via ${CLAUDE_PLUGIN_ROOT} resolution and
 * hands its contents in as args.promptsDoc. This script extracts and
 * interpolates the labelled sections at start and throws LOUDLY, before any
 * agent spend, if the reference did not arrive. Keeping the text in one file
 * plus a drift test (test-fixtures/mining/prompt-drift.test.mjs) is how the two
 * ports are kept from silently diverging.
 *
 * The flow (args: { problem, scope, constraints, promptsDoc }):
 *   1. scout   — one read-only agent grounds the problem area in the real code
 *                so options are not invented in a vacuum.
 *   2. candidates + grail — three practical candidates in parallel, plus one
 *                unconstrained holy-grail pass. All are first-level workflow
 *                agent() spawns (ux-dejank learning: never nest the mining
 *                script inside an engine-dispatched stage, or its spawns become
 *                second-level and the runtime rejects them).
 *   3. advisor — a single scout-grounded pass that ranks for practicality and
 *                simplicity, curbs anything needing upstream changes outside
 *                our authority (mark UNIMPLEMENTABLE NOW, never pick it),
 *                recommends one, and emits the declared-ignorance list:
 *                questions it cannot answer from the code (goals, priorities,
 *                taste, success criteria), each tagged with the evidence gate
 *                it blocks. There is deliberately no separate plan-critic stage
 *                (decision log): mined options are paragraph gists with no plan
 *                structure for critic lenses to grip.
 *   4. ask()   — the human decision gate. Options list the recommendation
 *                first; `none — reject all / re-mine` is always offered last.
 *                The human is the decision gate; the advisor only ranks and
 *                recommends (decision log).
 *   5. return  — { decided, choice?, options, ignorance, miningOutcome }.
 *
 * miningOutcome ('picked' | 'rejected-all' | 'dismissed') is recorded on EVERY
 * return path, decided or not, because G2's mining-acceptance rate needs the
 * denominator: a dismissed gate is a distinct outcome from a reject-all.
 *
 * Zero imports: the workflow sandbox may not support relative imports, so
 * everything this script needs is inlined (same rule as execute-contract.mjs).
 * The body uses only the injected globals — args, agent, parallel, ask, log.
 */

// The reject-all / re-mine choice is a sentinel id, never a real option id, and
// is always the LAST option in the ask() list.
const REJECT_ALL = '__reject_all__';

// Read-only tool allowlist for the grounding passes (harness-compat § 2 pi
// mapping: Read→read, Grep→grep, Glob→find, Bash→ls). The scout and candidate
// passes must never mutate the tree.
const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls'];

// The advisor's structured return. `ignorance` is a first-class field: an empty
// list is legal (the intake still runs its one consolidated confirmation), but
// the advisor must always emit the key.
const ADVISOR_SCHEMA = {
  type: 'object',
  required: ['options', 'recommended', 'why', 'rejections', 'ignorance'],
  additionalProperties: true,
  properties: {
    options: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'title', 'gist'],
        additionalProperties: true,
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          gist: { type: 'string' },
        },
      },
    },
    recommended: { type: 'string' },
    why: { type: 'string' },
    rejections: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'reason'],
        additionalProperties: true,
        properties: {
          id: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
    ignorance: {
      type: 'array',
      items: {
        type: 'object',
        required: ['question', 'gate', 'whyNotAnswerable'],
        additionalProperties: true,
        properties: {
          question: { type: 'string' },
          gate: { type: 'string' },
          whyNotAnswerable: { type: 'string' },
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Prompt loading + builders. The bodies live in references/mining-prompts.md;
// here we extract the labelled sections and interpolate them, so the flow below
// reads as the flow and the prompt text has a single source of truth.
// ---------------------------------------------------------------------------

// Extract a `<!-- prompt:NAME -->` … `<!-- /prompt:NAME -->` body from the
// shared reference. The delimiters sit on their own lines, so the captured body
// is the exact bytes between them — the same bytes the drift test compares
// against the CC skill quote. A missing section is a loud throw, not a silent
// empty prompt.
function section(doc, name) {
  const re = new RegExp(
    `<!--\\s*prompt:${name}\\s*-->\\n([\\s\\S]*?)\\n<!--\\s*/prompt:${name}\\s*-->`,
  );
  const m = re.exec(doc);
  if (!m) {
    throw new Error(
      `mining: reference section "${name}" not found in mining-prompts.md`,
    );
  }
  return m[1];
}

// Substitute {{key}} placeholders. An unknown placeholder is left verbatim so a
// drift bug stays visible rather than silently blanking part of the prompt.
function fill(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key) =>
    key in vars ? vars[key] : whole,
  );
}

function brief(a) {
  const parts = [`Problem: ${a.problem ?? '(none given)'}`];
  if (a.scope) parts.push(`Scope: ${a.scope}`);
  if (a.constraints) parts.push(`Constraints: ${a.constraints}`);
  return parts.join('\n');
}

function scoutPrompt(P, a) {
  return fill(P.scout, { brief: brief(a) });
}

function candidatePrompt(P, a, letter, scout) {
  return fill(P.candidate, { brief: brief(a), letter, scout });
}

function grailPrompt(P, a, scout) {
  return fill(P.grail, { brief: brief(a), scout });
}

function advisorPrompt(P, a, candidates, grail) {
  const candidateBlock = candidates
    .map((c, i) => `Candidate ${String.fromCharCode(65 + i)}:\n${c ?? '(no result)'}`)
    .join('\n\n');
  return fill(P.advisor, {
    brief: brief(a),
    candidates: candidateBlock,
    grail: grail ?? '(no result)',
  });
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

const a = typeof args === 'string' ? JSON.parse(args) : (args ?? {});

// Load the shared prompt reference the skill passed in. Fail loud, before any
// agent spend, if it did not arrive — a mining pass on blank prompts is worse
// than no mining pass.
const promptsDoc = a.promptsDoc;
if (typeof promptsDoc !== 'string' || !promptsDoc.trim()) {
  throw new Error(
    'mining: prompts reference missing. The ideation skill must read ' +
      '${CLAUDE_PLUGIN_ROOT}/references/mining-prompts.md and pass its contents ' +
      'as args.promptsDoc before running this workflow.',
  );
}
const P = {
  scout: section(promptsDoc, 'scout'),
  candidate: section(promptsDoc, 'candidate'),
  grail: section(promptsDoc, 'grail'),
  advisor: section(promptsDoc, 'advisor'),
};

// 1. Scout: read-only grounding of the problem area.
const scout = await agent(scoutPrompt(P, a), {
  label: 'mining:scout',
  tools: READ_ONLY_TOOLS,
});

// 2. Three practical candidates + one unconstrained grail, all in parallel and
//    all first-level workflow agent() spawns.
const [candA, candB, candC, grail] = await parallel([
  () =>
    agent(candidatePrompt(P, a, 'A', scout), {
      label: 'mining:candidate:A',
      tools: READ_ONLY_TOOLS,
    }),
  () =>
    agent(candidatePrompt(P, a, 'B', scout), {
      label: 'mining:candidate:B',
      tools: READ_ONLY_TOOLS,
    }),
  () =>
    agent(candidatePrompt(P, a, 'C', scout), {
      label: 'mining:candidate:C',
      tools: READ_ONLY_TOOLS,
    }),
  () =>
    agent(grailPrompt(P, a, scout), {
      label: 'mining:grail',
      tools: READ_ONLY_TOOLS,
    }),
]);

// 3. Single advisor pass: rank + recommend + curb + declared-ignorance list.
const advisor = await agent(
  advisorPrompt(P, a, [candA, candB, candC], grail),
  { label: 'mining:advisor', schema: ADVISOR_SCHEMA },
);

const options = advisor.options ?? [];
const ignorance = advisor.ignorance ?? [];

// 4. Human decision gate. Recommendation first, everything else after, and
//    reject-all always LAST.
const recommendedFirst = [
  ...options.filter(o => o.id === advisor.recommended),
  ...options.filter(o => o.id !== advisor.recommended),
];
const askOptions = [
  ...recommendedFirst.map(o => ({
    id: o.id,
    label: o.id === advisor.recommended ? `${o.title} (recommended)` : o.title,
    description: o.gist,
  })),
  {
    id: REJECT_ALL,
    label: 'none — reject all / re-mine',
    description:
      'None of these fit. Fall back to the classic full interview (or re-mine).',
  },
];

const answer = await ask({
  header: 'Mining complete — pick a direction',
  question: advisor.why
    ? `Recommended: ${advisor.recommended}. ${advisor.why}`
    : 'Pick a direction, or reject all to fall back to the classic interview.',
  options: askOptions,
});

// 5. Return, recording miningOutcome on every path.
//    ask() → undefined/null means the human dismissed the gate.
if (answer == null) {
  log('mining: dismissed (no answer)');
  return { decided: false, options, ignorance, miningOutcome: 'dismissed' };
}

// ask() may hand back either the chosen option's id or the option object.
const chosenId = typeof answer === 'string' ? answer : answer.id;

if (chosenId === REJECT_ALL) {
  log('mining: rejected all');
  return { decided: false, options, ignorance, miningOutcome: 'rejected-all' };
}

const choice = options.find(o => o.id === chosenId);
if (!choice) {
  // An id matching no option is treated as a dismissal, not a silent pick.
  log(`mining: unrecognized choice "${chosenId}" — treating as dismissed`);
  return { decided: false, options, ignorance, miningOutcome: 'dismissed' };
}

log(`mining: picked "${choice.id}"`);
return { decided: true, choice, options, ignorance, miningOutcome: 'picked' };
