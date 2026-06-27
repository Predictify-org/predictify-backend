import { Router } from "express";
import { register } from "../metrics/registry";

export const metricsRouter = Router();

function authorized(authHeader: string | undefined): boolean {
  const token = process.env.METRICS_AUTH_TOKEN;
  if (!token) return true;
  return authHeader === `Bearer ${token}`;
}

metricsRouter.get("/", async (req, res, next) => {
  try {
    if (!authorized(req.header("authorization"))) {
      res.status(401).json({ error: { code: "metrics_unauthorized" } });
      return;
    }

    res.setHeader("Content-Type", register.contentType);
    res.send(await register.metrics());
  } catch (err) {
    next(err);
  }
});
