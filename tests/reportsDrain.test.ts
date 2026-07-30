import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import {
  drainReportsRequests,
  reportsInFlightMiddleware,
} from "../src/routes/reports";

describe("/api/reports graceful shutdown drain", () => {
  it("waits for an in-flight response to finish", async () => {
    const response = new EventEmitter() as unknown as Response;
    const next = jest.fn();

    reportsInFlightMiddleware({} as Request, response, next);
    const draining = drainReportsRequests(500);

    await new Promise((resolve) => setImmediate(resolve));
    response.emit("finish");

    await expect(draining).resolves.toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("returns immediately when no requests are in flight", async () => {
    await expect(drainReportsRequests(50)).resolves.toBeUndefined();
  });
});
