# HTML for Ephemeral Comparisons

Scope: **ephemeral `_comparison.html` files only** — visual decision aids
written during ideation, opened once, deleted after the choice. Nothing else.
`contract.html` comes exclusively from `scripts/contract-gen.ts`;
implementation notes come exclusively from
`skills/execute-spec/references/implementation-notes.template.html`; specs and
PRDs are Markdown. If you are hand-writing HTML that is not a comparison, one
of those owners is being bypassed.

The behavioral workflow — when a comparison earns a file, how it is shown and
deleted — is owned by `skills/ideation/SKILL.md`'s Decision Aids section. This
file owns only what goes *in* the file.

## Rules (non-negotiable)

1. **One self-contained file** — all CSS and JS inlined.
2. **No CDN, no build step, no remote fonts, no external images.** It must work
   from `file://` offline.
3. **Filename starts with `_`** — `_comparison.html` marks it ephemeral; it is
   deleted after the choice.
4. Light and dark via a `prefers-color-scheme` media query.
5. Semantic HTML (`<header>`, `<main>`, `<section>`); interactive elements
   keyboard-accessible.

## Tokens

The token authority is `DESIGN.md` (repo root) — the field-guide world: paper
ground, ink, one cobalt accent. Declare the custom properties from its table in
a `:root` block plus a dark override, and reference the variables in component
CSS — never hardcode hex, never invent values. A comparison is a product
artifact and wears the product's world.

## Components a comparison needs

Three, rarely four. Each option gets a card (name, description, trade-offs,
visual where apt); trade-offs may also be a shared list; the copy snippet is
the only JS allowed.

### Option cards

One card per option, side by side; the recommended option wears the accent.

```css
.options {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
  gap: 1rem;
}
.option {
  border: 1px solid var(--line);
  border-radius: 3px;
  padding: 1rem 1.25rem;
}
.option h3 { margin: 0 0 0.5rem; }
.option.recommended { border-color: var(--accent); }
```

```html
<section class="options">
  <div class="option recommended">
    <h3>Option A — {name}</h3>
    <p>{description}</p>
    <!-- trade-offs, visual where apt -->
  </div>
  <!-- one .option per choice -->
</section>
```

### Trade-off lists

Plain two-column pros/cons inside a card, or a shared list under the cards when
the trade-offs are common to all options. `<ul>` is enough; do not build a
component for it.

### Copy snippet

The one piece of JS permitted in an artifact — a button that copies a command,
path, or config to the clipboard.

```html
<button type="button" data-copy="the text to copy">Copy</button>
<script>
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    await navigator.clipboard.writeText(btn.dataset.copy);
    btn.textContent = 'Copied';
    setTimeout(() => (btn.textContent = 'Copy'), 1200);
  });
</script>
```

## Checklist before `open`

- [ ] Filename is `_comparison.html` (or `_<something>.html`)
- [ ] One file, no external requests, works from `file://`
- [ ] Token values come from `DESIGN.md`, referenced as variables
- [ ] Every option is visible without scrolling sideways
- [ ] The file will be deleted after the choice is made
