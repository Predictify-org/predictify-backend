/**
 * impersonateCircuitBreaker.test.ts
 *
 * Focused tests for the circuit breaker behaviour in
 * POST /api/admin/users/:address/impersonate.
 *
 * Covers:
 *  - CLOSED (normal) state: request succeeds, returns 200
 *  - OPEN state: request fast-fails with 503, includes retryAfterMs
 *  - HALF_OPEN state: successful probe resets breaker back to CLOSED
 *  - HALF_OPEN state: failing probe trips breaker back to OPEN
 *  - Breaker trips after failureThreshold consecutive errors
 *  - Existing tests still pass (auth, validation guards)
 */

jest.mock("../src/services/jwtService");
jest.mock("../src/services/auditService");
jest.mock("../src/db/client", () => ({
  db: {
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue({}) }),
  },
}));

import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { createAdminImpersonateRouter, IMPERSONATE_CIRCUIT_NAME } from "../src/routes/admin/users/impersonate";
import {
  resetCircuitBreakersForTests,
  forceCircuitStateForTests,
  getCircuitBreaker,
} from "../src/lib/circuitBreaker";
import { errorHandler } from "../src/middleware/errorHandler";
import { signAccessToken } from "../src/services/jwtService";
import { createAuditLog } from "../src/services/auditService";

const mockSignAccessToken = signAccessToken as jest.MockedFunction<typeof signAccessToken>;
const mockCreateAuditLog = createAuditLog as jest.MockedFunction<typeof createAuditLog>;

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

const SECRET = process.env.JWT_SECRET ?? "test-jwt-secret-that-is-at-least-32-chars!";
const ISSUER = process.env.JWT_ISSUER || "predictify";
const AUDIENCE = process.env.JWT_AUDIENCE || "predictify-app";

const ADMIN_ADDRESS = "GADMIN7777777777777777777777777777777777777777777777777777";
const USER_ADDRESS = "GUSER88888888888888888888888888888888888888888888888888888";

function signJwt(payload: object): string {
  return jwt.sign(payload, SECRET, { issuer: ISSUER, audience: AUDIENCE, expiresIn: "1h" });
}

const adminJwt = signJwt({ sub: ADMIN_ADDRESS, role: "admin" });

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

/**
 * Creates a fresh Express app with a fresh circuit breaker per test.
 * circuitOpts are passed directly to the router so we can use low thresholds
 * in tests without polluting the global registry between suites.
 */
function makeApp(circuitOpts = {}) {
  // Reset shared state before each app build so each `makeApp` gets
  // a deterministic starting breaker state.
  resetCircuitBreakersForTests();
  const app = express();
  app.use(express.json());
  app.use(
    "/api/admin/users",
    createAdminImpersonateRouter({ rateLimitPerMinute: 100, circuitBreaker: circuitOpts }),
  );
  app.use(errorHandler);
  return app;
}

function authReq(app: express.Express) {
  return request(app)
    .post(`/api/admin/users/${USER_ADDRESS}/impersonate`)
    .set("Authorization", `Bearer ${adminJwt}`)
    .send({});
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  resetCircuitBreakersForTests();
  mockSignAccessToken.mockReturnValue("mocked-token-xyz");
  mockCreateAuditLog.mockResolvedValue("corr-id-123");
});

// ---------------------------------------------------------------------------
// CLOSED state (normal operation)
// ---------------------------------------------------------------------------

describe("CLOSED state — normal operation", () => {
  it("returns 200 with a token when downstream calls succeed", async () => {
    const res = await authReq(makeApp());
    expect(res.status).toBe(200);
    expect(res.body.data.token).toBe("mocked-token-xyz");
  });

  it("calls signAccessToken with the target address", async () => {
    await authReq(makeApp());
    expect(mockSignAccessToken).toHaveBeenCalledWith({ sub: USER_ADDRESS, role: "user" });
  });

  it("calls createAuditLog with admin.impersonate action", async () => {
    await authReq(makeApp());
    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "admin.impersonate",
        walletAddress: ADMIN_ADDRESS,
      }),
    );
  });

  it("failure counter resets after a success", async () => {
    const app = makeApp({ failureThreshold: 3 });

    // Simulate one failure then a success
    mockSignAccessToken
      .mockImplementationOnce(() => { throw new Error("transient"); })
      .mockReturnValue("ok-token");

    const firstRes = await authReq(app);
    expect(firstRes.status).toBe(500); // error propagated

    const secondRes = await authReq(app);
    expect(secondRes.status).toBe(200);

    // Breaker should still be CLOSED — single failure didn't trip it
    const snapshot = getCircuitBreaker(IMPERSONATE_CIRCUIT_NAME).snapshot();
    expect(snapshot.state).toBe("CLOSED");
    expect(snapshot.failures).toBe(0); // reset by the success
  });
});

// ---------------------------------------------------------------------------
// OPEN state — fast-fail
// ---------------------------------------------------------------------------

describe("OPEN state — fast-fail 503", () => {
  it("returns 503 when breaker is forced OPEN", async () => {
    const app = makeApp();
    // Force the breaker open after the app has been created
    forceCircuitStateForTests(IMPERSONATE_CIRCUIT_NAME, "OPEN", { halfOpenAfterMs: 30_000 });

    const res = await authReq(app);
    expect(res.status).toBe(503);
  });

  it("503 response includes service_unavailable code", async () => {
    const app = makeApp();
    forceCircuitStateForTests(IMPERSONATE_CIRCUIT_NAME, "OPEN", { halfOpenAfterMs: 30_000 });

    const res = await authReq(app);
    expect(res.body.error.code).toBe("service_unavailable");
  });

  it("503 response includes retryAfterMs", async () => {
    const app = makeApp({ halfOpenAfterMs: 15_000 });
    forceCircuitStateForTests(IMPERSONATE_CIRCUIT_NAME, "OPEN", { halfOpenAfterMs: 15_000 });

    const res = await authReq(app);
    expect(typeof res.body.error.retryAfterMs).toBe("number");
    expect(res.body.error.retryAfterMs).toBeGreaterThan(0);
  });

  it("does NOT call signAccessToken when circuit is OPEN", async () => {
    const app = makeApp();
    forceCircuitStateForTests(IMPERSONATE_CIRCUIT_NAME, "OPEN");

    await authReq(app);
    expect(mockSignAccessToken).not.toHaveBeenCalled();
  });

  it("does NOT call createAuditLog when circuit is OPEN", async () => {
    const app = makeApp();
    forceCircuitStateForTests(IMPERSONATE_CIRCUIT_NAME, "OPEN");

    await authReq(app);
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
  });

  it("trips to OPEN after failureThreshold consecutive failures", async () => {
    const app = makeApp({ failureThreshold: 3 });
    mockSignAccessToken.mockImplementation(() => {
      throw new Error("downstream error");
    });

    // Three failures should trip the breaker
    const r1 = await authReq(app);
    const r2 = await authReq(app);
    const r3 = await authReq(app);

    expect(r1.status).toBe(500);
    expect(r2.status).toBe(500);
    expect(r3.status).toBe(500);

    const snapshot = getCircuitBreaker(IMPERSONATE_CIRCUIT_NAME).snapshot();
    expect(snapshot.state).toBe("OPEN");

    // Fourth call should be 503 (fast-fail)
    mockSignAccessToken.mockReturnValue("token");
    const r4 = await authReq(app);
    expect(r4.status).toBe(503);
    expect(mockSignAccessToken).toHaveBeenCalledTimes(3); // never called on 4th
  });
});

// ---------------------------------------------------------------------------
// HALF_OPEN state — probe behaviour
// ---------------------------------------------------------------------------

describe("HALF_OPEN state — probe behaviour", () => {
  it("lets a probe through when in HALF_OPEN and resets to CLOSED on success", async () => {
    const app = makeApp({ halfOpenAfterMs: 0 }); // instant transition for tests
    forceCircuitStateForTests(IMPERSONATE_CIRCUIT_NAME, "HALF_OPEN");

    // The probe call should succeed → breaker returns to CLOSED
    const res = await authReq(app);
    expect(res.status).toBe(200);

    const snapshot = getCircuitBreaker(IMPERSONATE_CIRCUIT_NAME).snapshot();
    expect(snapshot.state).toBe("CLOSED");
  });

  it("trips back to OPEN when the HALF_OPEN probe fails", async () => {
    const app = makeApp({ halfOpenAfterMs: 0 });
    forceCircuitStateForTests(IMPERSONATE_CIRCUIT_NAME, "HALF_OPEN");

    mockSignAccessToken.mockImplementationOnce(() => {
      throw new Error("probe failed");
    });

    const res = await authReq(app);
    expect(res.status).toBe(500); // probe failure propagated

    const snapshot = getCircuitBreaker(IMPERSONATE_CIRCUIT_NAME).snapshot();
    expect(snapshot.state).toBe("OPEN");
  });

  it("transitions from OPEN to HALF_OPEN after halfOpenAfterMs elapses", async () => {
    jest.useFakeTimers();
    try {
      const app = makeApp({ halfOpenAfterMs: 1_000 });
      forceCircuitStateForTests(IMPERSONATE_CIRCUIT_NAME, "OPEN", { halfOpenAfterMs: 1_000 });

      // Still OPEN before window expires
      let res = await authReq(app);
      expect(res.status).toBe(503);

      // Advance time past the half-open window
      jest.advanceTimersByTime(1_100);

      // Now a probe is allowed
      mockSignAccessToken.mockReturnValue("new-token");
      res = await authReq(app);
      expect(res.status).toBe(200);

      const snapshot = getCircuitBreaker(IMPERSONATE_CIRCUIT_NAME).snapshot();
      expect(snapshot.state).toBe("CLOSED");
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Auth / validation guards still work with breaker in place
// ---------------------------------------------------------------------------

describe("Auth and validation guards (breaker transparent)", () => {
  it("returns 403 with no Authorization header (breaker CLOSED)", async () => {
    const res = await request(makeApp())
      .post(`/api/admin/users/${USER_ADDRESS}/impersonate`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("returns 403 with a non-admin JWT (breaker CLOSED)", async () => {
    const userJwt = signJwt({ sub: USER_ADDRESS, role: "user" });
    const res = await request(makeApp())
      .post(`/api/admin/users/${USER_ADDRESS}/impersonate`)
      .set("Authorization", `Bearer ${userJwt}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("returns 400 for blank address (breaker CLOSED)", async () => {
    const res = await request(makeApp())
      .post("/api/admin/users/ /impersonate")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns 403 when breaker is OPEN — auth guard fires before circuit", async () => {
    forceCircuitStateForTests(IMPERSONATE_CIRCUIT_NAME, "OPEN");

    // No auth → should 403 before circuit even checked
    const res = await request(makeApp())
      .post(`/api/admin/users/${USER_ADDRESS}/impersonate`)
      .send({});
    expect(res.status).toBe(403);
  });
});
