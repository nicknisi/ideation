export const ascii = value => String(value ?? '').replace(/[^\x20-\x7e]/g, '?');
export function safeUrl(value) {
  if (typeof value !== 'string' || /[\x00-\x20\x7f-\x9f]/.test(value)) throw new Error('Unsafe view URL');
  const url = new URL(value);
  if (!['file:', 'http:', 'https:'].includes(url.protocol)) throw new Error('Unsafe view URL');
  return url.href;
}
export function link(url, label = 'contract') {
  return `\x1b]8;;${safeUrl(url)}\x1b\\${ascii(label)}\x1b]8;;\x1b\\`;
}
export function progressSummary(run) {
  const criteria = run.brief?.acceptance ?? [];
  const objective = criteria.filter(c => c.check.cmd);
  const passed = objective.filter(c => {
    const evidence = run.evidence?.filter(e => e.criterionId === c.id).at(-1);
    return run.evidenceFresh !== false && Boolean(run.sourceRevision) && evidence?.status === 'passed' && evidence.sourceRevision === run.sourceRevision;
  }).length;
  const judgments = criteria.length - objective.length;
  const accepted = run.evidenceFresh !== false && run.state === 'accepted' && run.decisions?.some(d => d.type === 'accept' && d.sourceRevision === run.sourceRevision);
  return { passed, total: objective.length, judgments, pendingJudgments: accepted ? 0 : judgments,
    feedback: run.feedback?.filter(f => f.status === 'pending').length ?? 0 };
}
const summarySegments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function summaryText(value, limit = 64) {
  const text = String(value ?? '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = [...summarySegments.segment(text)].map(p => p.segment);
  const cells = (part) => /^[\x20-\x7e]*$/.test(part) ? part.length : 2;
  if (parts.reduce((n, part) => n + cells(part), 0) <= limit) return text;
  let output = '', used = 0;
  for (const part of parts) { if (used + cells(part) > limit - 2) break; output += part; used += cells(part); }
  return limit >= 2 ? `${output}…` : '';
}
export function approvalText(b) {
  const a = b.authority, commands = b.acceptance.filter(c => c.check.cmd).length;
  // The full, escaped agreement is already open in the browser. This is a
  // bounded confirmation, not a document viewer: keep its buttons on screen.
  return [
    `Change: ${summaryText(b.title)}`,
    `Scope: ${a.paths.length} path(s), ${a.commands.length} exact command(s).`,
    `Checks: ${commands} command + ${b.acceptance.length - commands} human; ${b.units.length} unit(s), ${b.executionMode}.`,
    `Local commit: ${a.allowLocalCommit ? 'yes' : 'no'}. No push, merge, deploy or new dependencies.`,
    'No time or token limit: it runs until verified, paused or stopped.',
    'Exact scope & commands: review the opened contract.',
    'Trusted project scripts; this is not an OS sandbox.',
    'Approve those boundaries and start in an isolated checkout?',
  ].join('\n');
}
export function acceptanceText(run) {
  const p = progressSummary(run);
  return [
    `Change: ${summaryText(run.brief.title)}`,
    `Evidence: ${p.passed}/${p.total} objective checks verified.`,
    `Human judgments to accept: ${p.pendingJudgments}.`,
    'Review the evidence and judgments in the opened contract.',
    'Accept this candidate? Nothing will be merged, pushed or deployed.',
  ].join('\n');
}
export function chooseRun(runs, repoRoot, ownerId) {
  const scoped = runs.filter(r => r.repoRoot === repoRoot && (!r.ownerId || r.ownerId === ownerId));
  const active = scoped.filter(r => !['accepted', 'cancelled', 'failed'].includes(r.state));
  return (active.length ? active : scoped).sort((a,b) => b.updatedAt - a.updatedAt)[0];
}
