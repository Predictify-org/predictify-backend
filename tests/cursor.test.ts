/**
 * Tests for the shared keyset cursor helper, focusing on the versioned wire
 * format that keeps pagination correct across schema migrations.
 */
import {
  CURSOR_VERSION,
  decodeCursor,
  encodeCursor,
  isAfter,
  paginate,
  type CursorKey,
} from "../src/utils/cursor";

describe("cursor encode/decode", () => {
  const key: CursorKey = { sortValue: "2026-06-27T12:00:00.000Z", id: "abc-123" };

  it("round-trips a cursor key", () => {
    expect(decodeCursor(encodeCursor(key))).toEqual(key);
  });

  it("embeds the current cursor version in the encoded value", () => {
    const decoded = Buffer.from(encodeCursor(key), "base64url").toString("utf8");
    expect(decoded.startsWith(`${CURSOR_VERSION}|`)).toBe(true);
  });

  it("rejects a cursor minted under a different (legacy/migrated) version", () => {
    // A pre-versioning cursor "<sortValue>|<id>" must not be re-interpreted.
    const legacy = Buffer.from(`${key.sortValue}|${key.id}`, "utf8").toString("base64url");
    expect(decodeCursor(legacy)).toBeNull();

    const otherVersion = Buffer.from(
      `v0|${key.sortValue}|${key.id}`,
      "utf8",
    ).toString("base64url");
    expect(decodeCursor(otherVersion)).toBeNull();
  });

  it("returns null for missing, empty, or malformed cursors", () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor(123)).toBeNull();
    expect(decodeCursor(encodeCursor({ ...key, id: "" }))).toBeNull();
  });

  it("preserves sortValues that themselves contain a separator", () => {
    const weird: CursorKey = { sortValue: "a|b|c", id: "id|1" };
    expect(decodeCursor(encodeCursor(weird))).toEqual(weird);
  });
});

describe("decodeCursor — malformed input", () => {
  it("returns null when base64url decodes to garbage with no separator", () => {
    const garbage = Buffer.from("not-a-valid-cursor-format", "utf8").toString("base64url");
    expect(decodeCursor(garbage)).toBeNull();
  });

  it("returns null when sortValueLen is not a finite number", () => {
    const bad = Buffer.from("v1|notanumber|somevalueid", "utf8").toString("base64url");
    expect(decodeCursor(bad)).toBeNull();
  });

  it("returns null when payload is shorter than the declared sortValue length", () => {
    const bad = Buffer.from("v1|100|short", "utf8").toString("base64url");
    expect(decodeCursor(bad)).toBeNull();
  });
});

describe("isAfter", () => {
  it("returns true when row.sortValue is strictly less than cursor.sortValue (DESC order)", () => {
    const cursor: CursorKey = { sortValue: "2026-06-27T12:00:00.000Z", id: "b" };
    const row: CursorKey = { sortValue: "2026-06-26T12:00:00.000Z", id: "a" };
    expect(isAfter(cursor, row)).toBe(true);
  });

  it("returns false when row.sortValue is strictly greater than cursor.sortValue", () => {
    const cursor: CursorKey = { sortValue: "2026-06-27T12:00:00.000Z", id: "b" };
    const row: CursorKey = { sortValue: "2026-06-28T12:00:00.000Z", id: "a" };
    expect(isAfter(cursor, row)).toBe(false);
  });

  it("uses id as tie-breaker when sortValue is equal", () => {
    const cursor: CursorKey = { sortValue: "2026-06-27T12:00:00.000Z", id: "m" };
    const tieWinner: CursorKey = { sortValue: "2026-06-27T12:00:00.000Z", id: "a" };
    const tieLoser: CursorKey = { sortValue: "2026-06-27T12:00:00.000Z", id: "z" };
    expect(isAfter(cursor, tieWinner)).toBe(true);
    expect(isAfter(cursor, tieLoser)).toBe(false);
  });
});

describe("paginate", () => {
  interface Row {
    sortValue: string;
    id: string;
  }
  const toKey = (r: Row): CursorKey => r;

  const rows: Row[] = [
    { sortValue: "2026-06-30T00:00:00.000Z", id: "e" },
    { sortValue: "2026-06-29T00:00:00.000Z", id: "d" },
    { sortValue: "2026-06-28T00:00:00.000Z", id: "c" },
    { sortValue: "2026-06-27T00:00:00.000Z", id: "b" },
    { sortValue: "2026-06-26T00:00:00.000Z", id: "a" },
  ];

  it("returns the first page and a nextCursor when more rows remain", () => {
    const page = paginate(rows, toKey, undefined, 2);
    expect(page.data).toEqual(rows.slice(0, 2));
    expect(page.nextCursor).not.toBeNull();
  });

  it("returns nextCursor = null on the last page", () => {
    const page = paginate(rows, toKey, undefined, 10);
    expect(page.data).toEqual(rows);
    expect(page.nextCursor).toBeNull();
  });

  it("advances correctly using a cursor from a prior page", () => {
    const first = paginate(rows, toKey, undefined, 2);
    const second = paginate(rows, toKey, first.nextCursor ?? undefined, 2);
    expect(second.data).toEqual(rows.slice(2, 4));
  });

  it("restarts from the beginning when the cursor doesn't match any row (findIndex = -1)", () => {
    const staleCursor = encodeCursor({ sortValue: "1999-01-01T00:00:00.000Z", id: "zzz" });
    const page = paginate(rows, toKey, staleCursor, 2);
    expect(page.data).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it("returns an empty page for an empty input array", () => {
    const page = paginate([], toKey, undefined, 20);
    expect(page.data).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});
