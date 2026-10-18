import pino from "pino";
import { envSchema, formatEnvErrors } from "./env-schema";

const _logger = pino({ level: "warn", base: { service: "predictify-backend" } });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  if (process.env.NODE_ENV !== "test") {
    console.error("❌ Invalid environment configuration:\n" + formatEnvErrors(parsed.error));
    throw parsed.error;
  }
}

export const env = parsed.success
  ? parsed.data
  : ({} as ReturnType<typeof envSchema.parse>);

if (parsed.success) {
  const _minTtl = env.WORKER_HEARTBEAT_SECONDS * 2;
  if (env.JWT_TTL_SECONDS < _minTtl * 1.1) {
    _logger.warn(
      { JWT_TTL_SECONDS: env.JWT_TTL_SECONDS, minimumRecommended: _minTtl },
      `JWT_TTL_SECONDS is within 10% of the minimum bound (${_minTtl}). Increase it to avoid worker token-expiry issues.`
    );
  }
}

