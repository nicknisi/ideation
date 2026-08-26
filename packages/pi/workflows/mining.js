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
 * The flow (args: { problem, scope, constraints }):
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
// Prompt builders — kept as pure functions so the flow below reads as the flow.
// ---------------------------------------------------------------------------

function brief(a) {
  const parts = [`Problem: ${a.problem ?? '(none given)'}`];
  if (a.scope) parts.push(`Scope: ${a.scope}`);
  if (a.constraints) parts.push(`Constraints: ${a.constraints}`);
  return parts.join('\n');
}

function scoutPrompt(a) {
  return `Ground the problem area in the ACTUAL code, read-only. Do not propose a
solution — map the terrain a solution would live in.

${brief(a)}

Report: the files, modules, and existing patterns a change here would touch;
what already exists that could be extended or reused; and any constraint the
code imposes that the brief does not mention. Cite paths. Read only.`;
}

function candidatePrompt(a, letter, scout) {
  return `Propose ONE practical candidate solution (candidate ${letter}) for the
problem below, grounded in the codebase map that follows. Practical means
buildable now, within our own code, without upstream changes to code we do not
own.

${brief(a)}

--- Codebase map (read-only scout pass) ---
${scout}
--- end map ---

Return a short paragraph: the approach, what it touches, and why it is a
sensible practical option. One candidate only.`;
}

function grailPrompt(a, scout) {
  return `Propose the HOLY-GRAIL solution for the problem below: the best possible
outcome ignoring effort and current constraints. Do not curb yourself to what
is buildable now — that is the advisor's job. Name the upstream or external
changes it would require if any.

${brief(a)}

--- Codebase map (read-only scout pass) ---
${scout}
--- end map ---

Return a short paragraph.`;
}

function advisorPrompt(a, candidates, grail) {
  const candidateBlock = candidates
    .map((c, i) => `Candidate ${String.fromCharCode(65 + i)}:\n${c ?? '(no result)'}`)
    .join('\n\n');
  return `You are the mining advisor. Rank the options below for PRACTICALITY and
SIMPLICITY, recommend exactly one, and declare your ignorance.

${brief(a)}

--- Practical candidates ---
${candidateBlock}

--- Holy grail ---
${grail ?? '(no result)'}
--- end options ---

Rules:
- Curb any option that needs upstream changes to code we do not own: keep it in
  the list but mark its gist "UNIMPLEMENTABLE NOW — <why>" and never recommend
  it.
- Recommend the simplest option that actually solves the problem.
- Declare your ignorance: list every question you CANNOT answer from the code —
  goals, priorities, taste, success criteria. Tag each with the evidence gate
  it blocks (problem | goals | criteria | scope | consistency) and say why the
  code cannot answer it. An empty list is legal only when the code genuinely
  answers everything, which is rare.

Return JSON matching the provided schema:
{ options: [{id, title, gist}], recommended, why,
  rejections: [{id, reason}],
  ignorance: [{question, gate, whyNotAnswerable}] }`;
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

const a = typeof args === 'string' ? JSON.parse(args) : (args ?? {});

// 1. Scout: read-only grounding of the problem area.
const scout = await agent(scoutPrompt(a), {
  label: 'mining:scout',
  tools: READ_ONLY_TOOLS,
});

// 2. Three practical candidates + one unconstrained grail, all in parallel and
//    all first-level workflow agent() spawns.
const [candA, candB, candC, grail] = await parallel([
  () =>
    agent(candidatePrompt(a, 'A', scout), {
      label: 'mining:candidate:A',
      tools: READ_ONLY_TOOLS,
    }),
  () =>
    agent(candidatePrompt(a, 'B', scout), {
      label: 'mining:candidate:B',
      tools: READ_ONLY_TOOLS,
    }),
  () =>
    agent(candidatePrompt(a, 'C', scout), {
      label: 'mining:candidate:C',
      tools: READ_ONLY_TOOLS,
    }),
  () =>
    agent(grailPrompt(a, scout), {
      label: 'mining:grail',
      tools: READ_ONLY_TOOLS,
    }),
]);

// 3. Single advisor pass: rank + recommend + curb + declared-ignorance list.
const advisor = await agent(
  advisorPrompt(a, [candA, candB, candC], grail),
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
