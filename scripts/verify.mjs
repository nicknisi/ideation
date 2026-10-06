#!/usr/bin/env node
// verify.mjs — the completion predicate for ONE ideation contract.
//
// Usage: node scripts/verify.mjs <contract-data.json | plan.json | folder> [--list|--advise]
//
// A plan's checks are its criteria and its units its phases (planAsContract);
// a folder verifies its plan.json when it has one, else its contract-data.json.
//
// COMMIT REFERENCE. `commits=A/B` means what it meant in 0.x: B units (0.x:
// phases) are expected to leave a commit, and A of them have at least one
// commit on the current branch (`git log HEAD`) that references them.
//   - A plan written by 1.0 references a unit with the git trailer
//     `Ideation-Unit: <plan-id>/<unit-id>` (unitTrailer below), on a line of its
//     own in the commit message. Both harnesses write it: Pi's change runner on
//     the host's unit commit, and in Claude Code the engine's commit stage (and
//     execute-spec's Commit step) for a run-contract unit. Ids rather than a
//     path, because the two harnesses keep packets in different places (Pi in
//     its run directory, Claude Code beside plan.json), and an id survives a
//     revised plan version.
//   - A plan migrated from 0.x, and a 0.x contract, reference a phase by its
//     slug-qualified spec path in the commit body, grepped exactly as 0.x did.
//
// SCOPE, and this is load-bearing: this verifies the acceptance checks of the
// contract you point it at. It is NOT a repo health check. Contract checks are
// acceptance-time predicates and they ROT — docs-site's checks reference a
// VitePress build this repo later replaced with a static page, so they fail
// today on a project that demonstrably shipped. A red run means "this
// contract's checks no longer hold", never "the repo is broken". The header
// prints the contract's date and status so a stale run is obvious on sight.
//
// It reads the data directly rather than executing an emitted verify.sh: an
// emitted script would be a second source of truth.
//
// This file also OWNS the definition of what a `check` is (normalizeCheck /
// validateCheck below) — the thing that runs the checks decides what is
// runnable. workflows/change-brief.mjs (and so plan approval), plan-migrate
// and plan-goal import these, so nothing that writes or runs a check can
// disagree with the executor about a criterion's kind.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TIMEOUT_MS = 120_000;

// --- Check normalization (shared with change-brief, plan-migrate and plan-goal) ---

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

/** Malformed criteria are not a legacy shape — strings and { criterion, check }
    objects are the only valid forms, and anything else used to crash outright.
    Returns a readable error string naming the index, or null when the entry is
    well-formed. Shared with plan-goal.mjs so the goal and the executor reject
    the same file: a contract that cannot verify must not hand /goal a done
    condition it can never satisfy. */
export function malformedCriterionError(raw, index) {
  if (typeof raw === 'string') return null;
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) return null;
  const kind = raw === null ? 'null' : Array.isArray(raw) ? 'an array' : typeof raw;
  return `successCriteria[${index}] is ${kind} — expected a string or a { criterion, check } object.`;
}

export function normalizeCriterion(raw) {
  if (typeof raw === 'string') return { criterion: raw };
  // null / undefined / numbers / arrays in a published contract's
  // successCriteria would otherwise crash verify outright (arrays pass the
  // `typeof === 'object'` branch and yield `{ criterion: undefined }`) — and
  // verify's exit code is what a /goal's done-when consumes. Stringify
  // instead. Tolerant by design.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { criterion: String(raw) };
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
 *
 * A plan gets the same rules over its checks and units (planAsContract); only
 * the words change: units, and a single unit runs its packet.
 */
export function adviseRunMode(data) {
  const plan = data.kind === 'plan';
  const noun = plan ? 'unit' : 'phase';
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
    add('ok', `${phases.length} ${noun} — orchestration adds nothing; run ${plan ? 'its packet with /ideation:execute-spec' : 'the spec directly'}`);
  } else if (highRisk.length) {
    mode = 'watch';
    add('no', `${noun} "${highRisk[0]}" is risk=high — be present for the failure gate`);
  } else if (judgment >= cmd) {
    mode = 'watch';
    add('no', `${judgment} of ${cmd + judgment} criteria are judgment calls — an unattended run would complete ${noun}s nothing checked`);
  } else if (cmd > 0 && staticCount * 2 > cmd) {
    mode = 'watch';
    add('no', `${staticCount} of ${cmd} cmd checks only inspect files — a green VERIFY would prove little`);
  } else {
    mode = 'walk-away';
    add('ok', `${cmd} of ${cmd + judgment} criteria are mechanically checked — verify.mjs can certify completion`);
    add('ok', `${phases.length} ${noun}s, no high-risk ${noun}`);
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

/** Phases that are expected to leave a commit behind: those with a commit
    reference (a 0.x spec path, or a 1.0 unit's trailer). Gates are human
    checkpoints and phases with no reference have nothing to match, so neither
    belongs in the denominator. */
export function committablePhases(data) {
  return (data.execution?.phases ?? []).filter(
    p => (p.trailer || p.specPath) && p.kind !== 'gate',
  );
}

/** The commit trailer that references one unit of a 1.0 plan (see the header). */
export const unitTrailer = (planId, unitId) => `Ideation-Unit: ${planId}/${unitId}`;

/** Does a commit message carry this trailer, on a line of its own? Any line, not
    only the last paragraph: a squash merge folds trailers into the body. */
export const hasTrailer = (message, trailer) => message.split('\n').some(line => line.trim() === trailer);

/** The commit that references a phase, or undefined. */
export function commitFor(phase, commits) {
  return phase.trailer
    ? commits.find(c => hasTrailer(c.body, phase.trailer))
    : commits.find(c => c.body.includes(phase.specPath));
}

/** A 0.x phase title as the unit id plan-migrate makes of it; planAsContract matches units back to phases with it. */
export const slug = s => String(s).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** A folder verifies its plan.json when it has one, else its contract-data.json. */
function resolveInput(path) {
  if (!existsSync(path) || !statSync(path).isDirectory()) return { path, note: null };
  const plan = join(path, 'plan.json');
  const legacy = join(path, 'contract-data.json');
  if (!existsSync(plan)) return { path: legacy, note: 'using contract-data.json' };
  return { path: plan, note: `using plan.json${existsSync(legacy) ? ' (contract-data.json also present)' : ''}` };
}

/**
 * A plan read as the contract shape this file checks: its checks are
 * the criteria (normalizeCriterion reads { id, criterion, check } as is) and its
 * units the phases. Returns the notes to print alongside.
 *
 * A plan the 1.0 skill wrote references each unit by its trailer. A plan
 * converted from 0.x keeps its 0.x reference instead: it borrows each unit's
 * specPath and kind from the contract-data.json beside it, matched by the slug
 * plan-migrate made the unit id with, so its commits= means what the 0.x line
 * meant. A 1.0 plan never supersedes contract-data.json, and once a migrated
 * plan is revised its next version supersedes plan.v1.json, so it is a 1.0
 * plan from then on.
 */
function planAsContract(plan, planPath) {
  const notes = [];
  let legacy = null;
  if (plan.supersedes === 'contract-data.json') {
    try {
      legacy = JSON.parse(readFileSync(join(dirname(planPath), 'contract-data.json'), 'utf8')).execution?.phases ?? [];
    } catch {
      notes.push('plan supersedes contract-data.json, but none is readable beside it; no unit commit is counted');
    }
  }
  const migrated = plan.supersedes === 'contract-data.json';
  const phases = (plan.units ?? []).map(u => {
    const unit = { title: u.title, risk: u.risk };
    if (!migrated) return { ...unit, trailer: unitTrailer(plan.id, u.id) };
    if (!legacy) return unit;
    const p = legacy.find(p => slug(p.title) === u.id);
    if (!p) notes.push(`unit "${u.id}" matches no phase in contract-data.json; its commit is not counted`);
    return p ? { ...unit, specPath: p.specPath, kind: p.kind } : unit;
  });
  return {
    data: { kind: 'plan', projectName: plan.title, slug: plan.id, version: plan.version, successCriteria: plan.checks, execution: { phases } },
    notes,
  };
}

/**
 * What verify checks, read from a folder, a plan.json or a contract-data.json:
 * { path, data, notes, plan }. `data` is the contract shape (a plan through
 * planAsContract); `plan` is the plan itself, or null for a 0.x contract.
 * Throws when the file cannot be read or parsed.
 */
export function readContract(path) {
  const input = resolveInput(path);
  const raw = JSON.parse(readFileSync(input.path, 'utf8'));
  const notes = input.note ? [input.note] : [];
  // contract-data.json has successCriteria and brief.json acceptance; only a plan has checks.
  if (!Array.isArray(raw?.checks)) return { path: input.path, data: raw, notes, plan: null };
  const read = planAsContract(raw, input.path);
  return { path: input.path, data: read.data, notes: [...notes, ...read.notes], plan: raw };
}

export function commitBodies(root) {
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
    data.version === undefined
      ? `  dated    ${data.date} · status ${data.status}`
      : `  version  ${data.version} (plan data has no date or status)`,
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
  if (!args[0]) {
    console.error(
      'Usage: node scripts/verify.mjs <contract-data.json | plan.json | folder> [--list|--advise]\n' +
        "  Verifies ONE contract's acceptance checks. Not a repo health check.\n" +
        '  A folder uses its plan.json when present, else its contract-data.json.\n' +
        '  --list    enumerate the criteria and their kind; run nothing\n' +
        '  --advise  print the run-mode recommendation and why; run nothing',
    );
    return 1;
  }

  const root = repoRoot();
  const dataPath = resolveInput(args[0]).path;
  let data;
  try {
    const read = readContract(args[0]);
    data = read.data;
    for (const note of read.notes) console.log(`verify: ${note}`);
  } catch (err) {
    console.error(`verify: cannot read ${dataPath} — ${err.message}`);
    return 1;
  }

  // Crash cleanly on malformed criteria: a malformed entry silently normalized
  // to a judgment criterion (printed, never counted) can hand /goal a false
  // green on a contract nobody actually verified.
  const malformed = (data.successCriteria ?? [])
    .map((c, i) => malformedCriterionError(c, i))
    .filter(Boolean);
  if (malformed.length > 0) {
    for (const err of malformed) console.error(`verify: ${dataPath} ${err}`);
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

  // One commit-check per phase: does any commit reference it? A 1.0 unit by
  // its trailer; a 0.x phase by its slug-qualified spec path (a bare
  // spec-phase-N.md collides across projects).
  const commits = commitBodies(root);
  let committed = 0;
  if (phases.length) {
    console.log('');
    console.log('COMMITS');
    for (const p of phases) {
      const hit = commitFor(p, commits);
      const ref = p.trailer ?? p.specPath;
      if (hit) {
        committed += 1;
        console.log(`  ok   ${ref}  ${hit.sha.slice(0, 8)}`);
      } else {
        console.log(`  --   ${ref}  no commit ${p.trailer ? 'carries this trailer' : 'references this spec path'}`);
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
