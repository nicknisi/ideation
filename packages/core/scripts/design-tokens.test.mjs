/**
 * The command-deck world — the dark navy palette 1a1a2e / 16213e / e94560 /
 * 0f3460 — was renounced when the field guide became the committed identity:
 * shipping it in the contract renderer was "the single biggest reason a
 * generated contract did not read as part of this product" (DESIGN.md). The
 * palette outlived its decision because nothing mechanical guarded it — it
 * survived for months in html-guide.md, the notes template, and README's
 * mermaid diagram after the world was renounced. This test is the enforcement.
 *
 * Walk scope is deliberately `skills/`, `scripts/`, and `README.md` — the three
 * places the renounced values ever lived. It is NOT repo-wide: `docs/` quotes
 * the palette descriptively (the pride report, its specs) and `workflows/`,
 * `site/`, `docs/index.html` were never infected.
 *
 * The literals are reconstructed from their hex bodies below — never written
 * with the leading '#' — so the repo's palette-census grep over this very
 * directory stays clean. The self-exemption in the walk is a second belt.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const repoRoot = resolve(SELF, '..', '..', '..', '..');
const coreRoot = resolve(SELF, '..', '..');

/** The renounced world's signature values, built without the '#' so this file
    does not trip the census it enforces. A coincidence is a smell — rename the
    literal, don't exempt it. */
const RENOUNCED = ['1a1a2e', '16213e', 'e94560', '0f3460'].map((h) => `#${h}`);
const ROOTS = [
  ['skills', coreRoot],
  ['scripts', coreRoot],
  ['README.md', repoRoot],
];

function* walk(path) {
  if (statSync(path).isFile()) {
    yield path;
    return;
  }
  for (const entry of readdirSync(path)) {
    if (entry === 'node_modules') continue;
    yield* walk(join(path, entry));
  }
}

describe('renounced command-deck palette', () => {
  it('appears nowhere under skills/, scripts/, or README.md', () => {
    const offenders = [];
    for (const [root, base] of ROOTS) {
      for (const file of walk(join(base, root))) {
        // Self-exemption: this file contains the literals. Compare resolved
        // paths, not substrings, so a rename can't silently re-include it.
        if (resolve(file) === resolve(SELF)) continue;
        const text = readFileSync(file, 'utf8');
        // CSS hex is case-insensitive, so `#1A1A2E` would slip past a
        // case-sensitive match — compare lowercased text against the
        // lowercase literals.
        for (const hex of RENOUNCED) {
          if (text.toLowerCase().includes(hex)) {
            offenders.push(`${relative(repoRoot, file)} contains ${hex}`);
          }
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `renounced palette literals found:\n${offenders.join('\n')}`,
    );
  });
});
