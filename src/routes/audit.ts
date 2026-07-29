import { Router } from "express";
import { accessLog } from "../middleware/accessLog";
import { auditCors } from "../middleware/cors";

export const auditRouter = Router();

// Enforce CORS allowlist early so unapproved origins are rejected
// before any processing (preflight responses cached via Access-Control-Max-Age).
auditRouter.use(auditCors());

// Apply structured access log middleware to all routes in this router
auditRouter.use(accessLog);

/**
 * @openapi
 * /api/audit:
 *   get:
 *     summary: Retrieve audit logs
 *     description: Returns a list of audit events. Used to test the audit access log.
 *     tags:
 *       - Audit
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 10
 *         description: Maximum number of events to return
 *     responses:
 *       200:
 *         description: A list of audit events
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 events:
 *                   type: array
 *                   items:
 *                     type: object
 *       400:
 *         description: Invalid input
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
auditRouter.get("/", (req, res) => {
  const limitQuery = req.query.limit;
  const limit = limitQuery ? parseInt(limitQuery as string, 10) : 10;
  
  if (isNaN(limit) || limit < 1 || limit > 100) {
    res.status(400).json({ error: { code: "invalid_input", message: "Limit must be between 1 and 100" } });
    return;
  }

  // Placeholder for real audit events
  res.json({ events: [] });
});
