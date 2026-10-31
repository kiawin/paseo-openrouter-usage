import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discover, fetchUsage } from "./usage.js";

const KEY = "sk-or-v1-test";
const MANAGEMENT = "sk-or-v1-management";

function keyBody(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      label: "sk-or-v1-te...test",
      limit: 50,
      limit_remaining: 12.5,
      limit_reset: "monthly",
      usage: 120.25,
      usage_daily: 0.0042,
      usage_weekly: 3.5,
      usage_monthly: 37.5,
      is_free_tier: false,
      budgets: [{ scope: "key_limit", resets_at: "2026-11-01T00:00:00.000Z" }],
      ...overrides,
    },
  };
}

function stubApi(routes: Record<string, { status?: number; body?: unknown; key: string }>) {
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const route = routes[new URL(url.toString()).pathname];
    if (!route) throw new Error(`Unmocked fetch: ${url}`);
    const auth = new Headers(init?.headers).get("Authorization");
    if (auth !== `Bearer ${route.key}`) return new Response("{}", { status: 401 });
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

let configHome: string;

beforeEach(() => {
  configHome = mkdtempSync(join(tmpdir(), "openrouter-usage-"));
  vi.stubEnv("XDG_CONFIG_HOME", configHome);
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.stubEnv("OPENROUTER_MANAGEMENT_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(configHome, { recursive: true, force: true });
});

describe("discover", () => {
  it("finds nothing without a key", async () => {
    expect(await discover({ kind: "global" })).toEqual([]);
  });

  it("prefers the environment over the key file and adds the management key", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", KEY);
    mkdirSync(join(configHome, "openrouter"));
    writeFileSync(join(configHome, "openrouter", "api-key"), "other\n");
    writeFileSync(join(configHome, "openrouter", "management-key"), `${MANAGEMENT}\n`);

    expect(await discover({ kind: "global" })).toEqual([
      {
        key: "default",
        input: {
          apiKey: { store: "env", locator: "OPENROUTER_API_KEY" },
          managementKey: {
            store: "file",
            locator: join(configHome, "openrouter", "management-key"),
          },
        },
      },
    ]);
  });

  it("joins a session only when it sends the same key to OpenRouter", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", KEY);
    const session = (env: Record<string, string>, model?: string) =>
      discover({ kind: "session", provider: "codex", model, env });

    expect(
      await session({ OPENAI_BASE_URL: "https://openrouter.ai/api/v1", OPENAI_API_KEY: KEY }),
    ).toHaveLength(1);
    expect(
      await session({ ANTHROPIC_BASE_URL: "https://openrouter.ai/api", ANTHROPIC_AUTH_TOKEN: KEY }),
    ).toHaveLength(1);
    expect(await session({ OPENROUTER_API_KEY: KEY }, "openrouter/anthropic/claude")).toHaveLength(
      1,
    );
    expect(
      await session({ OPENAI_BASE_URL: "https://openrouter.ai/api/v1", OPENAI_API_KEY: "other" }),
    ).toEqual([]);
    expect(await session({ OPENAI_API_KEY: KEY })).toEqual([]);
  });
});

describe("fetchUsage", () => {
  it("reports credits, the key limit window, and spend", async () => {
    stubApi({
      "/api/v1/key": { key: KEY, body: keyBody() },
      "/api/v1/credits": {
        key: MANAGEMENT,
        body: { data: { total_credits: 100, total_usage: 92.5 } },
      },
    });
    vi.stubEnv("OPENROUTER_API_KEY", KEY);
    vi.stubEnv("OPENROUTER_MANAGEMENT_KEY", MANAGEMENT);

    const report = await fetchUsage({
      apiKey: { store: "env", locator: "OPENROUTER_API_KEY" },
      managementKey: { store: "env", locator: "OPENROUTER_MANAGEMENT_KEY" },
    });

    expect(report).toEqual({
      status: "available",
      windows: [
        {
          id: "key_limit_monthly",
          label: "Monthly key limit",
          shortLabel: "mo",
          summary: true,
          usedPct: 75,
          remainingPct: 25,
          resetsAt: "2026-11-01T00:00:00.000Z",
          tone: "warning",
        },
      ],
      balances: [
        {
          id: "credits",
          label: "Credits",
          used: 92.5,
          remaining: 7.5,
          limit: 100,
          unit: "usd",
          tone: "danger",
        },
      ],
      details: [
        { id: "spend_daily", label: "Spent today (UTC)", value: "$0.0042" },
        { id: "spend_weekly", label: "Spent this week (UTC)", value: "$3.50" },
        { id: "spend_monthly", label: "Spent this month (UTC)", value: "$37.50" },
        { id: "spend_total", label: "Spent by this key", value: "$120.25" },
      ],
    });
  });

  it("shows a key limit that never resets as a balance", async () => {
    stubApi({ "/api/v1/key": { key: KEY, body: keyBody({ limit_reset: null }) } });
    vi.stubEnv("OPENROUTER_API_KEY", KEY);

    const report = await fetchUsage({ apiKey: { store: "env", locator: "OPENROUTER_API_KEY" } });

    expect(report).toMatchObject({
      windows: [],
      balances: [{ id: "key_limit", used: 37.5, remaining: 12.5, limit: 50, unit: "usd" }],
    });
  });

  it("omits the limit for an unlimited key", async () => {
    stubApi({
      "/api/v1/key": { key: KEY, body: keyBody({ limit: null, limit_remaining: null }) },
    });
    vi.stubEnv("OPENROUTER_API_KEY", KEY);

    const report = await fetchUsage({ apiKey: { store: "env", locator: "OPENROUTER_API_KEY" } });

    expect(report).toMatchObject({ windows: [], balances: [] });
  });

  it("reports a rejected key", async () => {
    stubApi({ "/api/v1/credits": { key: MANAGEMENT, status: 403 } });
    vi.stubEnv("OPENROUTER_MANAGEMENT_KEY", MANAGEMENT);

    const report = await fetchUsage({
      managementKey: { store: "env", locator: "OPENROUTER_MANAGEMENT_KEY" },
    });

    expect(report).toEqual({ status: "unavailable", problem: { kind: "rejected", status: 403 } });
  });

  it("throws when the key store disappeared after discovery", async () => {
    await expect(
      fetchUsage({ apiKey: { store: "file", locator: join(configHome, "missing") } }),
    ).rejects.toThrow("OpenRouter API key store no longer exists");
  });

  it("throws on a server error", async () => {
    stubApi({ "/api/v1/key": { key: KEY, status: 500 } });
    vi.stubEnv("OPENROUTER_API_KEY", KEY);

    await expect(
      fetchUsage({ apiKey: { store: "env", locator: "OPENROUTER_API_KEY" } }),
    ).rejects.toThrow("OpenRouter /key returned 500");
  });
});
