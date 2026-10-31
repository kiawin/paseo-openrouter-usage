import { z } from "zod";

const API_URL = "https://openrouter.ai/api/v1";

export const KeyResponseSchema = z.object({
  data: z.object({
    limit: z.number().nullable(),
    limit_remaining: z.number().nullable(),
    limit_reset: z.string().nullable(),
    usage: z.number(),
    usage_daily: z.number(),
    usage_weekly: z.number(),
    usage_monthly: z.number(),
    budgets: z.array(z.object({ scope: z.string(), resets_at: z.string().nullish() })).optional(),
  }),
});
export type KeyData = z.infer<typeof KeyResponseSchema>["data"];

export const CreditsResponseSchema = z.object({
  data: z.object({ total_credits: z.number(), total_usage: z.number() }),
});
export type CreditsData = z.infer<typeof CreditsResponseSchema>["data"];

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number };

export async function getJson<T>(
  path: string,
  key: string,
  schema: z.ZodType<T>,
): Promise<ApiResult<T>> {
  // A plain controller, not AbortSignal.timeout(): the client's React Native typings replace
  // the DOM AbortSignal type for the whole project and do not declare timeout().
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${API_URL}${path}`, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    });
    if (res.status === 401 || res.status === 403) return { ok: false, status: res.status };
    if (!res.ok) throw new Error(`OpenRouter ${path} returned ${res.status}`);
    return { ok: true, data: schema.parse(await res.json()) };
  } finally {
    clearTimeout(timer);
  }
}
