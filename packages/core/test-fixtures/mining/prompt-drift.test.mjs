/**
 * Three-way mining-prompt drift guard.
 *
 * The mining front door's prompt bodies have a single source of truth,
 * references/mining-prompts.md, but they are consumed from two other places:
 * the pi workflow (packages/pi/workflows/mining.js loads and interpolates the
 * reference at runtime) and the Claude Code branch of references/interview-
 * engine.md (which quotes the same bodies verbatim into its conversational
 * flow). Prose drift is silent by default — the exact failure lint-prompts.mjs
 * exists to prevent for cross-references. This suite makes a one-sided edit to
 * any of the three locations loud:
 *
 *   - reference ↔ skill: byte-equality of every delimited prompt body.
 *   - reference ↔ workflow: mining.js must request exactly the section keys the
 *     reference defines (it holds no prompt text of its own to compare).
 *
 * Bodies are delimited by `<!-- prompt:NAME -->` / `<!-- /prompt:NAME -->` in
 * both markdown files. The skill quotes them inside an indented fenced block,
 * so the extractor dedents by the common leading whitespace before comparing —
 * incidental indentation is not drift, a changed word is.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE = join(__dirname, '..', '..', 'references', 'mining-prompts.md');
const SKILL = join(__dirname, '..', '..', 'references', 'interview-engine.md');
const WORKFLOW = join(__dirname, '..', '..', '..', 'pi', 'workflows', 'mining.js');

const NAMES = ['scout', 'candidate', 'grail', 'advisor'];

/** Remove the common leading indentation across non-empty lines. */
function dedent(block) {
  const lines = block.split('\n');
  const indents = lines
    .filter(l => l.trim() !== '')
    .map(l => l.match(/^ */)[0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map(l => (l.trim() === '' ? '' : l.slice(min))).join('\n');
}

/** Extract and dedent one delimited prompt body, tolerant of indentation before
    either delimiter (the skill nests them inside a list-item code fence). */
function extract(doc, name) {
  const re = new RegExp(
    `<!--\\s*prompt:${name}\\s*-->\\n([\\s\\S]*?)\\n\\s*<!--\\s*/prompt:${name}\\s*-->`,
  );
  const m = re.exec(doc);
  assert.ok(m, `prompt section "${name}" not found`);
  return dedent(m[1]);
}

describe('mining prompts — reference and CC skill agree', () => {
  const reference = readFileSync(REFERENCE, 'utf8');
  const skill = readFileSync(SKILL, 'utf8');

  for (const name of NAMES) {
    it(`the "${name}" body is byte-identical in the reference and interview-engine.md`, () => {
      const fromRef = extract(reference, name);
      const fromSkill = extract(skill, name);
      assert.ok(fromRef.length > 40, `reference "${name}" body looks empty`);
      assert.equal(
        fromSkill,
        fromRef,
        `the "${name}" prompt drifted between mining-prompts.md and interview-engine.md — ` +
          'edit the reference and re-sync the CC quote in the same change.',
      );
    });
  }

  it('a one-sided edit is caught (negative control)', () => {
    // 'map the terrain' occurs only inside the scout body, so this simulates a
    // reference-only edit and must diverge from the (unchanged) skill quote.
    const poisoned = reference.replace('map the terrain', 'chart the terrain');
    assert.notEqual(poisoned, reference, 'negative control did not modify the source');
    assert.notEqual(extract(poisoned, 'scout'), extract(skill, 'scout'));
  });
});

describe('mining prompts — the workflow requests the reference sections', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');

  for (const name of NAMES) {
    it(`mining.js loads the "${name}" section from the reference`, () => {
      assert.match(
        workflow,
        new RegExp(`section\\(\\s*promptsDoc\\s*,\\s*'${name}'\\s*\\)`),
        `mining.js does not load the "${name}" section — it and the reference have drifted.`,
      );
    });
  }

  it('mining.js embeds no prompt bodies of its own (single source is the reference)', () => {
    // Distinctive phrases from each body — none should survive in the workflow,
    // which now interpolates the reference rather than carrying the text.
    for (const phrase of [
      'map the terrain a solution would live in',
      'best possible\noutcome ignoring effort',
      'declare your ignorance',
    ]) {
      assert.ok(
        !new RegExp(phrase).test(workflow),
        `mining.js still carries prompt text ("${phrase}") — it should live only in mining-prompts.md`,
      );
    }
  });
});
