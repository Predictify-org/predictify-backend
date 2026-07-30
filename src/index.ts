import express from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { v4 as uuidv4 } from "uuid";
import { env } from "./config/env";
import { logger } from "./config/logger";
import { metricsMiddleware } from "./metrics/httpMetrics";
import { metricsHistogramMiddleware } from "./middleware/metricsHistogram";
import { correlationMiddleware } from "./middleware/correlation";
import { deprecationMiddleware } from "./middleware/deprecation";
import { fingerprintMiddleware } from "./middleware/fingerprint";
import { accessLog } from "./middleware/accessLog";
import { idempotency } from "./middleware/idempotency";
import { defaultBodySizeLimitMiddleware, webhookBodySizeLimitMiddleware } from "./middleware/bodySize";
import { healthRouter } from "./routes/health";
import healthzDependenciesRouter from "./routes/healthz/dependencies";
import { createReadyRouter } from "./routes/health/ready";
import { dependenciesRouter } from "./routes/health/dependencies";
import { versionRouter } from "./routes/health/version";
import { redisConnection } from "./queue";
import { authRouter } from "./routes/auth";
import { adminRouter } from "./routes/admin";
import { recommendationsRouter } from "./routes/recommendations";
import { recommendationsHealthRouter } from "./routes/recommendations/health";
import { tagsRouter } from "./routes/tags";
import { auditRouter } from "./routes/audit";
import { marketsRouter } from "./routes/markets";
import { commentsRouter } from "./routes/comments";
import { usersRouter } from "./routes/users";
import { predictionsRouter } from "./routes/predictions";
import { usersHealthRouter } from "./routes/users/health";
import { exportsPredictionsRouter } from "./routes/exports/predictions";
import { userPortfolioRouter } from "./routes/users/portfolio";
import { statsRouter } from "./routes/stats";
import { userStatsRouter } from "./routes/users/stats";
import { devicesRouter } from "./routes/devices";
import { devicesRevokeRouter } from "./routes/devicesRevoke";
import { featureFlagsRouter } from "./routes/feature-flags";
import { adminFeatureFlagsRouter } from "./routes/admin/featureFlags";
import { adminUsersRouter } from "./routes/adminUsers";
import { adminNotesRouter } from "./routes/admin/users/notes";
import { adminImpersonateRouter } from "./routes/admin/users/impersonate";
import { leaderboardRouter } from "./routes/leaderboard";
import { globalLeaderboardRouter } from "./routes/leaderboard/global";
import { createDocsRouter } from "./routes/docs";
import { searchRouter } from "./routes/search";

import { sessionsRouter } from "./routes/me/sessions";
import { referralsRouter } from "./routes/referrals";
import { notificationsRouter } from "./routes/notifications";
import { socialRouter } from "./routes/social";
import { webhooksRouter } from "./routes/webhooks";
import { webhooksHealthRouter } from "./routes/webhooks/health";
import { adminAuditRouter } from "./routes/admin/audit";
import { adminAuditExportRouter } from "./routes/admin/audit/export";
import { auditCountsRouter } from "./routes/audit/counts";
import { auditHealthRouter } from "./routes/audit/health";
import { userAuditRouter } from "./routes/audit/user";
import { adminHealthRouter } from "./routes/admin/health";
import { adminMarketsRouter } from "./routes/admin/markets";
import { adminSchemaVersionsRouter } from "./routes/admin/schema-versions";
import { errorHandler } from "./middleware/errorHandler";
import { requestContextStorage } from "./lib/requestContext";
import { REQUEST_ID_HEADER } from "./lib/http";
import { register } from "./metrics/registry";
import { connectWithRetry, closeDb, db } from "./db/client";
import { stopScheduler } from "./services/scheduler";
import { startIndexerHealthProbe, stopIndexerHealthProbe } from "./jobs/indexerHealthProbe";
import { indexerHealthRouter } from "./routes/indexer/health";
import { indexerCursorRouter } from "./routes/indexer/cursor";
import { WebhookWorker } from "./workers/webhookWorker";
import { marketResolverWorker } from "./workers/marketResolver";
import { backupVerificationWorker } from "./workers/backupVerificationWorker";
import { reconciliationWorker } from "./workers/reconciliationWorker";
import { rateLimitRouter } from "./routes/rate-limit";
import { adminRateLimitInspectRouter } from "./routes/admin/rate-limit/inspect";
import { adminBroadcastRouter } from "./routes/admin/notifications/broadcast";
import { quotaRequestsRouter } from "./routes/quota/requests";
import { startSlowQueryAlerter } from "./workers/slowQueryAlerter";
import { reportsRouter } from "./routes/reports";
import { exportsRouter } from "./routes/exports";
import { fingerprintRouter } from "./routes/fingerprint";
import { alertsRouter } from "./routes/alerts";
import { gracefulShutdown } from "./lifecycle/shutdown";
import { perUserConcurrency } from "./middleware/perUserConcurrency";


const docsEnabled =
  process.env.ENABLE_DOCS === "true" ||
  (env.NODE_ENV !== "test" && env.NODE_ENV !== "production");

const REQUEST_ID_MAX_LENGTH = 64;

function sanitizeRequestId(raw: string): string | undefined {
  const sanitized = raw
    .slice(0, REQUEST_ID_MAX_LENGTH)
    .replace(/[^A-Za-z0-9\-_.]/g, "");
  return sanitized.length > 0 ? sanitized : undefined;
}

export function createApp(): express.Express {
  const app = express();

  app.set("etag", false);

  if (env.TRUST_PROXY) {
    app.set("trust proxy", true);
  }

  if (docsEnabled) {
    app.use("/docs", createDocsRouter());
  }

  app.use(helmet());

  app.use(
    pinoHttp({
      logger,
      genReqId(req) {
        const inbound = req.headers[REQUEST_ID_HEADER];
        const raw = Array.isArray(inbound) ? inbound[0] : inbound;
        return (raw && sanitizeRequestId(raw)) ?? uuidv4();
      },
      customProps(req) {
        return { reqId: (req as { id?: string }).id };
      },
    }),
  );

  app.use(
    (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      const requestId = String((req as { id?: unknown }).id);
      res.setHeader(REQUEST_ID_HEADER, requestId);
      requestContextStorage.run({ requestId }, next);
    },
  );

  // Resolve, echo, and propagate X-Correlation-Id for every request.
  // Runs after the ALS context is established so correlationMiddleware can
  // extend the existing store with the `correlationId` field.
  app.use(correlationMiddleware);
  app.use(deprecationMiddleware);

  app.use("/api/admin/webhooks", webhookBodySizeLimitMiddleware);
  app.use(defaultBodySizeLimitMiddleware);

  // Compute a stable SHA-256 fingerprint for every request.
  // Mounted after body-parsing middleware so that req.body is available
  // for the fingerprint body-hash computation, and after ALS context +
  // correlationMiddleware so correlationId is available for logging.
  app.use(fingerprintMiddleware);

  app.use(metricsMiddleware);
  app.use(metricsHistogramMiddleware);
  app.use("/health", healthRouter);
  app.use("/healthz/dependencies", healthzDependenciesRouter);
  app.use("/api/health/ready", createReadyRouter({ db, redis: redisConnection }));
  app.use("/api/health/dependencies", dependenciesRouter);
  app.use("/api/health/version", versionRouter);
  app.use("/api/health", healthRouter);
  app.use("/api/indexer", indexerHealthRouter);
  app.use("/api/indexer/cursor", indexerCursorRouter);

  // Cap in-flight concurrent requests per user/IP before any API route handler
  // runs. This prevents a single identity from exhausting the thread / DB-pool
  // by holding many connections open simultaneously.
  // Configured via MAX_CONCURRENT_REQUESTS_PER_USER (default: 10).
  app.use("/api", perUserConcurrency);

  const mutationMethods = ["POST", "PATCH"] as const;
  app.use("/api", (req, res, next) =>
    mutationMethods.includes(req.method as (typeof mutationMethods)[number])
      ? idempotency(req, res, next)
      : next(),
  );

  app.use("/api/auth", authRouter);
  app.use("/api/recommendations/health", recommendationsHealthRouter);
  app.use("/api/recommendations", recommendationsRouter);
  app.use("/api/tags", tagsRouter);
  app.use("/api/audit", auditRouter);
  app.use("/api/markets", marketsRouter);
  app.use("/api/markets", commentsRouter);
  app.use("/api/comments", commentsRouter);
  app.use("/api/predictions", predictionsRouter);
  app.use("/api/leaderboard", leaderboardRouter);
  app.use("/api/leaderboard/global", globalLeaderboardRouter);
  app.use("/api/rate-limit", rateLimitRouter);
  app.use("/api/search", searchRouter);
  app.use("/api/quota/requests", quotaRequestsRouter);
  app.use("/api/notifications", notificationsRouter);
  app.use("/api/webhooks/health", webhooksHealthRouter);
  app.use("/api/users/health", usersHealthRouter);
  app.use("/api/stats", statsRouter);
  app.use("/api/users", socialRouter);
  app.use("/api/users", userPortfolioRouter);
  app.use("/api/users", userStatsRouter);
  app.use("/api/users", usersRouter);
  app.use("/api/predictions", predictionsRouter);
  app.use("/api/me/devices", devicesRouter);

  // Structured access logging for /api/admin — captures req-id, latency,
  // status, response size, and actor for every admin request.
  // Mounted before the first admin route registration so the finish handler
  // is set up ahead of actual route handlers.
  app.use("/api/admin", accessLog);
  app.use("/api/me/devices/:id/revoke", devicesRevokeRouter);
  app.use("/api/me/sessions", sessionsRouter);
  app.use("/api/admin/audit", adminAuditRouter);
  app.use("/api/admin/audit", adminAuditExportRouter);
  app.use("/api/audit/health", auditHealthRouter);
  app.use("/api/audit/counts", auditCountsRouter);
  app.use("/api/audit/user", userAuditRouter);
  app.use("/api/admin/health", adminHealthRouter);
  // Mounted ahead of the other /api/admin/users routers: it only matches
  // POST /:address/impersonate and attaches its rate limit and admin guard to
  // that route alone, so unrelated requests fall straight through untouched.
  app.use("/api/admin/users", adminImpersonateRouter);
  app.use("/api/admin/users", adminUsersRouter);
  app.use("/api/admin/users", adminNotesRouter);
  app.use("/api/feature-flags", featureFlagsRouter);
  app.use("/api/admin/feature-flags", adminFeatureFlagsRouter);
  app.use("/api/admin/markets", adminMarketsRouter);
  app.use("/api/admin/schema-versions", adminSchemaVersionsRouter);
  app.use("/api/admin/rate-limit", adminRateLimitInspectRouter);
  app.use("/api/admin/notifications/broadcast", adminBroadcastRouter);
  app.use("/api/reports", reportsRouter);
  app.use("/api/exports", exportsRouter);
  app.use("/api/fingerprint", fingerprintRouter);
  app.use("/api/alerts", alertsRouter);
  app.use("/api/referrals", referralsRouter);

  app.get("/metrics", async (req, res) => {
    const metricsAuthToken = process.env.METRICS_AUTH_TOKEN;
    if (
      metricsAuthToken &&
      req.headers.authorization !== `Bearer ${metricsAuthToken}`
    ) {
      res.status(401).send("Unauthorized");
      return;
    }

    res.set("Content-Type", register.contentType);
    res.send(await register.metrics());
  });

  app.use(errorHandler);
  return app;
}

if (require.main === module) {
  const app = createApp();
  let webhookWorker: WebhookWorker | null = null;

  connectWithRetry()
    .then(() => {
      webhookWorker = new WebhookWorker(db);
      webhookWorker.start();
      marketResolverWorker.start();
      backupVerificationWorker.start();
      reconciliationWorker.start();
      startSlowQueryAlerter();
      startIndexerHealthProbe();

      app.listen(env.PORT, () => {
        logger.info({ port: env.PORT, env: env.NODE_ENV }, "predictify-backend listening");
        if (env.ENABLE_DOCS) {
          logger.info(`Swagger UI available at http://localhost:${env.PORT}/docs`);
        }
      });

      const handleShutdown = async (signal: string) => {
        logger.info({ signal }, "shutdown_signal_received");
        setAuthDraining(true);

        const forceExit = setTimeout(() => {
          logger.warn("Forced exit after shutdown timeout");
          process.exit(1);
        }, 10000).unref();

        try {
          logger.info("Draining in-flight /api/auth requests...");
          await waitForAuthDrain(5000);
          logger.info("In-flight /api/auth requests drained successfully");

          stopScheduler();
          await closeDb();
          clearTimeout(forceExit);
          logger.info("Shutdown completed successfully");
          process.exit(0);
        } catch (err) {
          logger.error({ err }, "Error during shutdown");
          clearTimeout(forceExit);
          process.exit(1);
        }
      };

      process.on("SIGTERM", () => handleShutdown("SIGTERM"));
      process.on("SIGINT", () => handleShutdown("SIGINT"));
    })
    .catch((err) => {
      logger.fatal({ err }, "Failed to start server");
      process.exit(1);
    });
}
