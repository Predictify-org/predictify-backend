import { Router, type Request, type Response, type NextFunction } from "express";
import { cleanupIdempotencyKeys } from "../../workers/cleanupIdempotency";
import { logger } from "../../config/logger";

export const internalJobsRouter = Router();

function requireInternalToken(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.INTERNAL_JOB_TOKEN;
  if (!expected) {
    res.status(404).json({ error: { type: "NotFound" } });
    return;
  }
  const header = req.headers.authorization;
  if (header !== `Bearer ${expected}`) {
    res.status(401).json({ error: { type: "Unauthorized" } });
    return;
  }
  next();
}

internalJobsRouter.use(requireInternalToken);

internalJobsRouter.post(
  "/cleanup-idempotency-keys",
  async (_req, res, next) => {
    try {
      const deleted = await cleanupIdempotencyKeys();
      logger.info({ deleted }, "internal_cleanup_idempotency_triggered");
      return res.status(200).json({ data: { deleted } });
    } catch (err) {
      return next(err);
    }
  },
);
