/**
 * Where each 0.x command went, read from README.md's "### Removed commands"
 * table under "## From 0.x".
 *
 * The README is what GitHub shows someone upgrading, so it owns the table and
 * the guide renders it. The build fails rather than render a table that has
 * stopped being true: a row whose 0.x command still ships as a skill was not
 * removed, and a row whose 1.0 column names no depth of /ideation (the
 * backticked names in skills/ideation/SKILL.md's "Pick the depth" table) points
 * nowhere.
 */
import { readFileSync } from 'node:fs';
import { repoPath } from './repo';
import { readDepths, readSkills } from './skills';

export interface Removed {
  /** The 0.x commands, as typed, e.g. ["/ideation:change", "/skill:ideation-change"]. */
  commands: string[];
  /** Where the work went, as the README words it (markdown inline code kept). */
  now: string;
  /** The depths of /ideation the row sends you to. */
  depths: string[];
}

const section = (md: string, heading: string, level: string, file: string) => {
  const start = md.indexOf(`\n${heading}\n`);
  if (start < 0) throw new Error(`${file}: no "${heading}" heading (the guide's From 0.x table reads it)`);
  const rest = md.slice(start + heading.length + 2);
  const end = rest.search(new RegExp(`\\n${level} `));
  return end < 0 ? rest : rest.slice(0, end);
};

const cells = (line: string) =>
  line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

const code = (s: string) => [...s.matchAll(/`([^`]+)`/g)].map(m => m[1]);

export function readRemoved(): Removed[] {
  const md = readFileSync(repoPath('README.md'), 'utf8');
  const table = section(section(md, '## From 0.x', '##', 'README.md'), '### Removed commands', '###', 'README.md');
  const lines = table.split('\n').filter(l => l.trim().startsWith('|'));
  const fail = (why: string): never => {
    throw new Error(`README.md "Removed commands": ${why}`);
  };
  if (lines.length < 3) fail('expected a header, a separator and at least one row');

  const shipped = new Set(readSkills().flatMap(s => [s.slug, s.name]));
  const depths = readDepths();
  return lines.slice(2).map(line => {
    const [was, now, ...extra] = cells(line);
    if (!was || !now || extra.length) fail(`row "${line.trim()}" must have exactly two cells`);
    const commands = code(was);
    if (!commands.length) fail(`row "${was}" names no backticked 0.x command`);
    for (const c of commands) {
      const name = c.match(/^\/(?:ideation:|skill:)([\w-]+)$/)?.[1] ?? fail(`"${c}" is not a /ideation:<name> or /skill:<name> command`);
      if (shipped.has(name)) fail(`"${c}" is listed as removed, but skills/ still ships "${name}"`);
    }
    const named = code(now).filter(n => depths.includes(n));
    if (!named.length) fail(`the 1.0 column for ${commands.join(', ')} names none of /ideation's depths (${depths.join(', ')})`);
    return { commands, now, depths: named };
  });
}
