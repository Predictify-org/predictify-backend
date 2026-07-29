import request from "supertest";
import { createApp } from "../src/index";
import { DEPRECATION_HEADER, SUNSET_HEADER } from "../src/middleware/deprecation";

describe("Deprecation middleware", () => {
  it("adds deprecation headers when version is v1 (default)", async () => {
    const app = createApp();

    // Using a route that exists, like /health
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.headers[DEPRECATION_HEADER.toLowerCase()]).toBeDefined();
    expect(res.headers[SUNSET_HEADER.toLowerCase()]).toBeDefined();
  });

  it("does not add deprecation headers when version is v2", async () => {
    const app = createApp();

    const res = await request(app)
      .get("/health")
      .set("x-api-version", "v2");

    expect(res.status).toBe(200);
    expect(res.headers[DEPRECATION_HEADER.toLowerCase()]).toBeUndefined();
    expect(res.headers[SUNSET_HEADER.toLowerCase()]).toBeUndefined();
  });
});
