/**
 * The five evidence gates, parsed from references/confidence-rubric.md.
 *
 * Derived rather than transcribed for the same reason as the command table:
 * the rubric is the authority the interview actually reads, and a second copy
 * of it on a docs page would drift the first time someone sharpened a wording.
 */
import { readFileSync } from 'node:fs';
import { corePath } from './repo';

const RUBRIC = corePath('references', 'confidence-rubric.md');

export interface Gate {
  /** Heading name, e.g. "Problem Clarity". */
  gate: string;
  /** What the interview is asking itself at this gate. */
  question: string;
  /** The condition that flips it to `ready`. */
  ready: string;
}

export function readGates(): Gate[] {
  const src = readFileSync(RUBRIC, 'utf8');
  const gates: Gate[] = [];

  for (const m of src.matchAll(/### Gate: (.+?)\n([\s\S]*?)(?=\n### Gate: |$)/g)) {
    const body = m[2];
    const field = (key: string): string => {
      const hit = new RegExp(`\\*\\*${key}\\*\\*:\\s*(.+)`).exec(body);
      if (!hit) throw new Error(`rubric gate "${m[1]}" has no **${key}**`);
      return hit[1].trim();
    };
    gates.push({
      gate: m[1].trim(),
      question: field('Gate question'),
      ready: field('Ready when'),
    });
  }

  // The interview proceeds only when all five read ready; a rubric that stopped
  // having five gates would make every "five gates" claim on the page false.
  if (gates.length !== 5) {
    throw new Error(
      `expected 5 evidence gates in confidence-rubric.md, found ${gates.length}. ` +
        'The guide states "five" in prose — update both or neither.',
    );
  }
  return gates;
}
