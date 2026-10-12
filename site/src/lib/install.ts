/**
 * Install commands, read from README.md's "## Installation" section.
 *
 * The site used to carry its own copy of the pi install lines, and it rotted:
 * it kept telling people to install a workflow package the plugin no longer
 * needs, under a package name that had moved. The README is what GitHub and
 * npm show, so the site renders the README and fails the build if the section
 * stops having the shape the page depends on.
 */
import { readFileSync } from 'node:fs';
import { repoPath } from './repo';

export interface InstallLine {
  cmd: string;
  /** Trailing `# comment` from the README, if any. */
  note?: string;
}

export interface Install {
  claudeCode: InstallLine[];
  /** What the native /ideation change workflow needs in Pi. */
  pi: InstallLine[];
  /** The two extra tools the planning path calls in Pi. */
  piPlanning: InstallLine[];
}

const section = (md: string, heading: string, level: string) => {
  const start = md.indexOf(`\n${heading}\n`);
  if (start < 0) throw new Error(`README.md: no "${heading}" heading (the site's install blocks read it)`);
  const rest = md.slice(start + heading.length + 2);
  const end = rest.search(new RegExp(`\\n${level} `));
  return end < 0 ? rest : rest.slice(0, end);
};

const blocks = (md: string): InstallLine[][] =>
  [...md.matchAll(/```(?:bash|sh)?\n([\s\S]*?)```/g)].map(m =>
    m[1]
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => {
        const [cmd, ...note] = l.split(/\s+#\s+/);
        return note.length ? { cmd: cmd.trim(), note: note.join(' # ').trim() } : { cmd: cmd.trim() };
      }),
  );

export function readInstall(): Install {
  const md = readFileSync(repoPath('README.md'), 'utf8');
  const install = section(md, '## Installation', '##');
  const [claudeCode] = blocks(section(install, '### Claude Code', '###'));
  const [pi, piPlanning] = blocks(section(install, '### pi', '###'));

  const fail = (why: string) => {
    throw new Error(`README.md installation section: ${why}`);
  };
  if (!claudeCode?.length || !claudeCode.every(l => l.cmd.startsWith('/plugin '))) {
    fail('the Claude Code block must be /plugin commands');
  }
  if (!pi?.length || !pi.every(l => l.cmd.startsWith('pi install '))) fail('the first pi block must be pi install commands');
  if (!pi[0].cmd.includes('github.com/nicknisi/ideation')) fail('the first pi line must install the plugin itself');
  if (!piPlanning?.length || !piPlanning.every(l => l.cmd.startsWith('pi install '))) {
    fail('a second pi block must list the planning-path tools');
  }
  return { claudeCode, pi, piPlanning };
}
