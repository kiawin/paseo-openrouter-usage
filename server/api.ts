import { z } from "zod";

const API_URL = "https://openrouter.ai/api/v1";

// The /key and /credits responses are a few kilobytes. Anything larger is not a legitimate
// response from these endpoints, so it is rejected while streaming, before any JSON parsing.
const MAX_RESPONSE_BYTES = 1_000_000;

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

// Reads the response body in chunks and refuses it once it exceeds MAX_RESPONSE_BYTES, so
// neither Content-Length nor a chunked/streamed body can make the daemon buffer unbounded
// attacker-controlled data.
async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Ignored: status handling must not surface body-stream errors to clients.
  }
}

async function readBoundedBody(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isInteger(declared) && declared > MAX_RESPONSE_BYTES) {
    await discardBody(res);
    throw new Error("response-too-large");
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("OpenRouter returned an unreadable response");

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("response-too-large");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    await reader.cancel().catch(() => {});
    // Too large, truncated UTF-8, or a broken stream: the caller maps all of these to a
    // sanitized message, since raw causes can quote response bodies or system details.
    throw new Error("OpenRouter returned an unreadable response");
  } finally {
    reader.releaseLock();
  }
  return text;
}

export async function getJson<T>(
  path: string,
  key: string,
  schema: z.ZodType<T>,
): Promise<ApiResult<T>> {
  // A plain controller, not AbortSignal.timeout(): the client's React Native typings replace
  // the DOM AbortSignal type for the whole project and do not declare timeout().
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let res: Response;
  try {
    try {
      // redirect: "error" never follows a redirect on an authenticated request; the Authorization
      // header would leak to whatever endpoint the redirect points at.
      res = await fetch(`${API_URL}${path}`, {
        signal: controller.signal,
        redirect: "error",
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      });
    } catch {
      // Never surface the raw cause: network errors can carry the URL, headers, or host details.
      throw new Error("Could not reach OpenRouter");
    }
    if (res.status === 401 || res.status === 403) {
      await discardBody(res);
      return { ok: false, status: res.status };
    }
    // Unreachable with redirect: "error", but kept as a guard if the fetch implementation differs.
    if (res.status >= 300 && res.status < 400) {
      await discardBody(res);
      throw new Error("OpenRouter redirected the request");
    }
    if (!res.ok) {
      await discardBody(res);
      throw new Error(`OpenRouter ${path} returned ${res.status}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBoundedBody(res));
    } catch {
      // Parse and size errors may quote response bodies or raw system messages.
      throw new Error("OpenRouter returned an unexpected response");
    }
    try {
      return { ok: true, data: schema.parse(parsed) };
    } catch {
      // Schema errors quote the received value, which is response-controlled.
      throw new Error("OpenRouter returned an unexpected response");
    }
  } finally {
    clearTimeout(timer);
  }
}
