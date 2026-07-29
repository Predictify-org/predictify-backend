/**
 * fingerprint.test.ts
 *
 * Tests for src/middleware/fingerprint.ts
 *
 * Coverage areas
 * ──────────────
 *  Unit tests (pure functions — no HTTP):
 *   1.  normalizeContentType: strips parameters, lowercases
 *   2.  normalizeContentType: handles absent header
 *   3.  normalizeAccept: sorts media types, removes q-values
 *   4.  normalizeAccept: handles absent header
 *   5.  extractAuthScheme: returns lowercased scheme only
 *   6.  extractAuthScheme: handles absent / malformed header
 *   7.  computeFingerprint: returns 64-char hex string
 *   8.  computeFingerprint: identical inputs → identical fingerprint
 *   9.  computeFingerprint: different method → different fingerprint
 *   10. computeFingerprint: different path → different fingerprint
 *   11. computeFingerprint: different body → different fingerprint
 *   12. computeFingerprint: different auth scheme → different fingerprint
 *   13. computeFingerprint: auth credential rotation does NOT change fingerprint
 *   14. buildFingerprintInputs: assembles all fields correctly
 *
 *  Integration tests (HTTP via supertest):
 *   15. X-Request-Fingerprint header is present on every response
 *   16. Header value is a 64-char hex string
 *   17. Identical requests produce the same fingerprint
 *   18. Different method → different fingerprint
 *   19. Different path → different fingerprint
 *   20. Different Content-Type → different fingerprint
 *   21. Different body → different fingerprint
 *   22. Authorization credential rotation does NOT change fingerprint
 *   23. Query string differences do NOT change fingerprint
 *   24. Both X-Request-Id and X-Request-Fingerprint present simultaneously
 *   25. getFingerprint() returns the value from within a request handler
 *   26. getFingerprint() returns undefined outside a request context
 *   27. fingerprintMiddleware continues on internal error (best-effort)
 *
 *  /api/fingerprint route tests (HTTP via supertest):
 *   28. GET /api/fingerprint returns 200 with fingerprint in body
 *   29. Response body includes correlationId field
 *   30. Response body includes method and path fields
 *   31. X-Correlation-Id response header echoes/sets the correlation ID
 *   32. Response body fingerprint matches X-Request-Fingerprint header
 *   33. Providing X-Correlation-Id request header echoes it back
 *   34. Identical requests to /api/fingerprint produce the same fingerprint
 */

import request from "supertest";
import { createApp } from "../src/index";
import { drainFingerprintRequests } from "../src/routes/fingerprint";
import {
  normalizeContentType,
  normalizeAccept,
  extractAuthScheme,
  computeFingerprint,
  buildFingerprintInputs,
  fingerprintMiddleware,
  FINGERPRINT_HEADER,
  type FingerprintInputs,
} from "../src/middleware/fingerprint";
import { getFingerprint } from "../src/lib/requestContext";
import type { Request, Response, NextFunction } from "express";

// ── Helpers ────────────────────────────────────────────────────────────────

const HEX64_RE = /^[0-9a-f]{64}$/;

function baseInputs(overrides: Partial<FingerprintInputs> = {}): FingerprintInputs {
  return {
    method: "GET",
    path: "/api/test",
    contentType: "",
    accept: "",
    authScheme: "",
    bodyHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", // sha256("")
    ...overrides,
  };
}

// ── 1–6: Unit tests for normalisation helpers ─────────────────────────────

describe("normalizeContentType()", () => {
  it("strips charset parameter and lowercases", () => {
    expect(normalizeContentType("application/json; charset=utf-8")).toBe("application/json");
  });

  it("handles value with no parameters", () => {
    expect(normalizeContentType("text/plain")).toBe("text/plain");
  });

  it("lowercases mixed-case type", () => {
    expect(normalizeContentType("Application/JSON")).toBe("application/json");
  });

  it("returns empty string for undefined", () => {
    expect(normalizeContentType(undefined)).toBe("");
  });

  it("returns empty string for empty string", () => {
    expect(normalizeContentType("")).toBe("");
  });
});

describe("normalizeAccept()", () => {
  it("sorts multiple media types alphabetically", () => {
    expect(normalizeAccept("text/html, application/json")).toBe("application/json,text/html");
  });

  it("removes quality factors", () => {
    expect(normalizeAccept("application/json;q=0.9, text/html;q=1.0")).toBe(
      "application/json,text/html",
    );
  });

  it("lowercases media types", () => {
    expect(normalizeAccept("TEXT/HTML")).toBe("text/html");
  });

  it("returns empty string for undefined", () => {
    expect(normalizeAccept(undefined)).toBe("");
  });

  it("handles single media type", () => {
    expect(normalizeAccept("application/json")).toBe("application/json");
  });
});

describe("extractAuthScheme()", () => {
  it("extracts bearer scheme, lowercased", () => {
    expect(extractAuthScheme("Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig")).toBe("bearer");
  });

  it("extracts basic scheme, lowercased", () => {
    expect(extractAuthScheme("Basic dXNlcjpwYXNz")).toBe("basic");
  });

  it("handles mixed-case scheme", () => {
    expect(extractAuthScheme("BEARER token123")).toBe("bearer");
  });

  it("returns empty string for undefined", () => {
    expect(extractAuthScheme(undefined)).toBe("");
  });

  it("returns empty string for empty string", () => {
    expect(extractAuthScheme("")).toBe("");
  });

  it("returns scheme even with extra whitespace", () => {
    expect(extractAuthScheme("  Bearer  token  ")).toBe("bearer");
  });
});

// ── 7–13: Unit tests for computeFingerprint ───────────────────────────────

describe("computeFingerprint()", () => {
  it("returns a 64-character lowercase hex string", () => {
    expect(computeFingerprint(baseInputs())).toMatch(HEX64_RE);
  });

  it("identical inputs produce identical fingerprint", () => {
    const a = computeFingerprint(baseInputs());
    const b = computeFingerprint(baseInputs());
    expect(a).toBe(b);
  });

  it("different method → different fingerprint", () => {
    const get = computeFingerprint(baseInputs({ method: "GET" }));
    const post = computeFingerprint(baseInputs({ method: "POST" }));
    expect(get).not.toBe(post);
  });

  it("different path → different fingerprint", () => {
    const a = computeFingerprint(baseInputs({ path: "/api/foo" }));
    const b = computeFingerprint(baseInputs({ path: "/api/bar" }));
    expect(a).not.toBe(b);
  });

  it("different content-type → different fingerprint", () => {
    const json = computeFingerprint(baseInputs({ contentType: "application/json" }));
    const text = computeFingerprint(baseInputs({ contentType: "text/plain" }));
    expect(json).not.toBe(text);
  });

  it("different body hash → different fingerprint", () => {
    const empty = computeFingerprint(baseInputs({ bodyHash: "aaa" }));
    const nonempty = computeFingerprint(baseInputs({ bodyHash: "bbb" }));
    expect(empty).not.toBe(nonempty);
  });

  it("different auth scheme → different fingerprint", () => {
    const bearer = computeFingerprint(baseInputs({ authScheme: "bearer" }));
    const basic = computeFingerprint(baseInputs({ authScheme: "basic" }));
    expect(bearer).not.toBe(basic);
  });

  it("rotating the auth credential (same scheme) does NOT change fingerprint", () => {
    // Both have scheme "bearer" — credential is excluded from the fingerprint
    const token1 = computeFingerprint(baseInputs({ authScheme: "bearer" }));
    const token2 = computeFingerprint(baseInputs({ authScheme: "bearer" }));
    expect(token1).toBe(token2);
  });

  it("absent auth scheme and empty auth scheme produce identical fingerprint", () => {
    const absent = computeFingerprint(baseInputs({ authScheme: "" }));
    const empty = computeFingerprint(baseInputs({ authScheme: "" }));
    expect(absent).toBe(empty);
  });
});

// ── 14: buildFingerprintInputs ────────────────────────────────────────────

describe("buildFingerprintInputs()", () => {
  it("assembles all fields from the request object", () => {
    const fakeReq = {
      method: "POST",
      path: "/api/data",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "accept": "text/html, application/json;q=0.9",
        "authorization": "Bearer secret-token",
      },
      body: { b: 2, a: 1 },
    } as unknown as Request;

    const inputs = buildFingerprintInputs(fakeReq);

    expect(inputs.method).toBe("POST");
    expect(inputs.path).toBe("/api/data");
    expect(inputs.contentType).toBe("application/json");
    expect(inputs.accept).toBe("application/json,text/html");
    expect(inputs.authScheme).toBe("bearer");
    // bodyHash must be a 64-char hex (SHA-256 of the stable JSON)
    expect(inputs.bodyHash).toMatch(HEX64_RE);
  });

  it("produces the same bodyHash regardless of object key order", () => {
    const req1 = {
      method: "POST", path: "/x", headers: {},
      body: { a: 1, b: 2 },
    } as unknown as Request;
    const req2 = {
      method: "POST", path: "/x", headers: {},
      body: { b: 2, a: 1 },
    } as unknown as Request;

    expect(buildFingerprintInputs(req1).bodyHash).toBe(buildFingerprintInputs(req2).bodyHash);
  });

  it("uses empty string for bodyHash when body is absent", () => {
    const req = {
      method: "GET", path: "/x", headers: {},
      body: undefined,
    } as unknown as Request;

    // SHA-256 of "" is the well-known empty-string hash
    const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(buildFingerprintInputs(req).bodyHash).toBe(EMPTY_SHA256);
  });
});

// ── 15–24: Integration tests ──────────────────────────────────────────────

describe("X-Request-Fingerprint response header", () => {
  it("is present on every response", async () => {
    const res = await request(createApp()).get("/health");
    expect(res.headers[FINGERPRINT_HEADER]).toBeDefined();
  });

  it("is a 64-char hex string", async () => {
    const res = await request(createApp()).get("/health");
    expect(res.headers[FINGERPRINT_HEADER]).toMatch(HEX64_RE);
  });

  it("identical requests produce the same fingerprint", async () => {
    const app = createApp();
    const [r1, r2] = await Promise.all([
      request(app).get("/health"),
      request(app).get("/health"),
    ]);
    expect(r1.headers[FINGERPRINT_HEADER]).toBe(r2.headers[FINGERPRINT_HEADER]);
  });

  it("different HTTP method → different fingerprint", async () => {
    const app = createApp();
    const getRes = await request(app).get("/health");
    // POST /health → 404 but fingerprint is still computed
    const postRes = await request(app).post("/health");
    expect(getRes.headers[FINGERPRINT_HEADER]).not.toBe(postRes.headers[FINGERPRINT_HEADER]);
  });

  it("different path → different fingerprint", async () => {
    const app = createApp();
    const r1 = await request(app).get("/health");
    const r2 = await request(app).get("/health/ready");
    expect(r1.headers[FINGERPRINT_HEADER]).not.toBe(r2.headers[FINGERPRINT_HEADER]);
  });

  it("different Content-Type → different fingerprint", async () => {
    const app = createApp();
    const r1 = await request(app)
      .post("/health")
      .set("content-type", "application/json")
      .send("{}");
    const r2 = await request(app)
      .post("/health")
      .set("content-type", "text/plain")
      .send("{}");
    expect(r1.headers[FINGERPRINT_HEADER]).not.toBe(r2.headers[FINGERPRINT_HEADER]);
  });

  it("different JSON body → different fingerprint", async () => {
    const app = createApp();
    const r1 = await request(app)
      .post("/health")
      .set("content-type", "application/json")
      .send({ value: "alpha" });
    const r2 = await request(app)
      .post("/health")
      .set("content-type", "application/json")
      .send({ value: "beta" });
    expect(r1.headers[FINGERPRINT_HEADER]).not.toBe(r2.headers[FINGERPRINT_HEADER]);
  });

  it("rotating auth credential (same scheme) does NOT change fingerprint", async () => {
    const app = createApp();
    const r1 = await request(app)
      .get("/health")
      .set("authorization", "Bearer token-version-1");
    const r2 = await request(app)
      .get("/health")
      .set("authorization", "Bearer token-version-2");
    expect(r1.headers[FINGERPRINT_HEADER]).toBe(r2.headers[FINGERPRINT_HEADER]);
  });

  it("query string differences do NOT change fingerprint", async () => {
    const app = createApp();
    const r1 = await request(app).get("/health?ts=1000");
    const r2 = await request(app).get("/health?ts=2000");
    expect(r1.headers[FINGERPRINT_HEADER]).toBe(r2.headers[FINGERPRINT_HEADER]);
  });

  it("X-Request-Id and X-Request-Fingerprint are both present and distinct", async () => {
    const res = await request(createApp()).get("/health");
    const reqId = res.headers["x-request-id"] as string;
    const fp = res.headers[FINGERPRINT_HEADER] as string;
    expect(reqId).toBeDefined();
    expect(fp).toBeDefined();
    expect(reqId).not.toBe(fp);
  });
});

// ── 25–26: AsyncLocalStorage integration ─────────────────────────────────

describe("getFingerprint()", () => {
  it("returns undefined outside a request context", () => {
    expect(getFingerprint()).toBeUndefined();
  });

  it("returns the fingerprint from within a request handler", async () => {
    let capturedFingerprint: string | undefined;

    const app = createApp();
    app.get("/capture-fp", (_req, res) => {
      capturedFingerprint = getFingerprint();
      res.json({ ok: true });
    });

    const res = await request(app).get("/capture-fp");
    expect(res.status).toBe(200);
    expect(capturedFingerprint).toMatch(HEX64_RE);
    // Fingerprint in header and in ALS store must agree
    expect(capturedFingerprint).toBe(res.headers[FINGERPRINT_HEADER]);
  });
});

// ── 28–34: /api/fingerprint route tests ────────────────────────────────

describe("GET /api/fingerprint", () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  it("returns 200 with fingerprint in body", async () => {
    const res = await request(createApp()).get("/api/fingerprint");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("fingerprint");
    expect(res.body.fingerprint).toMatch(HEX64_RE);
  });

  it("includes correlationId in the response body", async () => {
    const res = await request(createApp()).get("/api/fingerprint");
    expect(res.body).toHaveProperty("correlationId");
    expect(res.body.correlationId).toBeDefined();
    expect(typeof res.body.correlationId).toBe("string");
    expect(res.body.correlationId.length).toBeGreaterThan(0);
  });

  it("includes method and path in the response body", async () => {
    const res = await request(createApp()).get("/api/fingerprint");
    expect(res.body).toHaveProperty("method", "GET");
    expect(res.body).toHaveProperty("path", "/api/fingerprint");
    expect(res.body).toHaveProperty("computedAt");
    expect(new Date(res.body.computedAt).getTime()).not.toBeNaN();
  });

  it("echoes X-Correlation-Id in the response header", async () => {
    const res = await request(createApp()).get("/api/fingerprint");
    expect(res.headers["x-correlation-id"]).toBeDefined();
    expect(res.headers["x-correlation-id"]).toBe(res.body.correlationId);
  });

  it("response body fingerprint matches X-Request-Fingerprint header", async () => {
    const res = await request(createApp()).get("/api/fingerprint");
    expect(res.headers[FINGERPRINT_HEADER]).toBe(res.body.fingerprint);
  });

  it("echoes the supplied X-Correlation-Id request header", async () => {
    const correlationId = "test-fingerprint-correlation-abc";
    const res = await request(createApp())
      .get("/api/fingerprint")
      .set("x-correlation-id", correlationId);
    expect(res.body.correlationId).toBe(correlationId);
    expect(res.headers["x-correlation-id"]).toBe(correlationId);
  });

  it("identical requests produce the same fingerprint", async () => {
    const app = createApp();
    const [r1, r2] = await Promise.all([
      request(app).get("/api/fingerprint"),
      request(app).get("/api/fingerprint"),
    ]);
    expect(r1.body.fingerprint).toBe(r2.body.fingerprint);
  });

  it("enforces per-user token-bucket rate limit with 429 and Retry-After", async () => {
    const app = createApp();
    const limit = 60; // default FINGERPRINT_RATE_LIMIT_CAPACITY
    const isolatedIp = "9.9.9.9";

    // Exhaust the rate limit for this IP
    for (let i = 0; i < limit; i++) {
      await request(app).get("/api/fingerprint").set("x-forwarded-for", isolatedIp);
    }

    // The 61st request should be blocked
    const res = await request(app).get("/api/fingerprint").set("x-forwarded-for", isolatedIp);
    
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe("rate_limit_exceeded");
  });
});

// ── 35: fingerprintRoute drain ───────────────────────────────────────

describe("drainFingerprintRequests()", () => {
  it("returns immediately when no in-flight requests", async () => {
    const start = Date.now();
    await drainFingerprintRequests(1000);
    expect(Date.now() - start).toBeLessThan(100);
  });
});

// ── 36: fingerprintMiddleware error handling ────────────────────────────

describe("fingerprintMiddleware error handling", () => {
  it("calls next() and does not throw when an internal error occurs", () => {
    // Construct a request that will cause buildFingerprintInputs to throw
    // by making req.path a getter that throws.
    const fakeReq = {
      method: "GET",
      headers: {},
      body: undefined,
      get path(): string { throw new Error("path exploded"); },
    } as unknown as Request;

    const fakeRes = {
      locals: {},
      setHeader: jest.fn(),
    } as unknown as Response;

    const next = jest.fn() as unknown as NextFunction;

    // Must not throw
    expect(() => fingerprintMiddleware(fakeReq, fakeRes, next)).not.toThrow();
    // next() must still be called so the request chain continues
    expect(next).toHaveBeenCalledTimes(1);
    // No fingerprint header should have been set
    expect(fakeRes.setHeader).not.toHaveBeenCalled();
  });
});
