import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { Transform } from "stream";
import { requireAdmin } from "../../../middleware/requireAdmin";
import { getAuditLogsStream } from "../../../repositories/auditLogRepo";
import { getRequestId } from "../../../lib/requestContext";
import { logger } from "../../../config/logger";
import { startAuditSpan, endAuditSpan, recordErrorOnSpan } from "../../../otel/spans";

export interface AdminAuditExportRouterOptions {
  rateLimitPerMinute?: number;
  maxRecords?: number;
}

const exportQuerySchema = z.object({
  action: z.string().optional(),
  actor: z.string().optional(),
  startDate: z.string()
    .datetime({ message: "startDate must be a valid ISO 8601 datetime string" })
    .transform((val) => new Date(val))
    .optional(),
  endDate: z.string()
    .datetime({ message: "endDate must be a valid ISO 8601 datetime string" })
    .transform((val) => new Date(val))
    .optional(),
});

export function createAdminAuditExportRouter(
  opts: AdminAuditExportRouterOptions = {},
): Router {
  const router = Router();
  const rateLimitPerMinute = opts.rateLimitPerMinute ?? 10;
  const maxRecords = opts.maxRecords ?? 100_000;

  router.use(
    rateLimit({
      windowMs: 60_000,
      limit: rateLimitPerMinute,
      keyGenerator: (req) =>
        (req.headers.authorization as string | undefined) ?? req.ip ?? "unknown",
      standardHeaders: "draft-6",
      legacyHeaders: false,
      message: { error: { code: "rate_limit_exceeded" } },
    }),
  );

  router.use(requireAdmin);

  router.get("/export", async (req, res, next) => {
    const requestId = getRequestId();
    // For the streaming export handler the span is ended when the response
    // stream finishes, not when the initial handler returns.  Hook into
    // response "finish" / "close" / error events so the span duration
    // reflects the real export time and stream errors are recorded.
    const span = startAuditSpan("audit.admin.export", req, res);

    try {
      const parseResult = exportQuerySchema.safeParse(req.query);
      if (!parseResult.success) {
        const reqId = getRequestId();
        res.status(400);
        endAuditSpan(span, res);
        res.json({
          error: {
            code: "validation_error",
            message: parseResult.error.issues[0]?.message ?? "invalid query parameters",
            requestId: reqId,
          },
        });
        return;
      }

      const filters = parseResult.data;

      logger.info(
        {
          event: "audit_export_started",
          requestId,
          adminAddress: req.adminAddress,
          filters,
        },
        "Starting audit log export stream",
      );

      res.setHeader("Content-Type", "application/x-ndjson");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="audit-export-${Date.now()}.ndjson"`,
      );

      let recordCount = 0;

      const ndjsonTransform = new Transform({
        writableObjectMode: true,
        readableObjectMode: false,
        transform(chunk: unknown, _encoding, callback) {
          try {
            const line = JSON.stringify(chunk) + "\n";
            callback(null, line);
          } catch (err) {
            callback(err instanceof Error ? err : new Error(String(err)));
          }
        },
      });

      ndjsonTransform.on("error", (err) => {
        logger.error(
          {
            event: "audit_export_stream_error",
            requestId,
            error: err.message,
          },
          "Error in NDJSON transform stream",
        );
        recordErrorOnSpan(span, err);
        // span is ended in the response "close" handler below
      });

      ndjsonTransform.pipe(res);

      const stream = getAuditLogsStream(filters);

      (async () => {
        try {
          for await (const record of stream) {
            recordCount++;

            if (recordCount > maxRecords) {
              ndjsonTransform.end();
              logger.warn(
                {
                  event: "audit_export_max_records_reached",
                  requestId,
                  maxRecords,
                },
                "Audit export reached maximum record limit",
              );
              return;
            }

            if (recordCount % 10_000 === 0) {
              logger.info(
                {
                  event: "audit_export_progress",
                  requestId,
                  recordCount,
                },
                "Audit export streaming progress",
              );
            }

            ndjsonTransform.write(record);
          }

          ndjsonTransform.end();
          logger.info(
            {
              event: "audit_export_completed",
              requestId,
              recordCount,
            },
            "Audit export stream completed successfully",
          );
        } catch (err) {
          logger.error(
            {
              event: "audit_export_db_stream_error",
              requestId,
              error: err instanceof Error ? err.message : String(err),
            },
            "Error streaming audit logs for export",
          );

          if (!res.headersSent) {
            res.status(500);
            endAuditSpan(span, res);
            res.json({
              error: {
                code: "export_error",
                message: "Failed to stream audit logs",
                requestId,
              },
            });
          } else {
            ndjsonTransform.destroy(
              err instanceof Error ? err : new Error(String(err)),
            );
          }
        }
      })();

      req.on("close", () => {
        if (!res.writableEnded) {
          logger.info(
            {
              event: "audit_export_client_disconnect",
              requestId,
              recordCount,
            },
            "Client disconnected before audit export completed",
          );
          recordErrorOnSpan(span, new Error("client_disconnected"));
          ndjsonTransform.destroy();
        }
      });

      // End the span when the response finishes.  This covers:
      // - natural stream completion (res "finish")
      // - client disconnect (res "close")
      // - stream errors that don't already trigger "finish"
      const endSpanOnResponseFinish = () => {
        if (span.isRecording()) {
          endAuditSpan(span, res);
        }
      };
      res.on("finish", endSpanOnResponseFinish);
      res.on("close", () => {
        if (span.isRecording()) {
          // If "finish" already ran, this is a no-op (span already ended).
          endAuditSpan(span, res);
        }
      });
    } catch (err) {
      logger.error(
        {
          event: "audit_export_unexpected_error",
          requestId,
          error: err instanceof Error ? err.message : String(err),
        },
        "Unexpected error in audit export endpoint",
      );
      recordErrorOnSpan(span, err);
      span.end();
      next(err);
    }
  });

  return router;
}

export const adminAuditExportRouter = createAdminAuditExportRouter();
