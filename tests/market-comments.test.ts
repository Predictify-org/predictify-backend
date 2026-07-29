import express from "express";
import request from "supertest";
import { correlationMiddleware } from "../src/middleware/correlation";
import { commentsRouter } from "../src/routes/comments";
import { listMarketComments } from "../src/services/marketCommentsService";

// Mock the entire service module so we never hit the real DB.
jest.mock("../src/services/marketCommentsService", () => ({
    listMarketComments: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockListMarketComments = listMarketComments as any;

const ALLOWED_ORIGIN = "http://localhost:5173";

function getTestApp() {
    const app = express();
    app.use(express.json());
    app.use(correlationMiddleware);
    app.use("/api/markets", commentsRouter);
    return app;
}

type CommentRow = {
    id: string;
    marketId: string;
    authorId: string | null;
    authorAddress: string | null;
    body: string;
    moderationFlagged: boolean;
    moderationReason: string | null;
    createdAt: Date;
};

function makePage(
    rows: CommentRow[],
    nextCursor: string | null = null,
): { data: CommentRow[]; nextCursor: string | null } {
    return { data: rows, nextCursor };
}

describe("GET /api/markets/:id/comments", () => {
    afterEach(() => {
        jest.resetAllMocks();
    });

    // ── Basic pagination ──────────────────────────────────────────────────

    it("returns seeded comments and nextCursor with limit=1 (has more)", async () => {
        mockListMarketComments.mockResolvedValueOnce(
            makePage(
                [
                    {
                        id: "c-2",
                        marketId: "m-1",
                        authorId: null,
                        authorAddress: null,
                        body: "world",
                        moderationFlagged: false,
                        moderationReason: null,
                        createdAt: new Date("2026-07-01T00:00:00.000Z"),
                    },
                ],
                "next-cursor-abc",
            ),
        );

        const res = await request(getTestApp())
            .get("/api/markets/m-1/comments?limit=1")
            .set("Origin", ALLOWED_ORIGIN);

        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.nextCursor).toEqual(expect.any(String));
        expect(res.body.data[0]).toMatchObject({ id: "c-2", body: "world" });
    });

    it("returns nextCursor=null at end of list", async () => {
        mockListMarketComments.mockResolvedValueOnce(
            makePage([
                {
                    id: "c-1",
                    marketId: "m-1",
                    authorId: null,
                    authorAddress: null,
                    body: "hello",
                    moderationFlagged: false,
                    moderationReason: null,
                    createdAt: new Date("2026-07-01T00:00:01.000Z"),
                },
            ]),
        );

        const res = await request(getTestApp())
            .get("/api/markets/m-1/comments?limit=5")
            .set("Origin", ALLOWED_ORIGIN);

        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.nextCursor).toBeNull();
    });

    // ── Cursor follow-through ─────────────────────────────────────────────

    it("passes the cursor parameter to the service", async () => {
        mockListMarketComments.mockResolvedValueOnce(
            makePage([
                {
                    id: "c-4",
                    marketId: "m-1",
                    authorId: null,
                    authorAddress: null,
                    body: "delta",
                    moderationFlagged: false,
                    moderationReason: null,
                    createdAt: new Date("2026-07-02T00:00:00.000Z"),
                },
            ]),
        );

        await request(getTestApp())
            .get("/api/markets/m-1/comments?cursor=someBase64Cursor&limit=10")
            .set("Origin", ALLOWED_ORIGIN);

        expect(mockListMarketComments).toHaveBeenCalledWith(
            "m-1",
            "someBase64Cursor",
            10,
        );
    });

    // ── Market scoping ────────────────────────────────────────────────────

    it("passes the marketId to the service", async () => {
        mockListMarketComments.mockResolvedValueOnce(makePage([]));

        await request(getTestApp())
            .get("/api/markets/m-42/comments")
            .set("Origin", ALLOWED_ORIGIN);

        expect(mockListMarketComments).toHaveBeenCalledWith(
            "m-42",
            undefined,
            undefined,
        );
    });

    // ── Empty result set ──────────────────────────────────────────────────

    it("returns empty data array with nextCursor=null when no comments exist", async () => {
        mockListMarketComments.mockResolvedValueOnce(makePage([]));

        const res = await request(getTestApp())
            .get("/api/markets/m-ghost/comments")
            .set("Origin", ALLOWED_ORIGIN);

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([]);
        expect(res.body.nextCursor).toBeNull();
    });

    // ── Moderation flag fields ────────────────────────────────────────────

    it("returns moderation fields in the response", async () => {
        mockListMarketComments.mockResolvedValueOnce(
            makePage([
                {
                    id: "c-mod",
                    marketId: "m-1",
                    authorId: null,
                    authorAddress: null,
                    body: "flagged content",
                    moderationFlagged: true,
                    moderationReason: "spam",
                    createdAt: new Date("2026-07-01T00:00:00.000Z"),
                },
            ]),
        );

        const res = await request(getTestApp())
            .get("/api/markets/m-1/comments")
            .set("Origin", ALLOWED_ORIGIN);

        expect(res.status).toBe(200);
        expect(res.body.data[0]).toMatchObject({
            moderationFlagged: true,
            moderationReason: "spam",
        });
    });

    // ── Author fields ─────────────────────────────────────────────────────

    it("returns author fields (authorId, authorAddress) when present", async () => {
        mockListMarketComments.mockResolvedValueOnce(
            makePage([
                {
                    id: "c-auth",
                    marketId: "m-1",
                    authorId: "00000000-0000-0000-0000-000000000001",
                    authorAddress: "GABCDEF123456789012345678901234567890123456",
                    body: "signed comment",
                    moderationFlagged: false,
                    moderationReason: null,
                    createdAt: new Date("2026-07-01T00:00:00.000Z"),
                },
            ]),
        );

        const res = await request(getTestApp())
            .get("/api/markets/m-1/comments")
            .set("Origin", ALLOWED_ORIGIN);

        expect(res.status).toBe(200);
        expect(res.body.data[0]).toMatchObject({
            authorId: "00000000-0000-0000-0000-000000000001",
            authorAddress: "GABCDEF123456789012345678901234567890123456",
        });
    });

    // ── Validation / edge cases ───────────────────────────────────────────

    it("rejects invalid pagination query (limit=0)", async () => {
        const res = await request(getTestApp())
            .get("/api/markets/m-1/comments?limit=0")
            .set("Origin", ALLOWED_ORIGIN);

        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            error: {
                code: "validation_error",
                details: expect.any(Array),
            },
        });
    });

    it("rejects invalid pagination query (negative limit)", async () => {
        const res = await request(getTestApp())
            .get("/api/markets/m-1/comments?limit=-5")
            .set("Origin", ALLOWED_ORIGIN);

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("validation_error");
    });

    it("rejects invalid pagination query (string non-numeric limit)", async () => {
        const res = await request(getTestApp())
            .get("/api/markets/m-1/comments?limit=abc")
            .set("Origin", ALLOWED_ORIGIN);

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("validation_error");
    });

    it("rejects extra unknown query parameters", async () => {
        const res = await request(getTestApp())
            .get("/api/markets/m-1/comments?limit=10&unknownParam=evil")
            .set("Origin", ALLOWED_ORIGIN);

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("validation_error");
    });

    it("returns 200 with limit=1 and follows cursor to next page", async () => {
        mockListMarketComments
            .mockResolvedValueOnce(
                makePage(
                    [
                        {
                            id: "c-3",
                            marketId: "m-1",
                            authorId: null,
                            authorAddress: null,
                            body: "one",
                            moderationFlagged: false,
                            moderationReason: null,
                            createdAt: new Date("2026-07-01T00:00:02.000Z"),
                        },
                    ],
                    "cursor-for-page-2",
                ),
            )
            .mockResolvedValueOnce(
                makePage([
                    {
                        id: "c-2",
                        marketId: "m-1",
                        authorId: null,
                        authorAddress: null,
                        body: "two",
                        moderationFlagged: false,
                        moderationReason: null,
                        createdAt: new Date("2026-07-01T00:00:01.000Z"),
                    },
                ]),
            );

        const res = await request(getTestApp())
            .get("/api/markets/m-1/comments?limit=1")
            .set("Origin", ALLOWED_ORIGIN);

        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.nextCursor).toEqual(expect.any(String));

        // Follow the cursor
        const cursor = res.body.nextCursor;
        const res2 = await request(getTestApp())
            .get(`/api/markets/m-1/comments?limit=1&cursor=${cursor}`)
            .set("Origin", ALLOWED_ORIGIN);

        expect(res2.status).toBe(200);
        expect(res2.body.data).toHaveLength(1);
        expect(res2.body.data[0]).toMatchObject({ id: "c-2", body: "two" });
    });

    it("handles tampered cursor gracefully (falls back to first page)", async () => {
        mockListMarketComments.mockResolvedValueOnce(
            makePage([
                {
                    id: "c-first",
                    marketId: "m-1",
                    authorId: null,
                    authorAddress: null,
                    body: "first page",
                    moderationFlagged: false,
                    moderationReason: null,
                    createdAt: new Date("2026-07-01T00:00:00.000Z"),
                },
            ]),
        );

        const res = await request(getTestApp())
            .get("/api/markets/m-1/comments?cursor=!!!invalid!!!&limit=10")
            .set("Origin", ALLOWED_ORIGIN);

        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
        expect(mockListMarketComments).toHaveBeenCalledWith(
            "m-1",
            "!!!invalid!!!",
            10,
        );
    });
});
