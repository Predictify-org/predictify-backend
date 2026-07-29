/**
 * @module routes/indexer
 *
 * Router for `/api/indexer` endpoints, ensuring standard API security headers
 * (`Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy`)
 * are set on all responses.
 */

import { Router } from "express";
import { securityHeaders } from "../middleware/securityHeaders";
import {
  createIndexerHealthRouter,
  indexerHealthRouter,
} from "./indexer/health";

export const indexerRouter = Router();

// Apply security response headers to all /api/indexer routes
indexerRouter.use(securityHeaders);
indexerRouter.use(indexerHealthRouter);

export { createIndexerHealthRouter, indexerHealthRouter };
