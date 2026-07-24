import { envSchema, type Env } from "./env-schema";
import { formatEnvErrors } from "./env-schema";

const result = envSchema.safeParse(process.env);

if (!result.success) {
  console.error("❌ Invalid environment variables:\n" + formatEnvErrors(result.error));
  process.exit(1);
}

export const env: Env = result.data;