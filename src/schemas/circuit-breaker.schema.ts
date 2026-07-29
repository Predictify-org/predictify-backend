import { z } from "zod";

export const circuitBreakerTypeSchema = z.enum(["indexer", "webhook"]);

export const circuitBreakerToggleSchema = z
  .object({
    type: circuitBreakerTypeSchema,
    enabled: z.boolean(),
  })
  .strict();

export const circuitBreakerMultiToggleSchema = z
  .object({
    indexer: z.boolean().optional(),
    webhook: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.indexer !== undefined || v.webhook !== undefined, {
    message: "at least one of indexer or webhook is required",
  });

export type CircuitBreakerToggle = z.infer<typeof circuitBreakerToggleSchema>;
export type CircuitBreakerMultiToggle = z.infer<typeof circuitBreakerMultiToggleSchema>;