import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../utils/cursor';

export const featureFlagsQuerySchema = z.object({
  environment: z.enum(['development', 'testnet', 'mainnet']).optional(),
  clientVersion: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
});

export type FeatureFlagsQuery = z.infer<typeof featureFlagsQuerySchema>;
