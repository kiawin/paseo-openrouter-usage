import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const keyKindSchema = z.enum(["apiKey", "managementKey"]);
export type KeyKind = z.infer<typeof keyKindSchema>;

const keyStatusSchema = z.object({
  /** Where the key in use comes from. The environment wins over the file. */
  source: z.enum(["env", "file", "none"]),
  envVar: z.string(),
  file: z.string(),
});
export type KeyStatus = z.infer<typeof keyStatusSchema>;

export const keysStatus = defineRpc({
  name: "keys.status",
  input: z.object({}),
  output: z.object({ apiKey: keyStatusSchema, managementKey: keyStatusSchema }),
});

/** Checks the key with OpenRouter, then saves it to the key file. The key never comes back. */
export const saveKey = defineRpc({
  name: "keys.save",
  input: z.object({ kind: keyKindSchema, key: z.string().trim().min(1) }),
  output: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true) }),
    z.object({ ok: z.literal(false), error: z.string() }),
  ]),
});

export const removeKey = defineRpc({
  name: "keys.remove",
  input: z.object({ kind: keyKindSchema }),
  output: z.object({}),
});
