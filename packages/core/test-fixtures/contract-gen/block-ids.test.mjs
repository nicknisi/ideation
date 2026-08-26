/**
 * Block-id determinism for the annotatable review surface.
 *
 * contract-gen.ts derives an `id`/`data-block` for every annotatable <li>
 * (criterion, scope item, decision) from the item's content, so a comment
 * pinned to a block survives regeneration of unchanged content. This suite
 * spawns the CLI (it cannot be imported — parseArgs exits) against a scratch
 * dir and diffs the emitted id sets, the same black-box idiom as
 * scripts/contract-gen.test.mjs.
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

function baseData() {
  return {
    projectName: 'Block Ids',
    slug: 'block-ids',
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
      { criterion: 'First criterion holds steady', check: { judgment: 'human' } },
      { criterion: 'Second criterion also present', check: { judgment: 'human' } },
    ],
    scope: {
      mvp: [{ item: 'Mvp alpha item' }, { item: 'Mvp beta item' }],
      full: [{ item: 'Full gamma item' }],
      stretch: [],
      outOfScope: [],
      future: [],
    },
    decisions: [{ decision: 'Picked one path', reason: 'simpler' }],
    execution: { strategy: 'linear', phases: [{ title: 'Only phase here', risk: 'low' }] },
  };
}

/** Render `data` to a fresh scratch dir and return the sorted data-block ids. */
function renderIds(data) {
  const scratch = mkdtempSync(join(tmpdir(), 'block-ids-'));
  try {
    const input = join(scratch, 'in.json');
    const output = join(scratch, 'contract.html');
    writeFileSync(input, JSON.stringify(data));
    const r = spawnSync(process.execPath, [GEN, '--input', input, '--output', output], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `generator failed: ${r.stderr}`);
    const html = readFileSync(output, 'utf8');
    return [...html.matchAll(/data-block="([^"]+)"/g)].map(m => m[1]).sort();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe('block ids — determinism', () => {
  it('the same data renders a byte-identical id set twice', () => {
    const a = renderIds(baseData());
    const b = renderIds(baseData());
    assert.deepEqual(a, b);
    assert.ok(a.length >= 6, `expected ids for every annotatable item, got ${a.length}`);
    for (const id of a) assert.match(id, /^blk-[a-z0-9-]+-[0-9a-f]{6}$/);
  });

  it('reordering an array leaves unchanged items with their ids', () => {
    const before = renderIds(baseData());
    const reordered = baseData();
    reordered.scope.mvp.reverse();
    reordered.successCriteria.reverse();
    const after = renderIds(reordered);
    // Same set — order in the array does not change any id.
    assert.deepEqual(after, before);
  });

  it('editing one item changes only its id', () => {
    const before = renderIds(baseData());
    const edited = baseData();
    edited.successCriteria[0].criterion = 'First criterion holds steady always now';
    const after = renderIds(edited);
    const gone = before.filter(id => !after.includes(id));
    const added = after.filter(id => !before.includes(id));
    assert.equal(gone.length, 1, 'exactly one id should disappear');
    assert.equal(added.length, 1, 'exactly one id should appear');
    // Every other id is untouched.
    const stable = before.filter(id => id !== gone[0]);
    for (const id of stable) assert.ok(after.includes(id), `${id} should survive the edit`);
  });
});
