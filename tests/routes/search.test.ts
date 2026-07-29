import request from "supertest";
import { createApp } from "../../src/index";
import { drainSearchRequests } from "../../src/routes/search";

describe("Search Route Graceful Shutdown Drain", () => {
  const app = createApp();

  describe("GET /api/search", () => {
    it("should return validation error for empty query", async () => {
      const response = await request(app)
        .get("/api/search")
        .query({ q: "  " }); // Only whitespace, which gets trimmed to empty

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
      expect(response.body.error.code).toBe("validation_error");
      expect(response.body.error.message).toBe("Search query must not be empty");
    });

    it("should return validation error for control characters in query", async () => {
      const response = await request(app)
        .get("/api/search")
        .query({ q: "test\x00" });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
      expect(response.body.error.message).toBe("Control characters are not allowed in query");
    });

    it("should return validation error for limit out of bounds", async () => {
      const response = await request(app)
        .get("/api/search")
        .query({ q: "valid search", limit: 200 });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe("Limit cannot exceed 100");
    });

    it("should process a valid search successfully", async () => {
      const response = await request(app)
        .get("/api/search")
        .query({ q: "hello world", limit: 5, page: 2 });

      expect(response.status).toBe(200);
      expect(response.body.data).toBeDefined();
      expect(response.body.data.meta.query).toBe("hello world");
      expect(response.body.data.meta.limit).toBe(5);
      expect(response.body.data.meta.page).toBe(2);
    });
  });

  describe("drainSearchRequests()", () => {
    it("should return immediately when no in-flight requests", async () => {
      const start = Date.now();
      await drainSearchRequests(1000);
      expect(Date.now() - start).toBeLessThan(100);
    });

    it("should wait for in-flight requests to complete", async () => {
      // We initiate a request but don't await it yet so it runs in background
      const reqPromise = request(app)
        .get("/api/search")
        .query({ q: "slow request" });
      
      // Wait a tiny bit to ensure the router starts processing the request
      await new Promise(resolve => setTimeout(resolve, 50));
      
      const start = Date.now();
      // Drain should wait for the ~200ms mock delay to finish
      await drainSearchRequests(1000);
      const elapsed = Date.now() - start;
      
      expect(elapsed).toBeGreaterThanOrEqual(100); // Because of the 200ms delay in the route
      
      const response = await reqPromise;
      expect(response.status).toBe(200);
    });

    it("should timeout if requests take too long", async () => {
      const reqPromise = request(app)
        .get("/api/search")
        .query({ q: "timeout request" });
        
      await new Promise(resolve => setTimeout(resolve, 50));

      const start = Date.now();
      // We force a very short timeout that triggers before the 200ms route delay
      await drainSearchRequests(50);
      const elapsed = Date.now() - start;
      
      // The drain function will timeout and return early
      expect(elapsed).toBeGreaterThanOrEqual(40);
      expect(elapsed).toBeLessThan(150);

      const response = await reqPromise;
      expect(response.status).toBe(200);
    });
  });
});
