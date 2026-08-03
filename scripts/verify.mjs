#!/usr/bin/env node
// verify.mjs — the completion predicate for ONE ideation contract.
//
// Usage: node scripts/verify.mjs <path/to/contract-data.json> [--list]
//
// SCOPE, and this is load-bearing: this verifies the acceptance checks of the
// contract you point it at. It is NOT a repo health check. Contract checks are
// acceptance-time predicates and they ROT — docs-site's checks reference a
// VitePress build this repo later replaced with a static page, so they fail
// today on a project that demonstrably shipped. A red run means "this
// contract's checks no longer hold", never "the repo is broken". The header
// prints the contract's date and status so a stale run is obvious on sight.
//
// It reads contract-data.json directly rather than executing an emitted
// verify.sh: an emitted script would be a second source of truth, and
// contract-gen's lineage logic would archive it out from under itself.
//
// This file also OWNS the definition of what a `check` is (normalizeCheck /
// validateCheck below) — the thing that runs the checks decides what is
// runnable. scripts/contract-gen.ts imports these so the renderer and the
// executor can never disagree about a criterion's kind.

import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TIMEOUT_MS = 120_000;

// --- Check normalization (shared with contract-gen.ts) ---

/** A criterion's check is either a runnable command with its expected
    outcome, or an explicit statement that a human has to look. */
export function isJudgment(check) {
  return Boolean(check) && typeof check.judgment === 'string';
}

export function checkKind(check) {
  return check && !isJudgment(check) ? 'cmd' : 'judgment';
}

/** Does the leading token of a string plausibly name a command? Deliberately
    permissive: a false "cmd" is caught loudly by validateCheck or by a
    command-not-found at run time, whereas a false "judgment" silently drops a
    real check. Bias toward cmd; let validation be the net. */
function hasShellToken(s) {
  const first = s.trim().split(/\s+/)[0] ?? '';
  if (!first) return false;
  // `!` negation, `[` test, `(`/`{` grouping, `$(...)`, VAR=value prefix
  if (/^(?:!|\[+|\(|\{|\$|[A-Za-z_][\w.+-]*=)/.test(first)) return true;
  return /^[A-Za-z0-9_.~/][\w.:+~/-]*$/.test(first);
}

/** Legacy `check` was a plain string: a command, an em-dash, and the expected
    outcome ("npx vitest run — exits 0"). Published contracts in the wild still
    carry that shape, so it must keep working. Tolerant by design. */
export function normalizeCheck(raw) {
  if (raw === undefined || raw === null) return undefined;

  if (typeof raw === 'object') {
    if (typeof raw.judgment === 'string') return { judgment: raw.judgment };
    if (typeof raw.cmd === 'string') {
      return { cmd: raw.cmd.trim(), expect: String(raw.expect ?? '').trim() };
    }
    return undefined;
  }

  if (typeof raw !== 'string') return undefined;
  const s = raw.trim();
  if (!s) return undefined;

  // "judgment call: visual review …" was the informal convention for
  // "nobody can run this".
  if (/^judgment\b/i.test(s)) {
    return { judgment: s.replace(/^judgment(\s+call)?\s*[:—-]?\s*/i, '') || s };
  }

  const [cmd, ...rest] = s.split('—');
  const trimmedCmd = cmd.trim();
  if (!hasShellToken(trimmedCmd)) return { judgment: s };
  return { cmd: trimmedCmd, expect: rest.join('—').trim() };
}

export function normalizeCriterion(raw) {
  if (typeof raw === 'string') return { criterion: raw };
  // null / undefined / numbers in a published contract's successCriteria would
  // otherwise crash verify outright — and verify's exit code is what a /goal's
  // done-when consumes. Stringify instead. Tolerant by design.
  if (!raw || typeof raw !== 'object') return { criterion: String(raw) };
  return { criterion: raw.criterion, check: normalizeCheck(raw.check) };
}

/** Reject prose sitting in the executable slot. Returns an error string or
    null. The three signals are the ones real data actually tripped:
      - `sh -n` rejects it outright,
      - ` then ` with no shell conditional in sight ("… & then curl …"),
      - a bare `&` (backgrounds a process and leaks it). */
export function validateCheck(check) {
  if (!check || isJudgment(check)) return null;
  const cmd = check.cmd;
  if (!cmd) return 'check.cmd is empty — use { "judgment": "…" } instead';

  if (/\bthen\b/.test(cmd) && !/\b(?:if|while|until|for)\b/.test(cmd)) {
    return `check.cmd reads as prose, not shell (" then " with no if/while/for): ${cmd}`;
  }
  if (/(?<![&>])&(?![&>])/.test(cmd)) {
    return `check.cmd contains a bare "&" — it would background and leak a process: ${cmd}`;
  }

  const syn = spawnSync('sh', ['-n'], { input: cmd, encoding: 'utf8' });
  // No POSIX sh available (Windows): skip the syntax gate rather than block
  // rendering on a platform detail.
  if (syn.error) return null;
  if (syn.status !== 0) {
    const why = (syn.stderr || '').trim().split('\n')[0] ?? 'syntax error';
    return `check.cmd is not valid shell (${why}): ${cmd}`;
  }
  return null;
}

/** `{N} criteria ({M} cmd, {K} judgment)` — the count that replaces eyeballed
    "most criteria are checkable" majority rules in skill prose. */
export function summarizeCriteria(criteria) {
  const cmd = criteria.filter(c => c.check && checkKind(c.check) === 'cmd').length;
  return {
    total: criteria.length,
    cmd,
    judgment: criteria.length - cmd,
    line: `${criteria.length} criteria (${cmd} cmd, ${criteria.length - cmd} judgment)`,
  };
}

// --- Run-mode advice ---

/** Commands that only INSPECT the tree. A check built entirely from these never
    runs the thing it claims to verify — it asserts that a file contains a string
    someone was told to write, and passes whether or not the feature works. */
const STATIC_CMDS = new Set([
  'grep', 'rg', 'ag', 'test', 'ls', 'find', 'cat', 'head', 'tail', 'wc',
  'awk', 'sed', 'stat', 'file', 'diff', 'cmp', 'jq', 'basename', 'dirname',
  'echo', 'true', 'false', '[',
]);

/** True when EVERY segment of the pipeline is inspection-only. One executing
    segment (`node …`, `npm test`, `curl …`) makes the whole check dynamic, even
    when it greps the output afterwards — the grep is then reading real output. */
export function isStaticCheck(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) return false;
  const segments = cmd.split(/\|\||&&|[|;]/).map(s => s.trim()).filter(Boolean);
  if (!segments.length) return false;
  return segments.every(seg => {
    const head = seg.replace(/^[!(\s]+/, '').split(/\s+/)[0] ?? '';
    const bin = head.replace(/^.*\//, '');
    return STATIC_CMDS.has(bin);
  });
}

const RISK_ORDER = { low: 0, medium: 1, high: 2 };

/**
 * Which way should this contract be run? Contract-derived only — the two
 * session-level facts (is the Workflow tool present, can this workspace start a
 * `/goal`) are unknowable from a script and are overlaid by the calling skill.
 *
 * First matching rule wins. Reasons are collected for every condition worth
 * saying out loud, not only the deciding one, because the reason is the part a
 * human can argue with.
 */
export function adviseRunMode(data) {
  const phases = committablePhases(data);
  const criteria = (data.successCriteria ?? []).map(normalizeCriterion);
  const { cmd, judgment } = summarizeCriteria(criteria);
  const cmds = criteria.filter(c => c.check && checkKind(c.check) === 'cmd');
  const staticCount = cmds.filter(c => isStaticCheck(c.check.cmd)).length;
  const highRisk = phases.filter(p => p.risk === 'high').map(p => p.title);
  const maxRisk = phases.reduce(
    (m, p) => ((RISK_ORDER[p.risk] ?? 0) > (RISK_ORDER[m] ?? 0) ? p.risk : m),
    'low',
  );

  const reasons = [];
  const add = (mark, text) => reasons.push({ mark, text });

  let mode;
  if (phases.length <= 1) {
    mode = 'run-spec';
    add('ok', `${phases.length} phase — orchestration adds nothing; run the spec directly`);
  } else if (highRisk.length) {
    mode = 'watch';
    add('no', `phase "${highRisk[0]}" is risk=high — be present for the failure gate`);
  } else if (judgment >= cmd) {
    mode = 'watch';
    add('no', `${judgment} of ${cmd + judgment} criteria are judgment calls — an unattended run would complete phases nothing checked`);
  } else if (cmd > 0 && staticCount * 2 > cmd) {
    mode = 'watch';
    add('no', `${staticCount} of ${cmd} cmd checks only inspect files — a green VERIFY would prove little`);
  } else {
    mode = 'walk-away';
    add('ok', `${cmd} of ${cmd + judgment} criteria are mechanically checked — verify.mjs can certify completion`);
    add('ok', `${phases.length} phases, no high-risk phase`);
  }

  // Said regardless of the verdict — these change how much to trust the run.
  if (mode !== 'run-spec' && cmd > 0 && staticCount * 2 <= cmd && staticCount > 0) {
    add('warn', `${staticCount} of ${cmd} cmd checks only inspect files rather than running anything`);
  }
  if (data.approvalMode === 'express') {
    add('warn', 'express contract — no human reviewed these specs; phases dispatch --strict and fail closed');
  }
  if (mode === 'walk-away' && judgment > 0) {
    add('warn', `${judgment} judgment criteria are printed but never counted — verify cannot certify them`);
  }

  return {
    mode,
    phases: phases.length,
    cmd,
    judgment,
    staticCount,
    maxRisk,
    reasons,
    line: `RUNMODE ${data.slug}: ${mode}  phases=${phases.length} cmd=${cmd} judgment=${judgment} risk=${maxRisk}`,
  };
}

const MARKS = { ok: '✓', no: '✗', warn: '!' };

export function formatAdvice(advice) {
  return [
    advice.line,
    '',
    ...advice.reasons.map(r => `  ${MARKS[r.mark]} ${r.text}`),
  ].join('\n');
}

// --- CLI ---

function repoRoot() {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.error('verify: not inside a git repository.');
    process.exit(1);
  }
  return r.stdout.trim();
}

/** Phases that are expected to leave a commit behind. Gates are human
    checkpoints and phases without a specPath have nothing to reference, so
    neither belongs in the denominator. */
export function committablePhases(data) {
  return (data.execution?.phases ?? []).filter(
    p => p.specPath && p.kind !== 'gate',
  );
}

function commitBodies(root) {
  const r = spawnSync('git', ['log', '--format=%H%x1f%B%x1e'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) return [];
  return r.stdout
    .split('\x1e')
    .map(rec => rec.trim())
    .filter(Boolean)
    .map(rec => {
      const i = rec.indexOf('\x1f');
      return { sha: rec.slice(0, i), body: rec.slice(i + 1) };
    });
}

function header(data, dataPath, root) {
  const rel = relative(root, resolve(dataPath)) || dataPath;
  return [
    `VERIFYING ONE CONTRACT — ${data.projectName} (${data.slug})`,
    `  source   ${rel}`,
    `  dated    ${data.date} · status ${data.status}`,
    `  scope    this contract's acceptance checks only, not a repo health check.`,
    `           Checks are acceptance-time predicates and rot as the repo moves on;`,
    `           a red run means these checks no longer hold, not that the repo is broken.`,
    '',
  ].join('\n');
}

function tail(text, n = 10) {
  const lines = (text ?? '').replace(/\s+$/, '').split('\n').filter(Boolean);
  return lines.slice(-n).map(l => `           ${l}`);
}

function main(argv) {
  const FLAGS = ['--list', '--advise'];
  const args = argv.filter(a => !FLAGS.includes(a));
  const listOnly = argv.includes('--list');
  const adviseOnly = argv.includes('--advise');
  const dataPath = args[0];

  if (!dataPath) {
    console.error(
      'Usage: node scripts/verify.mjs <path/to/contract-data.json> [--list|--advise]\n' +
        "  Verifies ONE contract's acceptance checks. Not a repo health check.\n" +
        '  --list    enumerate the criteria and their kind; run nothing\n' +
        '  --advise  print the run-mode recommendation and why; run nothing',
    );
    return 1;
  }

  const root = repoRoot();
  let data;
  try {
    data = JSON.parse(readFileSync(dataPath, 'utf8'));
  } catch (err) {
    console.error(`verify: cannot read ${dataPath} — ${err.message}`);
    return 1;
  }

  // --advise runs nothing and touches nothing — it is safe to call at the
  // routing question, before a single phase has executed.
  if (adviseOnly) {
    console.log(formatAdvice(adviseRunMode(data)));
    return 0;
  }

  const criteria = (data.successCriteria ?? []).map(normalizeCriterion);
  const phases = committablePhases(data);
  const sum = summarizeCriteria(criteria);

  process.stdout.write(header(data, dataPath, root));

  if (listOnly) {
    criteria.forEach((c, i) => {
      const kind = c.check ? checkKind(c.check) : 'judgment';
      console.log(`[${i + 1}/${criteria.length}] ${kind.padEnd(8)} ${c.criterion}`);
      if (c.check && kind === 'cmd') console.log(`           $ ${c.check.cmd}`);
      else if (c.check) console.log(`           ${c.check.judgment}`);
    });
    console.log('');
    console.log(
      `LIST ${data.slug}: ${sum.line}, ${phases.length} phase commit${phases.length === 1 ? '' : 's'} to check`,
    );
    return 0;
  }

  // Sequential, in array order: real checks are order-coupled (ux-dejank
  // criterion 2 greps the /tmp file criterion 1 renders). Never parallelize.
  let pass = 0;
  let fail = 0;
  let judgment = 0;

  criteria.forEach((c, i) => {
    const tag = `[${i + 1}/${criteria.length}]`;
    if (!c.check || isJudgment(c.check)) {
      judgment += 1;
      console.log(`${tag} JUDGMENT  ${c.criterion}`);
      if (c.check?.judgment) console.log(`           ${c.check.judgment}`);
      console.log('           not counted — a human has to look');
      return;
    }

    const invalid = validateCheck(c.check);
    if (invalid) {
      fail += 1;
      console.log(`${tag} FAIL      ${c.criterion}`);
      console.log(`           ${invalid}`);
      return;
    }

    const started = Date.now();
    const r = spawnSync('sh', ['-c', c.check.cmd], {
      cwd: root,
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const timedOut = r.signal !== null && r.signal !== undefined;
    const ok = !timedOut && r.status === 0;

    if (ok) pass += 1;
    else fail += 1;
    console.log(`${tag} ${ok ? 'PASS     ' : 'FAIL     '} ${c.criterion}`);
    console.log(`           $ ${c.check.cmd}`);
    if (c.check.expect) console.log(`           expect: ${c.check.expect}`);
    if (!ok) {
      console.log(
        timedOut
          ? `           timed out after ${TIMEOUT_MS / 1000}s (${r.signal})`
          : `           exit ${r.status} after ${secs}s`,
      );
      tail(`${r.stdout ?? ''}\n${r.stderr ?? ''}`).forEach(l => console.log(l));
    }
  });

  // One commit-check per phase: does any commit body reference the
  // slug-qualified spec path? (Bare spec-phase-N.md collides across projects.)
  const commits = commitBodies(root);
  let committed = 0;
  if (phases.length) {
    console.log('');
    console.log('COMMITS');
    for (const p of phases) {
      const hit = commits.find(c => c.body.includes(p.specPath));
      if (hit) {
        committed += 1;
        console.log(`  ok   ${p.specPath}  ${hit.sha.slice(0, 8)}`);
      } else {
        console.log(`  --   ${p.specPath}  no commit references this spec path`);
      }
    }
  }

  console.log('');
  console.log(
    `VERIFY ${data.slug}: commits=${committed}/${phases.length} pass=${pass} fail=${fail} judgment=${judgment}`,
  );
  return fail === 0 && committed === phases.length ? 0 : 1;
}

/**
 * Is this file the process entry point?
 *
 * Must compare REAL paths. `import.meta.url` is symlink-resolved by Node;
 * `process.argv[1]` is whatever the caller typed, and `resolve()` normalizes
 * without following symlinks. Anyone who symlinks `~/.claude` into a dotfiles
 * repo — a common setup, and the plugin is installed under `~/.claude/plugins`
 * — makes the two sides disagree, and the naive comparison then silently skips
 * `main()` and exits 0. For a script that IS the completion predicate, printing
 * nothing and exiting 0 reads as success. Fail loudly or not at all.
 */
export function isEntryPoint(metaUrl, entry = process.argv[1]) {
  if (!entry) return false;
  const real = p => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(resolve(entry)) === real(fileURLToPath(metaUrl));
}

if (isEntryPoint(import.meta.url)) process.exit(main(process.argv.slice(2)));

export { main };
