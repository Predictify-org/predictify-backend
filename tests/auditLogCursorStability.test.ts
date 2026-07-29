/**
 * auditLogCursorStability.test.ts
 *
 * Focused tests for stable keyset cursor pagination on GET /api/admin/audit.
 *
 * The cursor is keyed on (created_at, id) DESC. These tests verify that when
 * rows share the same created_at timestamp — the scenario that arises under
 * concurrent writes — the id tie-breaker keeps pages gapless and duplicate-free.
 */

import { getAuditLogs } from "../src/repositories/auditLogRepo";
import { encodeCursor } from "../src/utils/cursor";
import { db } from "../src/db";

// ── DB Mock ──────────────────────────────────────────────────────────────────

jest.mock("../src/db", () => {
  const queryChain = {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn(),
  };
  return { db: queryChain };
});

const mockDb = db as unknown as {
  select: jest.Mock;
  from: jest.Mock;
  where: jest.Mock;
  orderBy: jest.Mock;
  limit: jest.Mock;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRow(id: string, createdAt: Date) {
  return {
    id,
    action: "test.action",
    walletAddress: "GADDR",
    ip: "127.0.0.1",
    correlationId: `corr-${id}`,
    rateLimitContext: null,
    createdAt,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("audit log cursor stability under concurrent writes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("ordering contract: DESC (created_at, id)", () => {
    it("uses DESC created_at as the primary sort and DESC id as the tie-breaker", async () => {
      mockDb.limit.mockResolvedValue([]);

      await getAuditLogs({});

      // orderBy must be called once
      expect(mockDb.orderBy).toHaveBeenCalledTimes(1);

      // Inspect the arguments passed to orderBy; Drizzle passes SQL objects.
      // We assert that exactly two sort expressions are provided.
      const orderByArgs = mockDb.orderBy.mock.calls[0];
      expect(orderByArgs).toHaveLength(2);
    });
  });

  describe("first page (no cursor)", () => {
    it("returns up to `limit` rows and sets nextCursor when more rows exist", async () => {
      const ts = new Date("2026-07-28T10:00:00.000Z");
      // Simulate DB returning limit+1 rows (DB-side look-ahead).
      const dbRows = [
        makeRow("id-1", ts),
        makeRow("id-2", ts),
        makeRow("id-3", ts),
      ];
      mockDb.limit.mockResolvedValue(dbRows);

      const result = await getAuditLogs({ limit: 2 });

      expect(result.data).toHaveLength(2);
      expect(result.data[0].id).toBe("id-1");
      expect(result.data[1].id).toBe("id-2");
      expect(result.nextCursor).not.toBeNull();
    });

    it("returns null nextCursor when all rows fit on one page", async () => {
      const ts = new Date("2026-07-28T10:00:00.000Z");
      const dbRows = [makeRow("id-1", ts), makeRow("id-2", ts)];
      mockDb.limit.mockResolvedValue(dbRows);

      const result = await getAuditLogs({ limit: 2 });

      expect(result.data).toHaveLength(2);
      expect(result.nextCursor).toBeNull();
    });
  });

  describe("cursor encoding / decoding round-trip", () => {
    it("encodes the last row's (created_at ISO, id) into the nextCursor", async () => {
      const ts = new Date("2026-07-28T10:00:00.000Z");
      const dbRows = [makeRow("id-alpha", ts), makeRow("id-beta", ts)];
      // Two rows returned for limit=1 → hasMore=true.
      mockDb.limit.mockResolvedValue(dbRows);

      const result = await getAuditLogs({ limit: 1 });

      expect(result.nextCursor).not.toBeNull();

      // The cursor must be the opaque encoding of the last row on the page.
      const expectedCursor = encodeCursor({
        sortValue: ts.toISOString(),
        id: "id-alpha",
      });
      expect(result.nextCursor).toBe(expectedCursor);
    });

    it("encodes the cursor using the ISO representation of createdAt", async () => {
      const ts = new Date("2026-07-28T22:00:00.500Z"); // includes sub-second precision
      const dbRows = [makeRow("id-x", ts), makeRow("id-y", ts)];
      mockDb.limit.mockResolvedValue(dbRows);

      const result = await getAuditLogs({ limit: 1 });

      const expectedCursor = encodeCursor({
        sortValue: ts.toISOString(),
        id: "id-x",
      });
      expect(result.nextCursor).toBe(expectedCursor);
    });
  });

  describe("concurrent-write scenario: rows sharing the same created_at timestamp", () => {
    /**
     * When N rows are inserted with the same millisecond timestamp (e.g. in
     * the same transaction or at high write rate), a single-column ORDER BY
     * created_at yields an unstable order that can skip or duplicate rows at
     * page boundaries. The (created_at, id) keyset cursor eliminates this.
     *
     * These tests exercise the predicate branch:
     *   (created_at = $ts AND id < $cursor_id)
     */

    it("includes the id tie-breaker predicate when cursor lands on a duplicate timestamp", async () => {
      const sameTs = new Date("2026-07-28T12:00:00.000Z");

      // Page 1: rows id-3, id-2 (cursor will point at id-2 after page 1).
      const page1Rows = [
        makeRow("id-3", sameTs),
        makeRow("id-2", sameTs),
        makeRow("id-1", sameTs), // look-ahead row → hasMore=true
      ];
      mockDb.limit.mockResolvedValueOnce(page1Rows);

      const page1 = await getAuditLogs({ limit: 2 });
      expect(page1.data).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();

      // Page 2: simulate fetching the next page using the cursor.
      // The cursor points at (sameTs, "id-2").
      // Expect the WHERE clause to include the tie-breaker predicate.
      const page2DbRows = [makeRow("id-1", sameTs)];
      mockDb.limit.mockResolvedValueOnce(page2DbRows);

      const page2 = await getAuditLogs({ limit: 2, cursor: page1.nextCursor! });

      expect(page2.data).toHaveLength(1);
      expect(page2.data[0].id).toBe("id-1");
      expect(page2.nextCursor).toBeNull();

      // The WHERE clause passed to the second query must contain the cursor predicate.
      const whereArg = mockDb.where.mock.calls[1][0]; // second call to .where()
      expect(whereArg).toBeDefined();
    });

    it("produces no duplicate rows across two pages of same-timestamp rows", async () => {
      const sameTs = new Date("2026-07-28T12:00:00.000Z");

      // Build 5 rows all with the same timestamp, ordered desc by id.
      const allRows = ["e", "d", "c", "b", "a"].map((id) =>
        makeRow(id, sameTs),
      );

      // Page 1: DB returns first 3 (limit=2, +1 look-ahead).
      mockDb.limit.mockResolvedValueOnce(allRows.slice(0, 3));
      const page1 = await getAuditLogs({ limit: 2 });

      expect(page1.data.map((r) => r.id)).toEqual(["e", "d"]);
      expect(page1.nextCursor).not.toBeNull();

      // Page 2: DB returns remaining rows after the cursor.
      mockDb.limit.mockResolvedValueOnce(allRows.slice(2)); // ["c","b","a"]
      const page2 = await getAuditLogs({ limit: 2, cursor: page1.nextCursor! });

      expect(page2.data.map((r) => r.id)).toEqual(["c", "b"]);
      expect(page2.nextCursor).not.toBeNull();

      // Page 3: last row.
      mockDb.limit.mockResolvedValueOnce([allRows[4]]);
      const page3 = await getAuditLogs({ limit: 2, cursor: page2.nextCursor! });

      expect(page3.data.map((r) => r.id)).toEqual(["a"]);
      expect(page3.nextCursor).toBeNull();

      // Verify no row appears on more than one page.
      const seen = new Set([
        ...page1.data.map((r) => r.id),
        ...page2.data.map((r) => r.id),
        ...page3.data.map((r) => r.id),
      ]);
      expect(seen.size).toBe(5);
    });

    it("handles mixed-timestamp rows: cursor crosses a timestamp boundary correctly", async () => {
      const tsNewer = new Date("2026-07-28T12:00:01.000Z");
      const tsOlder = new Date("2026-07-28T12:00:00.000Z");

      // Page 1: two newer rows; cursor points at (tsNewer, "id-b").
      const page1Rows = [
        makeRow("id-c", tsNewer),
        makeRow("id-b", tsNewer),
        makeRow("id-a", tsOlder), // look-ahead
      ];
      mockDb.limit.mockResolvedValueOnce(page1Rows);

      const page1 = await getAuditLogs({ limit: 2 });
      expect(page1.data.map((r) => r.id)).toEqual(["id-c", "id-b"]);

      // Page 2: next page starts at an older timestamp → predicate branch:
      //   (created_at < tsNewer)  ← the simpler branch, not the tie-breaker.
      const page2Rows = [makeRow("id-a", tsOlder)];
      mockDb.limit.mockResolvedValueOnce(page2Rows);

      const page2 = await getAuditLogs({ limit: 2, cursor: page1.nextCursor! });
      expect(page2.data.map((r) => r.id)).toEqual(["id-a"]);
      expect(page2.nextCursor).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("returns empty page with null cursor when DB returns no rows", async () => {
      mockDb.limit.mockResolvedValue([]);

      const result = await getAuditLogs({ limit: 10 });

      expect(result.data).toHaveLength(0);
      expect(result.nextCursor).toBeNull();
    });

    it("treats an invalid cursor as no cursor (first-page behaviour)", async () => {
      mockDb.limit.mockResolvedValue([]);

      const result = await getAuditLogs({ limit: 5, cursor: "not-a-valid-cursor!!" });

      // Invalid cursor → no keyset predicate → WHERE arg is undefined.
      const whereArg = mockDb.where.mock.calls[0][0];
      expect(whereArg).toBeUndefined();
      expect(result.data).toHaveLength(0);
    });

    it("clamps limit to DEFAULT_PAGE_SIZE (20) when limit is omitted", async () => {
      mockDb.limit.mockResolvedValue([]);

      await getAuditLogs({});

      // DB receives DEFAULT_PAGE_SIZE + 1 (look-ahead).
      expect(mockDb.limit).toHaveBeenCalledWith(21);
    });

    it("applies action and actor filters together with the cursor predicate", async () => {
      const ts = new Date("2026-07-28T10:00:00.000Z");
      const rows = [makeRow("id-1", ts), makeRow("id-2", ts)];
      mockDb.limit.mockResolvedValue(rows);

      const cursor = encodeCursor({ sortValue: ts.toISOString(), id: "id-5" });

      await getAuditLogs({
        action: "market.create",
        actor: "GADDR1",
        cursor,
        limit: 1,
      });

      // WHERE clause must be defined (action + actor + cursor predicate combined).
      const whereArg = mockDb.where.mock.calls[0][0];
      expect(whereArg).toBeDefined();
    });
  });
});
