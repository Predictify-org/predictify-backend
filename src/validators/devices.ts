import { z } from "zod";

export const listDevicesQuerySchema = z.object({}).strict();

export type ListDevicesQuery = z.infer<typeof listDevicesQuerySchema>;

export const deviceIdParamSchema = z.object({
  id: z.string().uuid({ message: "invalid device id" }),
});

export type DeviceIdParam = z.infer<typeof deviceIdParamSchema>;
