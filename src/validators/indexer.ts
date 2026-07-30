import { z } from "zod";

export const indexerRequestSchema = z.object({
  action: z.enum(["start", "stop", "poll", "status"], {
    errorMap: () => ({
      message: "Action must be one of: 'start', 'stop', 'poll', or 'status'",
    }),
  }),
  limit: z
    .number()
    .int()
    .min(1, "Limit must be at least 1")
    .max(500, "Limit cannot exceed 500")
    .optional()
    .default(50),
  force: z.boolean().optional().default(false),
});

export type IndexerRequestInput = z.infer<typeof indexerRequestSchema>;