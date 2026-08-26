/**
 * Build-time facts about the shipped skills, read out of skills/<name>/SKILL.md.
 *
 * Nothing here is hand-transcribed. This repo has been bitten repeatedly by
 * duplicated knowledge rotting — a run-model diagram that shipped four wrong
 * engine values, a field documented as dormant whose producer had been
 * specified all along, a KEEP IN SYNC comment that demonstrably did not work.
 * A docs page that restates skill metadata from memory would be the next one.
 *
 * So the page derives every mechanical claim from the frontmatter, and
 * `joinCommands` throws if the authored table and the shipped skills disagree.
 * Adding or removing a skill without updating the guide fails the build.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { corePath } from './repo';

const SKILLS_DIR = corePath('skills');

/** Tools that can put bytes on disk. Bash belongs here: `echo > file` writes. */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'Bash']);

export interface SkillFacts {
  /** Directory name under skills/, which is also the command suffix. */
  slug: string;
  /** `name:` from the frontmatter. */
  name: string;
  description: string;
  /** Absent `disable-model-invocation: true` means Claude may trigger it itself. */
  modelInvocable: boolean;
  argumentHint: string | null;
  allowedTools: string[];
  /**
   * Whether the skill declares `allowed-tools` at all. This distinction is
   * load-bearing: an ABSENT key means every tool is available, not none. The
   * first version of this file treated absent as an empty list and rendered
   * "writes no files" next to /ideation, which writes the entire contract.
   */
  toolsDeclared: boolean;
  /** Derived from allowed-tools, not from prose promises. */
  canWriteFiles: boolean;
}

function frontmatterOf(src: string, file: string): Record<string, unknown> {
  if (!src.startsWith('---')) throw new Error(`${file}: no frontmatter`);
  const end = src.indexOf('\n---', 3);
  if (end === -1) throw new Error(`${file}: unterminated frontmatter`);
  const parsed = parse(src.slice(3, end));
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`${file}: frontmatter is not a mapping`);
  }
  return parsed as Record<string, unknown>;
}

export function readSkills(): SkillFacts[] {
  const slugs = readdirSync(SKILLS_DIR).filter(d =>
    statSync(join(SKILLS_DIR, d)).isDirectory(),
  );

  return slugs
    .map(slug => {
      const file = join(SKILLS_DIR, slug, 'SKILL.md');
      const fm = frontmatterOf(readFileSync(file, 'utf8'), `skills/${slug}`);
      const toolsDeclared = Array.isArray(fm['allowed-tools']);
      const tools = toolsDeclared
        ? (fm['allowed-tools'] as unknown[]).map(String)
        : [];
      const name = typeof fm.name === 'string' ? fm.name : slug;
      const description = typeof fm.description === 'string' ? fm.description : '';
      if (!description) throw new Error(`skills/${slug}: empty description`);
      return {
        slug,
        name,
        description,
        modelInvocable: fm['disable-model-invocation'] !== true,
        argumentHint:
          typeof fm['argument-hint'] === 'string' ? fm['argument-hint'] : null,
        allowedTools: tools,
        toolsDeclared,
        // Undeclared means unrestricted, so it can certainly write.
        canWriteFiles: !toolsDeclared || tools.some(t => WRITE_TOOLS.has(t)),
      } satisfies SkillFacts;
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * The slash form a human types. The repo's own docs use the bare `/ideation`
 * for the main skill (66 uses to one `/ideation:ideation`) and the qualified
 * form for everything else.
 */
export const commandFor = (slug: string): string =>
  slug === 'ideation' ? '/ideation' : `/ideation:${slug}`;
