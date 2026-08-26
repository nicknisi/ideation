/**
 * Review-server approval write-back.
 *
 * Spawns packages/pi/src/review-server.ts against a Draft fixture and asserts
 * that POST /decision approve flips contract-data.json Draft -> Approved with
 * an approvedOn date, and that an approve before the surface was ever served
 * (no prior GET /) is refused — the anti-rubber-stamp guard.
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
const DATE = '2026-04-04';

const CONTRACT_HTML = '<!doctype html><html><body><li data-block="blk-x-1">x</li></body></html>';

function startServer(projectDir, slug) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER, '--project-dir', projectDir, '--slug', slug], {
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

function seed(scratch, slug) {
  const slugDir = join(scratch, slug);
  mkdirSync(slugDir, { recursive: true });
  writeFileSync(join(slugDir, 'contract.html'), CONTRACT_HTML);
  writeFileSync(
    join(slugDir, 'contract-data.json'),
    JSON.stringify({ projectName: 'Approve', slug, date: DATE, status: 'Draft', supersedes: null }),
  );
  return slugDir;
}

const approve = port =>
  fetch(`http://127.0.0.1:${port}/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'approve', comments: 0 }),
  });

describe('review server — approve before serving is refused', () => {
  let scratch;
  let handle;
  before(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'review-approve-guard-'));
    seed(scratch, 'guard');
    handle = await startServer(scratch, 'guard');
  });
  after(() => {
    handle?.child.kill();
    rmSync(scratch, { recursive: true, force: true });
  });

  it('refuses to approve without a prior GET /', async () => {
    const res = await approve(handle.port);
    assert.equal(res.status, 409, 'approve must require the surface to be opened');
    const data = JSON.parse(readFileSync(join(scratch, 'guard', 'contract-data.json'), 'utf8'));
    assert.equal(data.status, 'Draft', 'status must not flip');
  });
});

describe('review server — approve flips status', () => {
  let scratch;
  let slugDir;
  let handle;
  before(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'review-approve-'));
    slugDir = seed(scratch, 'approved');
    handle = await startServer(scratch, 'approved');
  });
  after(() => {
    handle?.child.kill();
    rmSync(scratch, { recursive: true, force: true });
  });

  it('flips Draft -> Approved with approvedOn after the surface is served', async () => {
    const opened = await fetch(`http://127.0.0.1:${handle.port}/`);
    assert.equal(opened.status, 200);

    const res = await approve(handle.port);
    assert.equal(res.status, 200);

    const data = JSON.parse(readFileSync(join(slugDir, 'contract-data.json'), 'utf8'));
    assert.equal(data.status, 'Approved');
    assert.match(data.approvedOn, /^\d{4}-\d{2}-\d{2}$/, 'approvedOn is set');
  });
});
