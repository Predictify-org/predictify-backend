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
        claimWinnings: jest.fn(),
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

// Helper to get the mocked function
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockClaimWinnings: any = claimService.claimWinnings;

const app = createApp();

function postClaim(body?: Record<string, unknown>) {
    return request(app)
        .post("/api/predictions/claim")
        .send(body ?? { marketId: "mkt-1" });
}

beforeEach(() => {
    jest.clearAllMocks();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("POST /api/predictions/claim", () => {
    // ── Validation ────────────────────────────────────────────────────────

    it("returns 400 for missing marketId", async () => {
        const res = await postClaim({});

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("validation_error");
    });

    it("returns 400 for empty marketId", async () => {
        const res = await postClaim({ marketId: "" });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("validation_error");
    });

    it("rejects extra fields in the body", async () => {
        const res = await postClaim({
            marketId: "mkt-1",
            extraField: "should not be allowed",
        });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("validation_error");
    });

    // ── Business rules ────────────────────────────────────────────────────

    it("returns 404 when market does not exist", async () => {
        mockClaimWinnings.mockRejectedValue(
            new claimService.ClaimError(404, "market_not_found", "Market not found"),
        );

        const res = await postClaim();

        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe("market_not_found");
    });

    it("returns 404 when user has no prediction in the market", async () => {
        mockClaimWinnings.mockRejectedValue(
            new claimService.ClaimError(
                404,
                "prediction_not_found",
                "No prediction found for this user and market",
            ),
        );

        const res = await postClaim();

        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe("prediction_not_found");
    });

    it("returns 400 when market is not resolved", async () => {
        mockClaimWinnings.mockRejectedValue(
            new claimService.ClaimError(
                400,
                "market_not_resolved",
                "Market must be resolved before claims can be processed",
            ),
        );

        const res = await postClaim();

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("market_not_resolved");
    });

    it("returns 400 when prediction is not a winner", async () => {
        mockClaimWinnings.mockRejectedValue(
            new claimService.ClaimError(
                400,
                "prediction_not_winning",
                'Prediction result is "lost". Only winning predictions can be claimed',
            ),
        );

        const res = await postClaim();

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("prediction_not_winning");
    });

    it("returns 500 when Soroban tx submission fails", async () => {
        mockClaimWinnings.mockRejectedValue(
            new claimService.ClaimError(
                500,
                "claim_tx_failed",
                "Failed to submit claim transaction: RPC error",
            ),
        );

        const res = await postClaim();

        expect(res.status).toBe(500);
        expect(res.body.error.code).toBe("claim_tx_failed");
    });

    // ── Success paths ─────────────────────────────────────────────────────

    it("returns 200 with claim result on successful claim", async () => {
        const fakeResult: claimService.ClaimResult = {
            predictionId: "pred-1",
            result: "won",
            claimTxHash: "0xdeadbeef1234567890abcdef",
            claimedAt: "2025-01-01T00:00:00.000Z",
        };
        mockClaimWinnings.mockResolvedValue(fakeResult);

        const res = await postClaim();

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual(fakeResult);
    });

    it("returns 200 for already claimed prediction (idempotent)", async () => {
        const fakeResult: claimService.ClaimResult = {
            predictionId: "pred-1",
            result: "won",
            claimTxHash: "0xalreadyclaimed",
            claimedAt: "2025-01-01T00:00:00.000Z",
        };
        mockClaimWinnings.mockResolvedValue(fakeResult);

        // First call — claim succeeds
        const res1 = await postClaim();
        expect(res1.status).toBe(200);
        expect(res1.body.data.claimTxHash).toBe("0xalreadyclaimed");

        // Second call — claim is idempotent; service returns same data
        const res2 = await postClaim();
        expect(res2.status).toBe(200);
        expect(res2.body.data.claimTxHash).toBe("0xalreadyclaimed");

        // Service was indeed called both times
        expect(mockClaimWinnings).toHaveBeenCalledTimes(2);
    });
});

