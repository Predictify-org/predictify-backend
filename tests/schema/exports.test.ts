import request from "supertest";
import express from "express";
import { exportsPredictionsRouter } from "../../src/routes/exports/predictions";

// Basic express app setup to mount the router for snapshot testing
const app = express();
app.use(express.json());

// Mock auth middleware directly to allow routing bypassing DB hooks
app.use((req, res, next) => {
  (req as any).user = { id: "test-user-id" };
  next();
});

app.use("/api/exports", exportsPredictionsRouter);

describe("Exports API Schema Stability", () => {
  it("should maintain a stable response shape for validation errors", async () => {
    // We intentionally trigger a Zod validation error by sending a bad format
    const response = await request(app).get("/api/exports?format=unsupported");

    // Assert status is not OK (validation error usually triggers 500 in error middleware or 400)
    expect(response.status).not.toBe(200);

    // Snapshot the response body structure so if the envelope changes, the test fails
    expect(response.body).toMatchSnapshot();
  });
});
