import { createApp } from "./index";
import { env } from "./config/env";
import { logger } from "./config/logger";
import { connectWithRetry, closeDb, db } from "./db/client";
import { stopScheduler } from "./services/scheduler";
import { startIndexerHealthProbe } from "./jobs/indexerHealthProbe";
import { WebhookWorker } from "./workers/webhookWorker";
import { marketResolverWorker } from "./workers/marketResolver";
import { backupVerificationWorker } from "./workers/backupVerificationWorker";
import { reconciliationWorker } from "./workers/reconciliationWorker";
import { startSlowQueryAlerter } from "./workers/slowQueryAlerter";
import { startPredictionsConfirmer } from "./workers/predictionsConfirmer";
import { drainSearchRequests } from "./routes/search";
import { drainExportsRequests } from "./routes/exports";

const app = createApp();
let webhookWorker: WebhookWorker | null = null;
let probeHandle: ReturnType<typeof setInterval> | null = null;
let predictionsConfirmerHandle: ReturnType<typeof setInterval> | null = null;

connectWithRetry()
  .then(() => {
    webhookWorker = new WebhookWorker(db);
    webhookWorker.start();
    marketResolverWorker.start();
    backupVerificationWorker.start();
    reconciliationWorker.start();
    startSlowQueryAlerter();
    predictionsConfirmerHandle = startPredictionsConfirmer();
    probeHandle = startIndexerHealthProbe();

    const server = app.listen(env.PORT, () => {
      logger.info({ port: env.PORT, env: env.NODE_ENV }, "predictify-backend listening");
      if (env.ENABLE_DOCS) {
        logger.info(`Swagger UI available at http://localhost:${env.PORT}/docs`);
      }
    });

    const shutdown = async () => {
      logger.info("SIGTERM/SIGINT received, shutting down gracefully");
      const forceExit = setTimeout(() => {
        logger.warn("Forced exit after shutdown timeout");
        process.exit(1);
      }, 5000).unref();

      // Ensure in-flight /api/search requests finish
      await drainSearchRequests(4000);
      // Ensure in-flight /api/exports requests finish
      await drainExportsRequests(4000);

      stopScheduler();
      await closeDb();
      clearTimeout(forceExit);
      process.exit(0);
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  })
  .catch((err) => {
    logger.fatal({ err }, "Failed to start server");
    process.exit(1);
  });
