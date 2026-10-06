#!/usr/bin/env node
// plan-goal.mjs — the one owner of the `/goal` command, for both harnesses.
//
// Usage: node scripts/plan-goal.mjs <folder | plan.json | run-contract.json | contract-data.json | contract.md>
//
// Prints the /goal that drives /ideation:autopilot to completion unattended,
// and writes nothing. A folder resolves the way scripts/verify.mjs resolves it:
//
//   - A plan written by 1.0 needs its approval: run-contract.json beside
//     plan.json, written by `plan-data.ts run-contract` after the terminal
//     confirmation, and still matching plan.json. Autopilot runs the run
//     contract on branch ideation/<id>.
//   - A plan migrated from 0.x (supersedes contract-data.json) and a 0.x folder
//     run their contract-data.json, as 0.x did.
//
// The goal's done-when delegates to verify.mjs on the same input, and its
// commits=N/N takes N from verify.mjs (committablePhases), so the two cannot
// disagree about what counts.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, toRunContract } from './plan-data.ts';
import {
  committablePhases, isEntryPoint, malformedCriterionError, normalizeCriterion, readContract, validateCheck,
} from './verify.mjs';

/** A path as the goal names it: repo-relative when inside `cwd`, else `fallback`. */
function shown(path, fallback, cwd) {
  const rel = relative(cwd, resolve(cwd, path));
  return rel && !rel.startsWith('..') ? rel : fallback;
}

/** verify.mjs, relative when this plugin lives inside the project (this repo
    dogfooding itself), else a ${CLAUDE_PLUGIN_ROOT} placeholder — never an
    absolute path, which would bake this machine into the goal. */
export function verifyBinFor(cwd = process.cwd()) {
  return shown(fileURLToPath(new URL('./verify.mjs', import.meta.url)), '${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs', cwd);
}

/**
 * The /goal string. Pure.
 *
 * `/goal` is "set a goal Claude checks before stopping": the argument is a
 * CONDITION evaluated against the transcript, not a procedure. So it reads as a
 * state of the world, and every imperative in it exists only because the
 * condition can't be true unless it happened. It must carry:
 *   1. Autopilot dispatches a BACKGROUND workflow: wait for the completion
 *      notification, and never start a second run while one is in flight.
 *      (Without this the Stop hook fires mid-run and re-injects the goal as a
 *      directive, launching a concurrent engine run.)
 *   2. verify.mjs after every run, VERIFY line left in the transcript: the
 *      evaluator reads the transcript and nothing else.
 *   3. A DISJUNCTIVE done-when. Rotted checks can never reach fail=0, and a
 *      purely conjunctive goal would loop on them forever; two consecutive
 *      identical failing VERIFY lines is the escape hatch.
 *
 * goal: { kind: 'contract' | 'plan', title, slug, run, verify, commits, branch?, verifyBin }
 *   run     — what autopilot is pointed at (contract.md, or run-contract.json)
 *   verify  — what verify.mjs is pointed at (contract-data.json, or the plan folder)
 *   commits — verify.mjs's commit denominator for that input
 */
export function buildGoal({ kind, title, slug, run, verify, commits, branch, verifyBin }) {
  const onBranch = branch
    ? ` All commits belong on branch ${branch} — switch to it before any run.`
    : '';
  // ${CLAUDE_PLUGIN_ROOT} is a plugin-markdown substitution, not a shell variable:
  // bash expands it to nothing. The goal names it as a placeholder to resolve
  // rather than handing over a command that fails verbatim.
  const verifyStep = verifyBin.startsWith('${')
    ? `Then run the ideation plugin's \`scripts/verify.mjs\` against \`${verify}\` and leave its VERIFY line in the conversation. Resolve the plugin's install directory first — \`${verifyBin}\` is a placeholder, not a shell variable, and bash will not expand it.`
    : `Then run \`node ${verifyBin} ${verify}\` and leave its VERIFY line in the conversation.`;
  // An approved plan's packets carry its authority; an unattended run repairs
  // the implementation, never the approval.
  const repair = kind === 'plan'
    ? 'If anything failed, fix the implementation within the approved packets and go back to step 1 — never edit the plan, the run contract or the packets, which would need a new approval. Autopilot skips units that already have commits.'
    : 'If anything failed, fix the spec or the implementation and go back to step 1. Autopilot skips phases that already have commits.';

  // Numbered lines, not a paragraph: the person pasting this has to be able to
  // skim it before they walk away. The done-when goes last, on its own line,
  // because it alone decides when the run may stop.
  return [
    `/goal Drive the ${title} ${kind} (${slug}) to completion with /ideation:autopilot.`,
    ``,
    `1. Run \`/ideation:autopilot ${run}\`.${onBranch}`,
    `2. It dispatches a BACKGROUND workflow. Wait for the completion notification — never start a second autopilot run while one is in flight.`,
    `3. ${verifyStep} That line is the only evidence this goal is judged on.`,
    `4. ${repair}`,
    ``,
    `Done when the most recent VERIFY line reads fail=0 and commits=${commits}/${commits} — or when two consecutive VERIFY lines are identical and still failing, in which case name the failing checks and stop, because a ${kind} whose checks have rotted must not trap the run.`,
  ].join('\n');
}

/**
 * The goal for a 0.x contract. Refuses (throws) a contract verify.mjs could not
 * honestly judge: malformed criteria, or a cmd slot holding prose, which an
 * unattended run would then execute.
 */
export function goalFromContract(data, { dataPath, cwd = process.cwd() } = {}) {
  if (!data.gates && data.confidence) {
    throw new Error('contract-data.json uses the pre-gate `confidence` schema; regenerate via ideation to produce the `gates` schema.');
  }
  const errors = (data.successCriteria ?? []).flatMap((c, i) => {
    const malformed = malformedCriterionError(c, i);
    if (malformed) return [malformed];
    const n = normalizeCriterion(c);
    const err = validateCheck(n.check);
    return err ? [`successCriteria[${i}] (${n.criterion}): ${err}`] : [];
  });
  if (errors.length) {
    throw new Error(`Refusing to print a /goal: ${errors.length} unrunnable check${errors.length === 1 ? '' : 's'}.\n${errors.map(e => `  ${e}`).join('\n')}\n  This goal is judged by scripts/verify.mjs, which would execute these.`);
  }
  const shownData = shown(dataPath ?? '', `docs/ideation/${data.slug}/contract-data.json`, cwd);
  return buildGoal({
    kind: 'contract',
    title: data.projectName,
    slug: data.slug,
    run: join(dirname(shownData), 'contract.md'),
    verify: shownData,
    // Single owner: verify.mjs decides which phases are expected to leave a commit.
    commits: committablePhases(data).length,
    branch: data.branch,
    verifyBin: verifyBinFor(cwd),
  });
}

/**
 * The goal for a plan folder written by 1.0. Throws unless the plan was
 * approved: run-contract.json must exist beside plan.json and match what
 * toRunContract derives from plan.json now, so an edited plan is re-approved
 * before anything runs unattended.
 */
export function goalFromPlan(folder, { cwd = process.cwd() } = {}) {
  const plan = load(join(folder, 'plan.json'));
  const runPath = join(folder, 'run-contract.json');
  if (!existsSync(runPath)) {
    throw new Error(`${folder} has no run-contract.json: the plan is not approved. Approve it in a terminal confirmation (skills/ideation's Approval), which writes run-contract.json, then ask for the goal again.`);
  }
  const frozen = JSON.parse(readFileSync(runPath, 'utf8'));
  const now = toRunContract(plan);
  if (frozen.fingerprint !== now.fingerprint) {
    throw new Error(`${runPath} no longer matches plan.json (v${plan.version}): the plan changed after approval. Approve the current version, which rewrites run-contract.json, then ask for the goal again.`);
  }
  const shownFolder = shown(folder, `docs/ideation/${plan.id}`, cwd);
  return buildGoal({
    kind: 'plan',
    title: plan.title,
    slug: plan.id,
    run: join(shownFolder, 'run-contract.json'),
    verify: shownFolder,
    commits: committablePhases(readContract(folder).data).length,
    branch: `ideation/${plan.id}`,
    verifyBin: verifyBinFor(cwd),
  });
}

/** The goal for whatever path the user named, resolved as described in the header. */
export function goalFor(path, { cwd = process.cwd() } = {}) {
  const abs = resolve(cwd, path);
  const folder = existsSync(abs) && statSync(abs).isDirectory() ? abs : dirname(abs);
  const named = existsSync(abs) && !statSync(abs).isDirectory() ? basename(abs) : null;
  const legacy = join(folder, 'contract-data.json');
  const fromContract = () => goalFromContract(JSON.parse(readFileSync(legacy, 'utf8')), { dataPath: legacy, cwd });
  if (named === 'contract-data.json' || named === 'contract.md') return fromContract();
  if (!existsSync(join(folder, 'plan.json'))) {
    if (existsSync(legacy)) return fromContract();
    throw new Error(`${path}: no plan.json or contract-data.json to build a goal from.`);
  }
  const { supersedes } = JSON.parse(readFileSync(join(folder, 'plan.json'), 'utf8'));
  if (supersedes === 'contract-data.json') {
    if (!existsSync(legacy)) throw new Error(`${folder}/plan.json was migrated from contract-data.json, which is gone: there is nothing autopilot can run.`);
    return fromContract();
  }
  return goalFromPlan(folder, { cwd });
}

if (isEntryPoint(import.meta.url)) {
  const [path, ...rest] = process.argv.slice(2);
  if (!path || rest.length) {
    console.error('Usage: node scripts/plan-goal.mjs <folder | plan.json | run-contract.json | contract-data.json | contract.md>\n  Prints the /goal that runs the project unattended. Writes nothing.');
    process.exit(2);
  }
  try {
    console.log(goalFor(path));
  } catch (e) {
    console.error(`plan-goal: ${e.message}`);
    process.exit(1);
  }
}
