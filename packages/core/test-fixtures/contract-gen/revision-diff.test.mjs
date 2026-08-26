/**
 * Revision-diff band for the annotatable review surface.
 *
 * When a revision supersedes an Approved predecessor whose contract-data.json
 * was archived, contract-gen renders a "Changes since {date}" band with
 * added/removed/changed markers matched by block slug. This suite spawns the
 * CLI (black-box, as scripts/contract-gen.test.mjs does): render v1 into a
 * scratch project, then render v2 from a SEPARATE input so the sibling v1 data
 * is archived and diffed.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const GEN = join(dir, '..', '..', 'scripts', 'contract-gen.ts');

function data(date, criteria) {
  return {
    projectName: 'Diff Demo',
    slug: 'diff-demo',
    date,
    status: 'Approved',
    supersedes: null,
    gates: {
      dimensions: [
        { key: 'problem', label: 'Problem', status: 'ready', evidence: 'x' },
      ],
    },
    problem: ['p'],
    goals: ['g'],
    successCriteria: criteria.map(c => ({ criterion: c, check: { judgment: 'human' } })),
    scope: { mvp: [{ item: 'Scope item stays' }], full: [], stretch: [], outOfScope: [], future: [] },
    decisions: [],
    execution: { strategy: 'linear', phases: [{ title: 'Phase one here', risk: 'low' }] },
  };
}

const V1 = [
  'Keep this one unchanged exactly',
  'Server boots on port zero',
  'Legacy criterion to remove',
];
const V2 = [
  'Keep this one unchanged exactly', // untouched
  'Server boots on port zero quickly', // changed (same first four words)
  'Fresh brand new criterion here', // added
  // 'Legacy criterion to remove' dropped -> removed
];

function render(input, output) {
  const r = spawnSync(process.execPath, [GEN, '--input', input, '--output', output], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `generator failed: ${r.stderr}`);
  return r;
}

describe('revision diff — band renders against archived data', () => {
  it('shows added / removed / changed markers, hides untouched', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'revision-diff-'));
    try {
      const output = join(scratch, 'contract.html');
      const sibling = join(scratch, 'contract-data.json');
      // v1: sibling IS the input, so nothing is archived and no band renders.
      writeFileSync(sibling, JSON.stringify(data('2026-01-01', V1)));
      render(sibling, output);

      // v2: separate input; the sibling v1 gets archived and diffed.
      const v2 = join(scratch, 'v2.json');
      writeFileSync(v2, JSON.stringify(data('2026-02-02', V2)));
      render(v2, output);

      const html = readFileSync(output, 'utf8');
      assert.match(html, /id="changes"/, 'diff band should render');
      assert.match(html, /Changes since 2026-01-01/);

      const rows = [...html.matchAll(/diff-row diff-(added|removed|changed)/g)].map(m => m[1]);
      assert.ok(rows.includes('added'), 'an added marker');
      assert.ok(rows.includes('removed'), 'a removed marker');
      assert.ok(rows.includes('changed'), 'a changed marker');
      // Untouched criterion must not appear as a diff row.
      assert.doesNotMatch(
        html,
        /diff-text">Keep this one unchanged exactly</,
        'untouched item must not render a marker',
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('revision diff — absent without archived data', () => {
  it('a first revision renders no diff band', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'revision-diff-first-'));
    try {
      const output = join(scratch, 'contract.html');
      const input = join(scratch, 'in.json');
      writeFileSync(input, JSON.stringify(data('2026-01-01', V1)));
      render(input, output);
      const html = readFileSync(output, 'utf8');
      assert.doesNotMatch(html, /id="changes"/, 'no band on a first revision');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('a legacy contract with no archived data does not crash and shows no band', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'revision-diff-legacy-'));
    try {
      const output = join(scratch, 'contract.html');
      // Pre-existing Approved html with a supersedes date but no archived data.
      const legacy = data('2026-02-02', V2);
      legacy.supersedes = 'contract-2026-01-01.html';
      const input = join(scratch, 'in.json');
      writeFileSync(input, JSON.stringify(legacy));
      const r = render(input, output);
      assert.equal(r.status, 0);
      const html = readFileSync(output, 'utf8');
      assert.doesNotMatch(html, /id="changes"/, 'no band without archived data');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
