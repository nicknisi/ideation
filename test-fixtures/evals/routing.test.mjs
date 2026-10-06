// Structure only: the routing cases and the skill's depth vocabulary agree.
// Whether a model actually picks the right depth is the manual checklist in
// each case (README.md says why); nothing here reads model output or prose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const here = new URL('./', import.meta.url);
const skill = readFileSync(new URL('../../skills/ideation/SKILL.md', import.meta.url), 'utf8');

/** The skill's vocabulary: the backticked first column of the table under `## Pick the depth`, with its Writes cell. */
function vocabulary() {
  const section = skill.split(/^## /m).find(s => s.startsWith('Pick the depth\n'));
  assert.ok(section, 'skills/ideation/SKILL.md has a "## Pick the depth" section');
  const [header, , ...rows] = section.split('\n').filter(l => l.startsWith('|'));
  const writes = header.split('|').map(c => c.trim()).indexOf('Writes');
  assert.ok(writes > 0, 'the depth table has a Writes column');
  return rows.map(r => r.split('|').map(c => c.trim())).map(cells => ({
    name: cells[1].match(/^`([^`]+)`$/)?.[1], writesNothing: /^\**nothing\**$/.test(cells[writes]),
  }));
}
const vocab = vocabulary();
const opening = vocab.filter(v => v.writesNothing).map(v => v.name);
const depths = vocab.filter(v => !v.writesNothing).map(v => v.name);

const cases = readdirSync(here).filter(f => /^route-.+\.md$/.test(f)).map(file => {
  const text = readFileSync(new URL(file, here), 'utf8');
  const field = name => text.match(new RegExp(`^\\*\\*${name}\\*\\*: (.+)$`, 'm'))?.[1];
  return {
    file, text,
    depth: field('Expected depth')?.match(/^`([^`]+)`$/)?.[1],
    overrule: field('Overrule')?.match(/^"([^"]+)" → `([^`]+)`$/)?.slice(1),
    asserts: new Set([...text.matchAll(/^- \[ \] \*\*(R\d)\*\*/gm)].map(m => m[1])),
  };
});

test('the skill names four depths and one opening, each by a backticked name', () => {
  assert.ok(vocab.every(v => v.name), 'every depth-table row starts with a backticked name');
  assert.equal(depths.length, 4, `four depths, got ${depths.join(', ')}`);
  assert.equal(opening.length, 1, 'exactly one row writes nothing: the opening');
});

test('every routing case names a depth from the skill and a one-word overrule to another depth', () => {
  assert.ok(cases.length >= 5);
  for (const c of cases) {
    assert.ok([...depths, ...opening].includes(c.depth), `${c.file}: expected depth "${c.depth}" is in the skill's vocabulary`);
    assert.ok(c.overrule, `${c.file}: has an **Overrule**: "word" → \`depth\` line`);
    const [word, target] = c.overrule;
    assert.equal(word, target, `${c.file}: the overrule word is the depth's own name`);
    assert.ok(depths.includes(target), `${c.file}: overrules to a depth, not the opening`);
    assert.notEqual(target, c.depth, `${c.file}: the overrule switches to a different depth`);
  }
});

test('each depth and the opening has at least one routing case', () => {
  for (const name of [...depths, ...opening]) {
    assert.ok(cases.some(c => c.depth === name), `a route-*.md case expects "${name}"`);
  }
});

test('every case asserts the one-line reason (R1) and the overrule (R2); the opening also asserts no files (R3)', () => {
  for (const c of cases) {
    for (const r of ['R1', 'R2']) assert.ok(c.asserts.has(r), `${c.file} asserts ${r}`);
    if (opening.includes(c.depth)) {
      assert.ok(c.asserts.has('R3'), `${c.file} asserts R3`);
      assert.match(c.text, /git status --porcelain/);
      assert.match(c.text, /test ! -e docs\/ideation/);
    }
  }
});

test('the skill states the opening\'s no-files rule as its own heading', () => {
  const [name] = opening;
  const heading = skill.match(/^## The "(.+)" opening writes no files$/m);
  assert.ok(heading, 'SKILL.md has a "## The \\"…\\" opening writes no files" heading');
  assert.equal(heading[1], name, 'the heading names the opening from the depth table');
});
