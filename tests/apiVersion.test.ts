import request from "supertest";
import { createApp } from "../src/index";
import { API_VERSION_HEADER, DEFAULT_API_VERSION } from "../src/middleware/apiVersion";

describe("GET /api/webhooks ETag support", () => {
  it("returns an ETag and supports conditional revalidation", async () => {
    const app = createApp();

    const first = await request(app).get("/api/webhooks");

    expect(first.status).toBe(200);
    expect(first.headers.etag).toBeDefined();
    expect(first.body).toEqual({
      data: {
        events: expect.any(Array),
        eventCount: expect.any(Number),
      },
    });

    const cached = await request(app)
      .get("/api/webhooks")
      .set("If-None-Match", first.headers.etag as string);

    expect(cached.status).toBe(304);
    expect(cached.text).toBe("");
  });
});

describe("X-Api-Version middleware", () => {
  it("defaults to v1 and exposes the resolved version to handlers", async () => {
    const app = createApp();

    app.get("/capture-version", (req, res) => {
      const requestWithVersion = req as typeof req & { apiVersion?: string };
      res.json({ apiVersion: requestWithVersion.apiVersion ?? null });
    });

    const res = await request(app).get("/capture-version");

    expect(res.status).toBe(200);
    expect(res.headers[API_VERSION_HEADER]).toBe(DEFAULT_API_VERSION);
    expect(res.body).toEqual({ apiVersion: DEFAULT_API_VERSION });
  });

  it("accepts supported versions and normalizes them to the canonical form", async () => {
    const app = createApp();

    app.get("/capture-version", (req, res) => {
      const requestWithVersion = req as typeof req & { apiVersion?: string };
      res.json({ apiVersion: requestWithVersion.apiVersion ?? null });
    });

    const res = await request(app).get("/capture-version").set(API_VERSION_HEADER, "2");

    expect(res.status).toBe(200);
    expect(res.headers[API_VERSION_HEADER]).toBe("v2");
    expect(res.body).toEqual({ apiVersion: "v2" });
  });

  it("rejects unsupported versions with a structured 400 response", async () => {
    const app = createApp();

    app.get("/capture-version", (req, res) => {
      const requestWithVersion = req as typeof req & { apiVersion?: string };
      res.json({ apiVersion: requestWithVersion.apiVersion ?? null });
    });

    const res = await request(app).get("/capture-version").set(API_VERSION_HEADER, "v3");

    expect(res.status).toBe(400);
    expect(res.body.error).toEqual(
      expect.objectContaining({
        code: "BadRequest",
        message: expect.stringContaining("Unsupported"),
      }),
    );
  });
});
