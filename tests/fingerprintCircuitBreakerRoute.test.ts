import express from "express";
import request from "supertest";
import {
  fingerprintRouter,
} from "../src/routes/fingerprint";
import { fingerprintCircuitBreaker } from "../src/lib/circuitBreaker";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/fingerprint", fingerprintRouter);
  return app;
}

describe("POST /api/fingerprint circuit breaker", () => {
  beforeEach(() => fingerprintCircuitBreaker.reset());

  it("returns 503 without calling downstream work when the circuit is open", async () => {
    const fail = async () => {
      throw new Error("downstream unavailable");
    };
    for (let i = 0; i < 3; i += 1) {
      await fingerprintCircuitBreaker.fire(fail).catch(() => undefined);
    }

    const response = await request(makeApp())
      .post("/api/fingerprint")
      .send({ address: "GTEST" });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("SERVICE_UNAVAILABLE");
  });

  it("allows requests again after an explicit reset", async () => {
    const response = await request(makeApp())
      .post("/api/fingerprint")
      .send({ address: "GTEST" });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });
});
