/**
 * Locate the plugin repo root from the build's working directory.
 *
 * `import.meta.url` is not usable for this: Astro bundles these modules into
 * dist/.prerender/chunks/, so a path relative to the source file resolves
 * somewhere that does not exist. Walking up from cwd for the plugin manifest
 * works in `astro dev` and `astro build` alike, and fails loudly rather than
 * silently reading nothing.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function repoRoot(): string {
  let dir = resolve(process.cwd());
  for (let up = 0; up < 8; up++) {
    if (existsSync(join(dir, '.claude-plugin', 'plugin.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `could not find the ideation repo root above ${process.cwd()} ` +
      '(looked for .claude-plugin/plugin.json). The guide reads skills/ and ' +
      'references/ from there at build time.',
  );
}

/** A path inside the plugin repo, e.g. repoPath('skills'). */
export const repoPath = (...parts: string[]): string => join(repoRoot(), ...parts);
