/**
 * ideation — review surface tool.
 *
 * Registers exactly one tool, `ideation_review`: it starts the per-session
 * review server for a slug (extensions/../src/review-server.ts), opens the
 * contract in a browser, and blocks until the review resolves — a decision
 * submitted on the surface, or an idle-timeout dismissal. The return value is
 * the approval outcome the SKILL's Phase 3 full-review path routes on.
 *
 * One tool name, so it can never trip pi's single-owner-per-tool-name rule
 * (harness-compat.md § 3). When this extension is absent (Claude Code, or it
 * failed to load), the SKILL falls through to the terminal AskUserQuestion,
 * unchanged. If the browser cannot be opened (headless/SSH) the URL is printed
 * and the review stays live until a decision or the idle timeout.
 */
import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { createReviewServer } from '../src/review-server.ts';

function openBrowser(url: string): boolean {
  const cmd =
    platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open';
  try {
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'ideation_review',
    label: 'Open Ideation Review Surface',
    description:
      "Open the annotatable review surface for an ideation contract and block until the reviewer decides. Starts a localhost server serving docs/ideation/{slug}/contract.html with the annotation bundle injected, opens it in a browser, and returns { decision: 'approved' | 'denied' | 'dismissed', reasons?, comments } once a decision is submitted (approve flips contract-data.json to Approved) or the surface times out. Used by the ideation skill's Phase 3 full-review path in pi.",
    promptSnippet: 'Open the contract review surface and wait for the decision',
    promptGuidelines: [
      'Call with the slug and the ideation project base directory (the parent of the slug directory, e.g. docs/ideation).',
      "On 'dismissed' (closed tab or idle timeout) fall back to the terminal AskUserQuestion; 'approved' and 'denied' are the surface's decision.",
    ],
    parameters: Type.Object({
      projectDir: Type.String(),
      slug: Type.String(),
    }),

    async execute(_toolCallId, params, _signal, onUpdate, _ctx) {
      const handle = await createReviewServer({
        projectDir: params.projectDir,
        slug: params.slug,
      });
      const opened = openBrowser(handle.url);
      onUpdate?.({
        content: [
          {
            type: 'text',
            text: opened
              ? `Review surface open at ${handle.url} — waiting for a decision…`
              : `Could not open a browser. Open ${handle.url} to review — waiting for a decision…`,
          },
        ],
      });
      const outcome = await handle.outcome;
      handle.close();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(outcome, null, 2) }],
        details: { outcome },
      };
    },
  });
}
