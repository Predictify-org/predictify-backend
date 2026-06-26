import express from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { v4 as uuidv4 } from "uuid";
import { env } from "./config/env";
import { logger } from "./config/logger";
import { healthRouter } from "./routes/health";
import { marketsRouter } from "./routes/markets";
import { adminUsersRouter } from "./routes/adminUsers";
import { errorHandler } from "./middleware/errorHandler";
import { connectWithRetry, closeDb } from "./db/client";

export interface AppDeps {
  /**
   * Webhook store + dispatcher. Optional so tests can inject an in-memory
   * implementation. When omitted, production wiring (drizzle + fetch) is built
   * lazily — importing this module never opens a DB connection by side effect.
   */
  webhooks?: AdminWebhookDeps;
}

function buildProductionWebhookDeps(): AdminWebhookDeps {
  // Imported lazily so test/tooling imports don't require a live database.
  const { getDb } = require("./db/client") as typeof import("./db/client");
  const { DrizzleWebhookStore } =
    require("./services/drizzleWebhookStore") as typeof import("./services/drizzleWebhookStore");
  const { WebhookDispatcher } =
    require("./services/webhookDispatcher") as typeof import("./services/webhookDispatcher");

  const store = new DrizzleWebhookStore(getDb());
  const dispatcher = new WebhookDispatcher({
    store,
    signingSecret: env.WEBHOOK_SIGNING_SECRET,
  });
  return { store, dispatcher };
}

export function createApp(deps: AppDeps = {}): express.Express {
  const app = express();

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

  app.use("/api/markets", marketsRouter);
  app.use("/api/admin/users", adminUsersRouter);

  app.get("/metrics", async (_req, res) => {
    const metricsAuthToken = process.env.METRICS_AUTH_TOKEN;
    if (metricsAuthToken && _req.headers.authorization !== `Bearer ${metricsAuthToken}`) {
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
