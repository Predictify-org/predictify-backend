import request from "supertest";
import { createApp } from "../src/index";
import * as claimService from "../src/services/claimService";

// ── Mock the claim service ────────────────────────────────────────────────
// We spread the actual module so ClaimError remains the real class and
// instanceof checks in the route handler work correctly.
jest.mock("../src/services/claimService", () => {
    const actual = jest.requireActual("../src/services/claimService");
    return {
        ...actual,
        prepareClaim: jest.fn(),
        submitClaim: jest.fn(),
    };
});

// Mock requireAuth so tests don't need a live PostgreSQL connection.
jest.mock("../src/middleware/requireAuth", () => ({
    requireAuth: (_req: any, _res: any, next: () => void) => {
        _req.user = { id: "test-user-id", stellarAddress: "GABCDEF..." };
        next();
    },
    requireAuthForbidden: (_req: any, _res: any, next: () => void) => {
        _req.user = { id: "test-user-id", stellarAddress: "GABCDEF..." };
        next();
    },
    optionalAuth: (_req: any, _res: any, next: () => void) => {
        next();
    },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrepare: any = claimService.prepareClaim;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockSubmit: any = claimService.submitClaim;

const app = createApp();

const CLAIM_ID = "0b7a5d5e-3c1f-4e0a-9d51-6d9f9a1c2b11";
const SIGNED_XDR = "AAAAAgAAAAA" + "A".repeat(40) + "==";

function postPrepare(body?: Record<string, unknown>) {
    return request(app)
        .post("/api/predictions/claim/prepare")
        .send(body ?? { marketId: "mkt_5cae97f9_0" });
}

function postClaim(body?: Record<string, unknown>) {
    return request(app)
        .post("/api/predictions/claim")
        .send(body ?? { claimId: CLAIM_ID, signedXdr: SIGNED_XDR });
}

function err(status: number, code: string) {
    return new claimService.ClaimError(status, code, `message for ${code}`);
}

beforeEach(() => {
    jest.clearAllMocks();
});

// ── POST /api/predictions/claim/prepare ───────────────────────────────────

describe("POST /api/predictions/claim/prepare", () => {
    it.each([
        ["missing marketId", {}],
        ["empty marketId", { marketId: "" }],
        ["marketId longer than 32 characters", { marketId: "a".repeat(33) }],
        ["marketId that is not a Soroban Symbol", { marketId: "mkt-1" }],
        ["marketId that is a UUID", { marketId: "0b7a5d5e-3c1f-4e0a-9d51-6d9f9a1c2b11" }],
        ["extra fields", { marketId: "mkt_1", extra: true }],
    ])("returns 400 validation_error for %s", async (_name, body) => {
        const res = await postPrepare(body as Record<string, unknown>);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("validation_error");
        expect(mockPrepare).not.toHaveBeenCalled();
    });

    it("accepts a 32-character Symbol", async () => {
        mockPrepare.mockResolvedValue({ claimId: CLAIM_ID });
        const res = await postPrepare({ marketId: "a".repeat(32) });
        expect(res.status).toBe(200);
    });

    it("returns 200 with { xdr, networkPassphrase, expiresAt, claimId }", async () => {
        const data = {
            claimId: CLAIM_ID,
            xdr: "AAAA",
            networkPassphrase: "Test SDF Network ; September 2015",
            expiresAt: "2026-10-19T12:05:00.000Z",
        };
        mockPrepare.mockResolvedValue(data);

        const res = await postPrepare();

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual(data);
        expect(mockPrepare).toHaveBeenCalledWith({
            marketId: "mkt_5cae97f9_0",
            userId: "test-user-id",
            stellarAddress: "GABCDEF...",
        });
    });

    it.each([
        [404, "market_not_found"],
        [404, "prediction_not_found"],
        [400, "market_not_resolved"],
        [400, "prediction_not_winning"],
        [409, "claim_in_progress"],
        [409, "claim_already_submitted"],
        [409, "claim_nonce_unavailable"],
        [422, "claim_simulation_failed"],
    ])("maps %i %s from the service", async (status, code) => {
        mockPrepare.mockRejectedValue(err(status, code));
        const res = await postPrepare();
        expect(res.status).toBe(status);
        expect(res.body.error.code).toBe(code);
        expect(res.body.error.message).toBe(`message for ${code}`);
    });

    it("passes unexpected errors to the global handler (no raw message in the body)", async () => {
        mockPrepare.mockRejectedValue(new Error("pg: connection refused 10.0.0.5"));
        const res = await postPrepare();
        expect(res.status).toBe(500);
        expect(JSON.stringify(res.body)).not.toContain("10.0.0.5");
    });
});

// ── POST /api/predictions/claim ───────────────────────────────────────────

describe("POST /api/predictions/claim", () => {
    it.each([
        ["missing body", {}],
        ["missing signedXdr", { claimId: CLAIM_ID }],
        ["missing claimId", { signedXdr: SIGNED_XDR }],
        ["non-uuid claimId", { claimId: "nope", signedXdr: SIGNED_XDR }],
        ["empty signedXdr", { claimId: CLAIM_ID, signedXdr: "" }],
        ["non-base64 signedXdr", { claimId: CLAIM_ID, signedXdr: "not base64!!" }],
        ["signedXdr over 16 KB", { claimId: CLAIM_ID, signedXdr: "A".repeat(16 * 1024 + 4) }],
        ["the old marketId-only body", { marketId: "mkt_1" }],
        ["extra fields", { claimId: CLAIM_ID, signedXdr: SIGNED_XDR, extra: 1 }],
    ])("returns 400 validation_error for %s", async (_name, body) => {
        const res = await postClaim(body as Record<string, unknown>);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("validation_error");
        expect(mockSubmit).not.toHaveBeenCalled();
    });

    it("accepts a signedXdr of exactly 16 KB", async () => {
        mockSubmit.mockResolvedValue({ claimId: CLAIM_ID });
        const res = await postClaim({ claimId: CLAIM_ID, signedXdr: "A".repeat(16 * 1024) });
        expect(res.status).toBe(200);
    });

    it("returns 200 with the submit result", async () => {
        const data = {
            claimId: CLAIM_ID,
            status: "paid",
            predictionId: "pred-1",
            result: "won",
            claimTxHash: "deadbeef",
            claimedAt: "2026-10-19T12:00:00.000Z",
        };
        mockSubmit.mockResolvedValue(data);

        const res = await postClaim();

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual(data);
        expect(mockSubmit).toHaveBeenCalledWith({
            claimId: CLAIM_ID,
            signedXdr: SIGNED_XDR,
            userId: "test-user-id",
            stellarAddress: "GABCDEF...",
        });
    });

    it("replaying a submit for a paid claim returns 200 with the same settlement tx", async () => {
        const data = { claimId: CLAIM_ID, status: "paid", claimTxHash: "deadbeef" };
        mockSubmit.mockResolvedValue(data);

        const res1 = await postClaim();
        const res2 = await postClaim();

        expect(res1.status).toBe(200);
        expect(res2.status).toBe(200);
        expect(res2.body.data.claimTxHash).toBe(res1.body.data.claimTxHash);
        expect(mockSubmit).toHaveBeenCalledTimes(2);
    });

    it.each([
        [404, "claim_not_found"],
        [400, "claim_xdr_mismatch"],
        [409, "claim_expired"],
        [409, "claim_in_progress"],
        [409, "claim_rejected"],
        [422, "claim_rejected"],
        [503, "claim_rpc_unavailable"],
    ])("maps %i %s from the service", async (status, code) => {
        mockSubmit.mockRejectedValue(err(status, code));
        const res = await postClaim();
        expect(res.status).toBe(status);
        expect(res.body.error.code).toBe(code);
    });

    it("never echoes the underlying SDK error from ClaimError.detail", async () => {
        mockSubmit.mockRejectedValue(
            new claimService.ClaimError(422, "claim_rejected", "Claim transaction was rejected", {
                sdk: "HostError: Error(Contract, #12) secret",
            }),
        );
        const res = await postClaim();
        expect(res.status).toBe(422);
        expect(JSON.stringify(res.body)).not.toMatch(/HostError|secret/);
    });
});
