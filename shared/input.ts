import { z } from "zod";

export const storeSchema = z
  .object({
    store: z.enum(["env", "file"]),
    locator: z.string().min(1),
  })
  .strict();
export type Store = z.infer<typeof storeSchema>;

/** Names where each key lives; never the key itself. */
export const inputSchema = z
  .object({
    apiKey: storeSchema.optional(),
    managementKey: storeSchema.optional(),
  })
  .strict()
  .refine((input) => input.apiKey || input.managementKey, "Needs an API key or management key");
export type UsageInput = z.infer<typeof inputSchema>;
