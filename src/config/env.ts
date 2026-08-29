import { envSchema, formatEnvErrors } from "./env-schema";

if (!parsed.success) {
  if (process.env.NODE_ENV !== "test") {
    console.error("“ invalid environment configuration:\n" + formatEnvErrors(parsed.error));
    process.exit(1);
  }
}

export const env = Object.freeze({
  ...(parsed.success ? parsed.data : {}),
  anomalyDetectorMaxMemoryEntries: Math.min(Number(process.env.ANOMALY_DETECTOR_MAX_MEMORY_ENTRIES)||10000, 100000),
  anomalyDetectorMaxAlertCardinality: Math.min(Number(process.env.ANOMALY_DETECTOR_MAX_ALERT_CARDINALITY)||1000, 10000),
});
