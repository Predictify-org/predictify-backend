import express from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { env } from "./config/env";
import { logger } from "./config/logger";
import { healthRouter } from "./routes/health";
import { marketsRouter } from "./routes/markets";
import { predictionsRouter } from "./routes/predictions";
import { errorHandler } from "./middleware/errorHandler";

export function createApp(): express.Express {
  const app = express();
  app.use(helmet());
  app.use(express.json({ limit: "256kb" }));
  app.use(pinoHttp({ logger }));

  app.use("/health", healthRouter);
  app.use("/api/markets", marketsRouter);
  app.use("/api/markets/:id/predictions", predictionsRouter);

  app.use(errorHandler);
  return app;
}

if (require.main === module) {
  const app = createApp();
  app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, "predictify-backend listening");
  });
}
