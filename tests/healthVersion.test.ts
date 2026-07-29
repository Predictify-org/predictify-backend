import request from "supertest";
import express from "express";
import { createVersionRouter } from "../src/routes/health/version";
import { errorHandler } from "../src/middleware/errorHandler";
import pkg from "../package.json";

function makeApp(): express.Express {
  const app = express();
  app.use("/api/health/version", createVersionRouter());
  app.use(errorHandler);
  return app;
}

const app = makeApp();

describe("GET /api/health/version", () => {
  const origGitCommitSha = process.env.GIT_COMMIT_SHA;
  const origVercelGitCommitSha = process.env.VERCEL_GIT_COMMIT_SHA;

  beforeEach(() => {
    delete process.env.GIT_COMMIT_SHA;
    delete process.env.VERCEL_GIT_COMMIT_SHA;
  });

  afterEach(() => {
    if (origGitCommitSha !== undefined) {
      process.env.GIT_COMMIT_SHA = origGitCommitSha;
    } else {
      delete process.env.GIT_COMMIT_SHA;
    }
    if (origVercelGitCommitSha !== undefined) {
      process.env.VERCEL_GIT_COMMIT_SHA = origVercelGitCommitSha;
    } else {
      delete process.env.VERCEL_GIT_COMMIT_SHA;
    }
  });

  it("returns 200", async () => {
    const res = await request(app).get("/api/health/version");
    expect(res.status).toBe(200);
  });

  it("returns the correct response shape", async () => {
    const res = await request(app).get("/api/health/version");

    expect(res.body).toHaveProperty("version");
    expect(res.body).toHaveProperty("commitSha");
    expect(res.body).toHaveProperty("correlationId");
    expect(res.body).toHaveProperty("checkedAt");
  });

  it("returns the version from package.json", async () => {
    const res = await request(app).get("/api/health/version");
    expect(res.body.version).toBe(pkg.version);
  });

  it("returns commitSha from GIT_COMMIT_SHA env var", async () => {
    process.env.GIT_COMMIT_SHA = "abc123def456";

    const res = await request(app).get("/api/health/version");
    expect(res.body.commitSha).toBe("abc123def456");
  });

  it("returns commitSha from VERCEL_GIT_COMMIT_SHA when GIT_COMMIT_SHA is not set", async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = "vercel-sha-789";

    const res = await request(app).get("/api/health/version");
    expect(res.body.commitSha).toBe("vercel-sha-789");
  });

  it("gives priority to GIT_COMMIT_SHA over VERCEL_GIT_COMMIT_SHA", async () => {
    process.env.GIT_COMMIT_SHA = "github-sha";
    process.env.VERCEL_GIT_COMMIT_SHA = "vercel-sha";

    const res = await request(app).get("/api/health/version");
    expect(res.body.commitSha).toBe("github-sha");
  });

  it("falls back to 'unknown' when neither env var is set", async () => {
    const res = await request(app).get("/api/health/version");
    expect(res.body.commitSha).toBe("unknown");
  });

  it("echoes x-correlation-id from request header", async () => {
    const correlationId = "test-version-correlation";
    const res = await request(app)
      .get("/api/health/version")
      .set("x-correlation-id", correlationId);

    expect(res.body.correlationId).toBe(correlationId);
  });

  it("generates a UUID correlationId when header is absent", async () => {
    const res = await request(app).get("/api/health/version");

    expect(res.body.correlationId).toBeDefined();
    expect(res.body.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("includes a valid ISO-8601 checkedAt timestamp", async () => {
    const before = new Date();
    const res = await request(app).get("/api/health/version");
    const after = new Date();

    const checkedAt = new Date(res.body.checkedAt);
    expect(checkedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(checkedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("does not require authentication", async () => {
    const res = await request(app).get("/api/health/version");
    expect(res.status).toBe(200);
  });

  it("responds with application/json content type", async () => {
    const res = await request(app).get("/api/health/version");
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });
});
