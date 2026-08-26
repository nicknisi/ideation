/**
 * Model-assumed provenance badge rendering.
 *
 * contract-gen.ts renders a `<span class="provenance">model-assumed</span>`
 * badge next to any success criterion, scope item, or decision carrying
 * `source: 'mined'` (what the mining front door contributed); `source: 'user'`
 * or an absent tag renders no badge. An invalid `source` value is rejected at
 * render time, the same optional-but-validated posture verify.mjs takes on
 * criteria. Same black-box spawn idiom as block-ids.test.mjs — the CLI cannot
 * be imported (parseArgs exits), so render to a scratch dir and assert on the
 * emitted HTML.
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

/** A complete-enough contract with one item of each annotatable kind. The
    `source` fields are filled per-test so the badge matrix is exercised. */
function baseData({ critSource, scopeSource, decisionSource } = {}) {
  return {
    projectName: 'Provenance',
    slug: 'provenance',
    date: '2026-05-05',
    status: 'Draft',
    supersedes: null,
    gates: {
      dimensions: [
        { key: 'problem', label: 'Problem', status: 'ready', evidence: 'x' },
      ],
    },
    problem: ['p'],
    goals: ['g'],
    successCriteria: [
      {
        criterion: 'Mined criterion under review',
        check: { judgment: 'human' },
        ...(critSource ? { source: critSource } : {}),
      },
    ],
    scope: {
      mvp: [{ item: 'Mined scope item', ...(scopeSource ? { source: scopeSource } : {}) }],
      full: [],
      stretch: [],
      outOfScope: [],
      future: [],
    },
    decisions: [
      {
        decision: 'Mined decision taken',
        reason: 'simpler',
        ...(decisionSource ? { source: decisionSource } : {}),
      },
    ],
    execution: { strategy: 'linear', phases: [{ title: 'Only phase here', risk: 'low' }] },
  };
}

/** Render `data`, returning `{ code, err, html }`. html is '' on non-zero exit. */
function render(data) {
  const scratch = mkdtempSync(join(tmpdir(), 'provenance-'));
  try {
    const input = join(scratch, 'in.json');
    const output = join(scratch, 'contract.html');
    writeFileSync(input, JSON.stringify(data));
    const r = spawnSync(process.execPath, [GEN, '--input', input, '--output', output], {
      encoding: 'utf8',
    });
    const html = r.status === 0 ? readFileSync(output, 'utf8') : '';
    return { code: r.status, err: r.stderr, html };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const BADGE = 'class="provenance">model-assumed</span>';

describe('provenance badge — mined renders it', () => {
  it('a mined criterion, scope item, and decision each render the badge', () => {
    const { code, html } = render(
      baseData({ critSource: 'mined', scopeSource: 'mined', decisionSource: 'mined' }),
    );
    assert.equal(code, 0);
    const badges = [...html.matchAll(/class="provenance">model-assumed<\/span>/g)];
    assert.equal(badges.length, 3, 'one badge per mined item');
  });
});

describe('provenance badge — user and unset render nothing', () => {
  it('source: user renders no badge', () => {
    const { code, html } = render(
      baseData({ critSource: 'user', scopeSource: 'user', decisionSource: 'user' }),
    );
    assert.equal(code, 0);
    assert.ok(!html.includes(BADGE), 'user-sourced items carry no model-assumed badge');
  });

  it('an absent source renders no badge (legacy data)', () => {
    const { code, html } = render(baseData());
    assert.equal(code, 0);
    assert.ok(!html.includes(BADGE), 'untagged items carry no badge');
  });
});

describe('provenance badge — invalid enum is rejected', () => {
  it('an unknown source value exits non-zero naming the field', () => {
    const { code, err } = render(baseData({ critSource: 'guessed' }));
    assert.equal(code, 1);
    assert.match(err, /source/);
    assert.match(err, /successCriteria\[0\]/);
  });

  it('an invalid scope source is rejected too', () => {
    const { code, err } = render(baseData({ scopeSource: 'robot' }));
    assert.equal(code, 1);
    assert.match(err, /scope\.mvp\[0\]/);
  });
});
