import request from "supertest";
import express from "express";
import {
  authRouter,
  setAuthDraining,
  getActiveAuthRequestsCount,
  waitForAuthDrain,
} from "../src/routes/auth";
import { errorHandler } from "../src/middleware/errorHandler";
import { createChallenge } from "../src/services/authChallengeService";

jest.mock("../src/services/authChallengeService", () => ({
  createChallenge: jest.fn(),
}));

describe("Auth Graceful Shutdown Drain", () => {
  let app: express.Express;

  beforeEach(() => {
    setAuthDraining(false);
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use("/api/auth", authRouter);
    app.use(errorHandler);
  });

  afterEach(() => {
    setAuthDraining(false);
  });

  it("tracks in-flight requests, blocks new requests, and drains successfully", async () => {
    expect(getActiveAuthRequestsCount()).toBe(0);

    let resolveChallenge: (val: unknown) => void = () => {};
    const challengePromise = new Promise((resolve) => {
      resolveChallenge = resolve;
    });

    (createChallenge as jest.Mock).mockReturnValueOnce(challengePromise);

    // Fire in-flight request using .end() so it runs in background
    request(app)
      .post("/api/auth/challenge")
      .send({ stellarAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF" })
      .end(() => {});

    // Wait until middleware registers the in-flight request
    let attempts = 0;
    while (getActiveAuthRequestsCount() === 0 && attempts < 50) {
      await new Promise((r) => setTimeout(r, 10));
      attempts++;
    }

    expect(getActiveAuthRequestsCount()).toBe(1);

    // Set draining flag manually to test rejection of new requests
    setAuthDraining(true);

    // Try new request while draining -> should get 503
    const res503 = await request(app)
      .post("/api/auth/challenge")
      .send({ stellarAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF" })
      .expect(503);

    expect(res503.body.error.code).toBe("service_unavailable");
    expect(res503.body.error).toHaveProperty("correlationId");

    // Resolve in-flight request
    resolveChallenge({
      nonce: "drain-test-nonce",
      expiresAt: new Date(Date.now() + 60000),
    });

    // Wait for in-flight request to drain
    await waitForAuthDrain(2000);
    expect(getActiveAuthRequestsCount()).toBe(0);
  });
});
