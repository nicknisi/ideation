/**
 * The authored layer: editorial judgements a machine cannot derive.
 *
 * Everything mechanical — the command name, whether Claude can trigger it,
 * whether it can write files — comes from the frontmatter via readSkills().
 * What belongs here is only what a human decided: the order to present them
 * in, the situation each one answers, and what you walk away with.
 *
 * `joinCommands` is the guard. If a skill ships without an entry here, or an
 * entry here names a skill that no longer ships, the build fails.
 */
import { commandFor, readDepths, readSkills, type SkillFacts } from '../lib/skills';

export type Stage = 'plan' | 'execute';

/** One planning depth of /ideation, in the skill's own words (its "Pick the depth" table). */
export interface Depth {
  name: string;
  when: string;
}

export interface CommandDoc {
  slug: string;
  stage: Stage;
  /** One line in the product's own voice — not the frontmatter description. */
  headline: string;
  /** The situation you are in when this is the right call. */
  when: string;
  /** What you have afterwards. */
  produces: string;
  /** The thing people get wrong about it. Optional. */
  caveat?: string;
  /** The depths a command picks between, when it has them. */
  depths?: Depth[];
}

export const STAGES: Record<Stage, { label: string; blurb: string }> = {
  plan: {
    label: 'Planning',
    blurb:
      'One entry point. It picks how much planning the work needs, says why in one line, and switches when you overrule it in a word.',
  },
  execute: {
    label: 'Executing',
    blurb:
      'Turning an approved plan into reviewed commits. /ideation hands off to these itself; you reach for them to resume or to run one piece by hand.',
  },
};

/** Presentation order. Roughly the order you would meet them. */
export const COMMANDS: CommandDoc[] = [
  {
    slug: 'ideation',
    stage: 'plan',
    headline: 'One entry point, at the right depth.',
    when: 'Anything from a one-line fix to an effort whose route you cannot see yet, or the question of whether to build it at all. In Pi, /ideation (or /ideation plan) starts it.',
    produces:
      'Plan data in docs/ideation/<slug>/plan.json, a page to answer its decisions on, and, once you approve in the terminal, a run on the engine with reviewed commits.',
    caveat:
      'A page never approves; only your terminal confirmation does. The "should we?" opening writes no files. The interview will not proceed on enthusiasm: every evidence gate must read ready, or the plan says why it stopped early.',
    depths: [
      { name: 'should we?', when: 'You are still deciding whether to build it. A conversation that ends in a decision and writes nothing.' },
      { name: 'just do it', when: 'One clear, low-risk change. No page: a compact plan, its checks, one confirmation, then the run.' },
      { name: 'short plan', when: 'Buildable now, with two to five real forks. You answer them on the page, then approve.' },
      { name: 'interview', when: 'The problem, goals or scope are not settled. The evidence-gated interview, the four critics, then the page.' },
      { name: 'map', when: 'Too big or foggy for one session. Open questions worked one per session until the route is clear, then the interview.' },
    ],
  },
  {
    slug: 'brainstorm',
    stage: 'plan',
    headline: 'Decide whether to build it, before any planning.',
    when: 'You are weighing an idea, not committing to it. The same conversation as the "should we?" opening of /ideation, as its own command. In Pi, /skill:brainstorm starts it.',
    produces:
      'A short conclusion in chat: the decision, its assumptions, the alternatives rejected, and what is out. If it is "build it", a pointer to the depth to run with /ideation.',
    caveat:
      'It never starts planning itself. Its tool list has no way to write, so run /ideation in the same conversation to turn a "build it" into a plan.',
  },
  {
    slug: 'autopilot',
    stage: 'execute',
    headline: 'Run every unit of an approved plan on the workflow engine.',
    when: 'A plan was approved (its run-contract.json still matches plan.json), or a 0.x contract has specs. Independent units run in parallel waves; dependent ones wait.',
    produces:
      'One reviewed commit per unit on ideation/<plan id>, each ending in its Ideation-Unit trailer, a run report beside the plan, and a VERIFY line stating whether the plan’s own checks pass.',
    caveat:
      'It resumes rather than repeating: a unit whose trailer is already on the branch is skipped (for a 0.x contract, a phase whose spec path appears in a commit body). A plan edited after approval is refused until it is approved again.',
  },
  {
    slug: 'execute-spec',
    stage: 'execute',
    headline: 'Run a single unit by hand, with the same review loop.',
    when: 'A one-unit plan, which /ideation hands here itself, or one unit (or 0.x spec) at a time, to watch it or to intervene.',
    produces:
      'A scouted, built, reviewed and committed unit. The same scout → build → review ⇄ fix → commit cycle autopilot runs per unit, within the packet’s paths and commands.',
  },
  {
    slug: 'get-goal-prompt',
    stage: 'execute',
    headline: 'Print a /goal that drives the whole plan unattended.',
    when: 'You want an approved plan (or a 0.x contract) run long-haul without you in the loop, and re-driven if it stalls.',
    produces:
      'A /goal string on your clipboard, printed by scripts/plan-goal.mjs so there is one owner for its wording.',
    caveat:
      'A plan gets a goal only once approved. The goal is judged on the VERIFY line alone, and two identical failing runs in a row end it, so checks that have rotted cannot trap the run forever.',
  },
];

export interface Command extends CommandDoc, SkillFacts {
  /** The slash form a human types. */
  command: string;
}

/**
 * Join the authored table to the shipped frontmatter, failing loudly on drift.
 * This is the whole reason the page is generated rather than written.
 */
export function joinCommands(): Command[] {
  const facts = new Map(readSkills().map(s => [s.slug, s]));
  const authored = new Set(COMMANDS.map(c => c.slug));

  const undocumented = [...facts.keys()].filter(s => !authored.has(s));
  if (undocumented.length) {
    throw new Error(
      `skills ship but the guide does not document them: ${undocumented.join(', ')}. ` +
        'Add an entry to src/data/commands.ts.',
    );
  }
  const phantom = COMMANDS.filter(c => !facts.has(c.slug)).map(c => c.slug);
  if (phantom.length) {
    throw new Error(
      `the guide documents skills that no longer ship: ${phantom.join(', ')}. ` +
        'Remove the entry from src/data/commands.ts.',
    );
  }

  const depths = readDepths();
  const authoredDepths = COMMANDS.find(c => c.slug === 'ideation')?.depths?.map(d => d.name) ?? [];
  if ([...depths].sort().join('|') !== [...authoredDepths].sort().join('|')) {
    throw new Error(
      `the guide's /ideation depths (${authoredDepths.join(', ')}) disagree with skills/ideation/SKILL.md (${depths.join(', ')}). ` +
        'Update the depths in src/data/commands.ts.',
    );
  }

  return COMMANDS.map(c => ({
    ...c,
    ...(facts.get(c.slug) as SkillFacts),
    command: commandFor(c.slug),
  }));
}
