#!/usr/bin/env node
// lint-prompts.mjs — assert that machine-shaped references in the prompt corpus
// (skills/, references/) resolve to real files and real headings.
//
// Usage: node scripts/lint-prompts.mjs
//
// WHY THIS GUARDS SOMETHING REAL: these prompts are the product, and they
// cross-reference each other constantly — paths, § section numbers, core
// rules, italic section anchors. When a referenced file is renamed or a
// heading is reworded, nothing fails: the reference simply dangles, and the
// next reader (human or agent) follows it into a 404. This exact incident
// shipped once — a dangling "Phase 2.2" reference survived a phasing rework
// because no check could see it. Prose drift is silent by default; this lint
// makes the machine-shaped part of it loud.
//
// The reference SHAPES are derived from the corpus, not copied from it: the
// checks below encode how references look (`${CLAUDE_PLUGIN_ROOT}/…` paths,
// backticked relative paths, `§ N.N`, `core rule N`, `*Italic Anchors*`), then
// resolve every match against the live tree. Nothing here names a specific
// file, section, or heading — a legitimate restructure of the prompts passes,
// only a broken reference fails. Checks are deliberately limited to shapes a
// script can resolve without prose judgment; loose numeric references and
// emphasis italics are out of scope by design.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not new URL().pathname — the latter stays percent-encoded,
// so a checkout path with spaces resolves to a nonexistent `%20` directory.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every markdown file under skills/ and references/ — the prompt corpus. */
export function collectCorpus(root = ROOT) {
  const files = [];
  const walk = dir => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry.endsWith('.md')) files.push(p);
    }
  };
  walk(join(root, 'skills'));
  walk(join(root, 'references'));
  return files.sort();
}

/** Heading index for one file: section numbers (`2`, `5.4`) and heading texts. */
function indexHeadings(text) {
  const numbers = new Set();
  const titles = new Set();
  for (const line of text.split('\n')) {
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    titles.add(m[1]);
    const n = /^(\d+(?:\.\d+)*)[.\s]/.exec(m[1]);
    if (n) numbers.add(n[1]);
  }
  return { numbers, titles };
}

/** Numbered list items under a `Core rules` heading, e.g. {1, 2, 3, 4}. */
function coreRuleNumbers(text) {
  const lines = text.split('\n');
  const start = lines.findIndex(l => /^#{1,6}\s+Core rules\b/.test(l));
  if (start === -1) return null;
  const rules = new Set();
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) break;
    const m = /^(\d+)\./.exec(lines[i]);
    if (m) rules.add(Number(m[1]));
  }
  return rules;
}

/** Expand one level of `{a,b}` brace lists; returns null when placeholders remain. */
function expandPath(token) {
  if (/[…<]/.test(token)) return null;
  const m = /\{([^{}]+)\}/.exec(token);
  if (!m) return token.includes('{') ? null : [token];
  const expanded = m[1].split(',').map(part => token.replace(m[0], part));
  return expanded.some(p => p.includes('{')) ? null : expanded;
}

/**
 * Resolve a referenced path relative to the mentioning file. Candidates are
 * derived from the corpus's three resolution contexts: repo root, the
 * mentioning file's own directory, and each ancestor up to the root (a skill's
 * bare `references/…` mention resolves to the skill's own references/ dir).
 */
function resolveReference(token, fromFile, root) {
  const cleaned = token.replace(/[.,;:!?)'`\]]+$/, '');
  const candidates = [];
  let dir = dirname(fromFile);
  while (true) {
    candidates.push(join(dir, cleaned));
    if (dir === root) break;
    dir = dirname(dir);
  }
  candidates.push(join(root, cleaned));
  return candidates.find(p => existsSync(p)) ?? null;
}

/** The file a `§`/`core rule` reference points at: a path on the same line,
 *  a prose `<name> SKILL.md`, or the mentioning file itself. */
function anchorTargetFile(line, fromFile, root) {
  for (const m of line.matchAll(/`([^`]+\.md)`/g)) {
    const token = m[1].replace(/^\$\{CLAUDE_PLUGIN_ROOT\}\//, '');
    const hit = resolveReference(token, fromFile, root);
    if (hit) return hit;
  }
  const prose = /\b([a-z][\w-]*) SKILL\.md\b/.exec(line);
  if (prose) {
    const hit = join(root, 'skills', prose[1], 'SKILL.md');
    if (existsSync(hit)) return hit;
  }
  return fromFile;
}

/** Strip fenced code blocks and inline code — anchors live in prose, not code.
 *  Fences are blanked, not deleted: violation line numbers are computed from
 *  the stripped text, so the strip must preserve the file's line structure. */
function proseOnly(text) {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, block => block.replace(/[^\n]/g, ''))
    .replace(/`[^`\n]*`/g, '');
}

/** Heading index for every corpus file — built once per run, shared across lintFile calls. */
function buildHeadingIndex(corpus) {
  return new Map(corpus.map(f => [f, indexHeadings(readFileSync(f, 'utf8'))]));
}

/**
 * Lint one corpus file. Returns violations as
 * `{ file, line, ref, reason }` objects.
 */
export function lintFile(path, corpus, root = ROOT, headings = buildHeadingIndex(corpus)) {
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  const rel = relative(root, path);
  const violations = [];
  const fail = (line, ref, reason) => violations.push({ file: rel, line, ref, reason });

  lines.forEach((line, i) => {
    const n = i + 1;

    // (a) ${CLAUDE_PLUGIN_ROOT}/… paths resolve from the repo root.
    for (const m of line.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^\s`'")\]]+)/g)) {
      const expanded = expandPath(m[1]);
      if (!expanded) continue; // placeholder paths ({slug}, …) are uncheckable
      for (const token of expanded) {
        const cleaned = token.replace(/[.,;:!?)'`\]]+$/, '');
        if (!existsSync(join(root, cleaned))) {
          fail(n, `\${CLAUDE_PLUGIN_ROOT}/${token}`, 'no such path in the repo — the reference dangles');
        }
      }
    }

    // (b) backticked bare `references/…` paths resolve per the corpus's
    // per-directory base rule.
    for (const m of line.matchAll(/`((?:\.\/)?references\/[^`]+)`/g)) {
      if (!resolveReference(m[1], path, root)) {
        fail(n, m[1], 'no such file under any references/ base — the reference dangles');
      }
    }

    // (c) `§ N[.N]` section references resolve to a numbered heading.
    if (line.includes('§')) {
      const target = anchorTargetFile(line, path, root);
      const targetHeadings = headings.get(target) ?? indexHeadings(readFileSync(target, 'utf8'));
      for (const m of line.matchAll(/§\s*(\d+(?:\.\d+)*)/g)) {
        if (!targetHeadings.numbers.has(m[1])) {
          fail(n, `§ ${m[1]}`, `no heading numbered ${m[1]} in ${relative(root, target)} — the reference dangles`);
        }
      }
    }

    // (d) `core rule N` references resolve to a numbered item under Core rules.
    if (/core rule \d/.test(line)) {
      const target = anchorTargetFile(line, path, root);
      const rules = coreRuleNumbers(readFileSync(target, 'utf8'));
      for (const m of line.matchAll(/core rule (\d+)/g)) {
        if (!rules) {
          fail(n, m[0], `${relative(root, target)} has no Core rules section — the reference dangles`);
        } else if (!rules.has(Number(m[1]))) {
          fail(n, m[0], `${relative(root, target)} has core rules ${[...rules].sort().join('-')} only — the reference dangles`);
        }
      }
    }
  });

  // (e) italic anchors (*Title Case phrases*) that match a corpus heading are
  // cross-references and must keep resolving; a near-match (case/whitespace
  // differs) is a suspected rename left behind. Lowercase and unmatched spans
  // are emphasis — not references, never flagged.
  const allTitles = new Set();
  for (const h of headings.values()) for (const t of h.titles) allTitles.add(t);
  const normalized = new Map([...allTitles].map(t => [t.toLowerCase().replace(/\s+/g, ' '), t]));
  proseOnly(text)
    .split('\n')
    .forEach((line, i) => {
      for (const m of line.matchAll(/(?<!\*)\*([A-Z][^*\n]{1,60}?)\*(?!\*)/g)) {
        const span = m[1].trim();
        if (allTitles.has(span)) continue;
        const near = normalized.get(span.toLowerCase().replace(/\s+/g, ' '));
        if (near) {
          fail(i + 1, `*${span}*`, `no heading "${span}" — closest is "${near}" (renamed? the anchor dangles)`);
        }
      }
    });

  // (f) SKILL.md frontmatter parses and carries the fields both harnesses read.
  if (path.endsWith('SKILL.md')) {
    if (lines[0] !== '---') {
      fail(1, 'frontmatter', 'SKILL.md must open with a --- frontmatter fence');
    } else {
      const end = lines.indexOf('---', 1);
      if (end === -1) {
        fail(1, 'frontmatter', 'frontmatter fence never closes');
      } else {
        const block = lines.slice(1, end);
        for (const field of ['name', 'description']) {
          if (!block.some(l => l.startsWith(`${field}:`))) {
            fail(1, 'frontmatter', `frontmatter has no \`${field}:\` field — both harnesses require it`);
          }
        }
      }
    }
  }

  return violations;
}

/** Lint the whole corpus; returns every violation, sorted by file then line. */
export function lintCorpus(root = ROOT) {
  const corpus = collectCorpus(root);
  const headings = buildHeadingIndex(corpus);
  return corpus
    .flatMap(f => lintFile(f, corpus, root, headings))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

// Only run the CLI when executed directly, so the test file can import.
// Real paths on both sides — the raw `file://` + argv[1] comparison breaks on
// percent-encoded characters (spaces) and on symlinked invocations; this is
// the same entry-guard idiom as wave-planner.mjs and verify.mjs.
if (process.argv[1]) {
  const real = p => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  if (real(resolve(process.argv[1])) === real(fileURLToPath(import.meta.url))) {
    const corpus = collectCorpus();
    const violations = lintCorpus();

    if (violations.length === 0) {
      console.log(`✓ prompt corpus clean — ${corpus.length} files, every machine-shaped reference resolves`);
      process.exit(0);
    }

    console.error(`✗ ${violations.length} broken reference${violations.length === 1 ? '' : 's'} in the prompt corpus:\n`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  ${v.ref}`);
      console.error(`      ${v.reason}`);
    }
    console.error('\nPrompt cross-references fail silently — a renamed file or heading leaves');
    console.error('the next reader following a pointer to nothing. Fix the reference or, if the');
    console.error('move was deliberate, update every mention in the same change.');
    process.exit(1);
  }
}
