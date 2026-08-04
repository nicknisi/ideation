// lint-prompts.test.mjs — fixture corpora with planted violations must fail;
// the repo's real prompt corpus must be clean (Phase 2's single-owner pass is
// what makes the second half achievable — keep it that way).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintCorpus } from './lint-prompts.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Build a minimal valid corpus root; `files` maps relative paths to bodies. */
function makeCorpus(files) {
  const root = mkdtempSync(join(tmpdir(), 'lint-prompts-'));
  const base = {
    'skills/alpha/SKILL.md': [
      '---',
      'name: alpha',
      'description: a fixture skill',
      '---',
      '',
      '# Alpha',
      '',
      'See `${CLAUDE_PLUGIN_ROOT}/references/engine.md` § 2 and `references/local.md`.',
    ].join('\n'),
    'skills/alpha/references/local.md': '# Local\n',
    'references/engine.md': [
      '# Engine',
      '',
      '## 1. First',
      '',
      '## 2. Second',
      '',
      '### Core rules',
      '',
      '1. Rule one.',
      '2. Rule two.',
      '',
      '### When to stop',
    ].join('\n'),
  };
  for (const [rel, body] of Object.entries({ ...base, ...files })) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

describe('lint-prompts fixtures', () => {
  it('a clean corpus produces zero violations', () => {
    const root = makeCorpus({});
    try {
      assert.deepEqual(lintCorpus(root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a dangling ${CLAUDE_PLUGIN_ROOT} path is named with file and line', () => {
    const root = makeCorpus({
      'skills/alpha/references/local.md':
        '# Local\n\nRead `${CLAUDE_PLUGIN_ROOT}/references/nope.md` first.\n',
    });
    try {
      const v = lintCorpus(root);
      assert.equal(v.length, 1);
      assert.equal(v[0].file, 'skills/alpha/references/local.md');
      assert.equal(v[0].line, 3);
      assert.match(v[0].ref, /references\/nope\.md/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a dangling bare references/ mention resolves per skill-local base', () => {
    const root = makeCorpus({
      'skills/alpha/SKILL.md': [
        '---',
        'name: alpha',
        'description: a fixture skill',
        '---',
        '',
        '# Alpha',
        '',
        'Components live in `references/gone.md`.',
      ].join('\n'),
    });
    try {
      const v = lintCorpus(root);
      assert.equal(v.length, 1);
      assert.equal(v[0].line, 8);
      assert.match(v[0].reason, /references\/ base/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a § reference to a renumbered section fails', () => {
    const root = makeCorpus({
      'skills/alpha/references/local.md': '# Local\n\nPer `engine.md` § 9.\n',
    });
    try {
      const v = lintCorpus(root);
      assert.equal(v.length, 1);
      assert.match(v[0].reason, /no heading numbered 9/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a core rule reference past the last rule fails', () => {
    // Bare sibling filenames resolve same-dir — the corpus's shared-refs shape.
    const root = makeCorpus({
      'references/note.md': '# Note\n\nOwned by `engine.md` core rule 3.\n',
    });
    try {
      const v = lintCorpus(root);
      assert.equal(v.length, 1);
      assert.match(v[0].reason, /core rules 1-2 only/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('an italic anchor left behind by a heading rename fails', () => {
    const root = makeCorpus({
      'references/engine.md': readReplacingWhenToStop(),
      'skills/alpha/references/local.md': '# Local\n\nSee *When to stop* before ending.\n',
    });
    try {
      const v = lintCorpus(root);
      assert.equal(v.length, 1);
      assert.match(v[0].reason, /no heading "When to stop"/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('an italic-anchor violation after a fenced code block keeps its real line number', () => {
    // The fence strip must preserve line structure: deleting the fence's
    // newlines shifts every violation below it up by the fence's height.
    const root = makeCorpus({
      'references/engine.md': readReplacingWhenToStop(),
      'skills/alpha/references/local.md': [
        '# Local',
        '',
        '```',
        'first code line',
        'second code line',
        '```',
        '',
        'See *When to stop* before ending.',
      ].join('\n'),
    });
    try {
      const v = lintCorpus(root);
      assert.equal(v.length, 1);
      assert.equal(v[0].line, 8);
      assert.match(v[0].reason, /no heading "When to stop"/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('SKILL.md frontmatter missing name or description fails', () => {
    const root = makeCorpus({
      'skills/alpha/SKILL.md': '---\nname: alpha\n---\n\n# Alpha\n',
    });
    try {
      const v = lintCorpus(root);
      assert.equal(v.length, 1);
      assert.match(v[0].reason, /no `description:` field/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function readReplacingWhenToStop() {
  return [
    '# Engine',
    '',
    '## 1. First',
    '',
    '## 2. Second',
    '',
    '### Core rules',
    '',
    '1. Rule one.',
    '2. Rule two.',
    '',
    '### When To Stop',
  ].join('\n');
}

describe('path handling', () => {
  it('resolves references in a corpus root containing spaces', () => {
    // fileURLToPath territory: new URL().pathname stays percent-encoded, and
    // every join downstream of it 404s in a spaced checkout. Lock the API
    // boundary — collectCorpus/lintCorpus take root — against that class.
    const root = mkdtempSync(join(tmpdir(), 'lint prompts spaced-'));
    try {
      mkdirSync(join(root, 'skills/alpha'), { recursive: true });
      mkdirSync(join(root, 'references'), { recursive: true });
      writeFileSync(
        join(root, 'skills/alpha/SKILL.md'),
        '---\nname: alpha\ndescription: fixture\n---\n\n# Alpha\n\nSee `${CLAUDE_PLUGIN_ROOT}/references/engine.md`.\n',
      );
      writeFileSync(join(root, 'references/engine.md'), '# Engine\n');
      assert.deepEqual(lintCorpus(root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the live prompt corpus is clean', () => {
  it('lintCorpus(repo) returns zero violations', () => {
    assert.deepEqual(lintCorpus(ROOT), []);
  });
});
