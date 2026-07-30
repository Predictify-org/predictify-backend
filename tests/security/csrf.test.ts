
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "security-test-secret-at-least-32-bytes!!";
process.env.JWT_ISSUER = "predictify";
process.env.JWT_AUDIENCE = "predictify-app";
process.env.ADMIN_ALLOWLIST = "GADMIN7777777777777777777777777777777777777777777777777777";

import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";
import { issueCsrfToken, verifyCsrfToken, generateCsrfToken } from "../../src/middleware/csrf";
import { errorHandler } from "../../src/middleware/errorHandler";
import { requestContextStorage } from "../../src/lib/requestContext";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  
  app.use((req, _res, next) => {
    const requestId = (req.headers["x-request-id"] as string) || "test-generated-id";
    (req as express.Request & { id?: string }).id = requestId;
    requestContextStorage.run({ requestId }, next);
  });

  app.post("/login", issueCsrfToken, (_req, res) => {
    res.cookie("session", "fake-session-value", { httpOnly: true, path: "/" });
    res.status(200).json({ ok: true });
  });

  app.get("/csrf-token", issueCsrfToken, (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.get("/public-resource", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  
  app.get("/mutate-guarded-get", verifyCsrfToken, (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.post("/mutate", verifyCsrfToken, (_req, res) => {
    res.status(200).json({ ok: true, mutated: true });
  });

  app.delete("/mutate", verifyCsrfToken, (_req, res) => {
    res.status(200).json({ ok: true, deleted: true });
  });

  app.use(errorHandler);

  return app;
}

describe("CSRF Protection Middleware", () => {
  const app = buildApp();

  describe("issueCsrfToken", () => {
    it("sets a csrf_token cookie on first request", async () => {
      const res = await request(app).get("/csrf-token");
      expect(res.status).toBe(200);
      const setCookie = res.headers["set-cookie"] as unknown as string[];
      expect(setCookie.some((c) => c.startsWith("csrf_token="))).toBe(true);
    });

    it("does not reissue a cookie if one is already present", async () => {
      const res = await request(app)
        .get("/csrf-token")
        .set("Cookie", ["csrf_token=existing-token-value"]);
      expect(res.status).toBe(200);
      const setCookie = (res.headers["set-cookie"] as unknown as string[]) ?? [];
      expect(setCookie.some((c) => c.startsWith("csrf_token="))).toBe(false);
    });

    it("issues the cookie as non-httpOnly so client JS can read it", async () => {
      const res = await request(app).get("/csrf-token");
      const setCookie = res.headers["set-cookie"] as unknown as string[];
      const csrfCookie = setCookie.find((c) => c.startsWith("csrf_token="));
      expect(csrfCookie?.toLowerCase()).not.toContain("httponly");
    });
  });

  describe("verifyCsrfToken — safe methods", () => {
    it("allows GET requests through without any token", async () => {
      const res = await request(app).get("/public-resource");
      expect(res.status).toBe(200);
    });

    it("no-ops for GET even when the middleware is mounted directly on the route", async () => {
      const res = await request(app)
        .get("/mutate-guarded-get")
        .set("Cookie", ["session=fake-session-value"]);
      expect(res.status).toBe(200);
    });
  });

  describe("verifyCsrfToken — no session cookie present (today's actual auth model)", () => {
    it("allows a mutating request through with only a Bearer token, no cookie", async () => {
      const res = await request(app)
        .post("/mutate")
        .set("Authorization", "Bearer some.jwt.token");
      expect(res.status).toBe(200);
      expect(res.body.mutated).toBe(true);
    });

    it("allows a mutating request through with a body-carried token and no cookie", async () => {
     
      const res = await request(app)
        .post("/mutate")
        .send({ refreshToken: "some-refresh-token-value" });
      expect(res.status).toBe(200);
    });
  });

  describe("verifyCsrfToken — session cookie present", () => {
    it("rejects a mutating request with a session cookie but no CSRF cookie or header", async () => {
      const res = await request(app)
        .post("/mutate")
        .set("Cookie", ["session=fake-session-value"]);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("Forbidden");
      expect(res.body.error.correlationId).toBeDefined();
    });

    it("uses the request's context-stored correlation id (matching src/index.ts's requestContextStorage wiring)", async () => {
      const res = await request(app)
        .post("/mutate")
        .set("Cookie", ["session=fake-session-value"])
        .set("x-request-id", "upstream-req-id-123");
      expect(res.status).toBe(403);
      expect(res.body.error.correlationId).toBe("upstream-req-id-123");
    });

    it("falls back to a generated id when no x-request-id is set on the request context", async () => {
      const res = await request(app)
        .post("/mutate")
        .set("Cookie", ["session=fake-session-value"]);
      expect(res.status).toBe(403);
      expect(res.body.error.correlationId).toBe("test-generated-id");
    });

    it("rejects when the CSRF cookie is present but the header is missing", async () => {
      const res = await request(app)
        .post("/mutate")
        .set("Cookie", ["session=fake-session-value", "csrf_token=abc123"]);
      expect(res.status).toBe(403);
    });

    it("rejects when the header is present but the CSRF cookie is missing", async () => {
      const res = await request(app)
        .post("/mutate")
        .set("Cookie", ["session=fake-session-value"])
        .set("X-CSRF-Token", "abc123");
      expect(res.status).toBe(403);
    });

    it("rejects when the cookie and header values do not match", async () => {
      const res = await request(app)
        .post("/mutate")
        .set("Cookie", ["session=fake-session-value", "csrf_token=abc123"])
        .set("X-CSRF-Token", "def456");
      expect(res.status).toBe(403);
    });

    it("rejects when the header value differs only in length from the cookie", async () => {
      const res = await request(app)
        .post("/mutate")
        .set("Cookie", ["session=fake-session-value", "csrf_token=abc123"])
        .set("X-CSRF-Token", "abc123extra");
      expect(res.status).toBe(403);
    });

    it("rejects when the header is sent as a duplicate (array) value", async () => {
      const token = generateCsrfToken();
      const res = await request(app)
        .post("/mutate")
        .set("Cookie", ["session=fake-session-value", `csrf_token=${token}`])
        .set("X-CSRF-Token" as string, [token, token] as unknown as string);
      expect(res.status).toBe(403);
    });

    it("accepts when the cookie and header values match", async () => {
      const token = generateCsrfToken();
      const res = await request(app)
        .post("/mutate")
        .set("Cookie", ["session=fake-session-value", `csrf_token=${token}`])
        .set("X-CSRF-Token", token);
      expect(res.status).toBe(200);
      expect(res.body.mutated).toBe(true);
    });

    it("enforces the same check on DELETE requests", async () => {
      const res = await request(app)
        .delete("/mutate")
        .set("Cookie", ["session=fake-session-value"]);
      expect(res.status).toBe(403);
    });

    it("accepts a matching token on DELETE", async () => {
      const token = generateCsrfToken();
      const res = await request(app)
        .delete("/mutate")
        .set("Cookie", ["session=fake-session-value", `csrf_token=${token}`])
        .set("X-CSRF-Token", token);
      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);
    });
  });

  describe("verifyCsrfToken — outside requestContextStorage scope", () => {
    it("falls back to req.id or a generated uuid when no context store is active", async () => {
     
      const bareApp = express();
      bareApp.use(cookieParser());
      bareApp.post("/mutate", verifyCsrfToken, (_req, res) => {
        res.status(200).json({ ok: true });
      });
      bareApp.use(errorHandler);

      const res = await request(bareApp)
        .post("/mutate")
        .set("Cookie", ["session=fake-session-value"]);
      expect(res.status).toBe(403);
      
      expect(typeof res.body.error.correlationId).toBe("string");
      expect(res.body.error.correlationId.length).toBeGreaterThan(0);
    });

    it("falls back to req.id specifically when it is set but no context store is active", async () => {
      const bareAppWithReqId = express();
      bareAppWithReqId.use(cookieParser());
      bareAppWithReqId.use((req, _res, next) => {
        (req as express.Request & { id?: string }).id = "manually-set-req-id";
        next();
      });
      bareAppWithReqId.post("/mutate", verifyCsrfToken, (_req, res) => {
        res.status(200).json({ ok: true });
      });
      bareAppWithReqId.use(errorHandler);

      const res = await request(bareAppWithReqId)
        .post("/mutate")
        .set("Cookie", ["session=fake-session-value"]);
      expect(res.status).toBe(403);
      expect(res.body.error.correlationId).toBe("manually-set-req-id");
    });
  });

  describe("end-to-end login → mutate flow", () => {
    it("allows a mutating request after login issues a matching CSRF cookie", async () => {
      const agent = request.agent(app);
      const loginRes = await agent.post("/login");
      expect(loginRes.status).toBe(200);

      const setCookie = loginRes.headers["set-cookie"] as unknown as string[];
      const csrfCookie = setCookie
        .find((c) => c.startsWith("csrf_token="))
        ?.split(";")[0]
        .split("=")[1];
      expect(csrfCookie).toBeDefined();

      const mutateRes = await agent.post("/mutate").set("X-CSRF-Token", csrfCookie as string);
      expect(mutateRes.status).toBe(200);
    });
  });

  describe("generateCsrfToken", () => {
    it("produces distinct, sufficiently long hex tokens", () => {
      const a = generateCsrfToken();
      const b = generateCsrfToken();
      expect(a).not.toEqual(b);
      expect(a.length).toBeGreaterThanOrEqual(32);
      expect(/^[0-9a-f]+$/.test(a)).toBe(true);
    });
  });
});