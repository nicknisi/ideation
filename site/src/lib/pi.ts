/**
 * Facts about the Pi front door, read out of extensions/change.ts.
 *
 * Same rule as the skills table: the page does not restate from memory what
 * `/ideation` accepts. It parses the command's own description, the actions
 * its dispatcher handles, the labels its guided menu offers, and the tool's
 * action enum, and throws when they stop agreeing with each other.
 */
import { readFileSync } from 'node:fs';
import { repoPath } from './repo';

export interface PiFacts {
  /** The command's registered description, verbatim. */
  description: string;
  /** Subcommands as the description lists them, with their argument hints. */
  subcommands: { name: string; args: string }[];
  /** Guided-menu labels in the order the handler offers them. */
  menu: { label: string; action: string }[];
  /** Actions the model tool accepts. */
  toolActions: string[];
  /** Notifications the extension shows, verbatim; {title} marks the change title. */
  notices: { approved: string; prepared: string; ready: string };
}

export function readPi(): PiFacts {
  const src = readFileSync(repoPath('extensions', 'change.ts'), 'utf8');
  const fail = (why: string): never => {
    throw new Error(`extensions/change.ts: ${why} (the site's Pi reference reads it)`);
  };

  const description =
    src.match(/registerCommand\('ideation',\s*\{\s*description:\s*'([^']+)'/)?.[1] ?? fail('no /ideation description');
  const also = description.match(/Also: (.+)\.$/)?.[1] ?? fail('description has no "Also: …." list');
  const subcommands = also.split(/,\s*/).map(item => {
    const [name, ...args] = item.trim().split(/\s+/);
    return { name, args: args.join(' ') };
  });

  // Every run control the dispatcher accepts must be advertised, and every
  // advertised subcommand must be handled.
  const controls = src.match(/if \(!\[((?:'[a-z-]+',?\s*)+)\]\.includes\(action\)\)/)?.[1] ?? fail('no run-control list');
  const handled = new Set([
    ...[...controls.matchAll(/'([a-z-]+)'/g)].map(m => m[1]),
    ...[...src.matchAll(/action === '([a-z-]+)'/g)].map(m => m[1]),
  ]);
  const listed = new Set(subcommands.map(s => s.name));
  for (const c of [...controls.matchAll(/'([a-z-]+)'/g)].map(m => m[1])) {
    if (!listed.has(c)) fail(`"${c}" is handled but missing from the command description`);
  }
  for (const s of listed) if (!handled.has(s)) fail(`"${s}" is advertised but never handled`);

  const menu = [...src.matchAll(/\{\s*label:\s*'([^']+)',\s*action:\s*'([a-z-]+)'/g)].map(m => ({
    label: m[1],
    action: m[2],
  }));
  if (menu.length < 6) fail('guided menu labels not found');

  const toolActions = (
    src.match(/action:\s*Type\.String\(\{\s*enum:\s*\[([^\]]+)\]/)?.[1] ?? fail('no ideation_change action enum')
  )
    .split(',')
    .map(s => s.trim().replace(/'/g, ''));

  const notice = (re: RegExp, what: string) => src.match(re)?.[1] ?? fail(`no ${what} notification`);
  const notices = {
    approved: notice(/notify\(s, `(Approval recorded\. [^`]+)`/, 'approval').replace('${summaryText(brief.title)}', '{title}'),
    prepared: notice(/notify\(s, '(Your contract is ready\.[^']+)'/, 'prepared'),
    ready: notice(/notify\(s, '(Ideation is ready for review\.[^']+)'/, 'ready-for-review'),
  };

  return { description, subcommands, menu, toolActions, notices };
}
