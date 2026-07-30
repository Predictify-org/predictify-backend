/**
 * tests/featureFlagsRoute.test.ts
 *
 * Focused tests for:
 *   - GET /api/feature-flags happy path (200)
 *   - Per-request timeout → 504 gateway_timeout
 *   - No double-response when the service resolves after the deadline
 *   - Cooperative abort: RequestAbortedError is silently dropped after 504
 *   - Query-parameter validation (400 on invalid enum)
 *   - Valid optional query params are accepted
 *   - Correlation-ID header is echoed back
 *   - logger.warn is emitted with the correct shape on timeout
 */

jest.mock('../src/services/featureFlags', () => ({
  getAllFlags: jest.fn().mockReturnValue([
    { id: 'MAINTENANCE_MODE', enabled: false, variant: null, description: 'System maintenance' },
    { id: 'NEW_MARKET_FLOW', enabled: true, variant: 'v2', description: 'Beta feature' },
    { id: 'OLD_CHECKOUT', enabled: false, variant: 'v1', description: 'Legacy checkout' },
  ]),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

describe('GET /feature-flags', () => {
  it('should return 200 OK with items, next_cursor, and total envelope', async () => {
    const res = await request(app).get('/feature-flags');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('items');
    expect(res.body).toHaveProperty('next_cursor');
    expect(res.body).toHaveProperty('total');
    expect(res.body.total).toBe(3);
    expect(res.body.items).toEqual([
      { id: 'OLD_CHECKOUT', enabled: false, variant: 'v1' },
      { id: 'NEW_MARKET_FLOW', enabled: true, variant: 'v2' },
      { id: 'MAINTENANCE_MODE', enabled: false, variant: null },
    ]);
    expect(res.body.next_cursor).toBeNull();
  });

  it('should return x-correlation-id header', async () => {
    const correlationId = 'test-uuid-123';
    const res = await request(app)
      .get('/feature-flags')
      .set('x-correlation-id', correlationId);

    expect(res.status).toBe(200);
    expect(res.headers['x-correlation-id']).toBe(correlationId);
  });

  it('should return 200 OK when valid query parameters are provided', async () => {
    const res = await request(app)
      .get('/feature-flags')
      .query({ environment: 'development', clientVersion: '1.0.0' });

    expect(res.status).toBe(200);
    expect(res.body.items).toBeDefined();
    expect(res.body.total).toBe(3);
  });

  it('should return 422 Unprocessable Entity when invalid query parameters are provided', async () => {
    const res = await request(app)
      .get('/feature-flags')
      .query({ environment: 'invalid-env' });

    expect(res.status).toBe(422);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.message).toBe('Invalid query parameters');
  });

  it('should paginate with limit', async () => {
    const res = await request(app)
      .get('/feature-flags')
      .query({ limit: 2 });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.total).toBe(3);
    expect(res.body.next_cursor).not.toBeNull();
    expect(typeof res.body.next_cursor).toBe('string');
  });

  it('filters flags by enabled state before pagination', async () => {
    const res = await request(app)
      .get('/feature-flags')
      .query({ enabled: true });

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      { id: 'NEW_MARKET_FLOW', enabled: true, variant: 'v2' },
    ]);
    expect(res.body.total).toBe(1);
    expect(res.body.next_cursor).toBeNull();
  });

  it('should return next_cursor as null on the last page', async () => {
    const first = await request(app)
      .get('/feature-flags')
      .query({ limit: 2 });

    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.next_cursor).not.toBeNull();

    const second = await request(app)
      .get('/feature-flags')
      .query({ cursor: first.body.next_cursor, limit: 2 });

    expect(second.status).toBe(200);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.next_cursor).toBeNull();
  });

  it('should restart from page one when cursor is tampered', async () => {
    const res = await request(app)
      .get('/feature-flags')
      .query({ cursor: 'invalid-cursor-token', limit: 2 });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.next_cursor).not.toBeNull();
  });
});

// ── Query-parameter validation ────────────────────────────────────────────────

describe("GET /api/feature-flags — query parameter validation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetFlagsForUser.mockReturnValue({});
  });

  it("returns 400 when environment is not a valid enum value", async () => {
    const res = await request(makeApp())
      .get("/api/feature-flags")
      .query({ environment: "staging" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns 400 with a requestId in the error envelope", async () => {
    const res = await request(makeApp())
      .get("/api/feature-flags")
      .query({ environment: "bad-value" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: "validation_error",
      requestId: expect.any(String),
    });
  });

  it("ignores unknown query parameters (zod strips them)", async () => {
    const res = await request(makeApp())
      .get("/api/feature-flags")
      .query({ unknownParam: "foo" });

    expect(res.status).toBe(200);
  });
});

// ── Timeout / cooperative abort ───────────────────────────────────────────────

describe("GET /api/feature-flags — per-request timeout", () => {
  /**
   * Accelerate the 5-second FEATURE_FLAGS_TIMEOUT_MS to 50 ms so the test
   * suite stays fast without jest.useFakeTimers (which can conflict with
   * supertest's async http wiring).
   */
  const originalSetTimeout = global.setTimeout;

  beforeEach(() => {
    jest.clearAllMocks();
    global.setTimeout = ((
      cb: (...args: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      if (ms === 5000) return originalSetTimeout(cb, 50, ...args);
      return originalSetTimeout(cb, ms, ...args);
    }) as typeof setTimeout;
  });

  afterEach(() => {
    global.setTimeout = originalSetTimeout;
  });

  it(
    "returns 504 gateway_timeout when the service hangs past the deadline",
    async () => {
      mockGetFlagsForUser.mockReturnValue(
        // Never resolves — simulates a slow upstream or lock contention
        new Promise(() => {}) as unknown as ReturnType<typeof FeatureFlagsService.getFlagsForUser>,
      );

      const res = await request(makeApp()).get("/api/feature-flags");

      expect(res.status).toBe(504);
      expect(res.body).toEqual({
        error: {
          code: "gateway_timeout",
          message: "Feature-flags request timed out",
          requestId: expect.any(String),
        },
      });
    },
    8000,
  );

  it(
    "does not double-respond when a hung service resolves after the deadline",
    async () => {
      let resolveLate!: (v: ReturnType<typeof FeatureFlagsService.getFlagsForUser>) => void;
      mockGetFlagsForUser.mockReturnValue(
        new Promise((resolve) => {
          resolveLate = resolve;
        }) as unknown as ReturnType<typeof FeatureFlagsService.getFlagsForUser>,
      );

      const res = await request(makeApp()).get("/api/feature-flags");
      expect(res.status).toBe(504);

      // Simulate the late resolution — should not throw or cause an unhandled
      // rejection because the RequestAbortedError path returns early.
      resolveLate({});
      await new Promise((r) => originalSetTimeout(r, 50));
    },
    8000,
  );

  it(
    "emits logger.warn with the correct shape when the timeout fires",
    async () => {
      mockGetFlagsForUser.mockReturnValue(
        new Promise(() => {}) as unknown as ReturnType<typeof FeatureFlagsService.getFlagsForUser>,
      );

      const clientCorrelationId = "warn-shape-test-001";
      await request(makeApp())
        .get("/api/feature-flags")
        .set("x-correlation-id", clientCorrelationId);

      // The requestTimeout middleware should have warned with these fields.
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          correlationId: clientCorrelationId,
          timeoutMs: 5000,
          path: expect.stringContaining("feature-flags"),
          method: "GET",
        }),
        "request_timeout_exceeded",
      );
    },
    8000,
  );

  it(
    "logs a breadcrumb when the RequestAbortedError is caught in the handler",
    async () => {
      mockGetFlagsForUser.mockReturnValue(
        new Promise(() => {}) as unknown as ReturnType<typeof FeatureFlagsService.getFlagsForUser>,
      );

      await request(makeApp()).get("/api/feature-flags");

      // The route handler should log 'Abandoned /api/feature-flags request after timeout'
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ correlationId: expect.any(String), path: "/" }),
        "Abandoned /api/feature-flags request after timeout",
      );
    },
    8000,
  );

  it(
    "responds normally within the deadline when the service resolves quickly",
    async () => {
      const flags = { ENABLE_DOCS: { enabled: true } };
      mockGetFlagsForUser.mockReturnValue(flags);

      const res = await request(makeApp()).get("/api/feature-flags");

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(flags);
    },
    8000,
  );
});
