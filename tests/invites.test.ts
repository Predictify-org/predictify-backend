let mockUserId: string | null = "test-user-id";

jest.mock("../src/middleware/requireAuth", () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (!mockUserId) {
      res.status(401).json({ error: { code: "unauthenticated" } });
      return;
    }
    req.user = { id: mockUserId, stellarAddress: `G${mockUserId}` };
    next();
  },
}));

jest.mock("../src/services/auditService", () => ({
  createAuditLog: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../src/config/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock("../src/lib/requestContext", () => {
  const actual = jest.requireActual("../src/lib/requestContext");
  return {
    ...actual,
    getRequestId: jest.fn(() => "test-correlation-id"),
  };
});

import express from "express";
import request from "supertest";
import { createInvitesRouter } from "../src/routes/invites";
import { errorHandler } from "../src/middleware/errorHandler";
import { correlationMiddleware, CORRELATION_ID_HEADER } from "../src/middleware/correlation";

// Basic app without correlation middleware (for auth / rate-limit tests)
function makeApp(rateLimitCapacity = 3) {
  const app = express();
  app.use(express.json());
  const router = createInvitesRouter({ rateLimit: { capacity: rateLimitCapacity } });
  app.use("/api/invites", router);
  app.use(errorHandler);
  return app;
}

// App with correlation middleware (for correlation propagation tests)
function makeAppWithCorrelation(rateLimitCapacity = 3) {
  const app = express();
  app.use(express.json());
  app.use(correlationMiddleware);
  const router = createInvitesRouter({ rateLimit: { capacity: rateLimitCapacity } });
  app.use("/api/invites", router);
  app.use(errorHandler);
  return app;
}

describe("POST /api/invites", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUserId = "test-user-id";
  });

  it("returns 401 when auth is rejected", async () => {
    mockUserId = null;
    const app = makeApp();

    const res = await request(app).post("/api/invites");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthenticated");
  });

  it("returns 201 on successful invite creation", async () => {
    const app = makeApp();

    const res = await request(app).post("/api/invites");
    expect(res.status).toBe(201);
    expect(res.body.data.message).toBe("Invite created");
  });

  it("applies rate limiting to POST /api/invites", async () => {
    const app = makeApp(2);

    await request(app).post("/api/invites");
    await request(app).post("/api/invites");

    const blocked = await request(app).post("/api/invites");
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("rate_limit_exceeded");
  });

  it("sets Retry-After header on rate-limited requests", async () => {
    const app = makeApp(1);

    await request(app).post("/api/invites");

    const blocked = await request(app).post("/api/invites");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThanOrEqual(1);
  });

  it("isolates rate limits per user", async () => {
    const app = makeApp(1);

    mockUserId = "user-1";
    await request(app).post("/api/invites");

    const user1Blocked = await request(app).post("/api/invites");
    expect(user1Blocked.status).toBe(429);

    mockUserId = "user-2";
    const user2Allowed = await request(app).post("/api/invites");
    expect(user2Allowed.status).toBe(201);
  });

  it("applies rate limiting to GET /api/invites", async () => {
    const app = makeApp(1);

    await request(app).get("/api/invites");

    const blocked = await request(app).get("/api/invites");
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("rate_limit_exceeded");
  });

  it("includes standard rate limit headers on successful requests", async () => {
    const app = makeApp(5);

    const res = await request(app).post("/api/invites");
    expect(res.status).toBe(201);

    expect(res.headers["ratelimit-limit"]).toBe("5");
    expect(Number(res.headers["ratelimit-remaining"])).toBeGreaterThanOrEqual(0);
    expect(res.headers["ratelimit-reset"]).toBeDefined();
  });
});

// ── Correlation ID Tests ───────────────────────────────────────────────────────

describe("X-Correlation-Id Propagation (/api/invites)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUserId = "test-user-id";
  });

  describe("POST /api/invites", () => {
    it("echoes the incoming X-Correlation-Id in the response header", async () => {
      const customCorrId = "invites-corr-12345";
      const app = makeAppWithCorrelation();

      const res = await request(app)
        .post("/api/invites")
        .set(CORRELATION_ID_HEADER, customCorrId);

      expect(res.status).toBe(201);
      expect(res.headers[CORRELATION_ID_HEADER]).toBe(customCorrId);
    });

    it("generates a UUID v4 X-Correlation-Id when none is provided", async () => {
      const app = makeAppWithCorrelation();

      const res = await request(app).post("/api/invites");

      expect(res.status).toBe(201);
      expect(res.headers[CORRELATION_ID_HEADER]).toBeDefined();
      expect(res.headers[CORRELATION_ID_HEADER]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    it("sanitizes unsafe characters from the incoming X-Correlation-Id", async () => {
      // supertest rejects actual newline/control characters, so we test
      // with characters that pass the transport layer but are stripped
      // by the sanitiser: angle brackets, quotes, spaces, and special chars.
      const unsafeCorrId = "corr-123<script>alert(1)</script> &quot;test&quot;";
      const app = makeAppWithCorrelation();

      const res = await request(app)
        .post("/api/invites")
        .set(CORRELATION_ID_HEADER, unsafeCorrId);

      expect(res.status).toBe(201);
      // Only alphanumeric, hyphen, underscore survive sanitisation
      expect(res.headers[CORRELATION_ID_HEADER]).toBe("corr-123scriptalert1scriptquottestquot");
    });

    it("propagates the correlation ID to outbound calls when outboundUrl is specified", async () => {
      const originalFetch = globalThis.fetch;
      const mockFetch = jest.fn().mockResolvedValue(
        new Response(JSON.stringify({ received: true }), { status: 200 }),
      );
      globalThis.fetch = mockFetch;

      const customCorrId = "invite-outbound-test-789";
      const app = makeAppWithCorrelation();

      try {
        const res = await request(app)
          .post("/api/invites")
          .set(CORRELATION_ID_HEADER, customCorrId)
          .send({
            recipientEmail: "test@example.com",
            message: "You're invited!",
            outboundUrl: "https://webhook.site/test-endpoint",
          });

        expect(res.status).toBe(201);
        expect(res.headers[CORRELATION_ID_HEADER]).toBe(customCorrId);

        // Verify that fetch was called with the same correlation ID
        expect(mockFetch).toHaveBeenCalled();
        const callArgs = mockFetch.mock.calls[0];
        expect(callArgs[0]).toBe("https://webhook.site/test-endpoint");
        const headers = callArgs[1]?.headers as Headers;
        expect(headers.get("x-correlation-id")).toBe(customCorrId);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("handles outbound call failures gracefully without crashing", async () => {
      const originalFetch = globalThis.fetch;
      const mockFetch = jest.fn().mockRejectedValue(new Error("Network error"));
      globalThis.fetch = mockFetch;

      const app = makeAppWithCorrelation();

      try {
        const res = await request(app)
          .post("/api/invites")
          .set(CORRELATION_ID_HEADER, "outbound-fail-corr")
          .send({
            recipientEmail: "fail@example.com",
            outboundUrl: "https://webhook.site/failing-endpoint",
          });

        expect(res.status).toBe(201);
        expect(res.headers[CORRELATION_ID_HEADER]).toBe("outbound-fail-corr");
        expect(res.body.data.message).toBe("Invite created");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("rejects invalid body with standardized validation error envelope", async () => {
      const app = makeAppWithCorrelation();

      const res = await request(app)
        .post("/api/invites")
        .send({ recipientEmail: "not-an-email" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
      expect(res.body.error.details).toBeDefined();
    });

    it("rejects body with unknown properties via .strict()", async () => {
      const app = makeAppWithCorrelation();

      const res = await request(app)
        .post("/api/invites")
        .send({ unknownField: "should not be allowed" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });
  });

  describe("GET /api/invites", () => {
    it("echoes the incoming X-Correlation-Id in the response header", async () => {
      const customCorrId = "get-invites-corr-555";
      const app = makeAppWithCorrelation();

      const res = await request(app)
        .get("/api/invites")
        .set(CORRELATION_ID_HEADER, customCorrId);

      expect(res.status).toBe(200);
      expect(res.headers[CORRELATION_ID_HEADER]).toBe(customCorrId);
    });

    it("generates a UUID v4 X-Correlation-Id when none is provided", async () => {
      const app = makeAppWithCorrelation();

      const res = await request(app).get("/api/invites");

      expect(res.status).toBe(200);
      expect(res.headers[CORRELATION_ID_HEADER]).toBeDefined();
      expect(res.headers[CORRELATION_ID_HEADER]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    it("rejects invalid query parameters with validation error", async () => {
      const app = makeAppWithCorrelation();

      const res = await request(app)
        .get("/api/invites?limit=invalid");

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });
  });

  describe("Correlation ID lifecycle", () => {
    it("uses the same correlation ID throughout the request lifecycle", async () => {
      const customCorrId = "lifecycle-test-999";
      const app = makeAppWithCorrelation();

      const res = await request(app)
        .post("/api/invites")
        .set(CORRELATION_ID_HEADER, customCorrId)
        .send({});

      // The response header should be exactly what we sent
      expect(res.status).toBe(201);
      expect(res.headers[CORRELATION_ID_HEADER]).toBe(customCorrId);
    });

    it("generates a new correlation ID for each request without one", async () => {
      const app = makeAppWithCorrelation();

      const res1 = await request(app).post("/api/invites");
      const res2 = await request(app).post("/api/invites");

      expect(res1.headers[CORRELATION_ID_HEADER]).toBeDefined();
      expect(res2.headers[CORRELATION_ID_HEADER]).toBeDefined();
      expect(res1.headers[CORRELATION_ID_HEADER]).not.toBe(
        res2.headers[CORRELATION_ID_HEADER],
      );
    });

    // Note: The `catch (e) { next(e) }` error paths in both GET and POST
    // handlers follow the standard Express async error forwarding pattern.
    // These paths are exercised indirectly via the `errorHandler` middleware
    // test suite (tests/errorHandler.test.ts) which validates that thrown
    // errors produce a 500 response with a correlationId in the envelope.
  });
});
