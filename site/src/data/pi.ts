/**
 * The authored layer for the Pi front door: what each subcommand is for.
 *
 * Names, argument hints, menu labels and tool actions come from
 * extensions/change.ts via readPi(). `joinPi` fails the build if a
 * subcommand or tool action ships without an entry here, or if an entry
 * names one that no longer ships.
 */
import { readPi } from '../lib/pi';

/** Short labels for the overview; the guide shows the full entries below. */
export const SHORT: Record<string, string> = {
  plan: 'shape a new change',
  approve: 'confirm once and start',
  status: 'where everything stands',
  review: 'open the contract',
  pause: 'stop at a safe boundary',
  resume: 'continue within the approval',
  stop: 'set a run aside, work intact',
  accept: 'record your decision',
  exit: 'leave, taking the work with you',
  motion: 'widget animation on or off',
};

const SUBCOMMANDS: Record<string, string> = {
  plan: 'Start shaping a change from an idea. The agent reads the code, asks only what the code cannot answer, and prepares a compact brief. Bare /ideation does the same when nothing is in flight.',
  approve:
    'Open the full contract and ask for one short confirmation of its paths and commands. With uncommitted files, it first asks whether to start from the last commit or include them. Yes starts work in an isolated worktree immediately. Remembers the prepared brief; a path is only for power users.',
  status: 'Show where every change stands, and refresh the widget and contract link.',
  review: 'Open the contract for a run (or the prepared draft) in your browser.',
  pause: 'Stop at the next safe boundary, with nothing lost.',
  resume: 'Continue a paused, interrupted or stopped run within its original approval. It always can, and it is told what failed last time.',
  stop: 'Set a run aside. It waits for owned processes to settle; the worktree and its commits stay.',
  accept:
    'Record your acceptance of a ready-for-review run after reading its evidence and judgments. It never merges, pushes or deploys.',
  exit: 'Leave ideation from any state. Stops a working run, brings its work into your checkout as uncommitted changes (or keeps it on its branch), and clears the widget. Nothing comes back on its own.',
  motion: 'Turn the widget animation on or off (saved). PI_REDUCED_MOTION=1 or IDEATION_MOTION=off also switch it off.',
};

const TOOL_ACTIONS: Record<string, string> = {
  prepare: 'Validate a brief and open its contract. Never approves.',
  status: 'Read a run’s state without restarting anything.',
  receipt: 'Read the source-bound record of what was verified.',
  feedback: 'File a note to the run’s inbox. Feedback is never permission.',
  answer: 'Reply to a question left on the contract page.',
  exit: 'Leave ideation when you ask to, bringing the work into your checkout.',
};

export function joinPi() {
  const facts = readPi();
  const drift = (kind: string, shipped: string[], authored: string[]) => {
    const missing = shipped.filter(s => !authored.includes(s));
    const phantom = authored.filter(a => !shipped.includes(a));
    if (missing.length || phantom.length) {
      throw new Error(
        `Pi ${kind} drifted from extensions/change.ts — undocumented: ${missing.join(', ') || 'none'}; ` +
          `no longer shipped: ${phantom.join(', ') || 'none'}. Update src/data/pi.ts.`,
      );
    }
  };
  drift('subcommands', facts.subcommands.map(s => s.name), Object.keys(SUBCOMMANDS));
  drift('short labels', facts.subcommands.map(s => s.name), Object.keys(SHORT));
  drift('tool actions', facts.toolActions, Object.keys(TOOL_ACTIONS));
  return {
    ...facts,
    subcommands: facts.subcommands.map(s => ({ ...s, summary: SUBCOMMANDS[s.name], short: SHORT[s.name] })),
    toolActions: facts.toolActions.map(a => ({ name: a, summary: TOOL_ACTIONS[a] })),
  };
}
