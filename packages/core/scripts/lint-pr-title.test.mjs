/**
 * lint-pr-title tests.
 *
 * The linter's job is to stop a PR title that release-please would silently
 * ignore, so the tests that matter most are the drift ones at the bottom:
 * every type release-please is configured to recognize must be accepted, and
 * the historical titles on main — the ones that actually produced releases —
 * must still pass. A linter stricter than the repo's own history would reject
 * the work it was written to describe.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { allowedTypes, lintPrTitle } from './lint-pr-title.mjs';

const ROOT = join(dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const TYPES = allowedTypes();

describe('lintPrTitle — accepts', () => {
  const valid = [
    'feat: add a thing',
    'fix: correct a thing',
    'feat(site): generate the command reference at build time',
    'fix(execute-spec,autopilot): surface degraded review',
    'feat!: replace the confidence object with gates',
    'feat(contract)!: rebuild the contract',
    'chore(ci): pin the remaining actions to commit SHAs',
    'docs: point the README at ideation.engineering, and fix a path I broke',
    'revert: undo the Node 24 bump',
  ];

  for (const title of valid) {
    it(title, () => {
      const result = lintPrTitle(title, TYPES);
      assert.equal(result.ok, true, result.ok ? '' : `rejected: ${result.reason}`);
    });
  }

  it('parses the pieces out', () => {
    assert.deepEqual(lintPrTitle('feat(site)!: a thing', TYPES), {
      ok: true,
      type: 'feat',
      scope: 'site',
      breaking: true,
      subject: 'a thing',
    });
  });

  it('treats a bare type as unscoped and non-breaking', () => {
    const r = lintPrTitle('fix: a thing', TYPES);
    assert.equal(r.scope, null);
    assert.equal(r.breaking, false);
  });
});

describe('lintPrTitle — rejects', () => {
  const invalid = [
    ['', 'empty'],
    ['   ', 'whitespace only'],
    ['add a thing', 'no type prefix'],
    ['Feat: add a thing', 'capitalized type'],
    ['feat:add a thing', 'no space after the colon'],
    ['feat: ', 'empty subject'],
    ['feat(): a thing', 'empty scope'],
    ['wibble: a thing', 'unknown type'],
    ['feature: a thing', 'near-miss type'],
    ['feat add a thing', 'missing colon'],
    [' feat: a thing', 'leading whitespace'],
    ['feat: a thing ', 'trailing whitespace'],
  ];

  for (const [title, why] of invalid) {
    it(`${why}: ${JSON.stringify(title)}`, () => {
      const result = lintPrTitle(title, TYPES);
      assert.equal(result.ok, false, 'expected rejection');
      assert.ok(result.reason.length > 0, 'a rejection must explain itself');
    });
  }

  it('names the offending type rather than restating the grammar', () => {
    const r = lintPrTitle('wibble: a thing', TYPES);
    assert.match(r.reason, /wibble/);
  });
});

describe('drift — the linter and release-please must agree', () => {
  it('accepts every type release-please is configured to recognize', () => {
    const config = JSON.parse(readFileSync(join(ROOT, 'release-please-config.json'), 'utf8'));
    for (const { type } of config['changelog-sections']) {
      const result = lintPrTitle(`${type}: a thing`, TYPES);
      assert.equal(result.ok, true, `linter rejects a configured type: ${type}`);
    }
  });

  it('derives its types from the config rather than a hardcoded list', () => {
    const config = JSON.parse(readFileSync(join(ROOT, 'release-please-config.json'), 'utf8'));
    for (const { type } of config['changelog-sections']) {
      assert.ok(TYPES.includes(type), `${type} missing from allowedTypes()`);
    }
  });

  it('accepts `revert` even though it has no changelog section', () => {
    const config = JSON.parse(readFileSync(join(ROOT, 'release-please-config.json'), 'utf8'));
    assert.ok(
      !config['changelog-sections'].some((s) => s.type === 'revert'),
      'precondition: revert is not in the config',
    );
    assert.equal(lintPrTitle('revert: a thing', TYPES).ok, true);
  });

  it('throws rather than silently passing everything if the config loses its sections', () => {
    assert.throws(() => allowedTypes(join(ROOT, 'package.json')), /changelog-sections/);
  });
});

describe('drift — historical release titles still pass', () => {
  // These are the real squash-merge subjects that produced 0.16.0 through
  // 0.20.0. They are the closest thing to a spec for "a title this repo ships".
  const historical = [
    'feat: restore the review layer, mechanical completion, and a rebuilt contract',
    'feat: one-door flow, generated contract.md, push-based learning loop',
    'feat: decision log + strawman elicitation',
    'feat: add /ideation:express — one-pass planning-to-execution',
    'feat: add over-engineering critic lens + sharpen interview/spec disciplines',
    'feat(docs): land the ideation site on main (re-target of #6)',
  ];

  for (const title of historical) {
    it(title.slice(0, 60), () => {
      const result = lintPrTitle(title, TYPES);
      assert.equal(result.ok, true, result.ok ? '' : `rejected: ${result.reason}`);
    });
  }
});
