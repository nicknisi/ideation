/**
 * The harness differences, parsed from references/harness-compat.md.
 *
 * Same reason as the gates and the command table: that file is what the skills
 * point at, so a second copy of it here would be wrong the first time pi's
 * agent registry or the Workflow signature moved. The page renders whatever the
 * reference says, and fails the build if the tables stop being parseable.
 */
import { readFileSync } from 'node:fs';
import { corePath } from './repo';

const COMPAT = corePath('references', 'harness-compat.md');

/** One row of a compat table, cells in column order. Markdown inline code is kept. */
export type CompatRow = string[];

export interface CompatTable {
  headers: string[];
  rows: CompatRow[];
}

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(c => c.trim());

/**
 * Read a cell by its column header name. Throws if the header is missing — so
 * a column rename in the markdown breaks the build rather than silently
 * rendering the wrong cell (positional `row[n]` access would swap content
 * silently on a column reorder). The header match is case-sensitive and
 * strips inline backticks so `\`Tool\`` matches `Tool`.
 */
export function cellByHeader(
  table: CompatTable,
  row: CompatRow,
  headerName: string,
): string {
  const idx = table.headers.findIndex(h => h.replace(/`/g, '').trim() === headerName);
  if (idx === -1) {
    throw new Error(
      `harness-compat.md table has no "${headerName}" column. ` +
        `Available: ${table.headers.join(', ')}. ` +
        `A column was renamed or reordered; update the page or the markdown.`,
    );
  }
  return row[idx];
}

/**
 * The first pipe table under the `## <n>. …` section whose title starts with
 * `titlePrefix`. Throws rather than rendering an empty table.
 */
export function readCompatTable(titlePrefix: string): CompatTable {
  const src = readFileSync(COMPAT, 'utf8');
  const section = new RegExp(
    `\\n## \\d+\\. ${titlePrefix}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`,
  ).exec(src);
  if (!section) {
    throw new Error(`harness-compat.md has no "## n. ${titlePrefix}…" section`);
  }

  const lines = section[1].split('\n');
  const start = lines.findIndex(l => l.trim().startsWith('|'));
  if (start === -1) {
    throw new Error(`harness-compat.md § ${titlePrefix}: no table found`);
  }

  const headers = cells(lines[start]);
  const rows: CompatRow[] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.trim().startsWith('|')) break;
    rows.push(cells(line));
  }
  if (!rows.length) {
    throw new Error(`harness-compat.md § ${titlePrefix}: table has no rows`);
  }
  for (const row of rows) {
    if (row.length !== headers.length) {
      throw new Error(
        `harness-compat.md § ${titlePrefix}: row "${row[0]}" has ${row.length} ` +
          `cells, headers have ${headers.length}`,
      );
    }
  }
  return { headers, rows };
}

/**
 * The two harnesses the plugin runs in, in the order the page names them.
 * Asserted against § 1's table so the page's prose cannot outlive the support.
 */
export function readHarnesses(): string[] {
  const table = readCompatTable('The engine invocation');
  const names = table.rows.map(r => cellByHeader(table, r, 'Harness'));
  if (names.length !== 2) {
    throw new Error(
      `expected 2 harnesses in harness-compat.md § 1, found ${names.length}: ` +
        `${names.join(', ')}. The guide says "two" in prose.`,
    );
  }
  return names;
}
