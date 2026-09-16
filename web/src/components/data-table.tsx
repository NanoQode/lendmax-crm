/**
 * The table every list in the CRM uses.
 *
 * Every table gets the same four things, in the same places: a search box, a
 * filter under each column header, sorting by clicking a header, and
 * pagination. A person who has learned one table has learned all of them.
 *
 * Two modes:
 *   · client — hand it every row; it searches, filters, sorts and pages in
 *     the browser. For lists that are small by nature (staff, API keys, a
 *     report's rows).
 *   · server — hand it one page and a `total`; it reports what the person
 *     asked for through `onQueryChange` and the server does the work. For
 *     lists that grow without limit (customers, required documents).
 *
 * On a phone the table becomes cards (see app.css), so the header row — and
 * the filters and sort in it — is hidden; the same controls are shown above
 * the cards instead.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Empty, Icon, ICONS, SearchSelect, Skeleton, type SelectOption } from './ui.tsx';

export type FilterSpec = false | 'text' | 'number' | 'auto' | { options: SelectOption[] };

export type Column<T> = {
  key: string;
  header: string;
  /** What sorting, filtering and searching look at. Defaults to row[key]. */
  value?: (row: T) => unknown;
  /**
   * What the filter looks at, when that differs from the value — a date
   * filtered as "This week", an amount as "Under $250k". Pair with `auto`.
   */
  filterValue?: (row: T) => unknown;
  render?: (row: T) => ComponentChildren;
  sortable?: boolean;
  /**
   * `text` (the default) — contains; `number` — `>5`, `<10`, `5-10`, `=3`
   * or a plain number; `auto` — a dropdown of the values present (client
   * mode); `{ options }` — a dropdown of these; `false` — none.
   */
  filter?: FilterSpec;
  /** In server mode, the query parameter this column's filter is sent as. */
  param?: string;
  /** In server mode, the sort key sent for this column. */
  sortKey?: string;
  align?: 'right';
  /** The card title on a phone. */
  primary?: boolean;
  /** Leave out of the table-wide search. */
  searchable?: boolean;
  width?: string;
};

export type TableQuery = {
  q: string;
  sort: string | null;
  dir: 'asc' | 'desc';
  page: number;
  pageSize: number;
  filters: Record<string, string>;
};

export const emptyQuery = (over: Partial<TableQuery> = {}): TableQuery => ({
  q: '', sort: null, dir: 'asc', page: 1, pageSize: 25, filters: {}, ...over,
});

/** A server-mode query as URL parameters, using each column's `param` and `sortKey`. */
export function queryToParams<T>(query: TableQuery, columns: Column<T>[], extra: Record<string, string> = {}): URLSearchParams {
  const params = new URLSearchParams(extra);
  if (query.q.trim()) params.set('q', query.q.trim());
  for (const [key, value] of Object.entries(query.filters)) {
    if (!value) continue;
    const column = columns.find((c) => c.key === key);
    params.set(column?.param ?? key, value);
  }
  if (query.sort) {
    const column = columns.find((c) => c.key === query.sort);
    params.set('sort', column?.sortKey ?? query.sort);
    params.set('dir', query.dir);
  }
  params.set('page', String(query.page));
  params.set('page_size', String(query.pageSize));
  return params;
}

type Props<T> = {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Server mode: the total across all pages. Its presence switches modes. */
  total?: number;
  query?: TableQuery;
  onQueryChange?: (query: TableQuery) => void;
  loading?: boolean;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  pageSize?: number;
  onRowClick?: (row: T) => void;
  rowClass?: (row: T) => string;
  searchPlaceholder?: string;
  /** Extra controls beside the search box. */
  toolbar?: ComponentChildren;
  /** Shown when there is nothing at all (not merely nothing matching). */
  empty?: ComponentChildren;
  /** Filters shown on first render. Small tables start with them tucked away. */
  filtersOpen?: boolean;
  label: string;
  /** Smaller page sizes for tables inside a card on a detail screen. */
  compact?: boolean;
};

const fold = (v: unknown) => String(v ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const valueOf = <T,>(column: Column<T>, row: T): unknown =>
  column.value ? column.value(row) : (row as Record<string, unknown>)[column.key];

function compare(a: unknown, b: unknown): number {
  const empty = (v: unknown) => v === null || v === undefined || v === '';
  if (empty(a) && empty(b)) return 0;
  if (empty(a)) return 1;            // blanks last, whichever way
  if (empty(b)) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(b) - Number(a);
  const na = Number(a), nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && String(a).trim() !== '' && String(b).trim() !== '') return na - nb;
  return String(a).localeCompare(String(b), 'en-CA', { numeric: true, sensitivity: 'base' });
}

const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);

/** ">5", "<= 10", "5-10", "=3", "7" — against one number. Unparseable: no filtering. */
export function matchesNumber(expression: string, value: unknown): boolean {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[^0-9.\-]/g, ''));
  const e = expression.replace(/[\s,$%]/g, '');
  if (!e) return true;
  if (value === null || value === undefined || value === '' || Number.isNaN(n)) return false;
  const range = e.match(/^(-?\d*\.?\d+)-(-?\d*\.?\d+)$/);
  if (range) return n >= Number(range[1]) && n <= Number(range[2]);
  const op = e.match(/^(>=|<=|>|<|=)?(-?\d*\.?\d+)$/);
  if (!op) return true;
  const x = Number(op[2]);
  switch (op[1]) {
    case '>': return n > x;
    case '<': return n < x;
    case '>=': return n >= x;
    case '<=': return n <= x;
    default: return n === x;
  }
}

/** A date as a bucket a filter can offer: Today, This week, This month, Older, Never. */
export function recency(value: string | null | undefined): string {
  if (!value) return 'Never';
  const days = (Date.now() - new Date(value).getTime()) / 86_400_000;
  if (Number.isNaN(days)) return 'Never';
  if (days < 1) return 'Today';
  if (days < 7) return 'This week';
  if (days < 31) return 'This month';
  return 'Older';
}

export function DataTable<T>(props: Props<T>) {
  const {
    columns, rows, rowKey, onRowClick, rowClass, label, toolbar, empty, loading = false,
    searchPlaceholder = 'Search…', compact = false,
  } = props;
  const server = props.total !== undefined;
  const sizes = compact ? [5, 10, 25] : [10, 25, 50, 100];

  const [local, setLocal] = useState<TableQuery>(() => emptyQuery({
    pageSize: props.pageSize ?? (compact ? 10 : 25),
    sort: props.initialSort?.key ?? null,
    dir: props.initialSort?.dir ?? 'asc',
  }));
  const query = server ? props.query ?? local : local;
  const setQuery = (next: TableQuery) => (server ? props.onQueryChange?.(next) : setLocal(next));
  // Open by default on a wide screen; on a phone the filters would fill the
  // screen before the first row, so they wait behind the Filters button.
  const [filtersOpen, setFiltersOpen] = useState(
    (props.filtersOpen ?? !compact) && (typeof window === 'undefined' || window.innerWidth > 860));

  // Typed text is held here and passed on after a pause, so a server table
  // does not send a request per keystroke.
  const [draft, setDraft] = useState<{ q: string; filters: Record<string, string> }>({ q: query.q, filters: query.filters });
  const lastSent = useRef(JSON.stringify({ q: query.q, filters: query.filters }));
  useEffect(() => {
    const incoming = JSON.stringify({ q: query.q, filters: query.filters });
    if (incoming !== lastSent.current) { lastSent.current = incoming; setDraft({ q: query.q, filters: query.filters }); }
  }, [query.q, JSON.stringify(query.filters)]);
  useEffect(() => {
    const next = JSON.stringify(draft);
    if (next === lastSent.current) return;
    const id = setTimeout(() => {
      lastSent.current = next;
      setQuery({ ...query, q: draft.q, filters: draft.filters, page: 1 });
    }, server ? 300 : 120);
    return () => clearTimeout(id);
  }, [JSON.stringify(draft)]);

  const setFilterNow = (key: string, value: string) => {
    const filters = { ...draft.filters, [key]: value };
    if (!value) delete filters[key];
    const next = { q: draft.q, filters };
    setDraft(next);
    lastSent.current = JSON.stringify(next);
    setQuery({ ...query, filters, page: 1 });
  };

  // Dropdown filters built from what is in the data (client mode).
  const autoOptions = useMemo(() => {
    const out: Record<string, SelectOption[]> = {};
    for (const c of columns) {
      if (c.filter !== 'auto') continue;
      const seen = new Map<string, string>();
      for (const row of rows) {
        for (const v of asList(c.filterValue ? c.filterValue(row) : valueOf(c, row))) {
          if (v === null || v === undefined || v === '') continue;
          const label = typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v);
          seen.set(String(v), label);
        }
      }
      out[c.key] = [...seen.entries()].sort((a, b) => compare(a[1], b[1]))
        .map(([value, labelText]) => ({ value, label: labelText }));
    }
    return out;
  }, [rows, columns]);

  const optionsFor = (c: Column<T>): SelectOption[] | null =>
    c.filter && typeof c.filter === 'object' ? c.filter.options : c.filter === 'auto' ? autoOptions[c.key] ?? [] : null;

  // ── Client-side work ─────────────────────────────────────────────────────
  const view = useMemo(() => {
    if (server) return { pageRows: rows, total: props.total ?? 0 };
    let list = rows;
    const needle = fold(query.q.trim());
    if (needle) {
      list = list.filter((row) => columns.some((c) => c.searchable !== false
        && asList(valueOf(c, row)).some((v) => fold(v).includes(needle))));
    }
    for (const [key, value] of Object.entries(query.filters)) {
      if (!value) continue;
      const c = columns.find((col) => col.key === key);
      if (!c) continue;
      const exact = optionsFor(c) !== null;
      const of = (row: T) => asList(c.filterValue ? c.filterValue(row) : valueOf(c, row));
      list = list.filter((row) => of(row).some((v) =>
        c.filter === 'number' ? matchesNumber(value, v)
          : exact ? String(v) === value : fold(v).includes(fold(value))));
    }
    if (query.sort) {
      const c = columns.find((col) => col.key === query.sort);
      if (c) {
        const sign = query.dir === 'desc' ? -1 : 1;
        list = [...list].sort((a, b) => {
          const va = valueOf(c, a), vb = valueOf(c, b);
          const blank = (v: unknown) => v === null || v === undefined || v === '';
          if (blank(va) || blank(vb)) return compare(va, vb); // blanks stay last either way
          return sign * compare(Array.isArray(va) ? va.length : va, Array.isArray(vb) ? vb.length : vb);
        });
      }
    }
    const start = (query.page - 1) * query.pageSize;
    return { pageRows: list.slice(start, start + query.pageSize), total: list.length };
  }, [server, rows, query, columns, autoOptions]);

  const total = view.total;
  const pages = Math.max(1, Math.ceil(total / query.pageSize));
  // A filter that shrinks the list below the current page brings you back.
  useEffect(() => {
    if (!loading && query.page > pages) setQuery({ ...query, page: pages });
  }, [pages, loading]);

  const activeFilters = Object.values(query.filters).filter(Boolean).length;
  const narrowed = activeFilters > 0 || query.q.trim() !== '';

  const sortBy = (c: Column<T>) => {
    if (c.sortable === false) return;
    if (query.sort !== c.key) setQuery({ ...query, sort: c.key, dir: 'asc', page: 1 });
    else if (query.dir === 'asc') setQuery({ ...query, dir: 'desc', page: 1 });
    else setQuery({ ...query, sort: props.initialSort?.key ?? null, dir: props.initialSort?.dir ?? 'asc', page: 1 });
  };

  const clearAll = () => {
    const next = { q: '', filters: {} };
    setDraft(next);
    lastSent.current = JSON.stringify(next);
    setQuery({ ...query, q: '', filters: {}, page: 1 });
  };

  const filterControl = (c: Column<T>, id: string) => {
    if (c.filter === false) return null;
    const options = optionsFor(c);
    if (options) {
      return (
        <SearchSelect id={id} value={query.filters[c.key] ?? ''} ariaLabel={`Filter ${c.header}`}
                      options={[{ value: '', label: `All` }, ...options]}
                      onChange={(v) => setFilterNow(c.key, v)} />
      );
    }
    return (
      <input id={id} class="dt-filter-input" value={draft.filters[c.key] ?? ''}
             placeholder={c.filter === 'number' ? 'e.g. >5' : 'Filter…'}
             title={c.filter === 'number' ? 'A number, or >5, <10, 5-10' : undefined}
             aria-label={`Filter ${c.header}`}
             onInput={(e) => {
               const value = (e.target as HTMLInputElement).value;
               const filters = { ...draft.filters, [c.key]: value };
               if (!value) delete filters[c.key];
               setDraft({ ...draft, filters });
             }} />
    );
  };

  const sortOptions: SelectOption[] = [
    { value: '', label: 'Default order' },
    ...columns.filter((c) => c.sortable !== false).flatMap((c) => [
      { value: `${c.key}:asc`, label: `${c.header} ↑` },
      { value: `${c.key}:desc`, label: `${c.header} ↓` },
    ]),
  ];

  const from = total ? (query.page - 1) * query.pageSize + 1 : 0;
  const to = Math.min(total, query.page * query.pageSize);

  return (
    <div class="dt" aria-busy={loading || undefined}>
      <div class="dt-toolbar">
        <div class="dt-search">
          <svg class="dt-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
               aria-hidden="true"><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" /></svg>
          <input value={draft.q} placeholder={searchPlaceholder} aria-label={`Search ${label}`}
                 onInput={(e) => setDraft({ ...draft, q: (e.target as HTMLInputElement).value })} />
        </div>
        <button type="button" class={`btn btn-sm${filtersOpen ? ' btn-pressed' : ''}`} aria-pressed={filtersOpen}
                onClick={() => setFiltersOpen(!filtersOpen)}>
          <Icon path="M3 5h18M6 12h12M10 19h4" size={14} /> Filters
          {activeFilters > 0 && <span class="dt-count">{activeFilters}</span>}
        </button>
        {narrowed && <button type="button" class="btn btn-sm btn-ghost" onClick={clearAll}>Clear</button>}
        <div class="dt-mobile-sort">
          <SearchSelect value={query.sort ? `${query.sort}:${query.dir}` : ''} options={sortOptions}
                        ariaLabel="Sort by" onChange={(v) => {
                          const [key, dir] = v.split(':');
                          setQuery({ ...query, sort: key || null, dir: (dir as 'asc' | 'desc') || 'asc', page: 1 });
                        }} />
        </div>
        <div class="spacer" />
        {toolbar}
      </div>

      {filtersOpen && (
        <div class="dt-filters-mobile" aria-label={`Filters for ${label}`}>
          {columns.filter((c) => c.filter !== false).map((c) => (
            <label key={c.key} class="dt-mobile-filter">
              <span>{c.header}</span>
              {filterControl(c, `dtm-${label}-${c.key}`)}
            </label>
          ))}
        </div>
      )}

      <div class="table-wrap">
        <table class="data dt-table" aria-label={label}>
          <thead>
            <tr>
              {columns.map((c) => {
                const sorted = query.sort === c.key;
                return (
                  <th key={c.key} class={c.align === 'right' ? 'num' : undefined}
                      style={c.width ? { width: c.width } : undefined}
                      aria-sort={sorted ? (query.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                    {c.sortable === false || !c.header ? c.header : (
                      <button type="button" class="dt-sort" onClick={() => sortBy(c)}
                              title={`Sort by ${c.header}`}>
                        {c.header}
                        <span class={`dt-arrow${sorted ? ' on' : ''}`} aria-hidden="true">
                          {sorted ? (query.dir === 'asc' ? '▲' : '▼') : '▲▼'}
                        </span>
                      </button>
                    )}
                  </th>
                );
              })}
            </tr>
            {filtersOpen && (
              <tr class="dt-filter-row">
                {columns.map((c) => (
                  <th key={c.key} onClick={(e) => e.stopPropagation()}>{filterControl(c, `dt-${label}-${c.key}`)}</th>
                ))}
              </tr>
            )}
          </thead>
          <tbody>
            {loading && view.pageRows.length === 0 && (
              <tr class="dt-state"><td colSpan={columns.length}><Skeleton rows={3} height={28} /></td></tr>
            )}
            {!loading && view.pageRows.length === 0 && (
              <tr class="dt-state">
                <td colSpan={columns.length}>
                  {narrowed || !empty ? (
                    <Empty title={narrowed ? 'Nothing matches' : 'Nothing here yet'}
                           action={narrowed
                             ? <button class="btn btn-sm" onClick={clearAll}>Clear search and filters</button>
                             : undefined}>
                      {narrowed ? 'Try a different search, or clear the filters.' : undefined}
                    </Empty>
                  ) : empty}
                </td>
              </tr>
            )}
            {view.pageRows.map((row) => (
              <tr key={rowKey(row)} class={[onRowClick ? 'dt-clickable' : '', rowClass?.(row) ?? ''].join(' ').trim() || undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) onRowClick(row); } : undefined}>
                {columns.map((c) => (
                  <td key={c.key} data-label={c.header} data-primary={c.primary || undefined}
                      class={c.align === 'right' ? 'num' : undefined}>
                    {c.render ? c.render(row) : String(valueOf(c, row) ?? '—')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(total > 0 || query.page > 1) && (
        <div class="dt-footer">
          <span class="text-sm text-muted" aria-live="polite">
            {loading ? 'Loading…' : `Showing ${from}–${to} of ${total}`}
          </span>
          <div class="row" style={{ gap: 6 }}>
            <span class="text-sm text-muted">Rows</span>
            <div style={{ width: 84 }}>
              <SearchSelect value={String(query.pageSize)} ariaLabel="Rows per page"
                            options={sizes.map((n) => ({ value: String(n), label: String(n) }))}
                            onChange={(v) => setQuery({ ...query, pageSize: Number(v), page: 1 })} />
            </div>
          </div>
          {pages > 1 && (
            <nav class="dt-pager" aria-label={`Pages of ${label}`}>
              <button type="button" class="btn btn-sm" disabled={query.page <= 1}
                      onClick={() => setQuery({ ...query, page: query.page - 1 })} aria-label="Previous page">
                <Icon path={ICONS.back} size={13} />
              </button>
              {pageList(query.page, pages).map((p, i) => p === '…'
                ? <span key={`gap${i}`} class="text-muted">…</span>
                : (
                  <button key={p} type="button" class={`btn btn-sm${p === query.page ? ' btn-pressed' : ''}`}
                          aria-current={p === query.page ? 'page' : undefined}
                          onClick={() => setQuery({ ...query, page: p })}>{p}</button>
                ))}
              <button type="button" class="btn btn-sm" disabled={query.page >= pages}
                      onClick={() => setQuery({ ...query, page: query.page + 1 })} aria-label="Next page">
                <span style={{ display: 'inline-flex', transform: 'scaleX(-1)' }}><Icon path={ICONS.back} size={13} /></span>
              </button>
            </nav>
          )}
        </div>
      )}
    </div>
  );
}

/** 1 … 4 5 6 … 20 */
function pageList(current: number, pages: number): Array<number | '…'> {
  const want = new Set([1, pages, current - 1, current, current + 1].filter((p) => p >= 1 && p <= pages));
  const sorted = [...want].sort((a, b) => a - b);
  const out: Array<number | '…'> = [];
  for (const p of sorted) {
    const prev = out[out.length - 1];
    if (typeof prev === 'number' && p - prev > 1) out.push('…');
    out.push(p);
  }
  return out;
}
