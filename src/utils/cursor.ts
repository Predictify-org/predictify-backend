/**
 * Shared keyset (cursor) pagination helper.
 *
 * Keyset pagination is preferred over OFFSET/LIMIT for operator-facing listings:
 * it stays correct and fast even as rows are inserted/removed between page loads,
 * which matters for a DLQ that is actively being written to and drained.
 *
 * A cursor encodes the sort key of the last row on the previous page. Callers
 * sort by a stable, unique composite `(sortValue, id)` and ask for rows strictly
 * "after" the cursor. We expose generic encode/decode helpers plus a small
 * `paginate` utility that slices an already-sorted, already-filtered array — the
 * in-memory store uses it directly, and the drizzle store uses
 * `decodeCursor` to build its WHERE clause.
 */

export interface CursorKey {
  /** ISO timestamp (or any lexicographically-ordered string) of the sort column. */
  sortValue: string;
  /** Tie-breaker, unique per row. */
  id: string;
}

export interface Page<T> {
  data: T[];
  /** Opaque cursor to pass as `?cursor=` for the next page, or null if last page. */
  nextCursor: string | null;
  /** Optional total count of items matching the query (may be omitted when expensive to compute). */
  total?: number;
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/**
 * Cursor wire-format version. Bump this whenever the meaning of the encoded
 * `(sortValue, id)` pair changes (e.g. a schema migration that re-types or
 * re-orders the sort columns). Cursors minted under a different version are
 * rejected by `decodeCursor` (treated as invalid → restart from page one)
 * instead of being silently re-interpreted, which previously let the keyset
 * predicate advance to the wrong offset after a migration.
 */
export const CURSOR_VERSION = "v1";

/** Clamp a user-supplied limit into a safe range. */
export function clampLimit(raw: unknown, fallback = DEFAULT_PAGE_SIZE): number {
  const n = typeof raw === "string" ? parseInt(raw, 10) : typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), MAX_PAGE_SIZE);
}

/**
 * Encode a cursor key to an opaque, URL-safe string.
 *
 * Wire format (after base64url decode):
 *   `<version>|<sortValueLen>|<sortValue><id>`
 *
 * Length-prefixing the sortValue field means neither sortValue nor id need to
 * be pipe-free. The id follows immediately after the sortValue bytes with no
 * delimiter so any character — including `|` — is preserved verbatim.
 */
export function encodeCursor(key: CursorKey): string {
  const svLen = Buffer.byteLength(key.sortValue, "utf8");
  return Buffer.from(
    `${CURSOR_VERSION}|${svLen}|${key.sortValue}${key.id}`,
    "utf8",
  ).toString("base64url");
}

/**
 * Decode an opaque cursor. Returns null for missing/invalid cursors rather than
 * throwing, so a tampered `?cursor=` value simply starts from the first page
 * instead of 500-ing.
 */
export function decodeCursor(raw: unknown): CursorKey | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    // Versioned format: "<version>|<sortValueLen>|<sortValue><id>".
    // The version guards against re-interpreting a cursor whose encoding
    // changed across a schema migration.
    const firstSep = decoded.indexOf("|");
    if (firstSep === -1) return null;
    const version = decoded.slice(0, firstSep);
    if (version !== CURSOR_VERSION) return null;

    const rest = decoded.slice(firstSep + 1); // "<sortValueLen>|<sortValue><id>"
    const secondSep = rest.indexOf("|");
    if (secondSep === -1) return null;
    const svLenStr = rest.slice(0, secondSep);
    const svLen = parseInt(svLenStr, 10);
    if (!Number.isFinite(svLen) || svLen < 0) return null;

    const payload = rest.slice(secondSep + 1); // "<sortValue><id>"
    // Use the byte-length to slice the sortValue — works even when sortValue
    // contains multi-byte UTF-8 characters or pipe characters.
    const buf = Buffer.from(payload, "utf8");
    if (buf.byteLength < svLen) return null;
    const sortValue = buf.slice(0, svLen).toString("utf8");
    const id = buf.slice(svLen).toString("utf8");
    if (!sortValue || !id) return null;
    return { sortValue, id };
  } catch {
    return null;
  }
}

/** True when `row` sorts strictly after `cursor` under DESC `(sortValue, id)` ordering. */
export function isAfter(cursor: CursorKey, row: CursorKey): boolean {
  if (row.sortValue !== cursor.sortValue) return row.sortValue < cursor.sortValue;
  return row.id < cursor.id;
}

/**
 * Slice an already-sorted (DESC by sortValue then id) array into one page.
 * Used by the in-memory store; the drizzle store pushes the same logic into SQL.
 */
export function paginate<T>(
  rowsSortedDesc: T[],
  toKey: (row: T) => CursorKey,
  rawCursor: unknown,
  rawLimit: unknown,
): Page<T> {
  const limit = clampLimit(rawLimit);
  const cursor = decodeCursor(rawCursor);

  const start = cursor
    ? rowsSortedDesc.findIndex((r) => isAfter(cursor, toKey(r)))
    : 0;
  const from = start === -1 ? rowsSortedDesc.length : start;

  const slice = rowsSortedDesc.slice(from, from + limit);
  const hasMore = from + limit < rowsSortedDesc.length;
  const last = slice[slice.length - 1];
  return {
    data: slice,
    nextCursor: hasMore && last ? encodeCursor(toKey(last)) : null,
  };
}
