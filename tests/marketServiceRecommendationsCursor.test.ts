/* eslint-disable @typescript-eslint/no-explicit-any */

import { encodeCursor, decodeCursor } from "../src/utils/cursor";

describe("recommendations cursor pagination", () => {
    it("encodes both createdAt and id into the cursor", () => {
        const cursor = encodeCursor({
            sortValue: "2026-07-29T12:00:00.000Z",
            id: "market-123",
        });

        const decoded = decodeCursor(cursor);

        expect(decoded).toEqual({
            sortValue: "2026-07-29T12:00:00.000Z",
            id: "market-123",
        });
    });

    it("preserves identical timestamps using id as tie breaker", () => {
        const firstCursor = encodeCursor({
            sortValue: "2026-07-29T12:00:00.000Z",
            id: "market-z",
        });

        const secondCursor = encodeCursor({
            sortValue: "2026-07-29T12:00:00.000Z",
            id: "market-a",
        });

        const first = decodeCursor(firstCursor);
        const second = decodeCursor(secondCursor);

        expect(first?.sortValue).toBe(second?.sortValue);

        expect(first?.id).toBe("market-z");
        expect(second?.id).toBe("market-a");
    });

    it("returns null for invalid cursors", () => {
        expect(decodeCursor("invalid-cursor")).toBeNull();
    });

    it("returns null for version mismatches", () => {
        const invalidVersion = Buffer.from(
            "v999|24|2026-07-29T12:00:00.000Zmarket-1",
            "utf8",
        ).toString("base64url");

        expect(decodeCursor(invalidVersion)).toBeNull();
    });
});