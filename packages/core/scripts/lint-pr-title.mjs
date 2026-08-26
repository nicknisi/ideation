#!/usr/bin/env node
// lint-pr-title.mjs — assert a pull request title is a Conventional Commit.
//
// Usage: node scripts/lint-pr-title.mjs "feat(site): add a guide page"
//        PR_TITLE="feat: ..." node scripts/lint-pr-title.mjs
//
// WHY THIS GUARDS SOMETHING REAL: this repo squash-merges, so the PR title
// becomes the commit subject on main, and that subject is the entire input
// release-please gets. A title it cannot parse does not fail loudly — it is
// silently ignored, contributing no version bump and no changelog entry. The
// work ships and the release simply does not mention it, which you discover a
// release later. A title is also the one part of a PR that no reviewer diffs.
//
// The accepted types are READ FROM release-please-config.json rather than
// duplicated here. Hardcoding them would mean this check and the changelog
// config could disagree — a type this accepts but release-please drops on the
// floor is the exact failure the check exists to prevent.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(new URL(import.meta.url).pathname), '..', '..', '..');

/** Types release-please is configured to recognize, plus the spec's `revert`. */
export function allowedTypes(configPath = join(ROOT, 'release-please-config.json')) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const sections = config['changelog-sections'];
  if (!Array.isArray(sections) || sections.length === 0) {
    throw new Error(`${configPath} has no changelog-sections; cannot derive the allowed types`);
  }
  // `revert` is in the Conventional Commits spec but needs no changelog section
  // of its own, so it never appears in the config. Accept it anyway.
  return [...new Set([...sections.map((s) => s.type), 'revert'])].sort();
}

// type(optional-scope)optional-!: subject
const PATTERN = /^([a-z]+)(?:\(([^()]*)\))?(!?): (.+)$/;

/**
 * @returns {{ok: true, type: string, scope: string|null, breaking: boolean, subject: string}
 *          | {ok: false, reason: string}}
 */
export function lintPrTitle(title, types = allowedTypes()) {
  if (typeof title !== 'string' || title.trim() === '') {
    return { ok: false, reason: 'the title is empty' };
  }
  if (title !== title.trim()) {
    return { ok: false, reason: 'the title has leading or trailing whitespace' };
  }

  const match = PATTERN.exec(title);
  if (!match) {
    // Aim the message at the mistake actually made, rather than restating the
    // grammar and leaving the author to spot the difference.
    if (!title.includes(':')) {
      return { ok: false, reason: 'no `type: ` prefix — a Conventional Commit needs a colon' };
    }
    const [head] = title.split(':');
    if (/^[A-Z]/.test(head)) {
      return { ok: false, reason: `the type must be lowercase (found \`${head}\`)` };
    }
    if (/:\S/.test(title)) {
      return { ok: false, reason: 'the colon needs a space after it' };
    }
    if (/:\s*$/.test(title)) {
      return { ok: false, reason: 'the subject after the colon is empty' };
    }
    return { ok: false, reason: 'not a Conventional Commit' };
  }

  const [, type, scope, bang, subject] = match;

  if (!types.includes(type)) {
    return { ok: false, reason: `\`${type}\` is not an allowed type` };
  }
  if (scope !== undefined && scope.trim() === '') {
    return { ok: false, reason: 'the scope parentheses are empty — drop them or name a scope' };
  }
  if (subject.trim() === '') {
    return { ok: false, reason: 'the subject after the colon is empty' };
  }

  return {
    ok: true,
    type,
    scope: scope ?? null,
    breaking: bang === '!',
    subject,
  };
}

/** What the release will do with this title, so the author sees the consequence. */
function describeEffect(result, types) {
  if (result.breaking) return 'bumps the minor version (breaking, pre-1.0)';
  if (result.type === 'feat') return 'bumps the minor version';
  const shown = JSON.parse(readFileSync(join(ROOT, 'release-please-config.json'), 'utf8'))
    ['changelog-sections'].find((s) => s.type === result.type);
  const where = shown && !shown.hidden ? `listed under "${shown.section}"` : 'not shown in the changelog';
  void types;
  return `bumps the patch version, ${where}`;
}

// Only run the CLI when executed directly, so the test file can import.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const title = process.env.PR_TITLE ?? process.argv[2];
  const types = allowedTypes();
  const result = lintPrTitle(title, types);

  if (result.ok) {
    console.log(`✓ ${title}`);
    console.log(`  → ${describeEffect(result, types)}`);
    process.exit(0);
  }

  console.error(`✗ PR title is not a Conventional Commit: ${result.reason}`);
  console.error(`\n  title: ${title ?? '(none)'}\n`);
  console.error('Because this repo squash-merges, the PR title becomes the commit subject on');
  console.error('main and is all release-please reads. An unparseable title is skipped in');
  console.error('silence: no version bump, no changelog entry, the work ships unmentioned.\n');
  console.error(`  format: type(optional-scope)!: subject`);
  console.error(`  types:  ${types.join(', ')}\n`);
  console.error('  feat(site): generate the command reference at build time');
  console.error('  fix: stop calling phase.files dormant');
  console.error('  feat!: replace the confidence object with gates');
  process.exit(1);
}
