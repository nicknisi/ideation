/**
 * Review-server feedback round-trip.
 *
 * Spawns packages/pi/src/review-server.ts on an ephemeral port against a
 * fixture slug directory, POSTs a pinned comment and a deny, and asserts the
 * feedback-{date}.json it writes (version, block id, deny reasons) plus the
 * post-resolution 410. Black-box over HTTP + the filesystem, the same
 * spawn+fs idiom the CLI tests use.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const SERVER = join(dir, '..', '..', '..', 'pi', 'src', 'review-server.ts');
const SLUG = 'review-fixture';
const DATE = '2026-03-03';

const CONTRACT_HTML =
  '<!doctype html><html><body>' +
  '<li data-block="blk-alpha-item-abc123">Alpha item</li>' +
  '</body></html>';

function contractData() {
  return { projectName: 'Review Fixture', slug: SLUG, date: DATE, status: 'Draft', supersedes: null };
}

/** Spawn the server, resolve once it prints its port. */
function startServer(projectDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER, '--project-dir', projectDir, '--slug', SLUG], {
      encoding: 'utf8',
    });
    let buf = '';
    let done = false;
    const timer = setTimeout(() => {
      if (!done) reject(new Error(`server did not start; stdout: ${buf}`));
    }, 10000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buf += chunk;
      const m = buf.match(/REVIEW_PORT (\d+)/);
      if (m && !done) {
        done = true;
        clearTimeout(timer);
        resolve({ child, port: Number(m[1]) });
      }
    });
    child.on('error', reject);
  });
}

const post = (port, path, body) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('review server — feedback round-trip', () => {
  let scratch;
  let slugDir;
  let handle;

  before(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'review-feedback-'));
    slugDir = join(scratch, SLUG);
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(join(slugDir, 'contract.html'), CONTRACT_HTML);
    writeFileSync(join(slugDir, 'contract-data.json'), JSON.stringify(contractData()));
    handle = await startServer(scratch);
  });

  after(() => {
    handle?.child.kill();
    rmSync(scratch, { recursive: true, force: true });
  });

  it('GET / injects the annotation bundle into a pristine contract', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /window\.__REVIEW__/, 'the config is injected');
    assert.match(html, /ideation-review-annotate/, 'the bundle is injected');
    // The on-disk file stays pristine.
    const onDisk = readFileSync(join(slugDir, 'contract.html'), 'utf8');
    assert.doesNotMatch(onDisk, /ideation-review-annotate/, 'on-disk html has no annotation chrome');
  });

  it('POST /feedback appends a comment, then a deny writes reasons', async () => {
    const c = await post(handle.port, '/feedback', {
      blockId: 'blk-alpha-item-abc123',
      kind: 'comment',
      text: 'tighten this item',
    });
    assert.equal(c.status, 200);

    const d = await post(handle.port, '/decision', {
      decision: 'deny',
      reasons: ['scope is too wide'],
      comments: 1,
    });
    assert.equal(d.status, 200);

    const file = JSON.parse(readFileSync(join(slugDir, `feedback-${DATE}.json`), 'utf8'));
    assert.equal(file.version, 1);
    assert.equal(file.slug, SLUG);
    const comment = file.entries.find(e => e.kind === 'comment');
    const deny = file.entries.find(e => e.kind === 'deny');
    assert.equal(comment.blockId, 'blk-alpha-item-abc123');
    assert.equal(comment.text, 'tighten this item');
    assert.equal(deny.text, 'scope is too wide');

    // A POST after the deny resolved the review gets 410 (checked immediately,
    // before the resolution's scheduled shutdown).
    const late = await post(handle.port, '/feedback', {
      blockId: null,
      kind: 'comment',
      text: 'too late',
    });
    assert.equal(late.status, 410);
  });
});
