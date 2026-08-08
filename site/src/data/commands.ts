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
import { commandFor, readSkills, type SkillFacts } from '../lib/skills';

export type Stage = 'route' | 'whether' | 'plan' | 'execute';

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
}

export const STAGES: Record<Stage, { label: string; blurb: string }> = {
  route: {
    label: 'Charting the route',
    blurb:
      'Too big for one session and the way is not yet visible? Map the decisions first — as many sessions as it takes.',
  },
  whether: {
    label: 'Deciding whether',
    blurb: 'Is this worth building at all? No files are written at this stage.',
  },
  plan: {
    label: 'Planning how',
    blurb:
      'The interview, the critics, the contract, the specs. This is where a plan becomes something you can approve.',
  },
  execute: {
    label: 'Executing',
    blurb:
      'Turning approved specs into reviewed commits. Every one of these needs a contract that already exists.',
  },
};

/** Presentation order. Roughly the order you would meet them. */
export const COMMANDS: CommandDoc[] = [
  {
    slug: 'chart',
    stage: 'route',
    headline: 'Map an effort too big for one session, one decision at a time.',
    when: 'The work is huge and the route is fog — you cannot yet see the way from here to done, so a single interview cannot hold it. “We need a map before we plan.”',
    produces:
      'A map and its decision tickets under docs/chart/<slug>/, worked one per session. When nothing is left to decide, the route hands off to the interview as its starting evidence.',
    caveat:
      'It plans, and only plans — a ticket resolves a decision, never a build. If the fog lifts on first look, it says so and sends you straight to the interview.',
  },
  {
    slug: 'brainstorm',
    stage: 'whether',
    headline: 'Pressure-test an idea before committing to it.',
    when: 'You are weighing options, or you suspect the idea might be wrong. “Should I do X?” “Which of these approaches?” “Am I over-engineering this?”',
    produces:
      'A conclusion in chat, in four parts, and nothing on disk. A “yes” hands off to the interview with its rejected alternatives already recorded.',
    caveat:
      'It is for a question, not a dump. Anything shaped like “I want to build…” belongs to the interview, however settled it sounds.',
  },
  {
    slug: 'ideation',
    stage: 'plan',
    headline: 'The one door. An evidence-gated interview to a contract you approve.',
    when: 'You have something to build and you want a plan you can hold — from a one-spec change up to a multi-phase initiative.',
    produces:
      'contract.html to decide on, contract.md and numbered spec files to execute against, and a run-mode recommendation.',
    caveat:
      'It will not proceed on enthusiasm. All five evidence gates have to read ready first, and it reads your codebase rather than asking you about it.',
  },
  {
    slug: 'express',
    stage: 'plan',
    headline: 'The same interview with the routing pre-answered.',
    when: 'The work is well understood and you would rather not review each artifact. You want planning that flows straight into execution.',
    produces:
      'The same artifacts, one consolidated confirmation instead of per-artifact gates, and execution on an isolation branch.',
    caveat:
      'Because no human reviewed the specs, execution runs fail-closed: a scout HOLD or a crashed reviewer stops the phase rather than committing anyway.',
  },
  {
    slug: 'autopilot',
    stage: 'execute',
    headline: 'Run every phase of an approved contract on the workflow engine.',
    when: 'The contract is approved and you want to walk away. Independent phases run in parallel waves; dependent ones wait.',
    produces:
      'One commit per phase, each naming its spec path, and a VERIFY line stating whether the contract’s own checks pass.',
    caveat:
      'It resumes rather than repeating: a phase whose spec path already appears in a commit body is skipped.',
  },
  {
    slug: 'execute-spec',
    stage: 'execute',
    headline: 'Run a single phase by hand, with the same review loop.',
    when: 'You want one phase at a time — to watch it, to intervene, or because the phase is risky enough to deserve your attention.',
    produces:
      'A scouted, built, reviewed and committed phase. The same scout → build → review ⇄ fix → commit cycle autopilot runs per phase.',
  },
  {
    slug: 'get-goal-prompt',
    stage: 'execute',
    headline: 'Print a /goal that drives the whole contract unattended.',
    when: 'You want the project run long-haul without you in the loop, and re-driven if it stalls.',
    produces:
      'A /goal string on your clipboard, generated by the contract generator so there is one owner for its wording.',
    caveat:
      'The goal is judged on the VERIFY line alone, and its done-when is disjunctive so a contract whose checks have rotted cannot trap the run forever.',
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

  return COMMANDS.map(c => ({
    ...c,
    ...(facts.get(c.slug) as SkillFacts),
    command: commandFor(c.slug),
  }));
}
