// Plan data: the source of truth for an ideation plan. Approval derives a frozen
// run contract (the change brief in workflows/change-brief.mjs) from it; see
// toRunContract in scripts/plan-data.ts. Validation lives there too: this file
// holds only the types and the closed vocabularies validation checks against.
//
// Erasable TypeScript only (Node strips types): no enums, no namespaces.

export const GATE_KEYS = ['problem', 'goals', 'criteria', 'scope', 'consistency'] as const;
export const EXHIBIT_KINDS = ['mock', 'machine', 'calls', 'schema', 'code'] as const;
export const DECISION_STATES = ['answered', 'kept', 'not-opened'] as const;
export const QUESTION_TYPES = ['research', 'prototype', 'decision', 'task'] as const;
export const RISKS = ['low', 'medium', 'high'] as const;
export const SCOPE_TIERS = ['mvp', 'full', 'stretch', 'future'] as const;
/** At most this many claims per level, and at most this many levels. */
export const MAX_CLAIMS = 5;
export const MAX_DEPTH = 3;

export type GateKey = (typeof GATE_KEYS)[number];
export type ExhibitKind = (typeof EXHIBIT_KINDS)[number];
export type DecisionState = (typeof DECISION_STATES)[number];
export type Risk = (typeof RISKS)[number];
export type ScopeTier = (typeof SCOPE_TIERS)[number];

/** Same union as the brief's acceptance check: a command that proves it by exiting 0, or a human judgment. */
export type Check = { cmd: string; expect?: string } | { judgment: string };

export interface Plan {
  schemaVersion: 1;
  /** Lowercase kebab-case; becomes the brief's id. */
  id: string;
  title: string;
  /** Starts at 1; each new version is version + 1 (nextVersion). Becomes the brief's revision. */
  version: number;
  /** The file this version replaces, e.g. "plan.v2.json"; null for a first version. */
  supersedes: string | null;
  /** The problem, in the words of whoever stated it. Joined into the brief's why. */
  why: { quote: string; from: string }[];
  /** May be empty while planning; the run contract needs both. */
  change: { before: string; after: string };
  mustHold: string[];
  gates: Record<GateKey, { ready: boolean; evidence: string }>;
  /** Present when planning was deliberately stopped before every gate was ready: why. */
  stoppedEarly?: string;
  claims: Claim[];
  checks: { id: string; criterion: string; check: Check }[];
  /** Work that keeps a gate open. blockedBy names other questions; absent means takeable now.
   * A closed question is removed, so blockedBy may name one that is gone. */
  openQuestions: { id: string; question: string; gate: GateKey; type: (typeof QUESTION_TYPES)[number]; blockedBy?: string[] }[];
  units: Unit[];
  /** The brief's authority block. May be empty while planning; the run contract needs a path. */
  authority: { paths: string[]; commands: string[]; allowLocalCommit: boolean };
  scope: Record<ScopeTier, string[]> & { notChanging: string[]; dropped: string[] };
}

/**
 * One sentence that can be true or false, shown with one exhibit.
 *
 * The tree reads top down in html-plan's order; only its shape is enforced
 * (at most MAX_CLAIMS per level, at most MAX_DEPTH levels):
 * - why: the plan's own title and why quotes, above the tree;
 * - level 1: what someone can now do or see;
 * - level 2: how it works;
 * - level 3: where in the code, usually a `code` exhibit's src/lines/ref.
 */
export interface Claim {
  /** e.g. "2.1"; stable across versions, so responses can name it. */
  id: string;
  text: string;
  exhibit: Exhibit;
  /** A decision sits on the claim it changes. */
  decision?: Decision;
  children?: Claim[];
}

export interface Exhibit {
  kind: ExhibitKind;
  /** Repo path the exhibit shows, with optional line range and git ref. */
  src?: string;
  lines?: string;
  ref?: string;
  /** Inline content, for sketches and anything without a source file: the source of the
   * html-plan block the kind names (vendor/html-plan; skills/html-plan/references/blocks.md
   * upstream), e.g. machine and calls in their DSLs, code and schema as text. A mock's body is
   * shown as text, never markup. The page renderer (scripts/plan-render.ts) passes it through,
   * so pack's lint reports a body that does not parse. */
  body?: string;
  /** True when the exhibit shows something that doesn't exist yet. */
  sketch: boolean;
}

export interface Decision {
  id: string;
  /** Required while not-opened. A recorded decision (answered or kept, e.g. converted from 0.x)
   * may omit it; the brief then names only the chosen option's label. */
  question?: string;
  /** At least 2 while not-opened; a recorded decision may have only the option it chose. */
  options: { value: string; label: string }[];
  /** The option the plan suggests. */
  recommended: string;
  /** Why the recommended option, or, once answered, why the answer. Becomes the brief decision's reason. */
  reason: string;
  /** Approval refuses while a required decision is not-opened. */
  required: boolean;
  /** answered: `answer` holds the chosen option. kept: the recommended option was accepted as is. not-opened: nobody chose. */
  state: DecisionState;
  /** Present only when state is answered. */
  answer?: string;
  /** Options turned down, each with why when known (a converted 0.x decision has one reason, for the choice). */
  rejected: { value: string; reason?: string }[];
}

/** A unit of execution; maps 1:1 onto a brief unit. */
export interface Unit {
  /** Lowercase kebab-case. */
  id: string;
  title: string;
  goal: string;
  risk: Risk;
  /** Required for high-risk units: interfaces, compatibility and rollback. */
  design?: string;
  /** Prerequisite unit ids. */
  needs: string[];
  /** The checks this unit must pass; becomes acceptanceIds. */
  checkIds: string[];
  /** The claims this unit makes true. */
  claimIds: string[];
}

/** What approval freezes: a brief `validateBrief` accepts, its fingerprint, and the plan file it came from. */
export interface RunContract {
  brief: Record<string, unknown>;
  fingerprint: string;
  plan: string;
}
