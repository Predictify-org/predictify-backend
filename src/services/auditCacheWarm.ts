import { env } from "../config/env";
import { logger } from "../config/logger";
import { v4 as uuidv4 } from "uuid";

/**
 * Warms the /api/audit cache at startup.
 * Makes an HTTP request to the local audit endpoint to ensure
 * caching layers are primed, mitigating cold-cache latency spikes.
 */
export async function warmAuditCache(): Promise<void> {
  const correlationId = uuidv4();
  const url = `http://localhost:${env.PORT}/api/audit?limit=10`;

  try {
    logger.info({ correlationId, url }, "Starting audit cache warm");

    // Make an internal request to our own server, using native fetch.
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "x-correlation-id": correlationId,
        "x-audit-cache-warm": "true",
      },
      // Timeout relatively short to prevent hanging indefinitely
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`Failed to warm audit cache, status: ${response.status}`);
    }

    logger.info(
      { correlationId, status: response.status },
      "Audit cache warm completed successfully",
    );
  } catch (err) {
    logger.warn({ err, correlationId, url }, "Audit cache warm failed");
  }
}
