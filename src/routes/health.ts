import { Router } from "express";
import { createAuditLog } from "../services/auditService";
import { getRequestId } from "../lib/requestContext";
import { db } from "../db/client";
import { auditLogs } from "../db/schema";
import { eq, desc } from "drizzle-orm";
import { requestTimeout, abortableRace } from "../middleware/timeout";

export const healthRouter = Router();

// Apply a 5000ms timeout with a 504 status code to all health routes
healthRouter.use(requestTimeout(5000, { statusCode: 504 }));

healthRouter.get("/", async (_req, res, next) => {
  try {
    const [latest] = await abortableRace(
      db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, "health.state_mutation"))
        .orderBy(desc(auditLogs.createdAt))
        .limit(1),
      res.locals.abortSignal
    );

    const state = (latest?.afterState as Record<string, unknown>) || { mode: "active", maintenance: false };
    res.json({ status: "ok", state });
  } catch (err) {
    next(err);
  }
});

healthRouter.post("/mutations", async (req, res, next) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const correlationId = getRequestId();

    const [latest] = await abortableRace(
      db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, "health.state_mutation"))
        .orderBy(desc(auditLogs.createdAt))
        .limit(1),
      res.locals.abortSignal
    );

    const beforeState = (latest?.afterState as Record<string, unknown>) || { mode: "active", maintenance: false };

    // Apply changes from body payload
    const afterState = { ...beforeState, ...req.body };

    await abortableRace(
      createAuditLog({
        action: "health.state_mutation",
        ip,
        correlationId,
        beforeState,
        afterState,
      }),
      res.locals.abortSignal
    );

    res.json({ status: "updated", state: afterState });
  } catch (err) {
    next(err);
  }
});
