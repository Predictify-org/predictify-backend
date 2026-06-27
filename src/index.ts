import express from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { env } from "./config/env";
import { logger } from "./config/logger";
import { healthRouter } from "./routes/health";
import { marketsRouter } from "./routes/markets";
import { usersRouter } from "./routes/users";
import { createDocsRouter } from "./routes/docs";
import { adminSeedRouter } from "./routes/admin/seed";
import { errorHandler } from "./middleware/errorHandler";
import { connectWithRetry, closeDb } from "./db/client";

export function createApp(): express.Express {
  const app = express();

  // ── Swagger UI docs (scoped relaxed CSP) ──────────────────────────────
  // Must be mounted BEFORE the global helmet() so /docs receives its own
  // relaxed Content-Security-Policy. See docs/security.md.
  app.use("/docs", createDocsRouter());

  // ── Global strict CSP (everything except /docs) ───────────────────────
  app.use(helmet());
  app.use(express.json({ limit: "256kb" }));
  app.use(pinoHttp({ logger }));
  app.use(metricsMiddleware);

  app.use("/health", healthRouter);

  // Idempotency guard for all state-mutating routes under /api.
  // Must be mounted before the routers it protects.
  const mutationMethods = ["POST", "PATCH"] as const;
  app.use("/api", (req, res, next) =>
    mutationMethods.includes(req.method as (typeof mutationMethods)[number])
      ? idempotency(req, res, next)
      : next(),
  );

  app.use("/api/auth", authRouter);
  app.use("/api/admin/seed", adminSeedRouter);
  app.use("/api/markets", marketsRouter);
  app.use("/api/users", usersRouter);

  app.use(errorHandler);
  return app;
}

if (require.main === module) {
  const app = createApp();

  connectWithRetry()
    .then(() => {
      app.listen(env.PORT, () => {
        logger.info({ port: env.PORT, env: env.NODE_ENV }, "predictify-backend listening");
      });
    })
    .catch((err) => {
      logger.fatal({ err }, "Failed to start server");
      process.exit(1);
    });

  process.on("SIGTERM", async () => {
    logger.info("SIGTERM received, shutting down");
    const forceExit = setTimeout(() => {
      logger.warn("Forced exit after shutdown timeout");
      process.exit(1);
    }, 5000).unref();

    await closeDb();
    clearTimeout(forceExit);
    process.exit(0);
  });
  
  // Graceful shutdown
  process.on("SIGTERM", () => {
    logger.info("SIGTERM received, shutting down gracefully");
    stopScheduler();
    process.exit(0);
  });
  
  process.on("SIGINT", () => {
    logger.info("SIGINT received, shutting down gracefully");
    stopScheduler();
    process.exit(0);
  });
}
