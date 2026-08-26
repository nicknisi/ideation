/**
 * run-report-gen tests.
 *
 * A run report is read by someone who was not watching the run. That makes one
 * failure worse than all the others: a report that reads clean when the run was
 * not. Nothing in a rendered HTML page fails loudly, so the guards have to live
 * here — the warnings band's presence AND its absence, the fixture's warning and
 * finding literals surviving record-to-render, and the refusal of a record that
 * disagrees with itself.
 *
 * Two of these tests exist because the bug already happened in this repo's
 * sibling generator: contract-gen once advertised an outcome the engine cannot
 * produce (an invented `PARTIAL`), which is why the accepted enums are drift-
 * tested against workflows/execute-contract.mjs rather than trusted, and why a
 * record carrying `PARTIAL` has its own negative control.
 *
 * The generator is a CLI: importing it runs parseArgs and exits. So every test
 * spawns it against a scratch directory and reads what it wrote — black box, the
 * same way a caller uses it.
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
const GENPATH = join(dir, 'run-report-gen.ts');
const GEN = readFileSync(GENPATH, 'utf8');
const ENGINE = readFileSync(
  join(dir, '..', 'workflows', 'execute-contract.mjs'),
  'utf8',
);
const FIXTURES = join(dir, '..', 'test-fixtures', 'run-report');
const VALID_FIXTURE = join(FIXTURES, 'run-record.json');
const MALFORMED_FIXTURE = join(FIXTURES, 'malformed-record.json');

/** assert.match dumps the whole haystack on failure; a rendered report is ~40kB. */
const has = (src, re, msg) => assert.ok(re.test(src), msg);
const lacks = (src, re, msg) => assert.ok(!re.test(src), msg);

/** A fresh clone of the committed fixture, for one-field mutations. */
const clone = () => JSON.parse(readFileSync(VALID_FIXTURE, 'utf8'));

/**
 * Run the CLI the way a caller does and report everything observable: exit
 * code, both streams, and whether the output file exists — "nothing was
 * written" is half of what validation promises, so it has to be checked, not
 * assumed. Pass `record` to render an object, `inputPath` to render a
 * committed fixture from its real location.
 */
function runGen({ record, inputPath }) {
  const scratch = mkdtempSync(join(tmpdir(), 'run-report-gen-'));
  try {
    const input = inputPath ?? join(scratch, 'run-record.json');
    if (!inputPath) writeFileSync(input, JSON.stringify(record, null, 2));
    const output = join(scratch, 'nested', 'run-report.html');
    const r = spawnSync(
      process.execPath,
      [GENPATH, '--input', input, '--output', output],
      { encoding: 'utf8' },
    );
    const wrote = existsSync(output);
    return {
      code: r.status,
      out: r.stdout,
      err: r.stderr,
      wrote,
      html: wrote ? readFileSync(output, 'utf8') : null,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Validation — the record's writer is an LLM, so this is a trust boundary
// ---------------------------------------------------------------------------

describe('validation', () => {
  it('accepts the committed fixture', () => {
    const { code, err, wrote } = runGen({ inputPath: VALID_FIXTURE });
    assert.equal(code, 0, `fixture was refused:\n${err}`);
    assert.ok(wrote, 'a valid record produced no output file');
  });

  it('reports all three defects of the malformed fixture in one pass', () => {
    // One fix pass, not one per run: a writer who has to re-run the generator
    // to discover the next violation fixes them one at a time forever.
    const { code, err, wrote } = runGen({ inputPath: MALFORMED_FIXTURE });
    assert.equal(code, 1);
    assert.equal(wrote, false, 'a refused record still produced a report');
    has(err, /3 violations/, 'the violation count is not stated');
    has(
      err,
      /summary\.results\[0\]\.reviewStatus: the string "partial" is not one of passed\|validation-only\|failed\|skipped-empty-diff\|not-run/,
      'the unknown reviewStatus was not reported with its accepted set',
    );
    has(
      err,
      /summary\.completed\[0\]: "Ghost phase" appears in no summary\.results\[\] entry/,
      'the bucketed title with no result was not reported',
    );
    has(
      err,
      /summary\.error: run-level errors produce no report \(nothing ran\)/,
      'the run-level error was not reported',
    );
  });

  it('refuses an invented outcome (negative control)', () => {
    // The exact bug class this repo already shipped once, in contract-gen's
    // run-model diagram: an outcome no engine code path can produce.
    const record = clone();
    record.summary.results[0].result = 'PARTIAL';
    const { code, err, wrote } = runGen({ record });
    assert.equal(code, 1);
    assert.equal(wrote, false);
    has(
      err,
      /summary\.results\[0\]\.result: the string "PARTIAL" is not one of PASS\|NO-OP\|FAIL\|SKIPPED/,
      'PARTIAL was not refused by name',
    );
  });

  it('refuses a bucket that disagrees with its result, naming both sides', () => {
    // The transcription failure this cross-check exists for: in the engine the
    // buckets are derived from results[], so they can only disagree because a
    // human or an LLM retyped one of them.
    const record = clone();
    record.summary.results[0].result = 'FAIL';
    const { code, err, wrote } = runGen({ record });
    assert.equal(code, 1);
    assert.equal(wrote, false);
    has(
      err,
      /summary\.completed\[0\]: "Run-report generator" is bucketed as completed \(which means result "PASS"\) but summary\.results\[0\]\.result is "FAIL"/,
      'the bucket side of the disagreement was not named',
    );
    has(
      err,
      /summary\.results\[0\]: "Run-report generator" has result "FAIL" but is missing from summary\.failed/,
      'the results side of the disagreement was not named',
    );
  });

  it('refuses a title listed twice in one bucket, naming both sides', () => {
    // At-least-one is not enough: the report takes its counts from the bucket
    // lengths, so a doubled title renders "2 of 1 phases completed" and "-1
    // did not complete" — a record disagreeing with itself, stated as a
    // measurement.
    const record = clone();
    record.summary.completed = ['Run-report generator', 'Run-report generator'];
    record.summary.noops = [];
    record.summary.failed = [];
    record.summary.skipped = [];
    record.summary.results = [record.summary.results[0]];
    const { code, err, wrote } = runGen({ record });
    assert.equal(code, 1);
    assert.equal(wrote, false, 'a self-contradicting record still produced a report');
    has(
      err,
      /summary\.results\[0\]: "Run-report generator" appears 2 times in summary\.completed but names one summary\.results\[\] entry/,
      err,
    );
  });

  it('refuses a run that touched no phase', () => {
    // Otherwise it renders "0 of 0 phases completed", "every phase in the plan
    // finished" and a clean stamp: a run that did nothing, described as a
    // successful one.
    const record = clone();
    record.summary = {
      completed: [],
      noops: [],
      failed: [],
      skipped: [],
      results: [],
    };
    const { code, err, wrote } = runGen({ record });
    assert.equal(code, 1);
    assert.equal(wrote, false);
    has(err, /summary\.results: empty/, err);
  });

  it('accepts an empty phase summary — the engine can produce one', () => {
    // The engine builds this field as [...warnings, build.summary,
    // review?.summary].filter(Boolean).join(' — '), which is '' when neither
    // stage produced prose. Refusing it would reject a faithful transcription.
    const record = clone();
    record.summary.results[0].summary = '';
    const { code, err, html } = runGen({ record });
    assert.equal(code, 0, `a legal empty summary was refused:\n${err}`);
    has(html, /No summary text/, 'an empty summary rendered as a blank gap');
  });

  it('refuses a verify block missing its exitCode', () => {
    const record = clone();
    record.verify = { line: 'VERIFY x: commits=1/1 pass=1 fail=0 judgment=0' };
    const { code, err, wrote } = runGen({ record });
    assert.equal(code, 1);
    assert.equal(wrote, false);
    has(err, /verify\.exitCode: expected an integer/, err);
  });

  it('refuses a URL in notesFiles', () => {
    // The report is a self-contained file:// document. An external reference is
    // a defect in the record, not something the renderer should launder.
    const record = clone();
    record.notesFiles = ['https://example.invalid/notes.html'];
    const { code, err, wrote } = runGen({ record });
    assert.equal(code, 1);
    assert.equal(wrote, false);
    has(err, /notesFiles\[0\]: .* is a URL/, err);
  });

  it('refuses a baseBranch that is neither string nor null', () => {
    // The review diff renders as `git diff {baseBranch}...{branch}` — a wrong
    // base produces a misleading diff, so an unknown base must be an explicit
    // null, never a guess.
    const record = clone();
    record.baseBranch = ['main'];
    const { code, err, wrote } = runGen({ record });
    assert.equal(code, 1);
    assert.equal(wrote, false);
    has(err, /baseBranch: expected a string or null/, err);
  });

  it('refuses input that is not JSON, naming the parse failure', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'run-report-gen-parse-'));
    try {
      const input = join(scratch, 'run-record.json');
      writeFileSync(input, '{ "projectName": ');
      const output = join(scratch, 'run-report.html');
      const r = spawnSync(
        process.execPath,
        [GENPATH, '--input', input, '--output', output],
        { encoding: 'utf8' },
      );
      assert.equal(r.status, 1);
      assert.equal(existsSync(output), false);
      has(r.stderr, /is not valid JSON/, r.stderr);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('reports an unreadable input as unreadable, not as bad JSON', () => {
    // Two different rows of the error table: pointing --input at a directory
    // used to read "is not valid JSON: EISDIR", which sends the writer to fix
    // syntax in a file they can't even open.
    const scratch = mkdtempSync(join(tmpdir(), 'run-report-gen-unreadable-'));
    try {
      const r = spawnSync(
        process.execPath,
        [GENPATH, '--input', scratch, '--output', join(scratch, 'out.html')],
        { encoding: 'utf8' },
      );
      assert.equal(r.status, 1);
      has(r.stderr, /Cannot read the run record at/, r.stderr);
      lacks(
        r.stderr,
        /is not valid JSON/,
        'an unreadable path was reported as a syntax error',
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('explains itself when --input is missing', () => {
    const r = spawnSync(process.execPath, [GENPATH], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    has(r.stderr, /Usage: run-report-gen\.ts --input/, r.stderr);
    has(
      r.stderr,
      /OVERWRITES/,
      'the usage block does not warn that --output is overwritten in place',
    );
  });
});

// ---------------------------------------------------------------------------
// Render honesty — what the page says about the run has to be true
// ---------------------------------------------------------------------------

describe('render honesty', () => {
  const rendered = runGen({ inputPath: VALID_FIXTURE });

  it('prints both stdout lines in their exact shapes', () => {
    // Phase 2 reads the second line out of the transcript; its shape is a
    // contract, not a courtesy.
    assert.equal(rendered.code, 0, rendered.err);
    has(
      rendered.out,
      /^Generated \S+ \(\d+ bytes\)$/m,
      `first stdout line drifted:\n${rendered.out}`,
    );
    has(
      rendered.out,
      /^RUN run-report-fixture: completed=2 noops=1 failed=1 skipped=1 warnings=2 verify=fail$/m,
      `RUN line drifted:\n${rendered.out}`,
    );
  });

  it('carries the fixture data literals the acceptance greps target', () => {
    // These are the same literals as the contract's success criteria. They fail
    // here first, with a message that says which one, rather than at acceptance
    // time as a bare non-zero grep.
    const { html } = rendered;
    has(html, /Fixture finding: esc\(\) missing on summary field/, 'a finding did not survive record-to-render');
    has(html, /UNREVIEWED CODE COMMITTED/, 'the unreviewed-commit warning is absent');
    has(
      html,
      /VERIFY run-report-fixture: commits=2\/3 pass=4 fail=1 judgment=1/,
      'the VERIFY line is not rendered verbatim',
    );
    has(html, /href="contract\.html"/, 'the contract link is absent');
    has(
      html,
      /href="implementation-notes-phase-2\.html"/,
      'the implementation-notes link is absent',
    );
  });

  it('references nothing external', () => {
    // Mirrors acceptance criterion 2's negated grep over the whole file,
    // inlined CSS and client JS included, so a stray URL fails in the inner
    // loop instead of at acceptance.
    lacks(
      rendered.html,
      /(src|href)="https?:\/\//,
      'the report carries an external reference — it must open over file:// with no network',
    );
  });

  it('names the contract it executed in the masthead, not only in the close band', () => {
    // A report is opened cold, days later, from a directory of siblings. The
    // close band's contract link at the foot of the page is too late to
    // orient the reader — and a project named like its artifact type (the
    // first real project was literally called "Run Report") makes a bare
    // projectName masthead read as tautology. The lede must state the
    // association before the shape.
    const { code, html } = runGen({ inputPath: VALID_FIXTURE });
    assert.equal(code, 0);
    has(
      html,
      /Execution record of the <a href="contract\.html">[^<]+ contract<\/a>/,
      'the lede must open with the contract association, linked',
    );
  });

  it('renders the review diff in merge-base form against baseBranch', () => {
    // `git diff {branch}` alone diffs the branch tip against the READER's
    // working tree — empty when read on the branch, reversed when read from
    // main. Only the three-dot merge-base form answers "what did this run
    // build". Caught by a human read-through of the first real report
    // (contract criterion 6), after two review cycles passed it: the wrong
    // command was faithfully implemented from the spec, so the guard lives
    // here now.
    const { code, html } = runGen({ inputPath: VALID_FIXTURE });
    assert.equal(code, 0);
    has(
      html,
      /git diff main\.\.\.ideation\/run-report-fixture/,
      'review diff must be {baseBranch}...{branch}',
    );
    lacks(
      html,
      /git diff ideation\//,
      'the two-argument-less form must not survive anywhere',
    );
  });

  it('omits the diff command when the default branch is unknown', () => {
    const record = clone();
    record.baseBranch = null;
    const { code, html } = runGen({ record });
    assert.equal(code, 0);
    lacks(
      html,
      /git diff /,
      'no diff command without a trustworthy base — a wrong diff is worse than none',
    );
  });

  it('leads with the warnings band', () => {
    const { html } = rendered;
    const warnings = html.indexOf('id="warnings"');
    const phases = html.indexOf('id="phases"');
    assert.notEqual(warnings, -1, 'the warned fixture rendered no warnings band');
    assert.ok(
      warnings < phases,
      'the warnings band does not precede the phases band',
    );
  });

  it('renders every finding from every phase, including one that quotes markup', () => {
    const { html } = rendered;
    // The fixture spreads its 4 findings over the first and fourth phases, so
    // a renderer that dropped everything after results[0] would still satisfy
    // assertions aimed only at the first phase. Count them, and read one from
    // the far end.
    const phases = html.slice(
      html.indexOf('id="phases"'),
      html.indexOf('id="verify"'),
    );
    assert.ok(phases.length > 0, 'the phases band was not found');
    assert.equal(
      (phases.match(/<li>/g) ?? []).length,
      4,
      "the phases band does not render exactly the fixture's 4 findings",
    );
    has(
      phases,
      /No test covers a VERIFY line missing the judgment= field/,
      "a finding from the fixture's last phase did not survive record-to-render",
    );
    has(html, /&lt;script&gt;alert\(&quot;drop&quot;\)&lt;\/script&gt;/, 'markup in a finding was not escaped');
    lacks(html, /<script>alert\(/, 'markup in a finding was emitted as markup');
  });

  it('omits the warnings band entirely when nothing warrants one', () => {
    // The absence case is the one that matters: a band that always renders
    // teaches the reader to skip it.
    const record = clone();
    record.summary = {
      completed: ['Only phase'],
      noops: [],
      failed: [],
      skipped: [],
      results: [
        {
          title: 'Only phase',
          result: 'PASS',
          reviewStatus: 'passed',
          commitHash: 'abc1234',
          summary: 'Reviewed and committed.',
          findings: [],
          warnings: [],
          reviewCycles: 1,
        },
      ],
    };
    record.verify = {
      line: 'VERIFY run-report-fixture: commits=1/1 pass=3 fail=0 judgment=0',
      exitCode: 0,
    };
    const { code, out, html } = runGen({ record });
    assert.equal(code, 0);
    lacks(html, /id="warnings"/, 'an all-clean run still rendered a warnings band');
    lacks(html, /UNREVIEWED/, 'an all-clean run mentions unreviewed code');
    has(out, /warnings=0 verify=ok$/m, `RUN line drifted:\n${out}`);
  });

  it('keeps the warnings band for a no-op — an empty diff is not a warning', () => {
    // A healthy NO-OP carries reviewStatus 'skipped-empty-diff' and committed
    // nothing. Keying the band off reviewStatus alone would fire it on every
    // clean run that skipped a satisfied phase.
    const record = clone();
    record.summary = {
      completed: [],
      noops: ['Already satisfied'],
      failed: [],
      skipped: [],
      results: [
        {
          title: 'Already satisfied',
          result: 'NO-OP',
          reviewStatus: 'skipped-empty-diff',
          commitHash: null,
          summary: 'Nothing to change.',
          findings: [],
          warnings: [],
          reviewCycles: 0,
        },
      ],
    };
    record.verify = null;
    const { code, html } = runGen({ record });
    assert.equal(code, 0);
    lacks(html, /id="warnings"/, 'a no-op was treated as a warning');
  });

  it('says so when verification had not run', () => {
    const record = clone();
    record.verify = null;
    const { code, out, html } = runGen({ record });
    assert.equal(code, 0);
    has(
      html,
      /Verification had not run when this record was written/,
      'a null verify block renders no explanation',
    );
    has(
      html,
      /verification had not run when this record was written/,
      'the flight strip does not say verification is missing',
    );
    has(out, /verify=not-run$/m, `RUN line drifted:\n${out}`);
    lacks(html, /VERIFY run-report-fixture/, 'a stale VERIFY line survived');
  });

  it('stamps a run rendered before verification pending, and does not call it done', () => {
    // Phases passing is not the contract's completion predicate. A `clean`
    // stamp here would contradict the two bands on the same page that say
    // verification had not run, and tell a reader who was not watching to
    // stop looking.
    const record = clone();
    record.summary = {
      completed: ['Only phase'],
      noops: [],
      failed: [],
      skipped: [],
      results: [
        {
          title: 'Only phase',
          result: 'PASS',
          reviewStatus: 'passed',
          commitHash: 'abc1234',
          summary: 'Reviewed and committed.',
          findings: [],
          warnings: [],
          reviewCycles: 1,
        },
      ],
    };
    record.verify = null;
    const { code, html } = runGen({ record });
    assert.equal(code, 0);
    has(
      html,
      /data-run-outcome="pending"/,
      'an unverified run was stamped as if the completion predicate had been measured',
    );
    lacks(html, /This run is done\./, 'the close band calls an unverified run done');
    has(
      html,
      /Verification has not run yet\./,
      'the close band does not send the reader to verify',
    );

    // Same phases, verification ran and failed: still not done.
    record.verify = {
      line: 'VERIFY run-report-fixture: commits=1/1 pass=2 fail=1 judgment=0',
      exitCode: 1,
    };
    const failed = runGen({ record });
    assert.equal(failed.code, 0);
    lacks(
      failed.html,
      /This run is done\./,
      'the close band calls a run with failing verification done',
    );
    has(
      failed.html,
      /Every phase passed\. Verification did not\./,
      'the close band does not point at the failing verification',
    );
  });

  it('renders the raw VERIFY line and no parsed cells when the shape is unfamiliar', () => {
    // Never invent a number: a partial match that renders `undefined` as a
    // measurement is the failure mode this falls back from.
    const record = clone();
    record.verify = { line: 'VERIFY somewhere: commits=2/3 pass=4', exitCode: 1 };
    const { code, html } = runGen({ record });
    assert.equal(code, 0);
    has(html, /VERIFY somewhere: commits=2\/3 pass=4/, 'the raw line was dropped');
    has(
      html,
      /did not match the expected shape/,
      'the flight strip does not admit it could not parse the line',
    );
    // Scoped to the strip: the fixture's own prose talks about `undefined`,
    // and the failure mode being guarded is a missing capture group rendered
    // as a measurement.
    const strip = html.slice(
      html.indexOf('<div class="flightstrip">'),
      html.indexOf('</header>'),
    );
    lacks(strip, /undefined/, `an unparsed count leaked into a figure:\n${strip}`);
  });

  it('holds the design non-negotiables a rendered report cannot self-check', () => {
    const { html } = rendered;
    has(html, /<meta name="color-scheme" content="light dark"/, 'no color-scheme meta');
    has(
      html,
      /localStorage\.getItem\('ideation-run-report-theme'\)/,
      'the theme is not applied before first paint, so a forced dark deck flashes light',
    );
    has(html, /@media print/, 'no print stylesheet');
    has(html, /break-inside: avoid/, 'the print stylesheet lets a phase split across pages');
    lacks(html, /@import/, 'the stylesheet is not self-contained');
  });
});

// ---------------------------------------------------------------------------
// Enum drift — the accepted sets belong to the engine, not to this generator
// ---------------------------------------------------------------------------

describe('enum drift vs the engine', () => {
  /** The `const PHASE_RESULT_SCHEMA = { … };` literal, as source text.
   *
   *  Scoping matters: the engine declares `result: { enum: [...] }` in at least
   *  three schemas, and BUILD_RESULT_SCHEMA's is ['BUILT','NO-OP','FAIL']. An
   *  unscoped sweep would quietly teach this generator to accept BUILT. */
  function phaseResultSchema(src) {
    const start = src.indexOf('const PHASE_RESULT_SCHEMA = {');
    assert.notEqual(
      start,
      -1,
      'PHASE_RESULT_SCHEMA not found in execute-contract.mjs — the engine was renamed; update this slice',
    );
    const end = src.indexOf('\n};', start);
    assert.notEqual(
      end,
      -1,
      'PHASE_RESULT_SCHEMA is not terminated by a column-0 "};"',
    );
    return src.slice(start, end + 3);
  }

  /** Quoted values, with `//` comments stripped first — the engine annotates
      every reviewStatus member, and a comment could carry a quote. */
  const values = text =>
    [...text.replace(/\/\/[^\n]*/g, '').matchAll(/'([^']+)'/g)].map(m => m[1]);

  function schemaEnum(block, key) {
    const m = block.match(new RegExp(`${key}:\\s*\\{\\s*enum:\\s*\\[([^\\]]*)\\]`));
    assert.ok(
      m,
      `no "${key}: { enum: [...] }" inside PHASE_RESULT_SCHEMA — the engine's syntax changed; fix this regex before trusting the green`,
    );
    return values(m[1]);
  }

  /** One of this generator's `const NAME = [ … ] as const;` accepted-value sets. */
  function generatorSet(src, name) {
    const start = src.indexOf(`const ${name} = [`);
    assert.notEqual(start, -1, `${name} not found in run-report-gen.ts`);
    const end = src.indexOf('] as const;', start);
    assert.notEqual(end, -1, `${name} is not closed by "] as const;"`);
    return values(src.slice(start, end));
  }

  const BLOCK = phaseResultSchema(ENGINE);
  const engineResults = schemaEnum(BLOCK, 'result');
  const engineStatuses = schemaEnum(BLOCK, 'reviewStatus');
  const genResults = generatorSet(GEN, 'PHASE_RESULTS');
  const genStatuses = generatorSet(GEN, 'REVIEW_STATUSES');

  it('the extractions found something to compare (guards the guard)', () => {
    // Without this, a rotted regex compares two empty sets and passes green.
    assert.ok(
      engineResults.length >= 4,
      `expected >= 4 engine result values, found ${engineResults.length}: ${engineResults.join(', ')}`,
    );
    assert.ok(
      engineStatuses.length >= 5,
      `expected >= 5 engine reviewStatus values, found ${engineStatuses.length}: ${engineStatuses.join(', ')}`,
    );
    assert.ok(genResults.length >= 4, `generator PHASE_RESULTS extraction found ${genResults.length}`);
    assert.ok(genStatuses.length >= 5, `generator REVIEW_STATUSES extraction found ${genStatuses.length}`);
    for (const known of ['PASS', 'NO-OP', 'FAIL', 'SKIPPED'])
      assert.ok(engineResults.includes(known), `engine should declare "${known}"`);
  });

  it('the slice stayed inside PHASE_RESULT_SCHEMA', () => {
    // BUILD_RESULT_SCHEMA sits a few lines below and declares BUILT. If it
    // leaks in, this generator would accept a build-stage outcome as a phase
    // outcome and the drift test would bless it.
    assert.ok(
      ENGINE.includes("enum: ['BUILT', 'NO-OP', 'FAIL']"),
      'the engine no longer declares the BUILD_RESULT_SCHEMA enum this over-match guard is aimed at',
    );
    assert.ok(
      !engineResults.includes('BUILT'),
      'the PHASE_RESULT_SCHEMA slice leaked into a neighbouring schema',
    );
  });

  it('the generator accepts exactly the engine result values', () => {
    assert.deepEqual(
      [...genResults].sort(),
      [...engineResults].sort(),
      `scripts/run-report-gen.ts PHASE_RESULTS (${genResults.join(', ')}) and ` +
        `workflows/execute-contract.mjs PHASE_RESULT_SCHEMA.properties.result.enum ` +
        `(${engineResults.join(', ')}) disagree. The engine owns this set — edit the generator.`,
    );
  });

  it('the generator accepts exactly the engine reviewStatus values', () => {
    assert.deepEqual(
      [...genStatuses].sort(),
      [...engineStatuses].sort(),
      `scripts/run-report-gen.ts REVIEW_STATUSES (${genStatuses.join(', ')}) and ` +
        `workflows/execute-contract.mjs PHASE_RESULT_SCHEMA.properties.reviewStatus.enum ` +
        `(${engineStatuses.join(', ')}) disagree. The engine owns this set — edit the generator.`,
    );
  });

  it('catches a value the engine cannot produce (negative control)', () => {
    const poisoned = GEN.replace(
      "['PASS', 'NO-OP', 'FAIL', 'SKIPPED'] as const",
      "['PASS', 'NO-OP', 'FAIL', 'SKIPPED', 'BUILT'] as const",
    );
    assert.notEqual(poisoned, GEN, 'negative control did not modify the source');
    const extra = generatorSet(poisoned, 'PHASE_RESULTS').filter(
      v => !engineResults.includes(v),
    );
    assert.deepEqual(extra, ['BUILT']);
  });

  it('the engine still raises the warning the fixture quotes', () => {
    // The fixture's warning is a realistic instance of the engine's sentence,
    // and 'UNREVIEWED CODE COMMITTED' is an acceptance grep target. If the
    // engine rewords it, the fixture is quoting something that no longer exists.
    has(
      ENGINE,
      /UNREVIEWED CODE COMMITTED/,
      "the engine no longer raises 'UNREVIEWED CODE COMMITTED' — the fixture quotes a warning the engine cannot produce",
    );
    const fixture = readFileSync(VALID_FIXTURE, 'utf8');
    has(
      fixture,
      /UNREVIEWED CODE COMMITTED/,
      'the fixture no longer carries the warning the acceptance grep targets',
    );
  });
});
