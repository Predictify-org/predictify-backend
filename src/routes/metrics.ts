import { Router } from "express";
import { register } from "../metrics/registry";

export const metricsRouter = Router();

metricsRouter.get("/", async (_req, res) => {
  const metricsAuthToken = process.env.METRICS_AUTH_TOKEN;

  if (metricsAuthToken) {
    const header = _req.headers.authorization;
    if (!header || header !== `Bearer ${metricsAuthToken}`) {
      res.status(401).json({ error: { type: "Unauthorized", message: "Invalid or missing metrics token" } });
      return;
    }
  }

  res.set("Content-Type", register.contentType);
  res.send(await register.metrics());
});
