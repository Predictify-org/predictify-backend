/**
 * @module routes/indexer
 *
 * Router for `/api/indexer` endpoints, ensuring standard API security headers
 * (`Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy`)
 * are set on all responses.
 */

import { Request, Response, Router } from "express";
import { securityHeaders } from "../middleware/securityHeaders";
import {
  createIndexerHealthRouter,
  indexerHealthRouter,
} from "./indexer/health";
import { indexerRequestSchema } from "../validators/indexer";
import { runPollCycle } from "../indexer";

export const indexerRouter = Router();

// Apply security response headers to all /api/indexer routes
indexerRouter.use(securityHeaders);
indexerRouter.use(indexerHealthRouter);

/**
 * POST /api/indexer
 * Runs poll cycles or indexer actions after validating incoming request payloads.
 */
indexerRouter.post("/", async (req: Request, res: Response): Promise<void> => {
  const result = indexerRequestSchema.safeParse(req.body);

  if (!result.success) {
    const formattedErrors = result.error.issues.map((issue) => ({
      field: issue.path.join(".") || "body",
      message: issue.message,
      code: issue.code,
    }));

    res.status(400).json({
      error: "Bad Request",
      message: "Validation failed for /api/indexer request parameters.",
      details: formattedErrors,
    });
    return;
  }

  const { action } = result.data;

  try {
    if (action === "poll") {
      await runPollCycle();
    }

    res.status(200).json({
      success: true,
      data: result.data,
    });
  } catch (error) {
    res.status(500).json({
      error: "Internal Server Error",
      message: error instanceof Error ? error.message : "An unexpected error occurred",
    });
  }
});

export { createIndexerHealthRouter, indexerHealthRouter };