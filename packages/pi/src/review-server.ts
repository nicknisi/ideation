/**
 * ideation — review server.
 *
 * A per-review-session `node:http` server on 127.0.0.1 (ephemeral port). It
 * serves exactly one slug's `contract.html`, injects the annotation bundle
 * before `</body>` at serve time (the on-disk file stays pristine), and exposes
 * write-back endpoints scoped to that one slug's directory:
 *
 *   GET  /          — the contract HTML with the annotation bundle injected
 *   GET  /state     — { status, slug, revision }
 *   POST /feedback  — { blockId, kind:'comment', text } appended to feedback-{date}.json
 *   POST /decision  — { decision:'approve'|'deny', reasons?, comments? }
 *
 * A decision (approve/deny) resolves the review exactly once and schedules
 * shutdown; a further POST gets 410. Approve re-reads contract-data.json,
 * flips status Draft→Approved + approvedOn, and requires at least one prior
 * `GET /` (an unopened surface cannot rubber-stamp). No requests for the idle
 * window → resolve as dismissed and shut down.
 *
 * The pattern is the pi-extensions `artifacts` package server; the shape here
 * is fully specified by the phase spec. This file is dependency-free (node
 * builtins only) so it runs under node's type-stripping the same way
 * contract-gen.ts does.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const IDLE_MS = Number(process.env.REVIEW_IDLE_MS ?? 30 * 60 * 1000);

export interface ReviewOptions {
  /** The base ideation directory that holds slug subdirectories (the slug's
      contract lives at `{projectDir}/{slug}/contract.html`). */
  projectDir: string;
  slug: string;
}

export interface ReviewOutcome {
  decision: 'approved' | 'denied' | 'dismissed';
  reasons?: string[];
  comments: number;
}

export interface ReviewHandle {
  port: number;
  url: string;
  outcome: Promise<ReviewOutcome>;
  close: () => void;
}

interface FeedbackEntry {
  blockId: string | null;
  kind: 'comment' | 'deny';
  text: string;
  at: string;
}

interface FeedbackFile {
  version: 1;
  slug: string;
  revision: string;
  entries: FeedbackEntry[];
}

interface ContractData {
  status?: string;
  date?: string;
  approvedOn?: string;
  [k: string]: unknown;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function readContractData(dataPath: string): ContractData {
  const raw = readFileSync(dataPath, 'utf8');
  const parsed = JSON.parse(raw) as ContractData;
  if (typeof parsed !== 'object' || parsed === null || !('status' in parsed)) {
    throw new Error('contract-data.json is missing the `status` field');
  }
  return parsed;
}

function readFeedback(path: string, slug: string, revision: string): FeedbackFile {
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as FeedbackFile;
      if (parsed && parsed.version === 1 && Array.isArray(parsed.entries)) {
        return parsed;
      }
    } catch {
      // Corrupt on disk: the resume path is what surfaces that; here we start a
      // clean file rather than block the review.
    }
  }
  return { version: 1, slug, revision, entries: [] };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Injects the annotation bundle before `</body>`. The bundle carries its own
    styles, so the on-disk contract.html needs no annotation CSS/JS. */
function injectBundle(html: string, bundle: string, config: unknown): string {
  const inject =
    `<script>window.__REVIEW__=${JSON.stringify(config)};</script>\n` +
    `<script>${bundle}</script>\n`;
  return html.includes('</body>')
    ? html.replace('</body>', `${inject}</body>`)
    : html + inject;
}

export function createReviewServer(opts: ReviewOptions): Promise<ReviewHandle> {
  const slugDir = join(opts.projectDir, opts.slug);
  const contractHtmlPath = join(slugDir, 'contract.html');
  const contractDataPath = join(slugDir, 'contract-data.json');
  const bundlePath = join(dirname(fileURLToPath(import.meta.url)), 'annotate.js');

  const initial = readContractData(contractDataPath);
  const revision = initial.date ?? today();
  const feedbackPath = join(slugDir, `feedback-${revision}.json`);

  let served = false;
  let resolved = false;
  let commentCount = 0;
  let resolveOutcome!: (o: ReviewOutcome) => void;
  const outcome = new Promise<ReviewOutcome>(r => {
    resolveOutcome = r;
  });

  let idle: NodeJS.Timeout | undefined;
  const resetIdle = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => finish({ decision: 'dismissed', comments: commentCount }), IDLE_MS);
    if (typeof idle.unref === 'function') idle.unref();
  };

  const finish = (o: ReviewOutcome) => {
    if (resolved) return;
    resolved = true;
    if (idle) clearTimeout(idle);
    resolveOutcome(o);
    // Let the in-flight response flush before tearing the socket down.
    setTimeout(() => server.close(), 250).unref?.();
  };

  const appendFeedback = (entries: FeedbackEntry[]): void => {
    // Re-read before write: the file may have grown from another endpoint.
    const file = readFeedback(feedbackPath, opts.slug, revision);
    file.entries.push(...entries);
    writeFileSync(feedbackPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  };

  const server: Server = createServer((req, res) => {
    resetIdle();
    const method = req.method ?? 'GET';
    const url = (req.url ?? '/').split('?')[0];

    // GET / — serve the contract with the bundle injected.
    if (method === 'GET' && url === '/') {
      let html: string;
      try {
        html = readFileSync(contractHtmlPath, 'utf8');
      } catch {
        return json(res, 404, { error: 'contract.html not found' });
      }
      let bundle = '';
      try {
        bundle = readFileSync(bundlePath, 'utf8');
      } catch {
        // Bundle missing: still serve the readable document.
      }
      served = true;
      const body = injectBundle(html, bundle, {
        slug: opts.slug,
        revision,
        status: initial.status,
      });
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      });
      return res.end(body);
    }

    if (method === 'GET' && url === '/state') {
      let status = initial.status;
      try {
        status = readContractData(contractDataPath).status;
      } catch {
        // fall back to the status read at startup
      }
      return json(res, 200, { slug: opts.slug, revision, status, resolved });
    }

    if (method === 'POST' && url === '/feedback') {
      if (resolved) return json(res, 410, { error: 'review already resolved' });
      readBody(req)
        .then(raw => {
          const b = (raw ?? {}) as { blockId?: unknown; kind?: unknown; text?: unknown };
          if (typeof b.text !== 'string' || !b.text.trim()) {
            return json(res, 400, { error: 'text is required' });
          }
          const entry: FeedbackEntry = {
            blockId: typeof b.blockId === 'string' ? b.blockId : null,
            kind: 'comment',
            text: b.text,
            at: new Date().toISOString(),
          };
          appendFeedback([entry]);
          commentCount += 1;
          json(res, 200, { ok: true, count: commentCount });
        })
        .catch(() => json(res, 400, { error: 'invalid JSON body' }));
      return;
    }

    if (method === 'POST' && url === '/decision') {
      if (resolved) return json(res, 410, { error: 'review already resolved' });
      readBody(req)
        .then(raw => {
          const b = (raw ?? {}) as {
            decision?: unknown;
            reasons?: unknown;
            comments?: unknown;
          };
          const reasons = Array.isArray(b.reasons)
            ? b.reasons.filter((r): r is string => typeof r === 'string')
            : [];

          if (b.decision === 'approve') {
            // Anti-rubber-stamp: the surface must have been opened at least once.
            if (!served) {
              return json(res, 409, {
                error: 'cannot approve before the contract has been served',
              });
            }
            let data: ContractData;
            try {
              data = readContractData(contractDataPath);
            } catch (e) {
              return json(res, 500, {
                error: `contract-data.json unreadable: ${(e as Error).message}`,
              });
            }
            data.status = 'Approved';
            data.approvedOn = today();
            writeFileSync(
              contractDataPath,
              `${JSON.stringify(data, null, 2)}\n`,
              'utf8',
            );
            json(res, 200, { ok: true, decision: 'approved' });
            finish({ decision: 'approved', comments: commentCount });
            return;
          }

          if (b.decision === 'deny') {
            if (reasons.length === 0) {
              return json(res, 400, { error: 'deny requires at least one reason' });
            }
            appendFeedback(
              reasons.map(text => ({
                blockId: null,
                kind: 'deny' as const,
                text,
                at: new Date().toISOString(),
              })),
            );
            json(res, 200, { ok: true, decision: 'denied' });
            finish({ decision: 'denied', reasons, comments: commentCount });
            return;
          }

          json(res, 400, { error: 'decision must be "approve" or "deny"' });
        })
        .catch(() => json(res, 400, { error: 'invalid JSON body' }));
      return;
    }

    json(res, 404, { error: 'not found' });
  });

  return new Promise<ReviewHandle>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resetIdle();
      resolve({
        port,
        url: `http://127.0.0.1:${port}/`,
        outcome,
        close: () => {
          if (idle) clearTimeout(idle);
          server.close();
        },
      });
    });
  });
}

// --- CLI: used by the black-box fixture tests ---------------------------
//
// `node review-server.ts --project-dir <dir> --slug <slug>` starts the server,
// prints `REVIEW_LISTENING <url>` (and `REVIEW_PORT <port>`) once bound, and on
// resolution prints `REVIEW_OUTCOME <json>` and exits 0.

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const { values } = parseArgs({
    options: {
      'project-dir': { type: 'string' },
      slug: { type: 'string' },
    },
  });
  if (!values['project-dir'] || !values.slug) {
    console.error('Usage: review-server.ts --project-dir <dir> --slug <slug>');
    process.exit(1);
  }
  createReviewServer({ projectDir: values['project-dir'], slug: values.slug })
    .then(handle => {
      console.log(`REVIEW_PORT ${handle.port}`);
      console.log(`REVIEW_LISTENING ${handle.url}`);
      return handle.outcome;
    })
    .then(outcome => {
      // Do not process.exit here: resolution schedules server.close(), and the
      // brief window before it lets a client observe the post-resolution 410.
      // The process ends on its own once the server socket and (unref'd) idle
      // timer are gone.
      console.log(`REVIEW_OUTCOME ${JSON.stringify(outcome)}`);
    })
    .catch(err => {
      console.error(`review-server failed: ${(err as Error).message}`);
      process.exit(1);
    });
}
