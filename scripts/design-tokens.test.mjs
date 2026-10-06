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
const repoRoot = resolve(SELF, '..', '..');

/** The renounced world's signature values, built without the '#' so this file
    does not trip the census it enforces. A coincidence is a smell — rename the
    literal, don't exempt it. */
const RENOUNCED = ['1a1a2e', '16213e', 'e94560', '0f3460'].map((h) => `#${h}`);
const ROOTS = ['skills', 'scripts', 'README.md'];

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
    for (const root of ROOTS) {
      for (const file of walk(join(repoRoot, root))) {
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

/**
 * Token values. DESIGN.md's table owns the palette and field-guide.css is its
 * canonical declaration; plan-render.css maps html-plan's token names onto
 * field-guide tokens, naming the one it copies in a trailing comment, and
 * change-render.css composes Pi's change page from field-guide tokens alone.
 * All of them must carry DESIGN.md's values, so no page drifts into a third world.
 */
const read = (path) => readFileSync(join(repoRoot, path), 'utf8');
const squash = (value) => value.replace(/\s+/g, ' ').trim();
/** DESIGN.md's token table: role → light-dark(light, dark), as field-guide.css writes it. */
const designTokens = () => new Map(
  [...read('DESIGN.md').matchAll(/^\| `(--[\w-]+)` \| `(#[0-9a-f]{6})` \| `(#[0-9a-f]{6})` \|$/gim)]
    .map(([, role, light, dark]) => [role, `light-dark(${light}, ${dark})`]),
);
/** field-guide.css's first :root block (later blocks are print overrides): token → value. */
const contractTokens = () => new Map(
  [...read('scripts/field-guide.css').match(/^:root \{([\s\S]*?)^\}/m)[1].matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)]
    .map(([, name, value]) => [name, squash(value)]),
);

describe('field-guide token values', () => {
  it('DESIGN.md lists the palette, and field-guide.css declares those values', () => {
    const design = designTokens(), contract = contractTokens();
    assert.equal(design.size, 13, 'DESIGN.md token table should have its 13 roles');
    for (const [role, value] of design) assert.equal(contract.get(role), value, `field-guide.css ${role}`);
  });

  it('change-render.css declares no colour and uses only field-guide tokens', () => {
    const contract = contractTokens();
    const css = read('scripts/change-render.css');
    assert.deepEqual(css.match(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/gi), null, 'change-render.css invents a colour');
    const local = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
    const missing = [...new Set([...css.matchAll(/var\((--[\w-]+)/g)].map(m => m[1]))].filter(t => !contract.has(t) && !local.has(t));
    assert.deepEqual(missing, [], 'change-render.css uses tokens field-guide.css does not declare');
  });

  it('plan-render.css maps every html-plan token onto a field-guide value, light and dark, and holds no other colour', () => {
    const design = designTokens(), contract = contractTokens();
    const css = read('scripts/plan-render.css');
    const block = (selector) => css.match(new RegExp(`^\\s*${selector.replace(/[[\]()":]/g, '\\$&')} \\{([^}]*)\\}`, 'm'))[1];
    const pair = (v) => v.match(/^light-dark\((#\w+), (#\w+)\)$/);
    const lightOf = (v) => pair(v)?.[1], darkOf = (v) => pair(v)?.[2];
    // The light block names, for each html-plan token, the field-guide token it copies.
    const mapped = [...block(':root').matchAll(/^\s*(--[\w-]+):\s*([^;]+);\s*\/\* (--[\w-]+) \*\/$/gm)].map(([, name, value, role]) => ({ name, value: squash(value), role }));
    assert.ok(mapped.length >= 20, `expected the html-plan palette, found ${mapped.length} mapped tokens`);
    const colours = mapped.filter((m) => m.value.startsWith('#'));
    for (const { name, value, role } of mapped) {
      assert.ok(contract.has(role), `${name} names ${role}, which field-guide.css does not declare`);
      const expected = value.startsWith('#') ? lightOf(contract.get(role)) : contract.get(role);
      assert.equal(value, expected, `plan-render.css ${name} should equal ${role}`);
      if (design.has(role)) assert.equal(value, lightOf(design.get(role)), `plan-render.css ${name} should equal DESIGN.md ${role} (light)`);
    }
    // Both dark blocks give every colour token its role's dark value, and nothing else.
    for (const selector of [':root:not([data-theme="light"])', ':root[data-theme="dark"]']) {
      const dark = Object.fromEntries([...block(selector).matchAll(/^\s*(--[\w-]+):\s*([^;]+);$/gm)].map(([, n, v]) => [n, v.trim()]));
      assert.deepEqual(Object.keys(dark).sort(), colours.map((m) => m.name).sort(), `${selector} declares exactly the colour tokens`);
      for (const { name, role } of colours) {
        assert.equal(dark[name], darkOf(contract.get(role)), `plan-render.css ${selector} ${name} should equal ${role} (dark)`);
        if (design.has(role)) assert.equal(dark[name], darkOf(design.get(role)), `plan-render.css ${selector} ${name} should equal DESIGN.md ${role} (dark)`);
      }
    }
    // A colour anywhere else would be a value nothing checks.
    assert.equal((css.match(/#[0-9a-f]{3,8}\b/gi) ?? []).length, colours.length * 3, 'every colour in plan-render.css is a mapped token');
    // htmlplan.css's colour tokens are all mapped.
    const upstream = read('vendor/html-plan/runtime/htmlplan.css').match(/^:root \{([\s\S]*?)^\}/m)[1];
    const upstreamColours = [...upstream.matchAll(/(--[\w-]+):\s*(#|rgba)/g)].map((m) => m[1]);
    assert.deepEqual(upstreamColours.filter((n) => !colours.some((m) => m.name === n)), []);
  });
});
