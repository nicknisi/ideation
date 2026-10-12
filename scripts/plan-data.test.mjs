import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { briefFingerprint, validateBrief, workPacket } from '../workflows/change-brief.mjs';
import { criticView, load, manifestFor, nextVersion, PACKET_PLAN, packetFile, toManifest, toRunContract, validate, writeRunContract } from './plan-data.ts';
import { unitTrailer } from './verify.mjs';

const FIXTURE = new URL('../test-fixtures/plan/plan.json', import.meta.url);
const fixture = () => JSON.parse(readFileSync(FIXTURE, 'utf8'));
const claim = id => ({ id, text: `Claim ${id}`, exhibit: { kind: 'mock', body: 'x', sketch: true } });
/** The fixture with one change applied. */
function plan(change) { const p = fixture(); change(p); return p; }
const rejects = (change, message) => assert.throws(() => validate(plan(change)), e => e instanceof TypeError && e.message === message, message);

test('a valid plan round-trips through load, validate and JSON', () => {
  const loaded = load(FIXTURE);
  assert.equal(validate(loaded), loaded);
  assert.deepEqual(JSON.parse(JSON.stringify(validate(loaded))), fixture());
});

test('load names the file when it is not JSON', t => {
  const dir = mkdtempSync(join(tmpdir(), 'plan-')); t.after(() => rmSync(dir, { recursive: true }));
  writeFileSync(join(dir, 'plan.json'), '{');
  assert.throws(() => load(join(dir, 'plan.json')), new RegExp(`^TypeError: ${join(dir, 'plan.json')}: `));
});

test('invalid plans fail with the JSON path and the reason', () => {
  rejects(p => { p.claims.push(claim('4'), claim('5'), claim('6')); }, 'claims[5]: at most 5 level-1 claims');
  rejects(p => { p.claims[1].children = ['a', 'b', 'c', 'd', 'e', 'f'].map(claim); }, 'claims[1].children[5]: at most 5 children');
  rejects(p => { p.claims[0].children[0].children[0].children = [claim('1.1.1.1')]; }, 'claims[0].children[0].children[0].children[0]: at most 3 levels');
  rejects(p => { p.claims[0].exhibit.kind = 'video'; }, 'claims[0].exhibit.kind: expected one of mock, machine, calls, schema, code');
  rejects(p => { delete p.claims[1].exhibit.body; }, 'claims[1].exhibit: expected src or body');
  rejects(p => { p.claims[0].decision.recommended = 'seven'; }, 'claims[0].decision.recommended: "seven" is not an option');
  rejects(p => { p.claims[1].decision.answer = 'later'; }, 'claims[1].decision.answer: "later" is not an option');
  rejects(p => { p.units[1].needs = ['worker', 'deploy']; }, 'units[1].needs[1]: unknown unit "deploy"');
  rejects(p => { p.checks[0].check = { cmd: 'npm test', judgment: 'looks right' }; }, 'checks[0].check: expected {cmd, expect?} or {judgment}');
  rejects(p => { p.checks[1].check = 'npm test'; }, 'checks[1].check: expected {cmd, expect?} or {judgment}');
  rejects(p => { p.checks[1].check = {}; }, 'checks[1].check: expected {cmd, expect?} or {judgment}');
});

test('duplicate IDs and other cross-references fail by path', () => {
  rejects(p => { p.claims[2].id = '1.1'; }, 'claims[2].id: duplicate claim ID "1.1"');
  rejects(p => { p.checks[1].id = 'retry-tests'; }, 'checks[1].id: duplicate check ID "retry-tests"');
  rejects(p => { p.units[1].id = 'worker'; }, 'units[1].id: duplicate unit ID "worker"');
  rejects(p => { p.claims[2].decision.id = 'retries'; }, 'claims[2].decision.id: duplicate decision ID "retries"');
  rejects(p => { p.units[0].checkIds = ['nope']; }, 'units[0].checkIds[0]: unknown check "nope"');
  rejects(p => { p.units[0].claimIds = ['9']; }, 'units[0].claimIds[0]: unknown claim "9"');
  rejects(p => { p.claims[2].decision.answer = 'env'; }, 'claims[2].decision.answer: only an answered decision has an answer (state is not-opened)');
  rejects(p => { p.claims[0].decision.rejected.push({ value: 'three', reason: 'x' }); }, 'claims[0].decision.rejected[1].value: the chosen option cannot be rejected');
  rejects(p => { p.gates.scope.ready = 'yes'; }, 'gates.scope.ready: expected boolean');
  rejects(p => { delete p.gates.consistency; }, 'gates.consistency: required');
  rejects(p => { p.openQuestions = [{ id: 'q', question: 'Which?', gate: 'budget', type: 'research' }]; }, 'openQuestions[0].gate: expected one of problem, goals, criteria, scope, consistency');
  rejects(p => { p.extra = true; }, 'plan.extra: unknown field');
});

test('a recorded decision may omit its question, have one option, and reject without a reason; an open one may not', () => {
  // Recorded (kept, answered): what a converted 0.x decision looks like.
  assert.doesNotThrow(() => validate(plan(p => {
    const d = p.claims[0].decision;
    delete d.question; d.options = [d.options[0]]; d.rejected = [];
    delete p.claims[1].decision.rejected[0].reason;
  })));
  // Open (not-opened): still a real question with real alternatives.
  rejects(p => { delete p.claims[2].decision.question; }, 'claims[2].decision.question: expected nonempty string');
  rejects(p => { p.claims[2].decision.options.pop(); }, 'claims[2].decision.options: expected at least 2 options');
  rejects(p => { const d = p.claims[0].decision; d.options = []; d.rejected = []; }, 'claims[0].decision.options: expected at least 1 option');
  rejects(p => { p.claims[0].decision.rejected[0].reason = ' '; }, 'claims[0].decision.rejected[0].reason: expected nonempty string');
});

test('without a question or a rejected reason, the brief names only the labels', () => {
  const { brief } = toRunContract(plan(p => { delete p.claims[0].decision.question; delete p.claims[0].decision.rejected[0].reason; }));
  assert.deepEqual(brief.decisions[0], { decision: '3, five minutes apart', reason: 'Three covers a brief outage without hiding a real failure.', rejected: 'None. The user presses Try again' });
});

test('feedback is optional on the plan and on claims: verbatim text with the version it was given on', () => {
  const ok = plan(p => { p.feedback = [{ version: 1, text: '$(touch x)' }]; p.claims[0].children[0].feedback = [{ version: 2, text: 'a\nb' }]; });
  assert.equal(validate(ok), ok);
  assert.throws(() => toRunContract(plan(p => { p.claims[2].decision.state = 'not-opened'; p.claims[2].decision.required = true; p.feedback = [{ version: 2, text: 'approve' }]; })), /not approvable/);
  rejects(p => { p.feedback = {}; }, 'feedback: expected array');
  rejects(p => { p.feedback = [{ version: 0, text: 'x' }]; }, 'feedback[0].version: expected integer >= 1');
  rejects(p => { p.feedback = [{ version: 1, text: ' ' }]; }, 'feedback[0].text: expected nonempty string');
  rejects(p => { p.claims[1].feedback = [{ version: 1, text: 'x', approved: true }]; }, 'claims[1].feedback[0].approved: unknown field');
  rejects(p => { p.claims[1].feedback = [{ text: 'x' }]; }, 'claims[1].feedback[0].version: required');
});

test('nextVersion bumps the version, supersedes the previous file, and leaves the input alone', () => {
  const before = fixture(), input = fixture();
  const next = nextVersion(input);
  assert.deepEqual(input, before);
  assert.equal(next.version, 3);
  assert.equal(next.supersedes, 'plan.v2.json');
  assert.deepEqual({ ...next, version: before.version, supersedes: before.supersedes }, before);
  next.claims[0].text = 'changed';
  assert.equal(input.claims[0].text, before.claims[0].text);
  assert.equal(nextVersion(next).supersedes, 'plan.v3.json');
});

test('toRunContract derives a brief validateBrief accepts, fingerprinted by briefFingerprint', () => {
  const contract = toRunContract(fixture());
  assert.deepEqual(Object.keys(contract).sort(), ['brief', 'fingerprint', 'plan']);
  assert.deepEqual(validateBrief(contract.brief), contract.brief);
  assert.equal(contract.fingerprint, briefFingerprint(contract.brief));
  assert.equal(contract.plan, 'plan.v2.json');
  const { brief } = contract;
  assert.equal(brief.id, 'send-retry');
  assert.equal(brief.revision, 2);
  assert.equal(brief.why, 'When a send fails I only find out hours later. Nobody should have to press send twice.');
  assert.deepEqual(brief.outOfScope, ['How a message is composed']);
  assert.deepEqual(brief.acceptance, fixture().checks);
  assert.deepEqual(brief.units.map(u => [u.id, u.needs, u.acceptanceIds, u.design ?? null]),
    [['worker', [], ['retry-tests'], null], ['outbox-label', ['worker'], ['gave-up-readable'], 'Adds one label; removing it restores the old row.']]);
  // Kept and answered decisions, with what was rejected; the unopened optional one is left out.
  assert.deepEqual(brief.decisions, [
    { decision: 'How many retries before the worker stops? 3, five minutes apart', reason: 'Three covers a brief outage without hiding a real failure.', rejected: 'None. The user presses Try again (It is the problem we are fixing.)' },
    { decision: 'What does a given-up send say? Gave up after 3 tries', reason: 'The count tells the user retries already happened.', rejected: 'Not sent (Reads as if nothing was tried.)' },
  ]);
});

test('toRunContract is deterministic and does not touch its input', () => {
  const input = fixture();
  const first = toRunContract(input), second = toRunContract(input);
  assert.deepEqual(first, second);
  assert.deepEqual(input, fixture());
  first.brief.units[0].needs.push('x');
  assert.deepEqual(input, fixture());
});

test('toRunContract refuses unanswered required decisions and not-ready gates, naming them', () => {
  const open = p => { p.claims[0].decision.state = 'not-opened'; p.claims[1].decision.state = 'not-opened'; delete p.claims[1].decision.answer; };
  assert.throws(() => toRunContract(plan(open)), { message: 'plan send-retry v2 is not approvable: required decisions not answered: retries, give-up-label' });
  assert.throws(() => toRunContract(plan(p => { p.gates.goals.ready = false; p.gates.scope.ready = false; })),
    { message: 'plan send-retry v2 is not approvable: gates not ready: goals, scope' });
  assert.throws(() => toRunContract(plan(p => { open(p); p.gates.criteria.ready = false; })),
    { message: 'plan send-retry v2 is not approvable: required decisions not answered: retries, give-up-label; gates not ready: criteria' });
  // An unopened decision that isn't required doesn't block.
  assert.doesNotThrow(() => toRunContract(plan(p => { p.claims[0].decision.required = false; p.claims[0].decision.state = 'not-opened'; p.claims[0].decision.rejected = []; })));
});

test('an early-stopped plan is approvable with gates still open, but not with required decisions open', () => {
  const stopped = p => { p.gates.scope.ready = false; p.gates.scope.evidence = ''; p.stoppedEarly = 'The user ended the interview.'; };
  assert.equal(validateBrief(toRunContract(plan(stopped)).brief).id, 'send-retry');
  assert.throws(() => toRunContract(plan(p => { stopped(p); p.claims[0].decision.state = 'not-opened'; p.claims[0].decision.rejected = []; })),
    { message: 'plan send-retry v2 is not approvable: required decisions not answered: retries' });
});

test('toRunContract passes on what the brief itself requires', () => {
  assert.throws(() => toRunContract(plan(p => { p.mustHold = []; })), /^TypeError: mustHold: expected nonempty array/);
  assert.throws(() => toRunContract(plan(p => { p.authority.commands = []; })), /^TypeError: authority.commands: missing exact command for retry-tests/);
});

/**
 * What Riker reads from an ideation:v1:run-changed event. Mirrors parseRun in
 * riker's packages/riker/src/ideation.ts (decision 170), copied so this repo's
 * tests never read Riker's. parseRun drops an event without a run id matching
 * /^[\w.-]+$/, a repoRoot or a brief id, and takes the title, why, unit needs
 * and acceptance checks from the brief; here those are required outright.
 */
function rikerReads(event) {
  const want = (ok, what) => { if (!ok) throw new Error(`Riker cannot read ${what}`); };
  const nonempty = v => typeof v === 'string' && v.trim() !== '';
  const { run } = event;
  want(event.type === 'ideation:v1:run-changed', 'type');
  want(nonempty(run?.id) && /^[\w.-]+$/.test(run.id), 'run.id');
  want(nonempty(run.repoRoot), 'run.repoRoot');
  const { brief } = run;
  for (const key of ['id', 'title', 'why']) want(nonempty(brief?.[key]), `brief.${key}`);
  for (const [i, u] of brief.units.entries()) {
    want(nonempty(u.id), `brief.units[${i}].id`);
    want(Array.isArray(u.needs) && u.needs.every(nonempty), `brief.units[${i}].needs`);
  }
  for (const [i, a] of brief.acceptance.entries()) {
    want(nonempty(a.id) && nonempty(a.criterion), `brief.acceptance[${i}]`);
    want(nonempty(a.check?.cmd) !== nonempty(a.check?.judgment), `brief.acceptance[${i}].check`);
  }
  for (const [i, u] of run.units.entries()) want(nonempty(u.id) && nonempty(u.title) && nonempty(u.state) && Number.isInteger(u.attempts), `run.units[${i}]`);
  return {
    id: run.id, change: brief.id, title: brief.title, why: brief.why, repo: run.repoRoot,
    units: brief.units.map(u => ({ id: u.id, needs: u.needs })),
    acceptance: brief.acceptance.map(a => ({ id: a.id, criterion: a.criterion, command: a.check.cmd, judgment: a.check.judgment })),
  };
}

test('a run-changed event built from the run contract is one Riker can read', () => {
  const { brief } = toRunContract(fixture());
  // Shaped like change-run.mjs's snapshot: run id is `${brief.id}-${uuid}`.
  const id = `${brief.id}-00000000-0000-4000-8000-000000000000`;
  const event = { type: 'ideation:v1:run-changed', run: {
    id, repoRoot: '/repo', state: 'ready', branch: `ideation/${id}`, workspace: `/repo/.ideation/${id}`, baseRevision: 'abc123',
    attention: { reason: 'acceptance', message: 'Objective verification complete.' },
    units: brief.units.map(u => ({ id: u.id, title: u.title, state: 'ready', attempts: 0 })),
    brief,
  } };
  assert.deepEqual(rikerReads(event), {
    id, change: 'send-retry', title: 'Failed sends retry on their own', why: brief.why, repo: '/repo',
    units: [{ id: 'worker', needs: [] }, { id: 'outbox-label', needs: ['worker'] }],
    acceptance: [
      { id: 'retry-tests', criterion: "The retry worker's tests pass", command: 'node --test src/retry.test.mjs', judgment: undefined },
      { id: 'gave-up-readable', criterion: 'A given-up send is easy to spot', command: undefined, judgment: 'Look at the outbox with one given-up send' },
    ],
  });
  assert.throws(() => rikerReads({ ...event, run: { ...event.run, id: 'has space' } }), /run\.id/);
});

test('criticView: every id a critic cites, without exhibits, deterministically', () => {
  const view = criticView(fixture());
  assert.deepEqual(view, criticView(fixture()));
  assert.equal(JSON.stringify(view).includes('exhibit'), false);
  assert.deepEqual(view.why, ['When a send fails I only find out hours later.', 'Nobody should have to press send twice.']);
  assert.deepEqual(view.goals, ['1', '2', '3']);
  assert.deepEqual(view.claims.map(c => c.id), ['1', '1.1', '1.1.1', '2', '3']);
  assert.deepEqual(view.decisions[1], {
    id: 'give-up-label', claim: '2', question: 'What does a given-up send say?', state: 'answered',
    options: ['Gave up after 3 tries', 'Not sent'], recommended: 'Not sent', answer: 'Gave up after 3 tries',
  });
  assert.deepEqual(view.decisions.map(d => [d.id, d.state]), [['retries', 'kept'], ['give-up-label', 'answered'], ['setting-home', 'not-opened']]);
  assert.deepEqual(view.checks.map(c => c.id), ['retry-tests', 'gave-up-readable']);
  assert.deepEqual(view.units, [
    { id: 'worker', title: 'Retry worker', risk: 'medium', needs: [], checkIds: ['retry-tests'], claimIds: ['1', '1.1', '1.1.1', '3'] },
    { id: 'outbox-label', title: 'Gave-up label', risk: 'high', needs: ['worker'], checkIds: ['gave-up-readable'], claimIds: ['2'] },
  ]);
  assert.deepEqual(view.scope, fixture().scope);
  assert.deepEqual(view.gates, fixture().gates);
  assert.deepEqual(view.openQuestions, fixture().openQuestions);
  assert.throws(() => criticView(plan(p => { p.units[0].needs = ['nope']; })), /units\[0\]\.needs\[0\]: unknown unit "nope"/);
});

test('the plan critic reads plan.json, extracts every field criticView names, and cites ids', () => {
  const prompt = readFileSync(new URL('../agents/plan-critic.md', import.meta.url), 'utf8');
  assert.match(prompt, /^description: .*plan data/m);
  assert.match(prompt, /`plan\.json`/);
  const { id, title, version, ...reviewed } = criticView(fixture());
  for (const key of Object.keys(reviewed)) assert.match(prompt, new RegExp(`\`${key}[\`.]`), `plan-critic.md names \`${key}\``);
  for (const kind of ['claim', 'decision', 'check', 'unit']) assert.match(prompt, new RegExp(`${kind} ids?`), `findings cite ${kind} ids`);
  assert.doesNotMatch(prompt, /successCriteria|execution\.phases/);
});

/** A scratch plan folder holding the fixture, with one change applied. */
function folder(t, change = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'plan-folder-')); t.after(() => rmSync(dir, { recursive: true }));
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan(change)));
  return dir;
}
const CLI = new URL('./plan-data.ts', import.meta.url).pathname;

test('run-contract refuses an unapprovable plan and writes nothing', t => {
  const dir = folder(t, p => { p.claims[2].decision.required = true; });
  assert.throws(() => writeRunContract(dir, 'abc'), /not approvable: required decisions not answered: setting-home/);
  const cli = spawnSync(process.execPath, [CLI, 'run-contract', dir], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /not approvable/);
  const gates = folder(t, p => { p.gates.scope.ready = false; });
  assert.throws(() => writeRunContract(gates, 'abc'), /gates not ready: scope/);
  assert.deepEqual(readdirSync(dir), ['plan.json']);
  assert.deepEqual(readdirSync(gates), ['plan.json']);
});

test('run-contract writes the toRunContract output and one workPacket per unit beside plan.json', t => {
  const dir = folder(t);
  const { contract, packets } = writeRunContract(dir, 'abc123');
  const written = JSON.parse(readFileSync(join(dir, 'run-contract.json'), 'utf8'));
  assert.deepEqual(written, toRunContract(fixture()));
  assert.deepEqual(validateBrief(written.brief), written.brief);
  assert.equal(written.fingerprint, briefFingerprint(written.brief));
  assert.deepEqual(packets, ['worker', 'outbox-label'].map(id => join(dir, packetFile(id))));
  for (const u of contract.brief.units) {
    assert.equal(readFileSync(join(dir, packetFile(u.id)), 'utf8'), workPacket(contract.brief, u.id, { plan: PACKET_PLAN, sourceRevision: 'abc123' }));
  }
  assert.deepEqual(readdirSync(dir).sort(), ['plan.json', 'run-contract.json', 'unit-outbox-label.md', 'unit-worker.md']);
});

test('the CLI prints the critic view, writes the run contract, and is never mistaken for approval', t => {
  const dir = folder(t);
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, [CLI, 'critic-view', dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })), criticView(fixture()));
  assert.equal(existsSync(join(dir, 'run-contract.json')), false, 'critic-view writes nothing');
  const out = execFileSync(process.execPath, [CLI, 'run-contract', dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  assert.match(out, /^run contract: .*run-contract\.json \(send-retry v2, [0-9a-f]{12}\)$/m);
  assert.equal(out.match(/^packet: /gm).length, 2);
  const usage = spawnSync(process.execPath, [CLI, 'approve', dir], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /run-contract is not approval/);
});

test("autopilot's run-contract manifest: the worked example is toManifest's output", t => {
  const dir = folder(t);
  const contract = writeRunContract(dir, 'abc').contract;
  const { brief } = contract;
  const manifest = JSON.parse(readFileSync(new URL('../test-fixtures/run-contract/manifest.json', import.meta.url), 'utf8'));
  const projectDir = `docs/ideation/${brief.id}/`;
  assert.deepEqual(toManifest(contract, `docs/ideation/${brief.id}`), manifest);
  // A Claude Code run contract runs approved packets fail-closed, and its agent commit stage adds the trailer.
  assert.deepEqual(manifest, {
    projectName: brief.title, slug: brief.id, projectDir, strict: true, packet: true, hostCommits: false, completedPhases: [],
    phases: brief.units.map(u => ({
      title: u.title, specPath: projectDir + packetFile(u.id),
      prereqs: u.needs.map(id => brief.units.find(n => n.id === id).title), risk: u.risk, files: brief.authority.paths,
      trailer: unitTrailer(brief.id, u.id),
    })),
  });
  for (const p of manifest.phases) {
    assert.ok(existsSync(join(dir, p.specPath.slice(projectDir.length))), `${p.specPath} is a written packet`);
    // The packet's File Changes list is what files carries.
    assert.ok(readFileSync(join(dir, p.specPath.slice(projectDir.length)), 'utf8').includes(`## File Changes\n\nOnly within these exact files or trailing-slash directory prefixes ('.' means ordinary project files):\n${p.files.map(f => `- ${f}`).join('\n')}`));
  }
});

test('manifest refuses an unapproved or edited plan and a missing packet, and resumes from trailers', t => {
  const repo = mkdtempSync(join(tmpdir(), 'plan-manifest-')); t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8', timeout: 30_000 });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.invalid'); git('config', 'user.name', 'T'); git('config', 'commit.gpgsign', 'false');
  const dir = join(repo, 'docs', 'ideation', 'send-retry');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(fixture()));
  assert.throws(() => manifestFor(dir, repo), /has no run-contract\.json: the plan is not approved/);
  const cliRefusal = spawnSync(process.execPath, [CLI, 'manifest', dir], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(cliRefusal.status, 1);
  assert.match(cliRefusal.stderr, /^plan-data: .*not approved/m);

  writeRunContract(dir, 'abc');
  assert.deepEqual(manifestFor(dir, repo), toManifest(toRunContract(fixture()), 'docs/ideation/send-retry'));
  git('add', '-A'); git('commit', '-q', '-m', 'feat: retry worker\n\nIdeation-Unit: send-retry/worker');
  assert.deepEqual(manifestFor(dir, repo).completedPhases, ['Retry worker']);
  const printed = spawnSync(process.execPath, [CLI, 'manifest', 'docs/ideation/send-retry'], { cwd: repo, encoding: 'utf8', timeout: 30_000 });
  assert.equal(printed.status, 0, printed.stderr);
  assert.deepEqual(JSON.parse(printed.stdout), manifestFor(dir, repo));

  rmSync(join(dir, 'unit-outbox-label.md'));
  assert.throws(() => manifestFor(dir, repo), /unit-outbox-label\.md is missing: run run-contract again/);
  writeRunContract(dir, 'abc');
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan(p => { p.mustHold.push('Unapproved.'); })));
  assert.throws(() => manifestFor(dir, repo), /no longer matches plan\.json \(v2\): the plan changed after approval/);
});
