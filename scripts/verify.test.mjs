// Tests for scripts/verify.mjs — the contract completion predicate.
// Run: node --test scripts/verify.test.mjs   (from the repo root)

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  adviseRunMode,
  checkKind,
  isEntryPoint,
  isStaticCheck,
  main,
  normalizeCheck,
  normalizeCriterion,
  summarizeCriteria,
  validateCheck,
} from './verify.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'verify-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Run the CLI in-process and capture what it printed. */
function run(args) {
  const out = [];
  const log = console.log;
  const write = process.stdout.write.bind(process.stdout);
  console.log = (...a) => out.push(a.join(' '));
  process.stdout.write = s => (out.push(String(s)), true);
  try {
    return { code: main(args), out: out.join('\n') };
  } finally {
    console.log = log;
    process.stdout.write = write;
  }
}

/** A contract whose only variable is its criteria and phases. */
function contract(successCriteria, phases = []) {
  const path = join(scratch, `c-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      projectName: 'Test Contract',
      slug: 'test-contract',
      date: '2026-07-25',
      status: 'Approved',
      successCriteria,
      execution: { strategy: 'Sequential', phases },
    }),
  );
  return path;
}

/**
 * A throwaway git repo containing one commit whose body carries `specPath`.
 *
 * The commit-matching tests used to assert against THIS repo's history (a spec
 * path in db0fb41's body). That passed locally and failed on CI, where
 * actions/checkout does a shallow clone and the commit does not exist. A unit
 * test should not depend on the history of the repo it lives in — so build the
 * history the test needs.
 */
function repoWithCommitFor(specPath) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-repo-'));
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Verify Test');
  // A throwaway repo must not inherit the user's global commit signing: on a
  // machine with commit.gpgsign=true and an unavailable signer the commit
  // silently never lands and the test fails for the wrong reason (after the
  // signer's timeout, no less).
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'placeholder.txt'), 'x\n');
  git('add', '-A');
  git('commit', '-q', '-m', `feat: a phase\n\nPhase 1 of ${specPath}`);
  return dir;
}

/** Run the CLI with cwd inside `dir`, since repoRoot() derives from cwd. */
function runIn(dir, args) {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return run(args);
  } finally {
    process.chdir(prev);
  }
}

describe('legacy string normalization', () => {
  it('splits a plain string on the em-dash into cmd and expect', () => {
    assert.deepEqual(normalizeCheck('npx vitest run src/auth — exits 0'), {
      cmd: 'npx vitest run src/auth',
      expect: 'exits 0',
    });
  });

  it('keeps later em-dashes inside the expectation', () => {
    assert.deepEqual(
      normalizeCheck("grep -q x f.md — exits 0 — the file's own marker"),
      { cmd: 'grep -q x f.md', expect: "exits 0 — the file's own marker" },
    );
  });

  it('treats a string with no em-dash as a bare command', () => {
    assert.deepEqual(normalizeCheck('node --test t.mjs'), {
      cmd: 'node --test t.mjs',
      expect: '',
    });
  });

  it('coerces a "judgment call:" string to a judgment check', () => {
    assert.deepEqual(
      normalizeCheck('judgment call: visual review in light and dark'),
      { judgment: 'visual review in light and dark' },
    );
  });

  it('coerces a string with no plausible shell token to judgment', () => {
    assert.deepEqual(normalizeCheck('— nothing runnable here'), {
      judgment: '— nothing runnable here',
    });
  });

  it('passes the union shape through untouched', () => {
    assert.deepEqual(normalizeCheck({ cmd: 'true', expect: 'exits 0' }), {
      cmd: 'true',
      expect: 'exits 0',
    });
    assert.deepEqual(normalizeCheck({ judgment: 'look at it' }), {
      judgment: 'look at it',
    });
  });

  it('treats an absent check as absent, not as an empty command', () => {
    assert.equal(normalizeCheck(undefined), undefined);
    assert.equal(normalizeCriterion('bare string criterion').check, undefined);
  });

  it('tolerates a null criterion instead of crashing', () => {
    // A null inside successCriteria used to take verify down with a TypeError
    // reading `raw.criterion` — and verify's exit code is what a /goal's
    // done-when consumes, so a crash is the ultimate misreadable red.
    assert.deepEqual(normalizeCriterion(null), { criterion: 'null' });
    assert.deepEqual(normalizeCriterion(undefined), { criterion: 'undefined' });
  });
});

describe('validateCheck rejects prose in the executable slot', () => {
  it('rejects " then " with no shell conditional', () => {
    const err = validateCheck(
      normalizeCheck('npm run docs:dev & then curl -sf localhost:5173'),
    );
    assert.match(err, /prose|bare "&"/);
  });

  it('rejects a bare & that would leak a background process', () => {
    assert.match(validateCheck({ cmd: 'sleep 30 & wait', expect: '' }), /bare "&"/);
  });

  it('allows && and 2>&1', () => {
    assert.equal(validateCheck({ cmd: 'a && b 2>&1', expect: '' }), null);
  });

  it('allows a real if/then', () => {
    assert.equal(
      validateCheck({ cmd: 'if [ -f x ]; then echo y; fi', expect: '' }),
      null,
    );
  });

  it('rejects a command sh cannot parse', () => {
    assert.match(validateCheck({ cmd: 'grep -q "unclosed f.md', expect: '' }), /valid shell/);
  });

  it('never rejects a judgment check', () => {
    assert.equal(validateCheck({ judgment: 'anything at all & then some' }), null);
  });
});

describe('judgment criteria are never counted as pass or fail', () => {
  it('summarizeCriteria counts explicit and absent judgment alike', () => {
    const s = summarizeCriteria(
      [
        { criterion: 'a', check: { cmd: 'true', expect: '' } },
        { criterion: 'b', check: { judgment: 'look' } },
        { criterion: 'c' },
      ].map(c => ({ ...c })),
    );
    assert.deepEqual(
      { total: s.total, cmd: s.cmd, judgment: s.judgment },
      { total: 3, cmd: 1, judgment: 2 },
    );
    assert.equal(s.line, '3 criteria (1 cmd, 2 judgment)');
    assert.equal(checkKind({ judgment: 'x' }), 'judgment');
    assert.equal(checkKind({ cmd: 'true' }), 'cmd');
  });

  it('a failing-looking judgment note does not add to fail', () => {
    const path = contract([
      { criterion: 'runs', check: { cmd: 'true', expect: 'exits 0' } },
      { criterion: 'looks right', check: { judgment: 'false; exit 1' } },
      { criterion: 'unstated' },
    ]);
    const { code, out } = run([path]);
    assert.match(out, /VERIFY test-contract: commits=0\/0 pass=1 fail=0 judgment=2/);
    assert.equal(code, 0);
  });
});

describe('exit code', () => {
  const SPEC = 'docs/ideation/ux-dejank/spec-phase-1.md';

  it('is 0 when every cmd passes and every phase has a commit', () => {
    const repo = repoWithCommitFor(SPEC);
    const path = contract(
      [{ criterion: 'ok', check: { cmd: 'true', expect: 'exits 0' } }],
      [{ title: 'P1', specPath: SPEC }],
    );
    const { code, out } = runIn(repo, [path]);
    assert.match(out, /commits=1\/1 pass=1 fail=0 judgment=0/);
    assert.equal(code, 0);
    rmSync(repo, { recursive: true, force: true });
  });

  it('is 1 when a cmd fails, even with commits complete', () => {
    const repo = repoWithCommitFor(SPEC);
    const path = contract(
      [
        { criterion: 'ok', check: { cmd: 'true', expect: '' } },
        { criterion: 'nope', check: { cmd: 'exit 3', expect: 'exits 0' } },
      ],
      [{ title: 'P1', specPath: SPEC }],
    );
    const { code, out } = runIn(repo, [path]);
    assert.match(out, /commits=1\/1 pass=1 fail=1 judgment=0/);
    assert.match(out, /exit 3 after/);
    assert.equal(code, 1);
    rmSync(repo, { recursive: true, force: true });
  });

  it('is 1 when checks pass but a phase has no commit', () => {
    const path = contract(
      [{ criterion: 'ok', check: { cmd: 'true', expect: '' } }],
      [{ title: 'P1', specPath: 'docs/ideation/no-such-project/spec-phase-1.md' }],
    );
    const { code, out } = run([path]);
    assert.match(out, /commits=0\/1 pass=1 fail=0 judgment=0/);
    assert.equal(code, 1);
  });

  it('counts an unrunnable cmd as a failure rather than executing it', () => {
    const path = contract([
      { criterion: 'prose', check: 'npm run dev & then curl localhost' },
    ]);
    const { code, out } = run([path]);
    assert.match(out, /pass=0 fail=1 judgment=0/);
    assert.equal(code, 1);
  });

  it('excludes gates and specPath-less phases from the commit denominator', () => {
    const path = contract(
      [{ criterion: 'ok', check: { cmd: 'true', expect: '' } }],
      [
        { title: 'Review', kind: 'gate', specPath: 'docs/ideation/x/gate.md' },
        { title: 'Undecided' },
      ],
    );
    const { code, out } = run([path]);
    assert.match(out, /commits=0\/0 pass=1 fail=0/);
    assert.equal(code, 0);
  });

  it('runs cmd checks sequentially in array order', () => {
    const marker = join(scratch, 'order.txt');
    const path = contract([
      { criterion: 'first writes', check: { cmd: `printf a > ${marker}`, expect: '' } },
      { criterion: 'second appends', check: { cmd: `printf b >> ${marker}`, expect: '' } },
      { criterion: 'third reads', check: { cmd: `test "$(cat ${marker})" = ab`, expect: '' } },
    ]);
    const { code } = run([path]);
    assert.equal(code, 0);
  });
});

describe('--list', () => {
  it('enumerates criteria and kinds without running anything', () => {
    const sentinel = join(scratch, 'must-not-exist');
    const path = contract([
      { criterion: 'would touch a file', check: { cmd: `touch ${sentinel}`, expect: '' } },
      { criterion: 'human', check: { judgment: 'someone looks' } },
    ]);
    const { code, out } = run([path, '--list']);
    assert.equal(existsSync(sentinel), false, 'no check may execute under --list');
    assert.match(out, /\[1\/2\] cmd\s+would touch a file/);
    assert.match(out, /\[2\/2\] judgment\s+human/);
    assert.match(out, /LIST test-contract: 2 criteria \(1 cmd, 1 judgment\)/);
    assert.equal(code, 0);
  });

  it('prints no VERIFY line, so a listing can never be read as a result', () => {
    const path = contract([{ criterion: 'x', check: { cmd: 'true', expect: '' } }]);
    assert.doesNotMatch(run([path, '--list']).out, /^VERIFY /m);
  });
});

describe('header states the scope so a stale run is obvious', () => {
  it('prints the contract date, status, and the not-a-health-check caveat', () => {
    const path = contract([{ criterion: 'x', check: { judgment: 'look' } }]);
    const { out } = run([path, '--list']);
    assert.match(out, /dated\s+2026-07-25 · status Approved/);
    assert.match(out, /not a repo health check/);
  });
});

describe('isStaticCheck — does the check actually run anything?', () => {
  it('flags a check that only inspects files', () => {
    assert.equal(isStaticCheck("grep -q 'strawman' references/interview-engine.md"), true);
    assert.equal(isStaticCheck('test ! -e skills/retro'), true);
    assert.equal(isStaticCheck("ls docs/index.md docs/how-it-works.md"), true);
  });

  it('does NOT flag a pipeline that executes something, even if it greps after', () => {
    // The grep is reading real output here — that is a genuine behavioral check.
    assert.equal(
      isStaticCheck("node scripts/contract-gen.ts --input x.json --output /tmp/o.html && grep -ci 'decisions' /tmp/o.html"),
      false,
    );
    assert.equal(isStaticCheck('npm run docs:build'), false);
    assert.equal(isStaticCheck('node --test workflows/wave-planner.test.mjs'), false);
  });

  it('sees through leading negation and path prefixes', () => {
    assert.equal(isStaticCheck("! grep -rq 'ideation:retro' skills/"), true);
    assert.equal(isStaticCheck('/usr/bin/grep -q x f.md'), true);
  });

  it('is false for junk rather than throwing', () => {
    assert.equal(isStaticCheck(''), false);
    assert.equal(isStaticCheck(undefined), false);
  });
});

describe('adviseRunMode — the routing decision, first match wins', () => {
  const dyn = n => ({ criterion: `c${n}`, check: { cmd: `node --test t${n}.mjs`, expect: 'exits 0' } });
  const stat = n => ({ criterion: `s${n}`, check: { cmd: `grep -q x f${n}.md`, expect: 'exits 0' } });
  const judge = n => ({ criterion: `j${n}`, check: { judgment: 'someone looks' } });
  const ph = (title, risk = 'low') => ({ title, risk, specPath: `docs/ideation/t/${title}.md` });
  const advise = (criteria, phases, extra = {}) =>
    adviseRunMode({ slug: 'test-contract', successCriteria: criteria, execution: { phases }, ...extra });

  it('a single phase needs no orchestration at all', () => {
    assert.equal(advise([dyn(1)], [ph('only')]).mode, 'run-spec');
  });

  it('a high-risk phase forces watch even when everything is checkable', () => {
    const a = advise([dyn(1), dyn(2), dyn(3)], [ph('a'), ph('b', 'high')]);
    assert.equal(a.mode, 'watch');
    assert.match(a.reasons[0].text, /risk=high/);
  });

  it('judgment-dominant criteria force watch', () => {
    const a = advise([dyn(1), judge(1), judge(2)], [ph('a'), ph('b')]);
    assert.equal(a.mode, 'watch');
    assert.match(a.reasons[0].text, /judgment calls/);
  });

  it('mostly-static checks force watch — a green VERIFY would prove little', () => {
    const a = advise([stat(1), stat(2), stat(3), dyn(1)], [ph('a'), ph('b')]);
    assert.equal(a.mode, 'watch');
    assert.match(a.reasons[0].text, /only inspect files/);
  });

  it('multi-phase, dynamic-dominant, no high risk → walk away', () => {
    const a = advise([dyn(1), dyn(2), dyn(3)], [ph('a'), ph('b')]);
    assert.equal(a.mode, 'walk-away');
  });

  it('high risk outranks a clean criteria profile — ordering is load-bearing', () => {
    const clean = [dyn(1), dyn(2), dyn(3)];
    assert.equal(advise(clean, [ph('a'), ph('b')]).mode, 'walk-away');
    assert.equal(advise(clean, [ph('a'), ph('b', 'high')]).mode, 'watch');
  });

  it('warns about express provenance without changing the verdict', () => {
    const a = advise([dyn(1), dyn(2)], [ph('a'), ph('b')], { approvalMode: 'express' });
    assert.equal(a.mode, 'walk-away');
    assert.ok(a.reasons.some(r => /express contract/.test(r.text)));
  });

  it('surfaces a static minority even when it does not change the verdict', () => {
    const a = advise([dyn(1), dyn(2), dyn(3), stat(1)], [ph('a'), ph('b')]);
    assert.equal(a.mode, 'walk-away');
    assert.ok(a.reasons.some(r => r.mark === 'warn' && /only inspect files/.test(r.text)));
  });
});

describe('--advise is inert', () => {
  it('runs no check and prints no VERIFY line', () => {
    const sentinel = join(scratch, 'advise-sentinel.txt');
    const path = contract(
      [{ criterion: 'would touch a file', check: { cmd: `touch ${sentinel}`, expect: '' } }],
      [{ title: 'a', risk: 'low', specPath: 'docs/ideation/t/a.md' }],
    );
    const { code, out } = run([path, '--advise']);
    assert.equal(existsSync(sentinel), false, 'no check may execute under --advise');
    assert.doesNotMatch(out, /^VERIFY /m);
    assert.match(out, /^RUNMODE test-contract: /m);
    assert.equal(code, 0);
  });
});

describe('entry-point detection survives a symlinked install path', () => {
  // The bug this guards: `~/.claude` is commonly a symlink into a dotfiles repo,
  // and the plugin installs under `~/.claude/plugins`. Node symlink-resolves
  // `import.meta.url` but not `process.argv[1]`, so a naive comparison skipped
  // main() and exited 0 — printing nothing while reading as success to anything
  // checking the exit code. For the completion predicate that is a false green.
  it('matches when argv[1] reaches the file through a symlinked directory', () => {
    const realDir = join(scratch, 'real-plugin-root');
    const linkDir = join(scratch, 'linked-plugin-root');
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(realDir, 'verify.mjs'), '// stand-in\n');
    try {
      symlinkSync(realDir, linkDir, 'dir');
    } catch {
      return; // no symlink permission (Windows CI) — nothing to assert
    }
    const throughLink = join(linkDir, 'verify.mjs');
    const realUrl = pathToFileURL(join(realDir, 'verify.mjs')).href;

    assert.equal(isEntryPoint(realUrl, throughLink), true,
      'a symlinked argv[1] must still count as the entry point');
    assert.equal(isEntryPoint(realUrl, join(realDir, 'verify.mjs')), true,
      'the direct path must keep working');
    assert.equal(isEntryPoint(realUrl, join(realDir, 'other.mjs')), false,
      'a different file must not count');
    assert.equal(isEntryPoint(realUrl, undefined), false,
      'no argv[1] means not an entry point');
  });

  it('falls back to resolve() for a path that does not exist', () => {
    const ghost = join(scratch, 'nope', 'verify.mjs');
    assert.equal(isEntryPoint(pathToFileURL(ghost).href, ghost), true);
  });
});
