import {
  toneFromUsedPct,
  unavailable,
  usedPctOf,
  windowFromUsedPct,
  type UsageAccount,
  type UsageBalance,
  type UsageDetail,
  type UsageReport,
  type UsageScope,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";
import { inputSchema, type Store, type UsageInput } from "../shared/input.js";
import {
  CreditsResponseSchema,
  KeyResponseSchema,
  getJson,
  type CreditsData,
  type KeyData,
} from "./api.js";
import { apiKeyStores, firstStore, managementKeyStores, readKey } from "./stores.js";

async function globalAccount(): Promise<UsageAccount | undefined> {
  const [apiKey, managementKey] = await Promise.all([
    firstStore(apiKeyStores()),
    firstStore(managementKeyStores()),
  ]);
  if (!apiKey && !managementKey) return undefined;
  const input: UsageInput = {};
  if (apiKey) input.apiKey = apiKey;
  if (managementKey) input.managementKey = managementKey;
  return { key: "default", input };
}

const isOpenRouter = (url: string | undefined) => url?.includes("openrouter.ai") ?? false;

/** Keys a session sends to OpenRouter, by the routes its launch environment selects. */
function sessionKeys(scope: Extract<UsageScope, { kind: "session" }>): string[] {
  const { env } = scope;
  const keys: Array<string | undefined> = [];
  if (scope.model?.startsWith("openrouter/")) keys.push(env.OPENROUTER_API_KEY);
  if (isOpenRouter(env.OPENAI_BASE_URL)) keys.push(env.OPENAI_API_KEY);
  if (isOpenRouter(env.ANTHROPIC_BASE_URL))
    keys.push(env.ANTHROPIC_AUTH_TOKEN, env.ANTHROPIC_API_KEY);
  return keys.flatMap((key) => (key?.trim() ? [key.trim()] : []));
}

export async function discover(scope: UsageScope): Promise<UsageAccount[]> {
  const account = await globalAccount();
  if (!account) return [];
  if (scope.kind === "global") return [account];
  // A session joins the account only when it runs on that same API key; the key itself stays
  // in the session and never enters the input.
  const keys = sessionKeys(scope);
  if (keys.length === 0) return [];
  const { apiKey } = account.input as UsageInput;
  const known = apiKey && (await readKey(apiKey));
  return known && keys.includes(known) ? [account] : [];
}

async function requireKey(store: Store | undefined, name: string): Promise<string | undefined> {
  if (!store) return undefined;
  const key = await readKey(store);
  if (!key) throw new Error(`OpenRouter ${name} store no longer exists`);
  return key;
}

const PERIODS: Record<string, { label: string; shortLabel: string }> = {
  daily: { label: "Daily key limit", shortLabel: "day" },
  weekly: { label: "Weekly key limit", shortLabel: "wk" },
  monthly: { label: "Monthly key limit", shortLabel: "mo" },
};

function formatUsd(value: number): string {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: Math.abs(value) < 1 ? 4 : 2,
  });
}

function keyLimit(key: KeyData): { windows: UsageWindow[]; balances: UsageBalance[] } {
  if (key.limit === null || key.limit <= 0) return { windows: [], balances: [] };
  const remaining = key.limit_remaining ?? key.limit;
  const used = key.limit - remaining;
  const tone = toneFromUsedPct(usedPctOf(used, key.limit));
  const period = key.limit_reset === null ? undefined : PERIODS[key.limit_reset];
  if (key.limit_reset === null || !period)
    return {
      windows: [],
      balances: [
        {
          id: "key_limit",
          label: "Key limit",
          used,
          remaining,
          limit: key.limit,
          unit: "usd",
          tone,
        },
      ],
    };
  const resetsAt = key.budgets?.find((budget) => budget.scope === "key_limit")?.resets_at ?? null;
  return {
    windows: [
      windowFromUsedPct({
        id: `key_limit_${key.limit_reset}`,
        ...period,
        summary: true,
        utilizationPct: usedPctOf(used, key.limit),
        resetsAt,
        tone,
      }),
    ],
    balances: [],
  };
}

// OpenRouter's /credits docs say "credits" without a currency; credits are bought one per US
// dollar and its dashboard shows them as dollars, so they are reported in USD.
function creditBalance(credits: CreditsData): UsageBalance {
  const remaining = credits.total_credits - credits.total_usage;
  return {
    id: "credits",
    label: "Credits",
    used: credits.total_usage,
    remaining,
    limit: credits.total_credits,
    unit: "usd",
    tone: toneFromUsedPct(usedPctOf(credits.total_usage, credits.total_credits)),
  };
}

// OpenRouter counts usage_daily/weekly/monthly in UTC calendar periods.
function spendDetails(key: KeyData): UsageDetail[] {
  return [
    { id: "spend_daily", label: "Spent today (UTC)", value: formatUsd(key.usage_daily) },
    { id: "spend_weekly", label: "Spent this week (UTC)", value: formatUsd(key.usage_weekly) },
    { id: "spend_monthly", label: "Spent this month (UTC)", value: formatUsd(key.usage_monthly) },
    { id: "spend_total", label: "Spent by this key", value: formatUsd(key.usage) },
  ];
}

export async function fetchUsage(value: unknown): Promise<UsageReport> {
  const input = inputSchema.parse(value);
  const [apiKey, managementKey] = await Promise.all([
    requireKey(input.apiKey, "API key"),
    requireKey(input.managementKey, "management key"),
  ]);
  const [key, credits] = await Promise.all([
    apiKey ? getJson("/key", apiKey, KeyResponseSchema) : undefined,
    managementKey ? getJson("/credits", managementKey, CreditsResponseSchema) : undefined,
  ]);
  for (const result of [key, credits])
    if (result && !result.ok) return unavailable({ kind: "rejected", status: result.status });

  const limit = key?.ok ? keyLimit(key.data.data) : { windows: [], balances: [] };
  return {
    status: "available",
    windows: limit.windows,
    balances: [...(credits?.ok ? [creditBalance(credits.data.data)] : []), ...limit.balances],
    details: key?.ok ? spendDetails(key.data.data) : [],
  };
}
