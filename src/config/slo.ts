// src/config/slo.ts
import { z } from "zod";

/**
 * Per‑endpoint SLO configuration.
 * Keys are route patterns (as produced by the metricsHistogram middleware after sanitization).
 * Use "*" as a wildcard default for any route not explicitly defined.
 */
export const sloConfigSchema = z.object({
  latencySec: z.number().positive().optional(),
  errorRate: z.number().min(0).max(1).optional(),
  windowSec: z.number().positive().optional(),
});

type ConfigMap = Record<string, z.infer<typeof sloConfigSchema>>;

export const sloConfigMap: ConfigMap = {
  // Default configuration applying to all routes unless overridden.
  "*": {
    latencySec: 1, // seconds
    errorRate: 0.01, // 1% errors allowed
    windowSec: 300, // 5-minute rolling window
  },
  // Example of a custom endpoint configuration (override as needed).
  // "/api/feature-flags": { latencySec: 0.5, errorRate: 0.005, windowSec: 60 },
};
