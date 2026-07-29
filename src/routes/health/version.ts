import { Router, Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import { logger } from "../../config/logger";
import pkg from "../../../package.json";

const APP_VERSION = pkg.version;

export interface VersionInfo {
  version: string;
  commitSha: string;
  correlationId: string;
  checkedAt: string;
}

function resolveCommitSha(): string {
  return (
    process.env.GIT_COMMIT_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    "unknown"
  );
}

export function createVersionRouter(): Router {
  const router = Router();

  router.get(
    "/",
    (_req: Request, res: Response, next: NextFunction): void => {
      const correlationId =
        ((_req.headers["x-correlation-id"] as string | undefined) ?? "").trim() ||
        randomUUID();

      const requestStart = Date.now();

      try {
        const commitSha = resolveCommitSha();

        logger.info(
          {
            correlationId,
            version: APP_VERSION,
            commitSha,
            elapsedMs: Date.now() - requestStart,
          },
          "health_version_check_complete",
        );

        res.status(200).json({
          version: APP_VERSION,
          commitSha,
          correlationId,
          checkedAt: new Date().toISOString(),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

export const versionRouter = createVersionRouter();
