import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { failureAttention } from './change-run.mjs';

test('rejected Anthropic client versions explain the Pi worker problem without dumping provider JSON', () => {
  const failure = new Error('empty: Child produced no output (session error: 400 {"type":"error","error":{"message":"Claude Code 2.1.75 does not support this model; version 2.1.280 or newer is required.","details":{"error_code":"claude_code_version_too_old"}}})');
  const attention = failureAttention(failure);
  assert.equal(attention.reason, 'provider-client-version');
  assert.match(attention.message, /Pi SDK dependencies/);
  assert.match(attention.message, /resume this run/);
  assert.doesNotMatch(attention.message, /\{"type"|Run 'claude update'/);
  assert.equal(attention.detail, failure.message, 'raw diagnostic remains available for inspection');
});

test('worker SDK peers and published lockfile cannot resolve the rejected pre-0.87 Anthropic client', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  for (const name of ['pi-ai', 'pi-coding-agent', 'pi-tui']) {
    const key = `@earendil-works/${name}`;
    assert.equal(pkg.peerDependencies[key], '>=0.87.1');
    assert.equal(lock.packages[''].peerDependencies[key], pkg.peerDependencies[key]);
    const [major, minor, patch] = lock.packages[`node_modules/${key}`].version.split('.').map(Number);
    assert.ok(major > 0 || minor > 87 || (minor === 87 && patch >= 1), `${key} resolves below the supported client floor`);
  }
});
