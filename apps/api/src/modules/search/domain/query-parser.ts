/**
 * The field-query syntax (`12-search-architecture.md` §5).
 *
 * `number:QMS-* status:PUBLISHED approver:me updated:>2026-01-01 pump maintenance` — the
 * fielded tokens become structured filters and the rest stays free text. Parsed here, in the
 * domain, and **never into SQL**: the output is the same `Record<string, string[]>` shape the
 * filter rail produces, so a typed query and a clicked facet run through one validated path.
 *
 * Unknown fields are kept as text rather than refused — `re:union` in a title search is a
 * colon in a word, not a syntax error, and a search box that errors on it would be wrong more
 * often than it is right.
 */

/** The fields the syntax accepts, mapped to the filter keys the engine understands. */
const FIELD_KEYS: Readonly<Record<string, string>> = Object.freeze({
  number: 'number',
  status: 'status',
  type: 'typeCode',
  owner: 'owner',
  approver: 'approver',
  author: 'owner',
  updated: 'updated',
  published: 'published',
  created: 'created',
  effective: 'effective',
  language: 'language',
});

export interface ParsedQuery {
  /** The free-text remainder, trimmed; empty when the query was all fields. */
  readonly text: string;
  /** Field filters, in the same shape explicit filters arrive in. */
  readonly filters: Readonly<Record<string, readonly string[]>>;
}

const FIELD_TOKEN = /^([a-z]+):(.+)$/i;

export function parseSearchQuery(raw: string): ParsedQuery {
  const filters = new Map<string, string[]>();
  const text: string[] = [];

  for (const token of tokenize(raw)) {
    const match = FIELD_TOKEN.exec(token);
    const key = match ? FIELD_KEYS[match[1]?.toLowerCase() ?? ''] : undefined;
    if (!match || key === undefined) {
      text.push(token);
      continue;
    }
    const value = unquote(match[2] ?? '');
    if (value === '') {
      continue;
    }
    const existing = filters.get(key) ?? [];
    filters.set(key, [...existing, value]);
  }

  return {
    text: text.join(' ').trim(),
    filters: Object.fromEntries(filters.entries()),
  };
}

/** Split on whitespace, keeping double-quoted phrases — including after a field colon — whole. */
function tokenize(raw: string): readonly string[] {
  const tokens: string[] = [];
  const pattern = /(?:[^\s"]+"[^"]*"?|"[^"]*"?|[^\s"]+)/g;
  for (const match of raw.matchAll(pattern)) {
    tokens.push(match[0]);
  }
  return tokens;
}

function unquote(value: string): string {
  return value.replaceAll('"', '').trim();
}
