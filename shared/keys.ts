import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const MAX_OPENROUTER_KEY_LENGTH = 256;

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
  // Bounded length: OpenRouter keys are far shorter, and the value is sent in a header and
  // written to disk, so an unbounded string is pure abuse surface.
  input: z.object({
    kind: keyKindSchema,
    key: z
      .string()
      .trim()
      .min(1)
      .max(MAX_OPENROUTER_KEY_LENGTH)
      .regex(/^[\x21-\x7e]+$/),
  }),
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
