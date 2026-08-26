/**
 * Intake-stats rendering — the RunRecord's optional questionCount / miningOutcome.
 *
 * These two fields are NOT part of the run record itself: run-report-gen reads
 * them from the sibling contract-data.json's `intake` block at generation time
 * ({ intake: { questionsAsked, miningOutcome } }, written by the mining intake
 * at contract time). This test seeds a scratch directory with both files and
 * checks the present/rendered/omitted matrix — the same black-box, spawn-the-CLI
 * convention as run-report-gen.test.mjs.
 *
 * The omit case is the one that matters most: a legacy contract with no intake
 * block must render neither field, and never leak the string `undefined` into a
 * flight-strip figure.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const GENPATH = join(dir, '..', '..', 'scripts', 'run-report-gen.ts');
const VALID_FIXTURE = join(dir, 'run-record.json');

/** assert.match dumps the whole ~40kB report on failure; scope instead. */
const has = (src, re, msg) => assert.ok(re.test(src), msg);
const lacks = (src, re, msg) => assert.ok(!re.test(src), msg);

/** A fresh clone of the committed run-record fixture. */
const cloneRecord = () => JSON.parse(readFileSync(VALID_FIXTURE, 'utf8'));

/** The flight strip slice, where both intake cells render. */
function flightStrip(html) {
  return html.slice(
    html.indexOf('<div class="flightstrip">'),
    html.indexOf('</header>'),
  );
}

/**
 * Render a run record, optionally seeding a sibling contract-data.json carrying
 * an `intake` block. Returns exit code + rendered HTML, black-box.
 */
function render({ record, intake }) {
  const scratch = mkdtempSync(join(tmpdir(), 'intake-stats-'));
  try {
    const input = join(scratch, 'run-record.json');
    writeFileSync(input, JSON.stringify(record, null, 2));
    if (intake !== undefined) {
      writeFileSync(
        join(scratch, 'contract-data.json'),
        JSON.stringify({ projectName: 'x', slug: 'x', intake }, null, 2),
      );
    }
    const output = join(scratch, 'run-report.html');
    const r = spawnSync(
      process.execPath,
      [GENPATH, '--input', input, '--output', output],
      { encoding: 'utf8' },
    );
    const wrote = existsSync(output);
    return {
      code: r.status,
      err: r.stderr,
      html: wrote ? readFileSync(output, 'utf8') : null,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe('intake stats — present', () => {
  it('renders questionCount and a picked mining outcome', () => {
    const { code, err, html } = render({
      record: cloneRecord(),
      intake: { questionsAsked: 3, miningOutcome: 'picked' },
    });
    assert.equal(code, 0, err);
    const strip = flightStrip(html);
    has(strip, /intake questions/, 'the intake-questions cell is absent');
    has(strip, /<span class="num">03<\/span>/, 'questionCount 3 did not render');
    has(strip, />mining</, 'the mining cell is absent');
    has(strip, /<span class="num">picked<\/span>/, 'the picked outcome did not render');
  });

  it('renders a rejected-all mining outcome', () => {
    const { code, html } = render({
      record: cloneRecord(),
      intake: { questionsAsked: 12, miningOutcome: 'rejected-all' },
    });
    assert.equal(code, 0);
    const strip = flightStrip(html);
    has(strip, /<span class="num">12<\/span>/, 'questionCount 12 did not render');
    has(strip, /<span class="num">rejected-all<\/span>/, 'the rejected-all outcome did not render');
  });
});

describe('intake stats — omitted', () => {
  it('renders neither field when no sibling contract-data.json exists (legacy)', () => {
    const { code, html } = render({ record: cloneRecord() });
    assert.equal(code, 0);
    const strip = flightStrip(html);
    lacks(strip, /intake questions/, 'a legacy record rendered an intake-questions cell');
    lacks(strip, />mining</, 'a legacy record rendered a mining cell');
    lacks(strip, /undefined/, `an omitted field leaked "undefined" into the strip:\n${strip}`);
  });

  it('renders neither field when the sibling has no intake block', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'intake-stats-noblock-'));
    try {
      const input = join(scratch, 'run-record.json');
      writeFileSync(input, JSON.stringify(cloneRecord(), null, 2));
      writeFileSync(
        join(scratch, 'contract-data.json'),
        JSON.stringify({ projectName: 'x', slug: 'x' }, null, 2),
      );
      const output = join(scratch, 'run-report.html');
      const r = spawnSync(
        process.execPath,
        [GENPATH, '--input', input, '--output', output],
        { encoding: 'utf8' },
      );
      assert.equal(r.status, 0, r.stderr);
      const strip = flightStrip(readFileSync(output, 'utf8'));
      lacks(strip, /intake questions/, 'a sibling without intake rendered the cell');
      lacks(strip, /undefined/, 'a missing intake block leaked "undefined"');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('ignores a junk miningOutcome rather than rendering it', () => {
    const { code, html } = render({
      record: cloneRecord(),
      intake: { questionsAsked: 4, miningOutcome: 'bogus' },
    });
    assert.equal(code, 0);
    const strip = flightStrip(html);
    has(strip, /<span class="num">04<\/span>/, 'a valid questionCount was dropped alongside the junk outcome');
    lacks(strip, />mining</, 'a junk miningOutcome was rendered');
    lacks(strip, /bogus/, 'the junk outcome value leaked into the report');
  });
});
