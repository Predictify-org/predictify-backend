import { envSchema, formatEnvErrors } from "./env-schema";

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  if (process.env.NODE_ENV !== "test") {
    console.error("❌ Invalid environment configuration:\n" + formatEnvErrors(parsed.error));
    process.exit(1);
  }
}

export const env = parsed.success
  ? parsed.data
  : ({} as ReturnType<typeof envSchema.parse>);
