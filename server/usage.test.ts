import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discover, fetchUsage } from "./usage.js";
import { keyStores } from "./stores.js";

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

function mkdirSafeCredentialsDir(): string {
  const dir = join(configHome, "openrouter");
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

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

  it("keeps environment-only usage available when HOME is not absolute", async () => {
    if (process.platform === "win32") return;
    vi.stubEnv("XDG_CONFIG_HOME", "");
    vi.stubEnv("OPENROUTER_API_KEY", KEY);
    for (const home of ["relative-home", ""]) {
      vi.stubEnv("HOME", home);
      expect(await discover({ kind: "global" })).toEqual([
        {
          key: "default",
          input: { apiKey: { store: "env", locator: "OPENROUTER_API_KEY" } },
        },
      ]);
    }
  });

  it("prefers the environment over the key file and adds the management key", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", KEY);
    mkdirSafeCredentialsDir();
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
    expect(
      await session({
        OPENAI_BASE_URL: "https://openrouter.ai.evil.example/api/v1",
        OPENAI_API_KEY: KEY,
      }),
    ).toEqual([]);
    expect(
      await session({ OPENAI_BASE_URL: "http://openrouter.ai/api/v1", OPENAI_API_KEY: KEY }),
    ).toEqual([]);
  });
});

describe("fetchUsage", () => {
  it("fetches with an environment key when HOME is not absolute", async () => {
    if (process.platform === "win32") return;
    vi.stubEnv("XDG_CONFIG_HOME", "");
    vi.stubEnv("HOME", "relative-home");
    vi.stubEnv("OPENROUTER_API_KEY", KEY);
    stubApi({ "/api/v1/key": { key: KEY, body: keyBody({ limit_reset: null }) } });

    const report = await fetchUsage({
      apiKey: { store: "env", locator: "OPENROUTER_API_KEY" },
    });

    expect(report.status).toBe("available");
  });

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

    expect(JSON.stringify(report)).not.toContain(KEY);
    expect(JSON.stringify(report)).not.toContain(MANAGEMENT);
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

  it("cancels rejected response bodies without exposing them", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body as never, { status: 401 })));
    vi.stubEnv("OPENROUTER_API_KEY", KEY);

    await expect(
      fetchUsage({ apiKey: { store: "env", locator: "OPENROUTER_API_KEY" } }),
    ).resolves.toEqual({ status: "unavailable", problem: { kind: "rejected", status: 401 } });
    expect(cancel).toHaveBeenCalled();
  });

  it("sanitizes network exceptions in usage fetches", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", KEY);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(`network failure for key ${KEY} at /home/daemon/.config/openrouter/api-key`);
      }),
    );

    const error = await fetchUsage({
      apiKey: { store: "env", locator: "OPENROUTER_API_KEY" },
    }).catch((cause: unknown) => cause);
    expect((error as Error).message).toBe("Could not reach OpenRouter");
    expect((error as Error).message).not.toContain(KEY);
    expect((error as Error).message).not.toContain("/home/daemon");
  });

  it("throws when the key store disappeared after discovery", async () => {
    await expect(
      fetchUsage({ apiKey: { store: "file", locator: join(configHome, "openrouter", "api-key") } }),
    ).rejects.toThrow("OpenRouter API key store no longer exists");
  });

  it("rejects an arbitrary environment locator before making authenticated requests", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("unmocked fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchUsage({ apiKey: { store: "env", locator: "ANTHROPIC_API_KEY" } }),
    ).rejects.toThrow("OpenRouter API key locator was not provided by this plugin");
    await expect(
      fetchUsage({
        managementKey: { store: "env", locator: "OPENROUTER_API_KEY" },
      }),
    ).rejects.toThrow("OpenRouter management key locator was not provided by this plugin");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an arbitrary file locator before making authenticated requests", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("unmocked fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    for (const locator of [
      "/etc/shadow",
      join(configHome, "other", "api-key"),
      join(configHome, "..", "elsewhere", "api-key"),
    ]) {
      await expect(fetchUsage({ apiKey: { store: "file", locator } })).rejects.toThrow(
        "OpenRouter API key locator was not provided by this plugin",
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores relative XDG_CONFIG_HOME and rejects relative locators", async () => {
    vi.stubEnv("XDG_CONFIG_HOME", "relative-config");
    expect(isAbsolute(keyStores("apiKey")[1].locator)).toBe(true);
    expect(keyStores("apiKey")[1].locator).not.toContain("relative-config");
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchUsage({
        apiKey: { store: "file", locator: join("relative-config", "openrouter", "api-key") },
      }),
    ).rejects.toThrow("OpenRouter API key locator was not provided by this plugin");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to read a symlink at the canonical credential path", async () => {
    mkdirSafeCredentialsDir();
    const victim = join(configHome, "victim");
    const canonical = join(configHome, "openrouter", "api-key");
    writeFileSync(victim, KEY);
    symlinkSync(victim, canonical);
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchUsage({ apiKey: { store: "file", locator: canonical } }),
    ).rejects.toThrow("OpenRouter API key store no longer exists");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a hardlink at the canonical credential path", async () => {
    mkdirSafeCredentialsDir();
    const victim = join(configHome, "victim");
    const canonical = join(configHome, "openrouter", "api-key");
    writeFileSync(victim, KEY);
    linkSync(victim, canonical);
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchUsage({ apiKey: { store: "file", locator: canonical } }),
    ).rejects.toThrow("OpenRouter API key store no longer exists");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads a key through a safe symlinked credentials directory", async () => {
    const targetDir = join(configHome, "managed-openrouter");
    mkdirSync(targetDir, { mode: 0o700 });
    writeFileSync(join(targetDir, "api-key"), `${KEY}\n`);
    symlinkSync(targetDir, join(configHome, "openrouter"));
    stubApi({ "/api/v1/key": { key: KEY, body: keyBody({ limit_reset: null }) } });

    const report = await fetchUsage({
      apiKey: { store: "file", locator: join(configHome, "openrouter", "api-key") },
    });

    expect(report.status).toBe("available");
  });

  it("resolves safe nested symlink targets while reading credentials", async () => {
    const targetConfig = join(configHome, "managed-config");
    const nestedLink = join(configHome, "nested-link");
    const credentialsLink = join(configHome, "openrouter");
    mkdirSync(targetConfig, { mode: 0o700 });
    mkdirSync(join(targetConfig, "openrouter"), { mode: 0o700 });
    writeFileSync(join(targetConfig, "openrouter", "api-key"), `${KEY}\n`);
    symlinkSync(targetConfig, nestedLink);
    symlinkSync(join(nestedLink, "openrouter"), credentialsLink);
    stubApi({ "/api/v1/key": { key: KEY, body: keyBody({ limit_reset: null }) } });

    const report = await fetchUsage({
      apiKey: { store: "file", locator: join(credentialsLink, "api-key") },
    });

    expect(report.status).toBe("available");
  });

  it("applies dot-dot after following a symlink in its literal target", async () => {
    const parent = join(configHome, "symlink-target-parent");
    const child = join(parent, "child");
    const sub = join(configHome, "sub");
    mkdirSync(parent, { mode: 0o700 });
    mkdirSync(child, { mode: 0o700 });
    mkdirSync(sub, { mode: 0o700 });
    writeFileSync(join(parent, "api-key"), `${KEY}\n`);
    symlinkSync(child, join(sub, "inner-link"));
    symlinkSync("sub/inner-link/..", join(configHome, "openrouter"));
    stubApi({ "/api/v1/key": { key: KEY, body: keyBody({ limit_reset: null }) } });

    const report = await fetchUsage({
      apiKey: { store: "file", locator: join(configHome, "openrouter", "api-key") },
    });

    expect(report.status).toBe("available");
  });

  it("allows a sticky ancestor reached through nested symlinks", async () => {
    const targetConfig = mkdtempSync(join(tmpdir(), "openrouter-sticky-config-"));
    try {
      mkdirSync(join(targetConfig, "openrouter"), { mode: 0o700 });
      writeFileSync(join(targetConfig, "openrouter", "api-key"), `${KEY}\n`);
      const tmpLink = join(configHome, "tmp-link");
      const xdgLink = join(configHome, "xdg-link");
      symlinkSync(tmpdir(), tmpLink);
      symlinkSync(join(tmpLink, targetConfig.split(sep).pop()!), xdgLink);
      vi.stubEnv("XDG_CONFIG_HOME", xdgLink);
      stubApi({ "/api/v1/key": { key: KEY, body: keyBody({ limit_reset: null }) } });

      const report = await fetchUsage({
        apiKey: { store: "file", locator: join(xdgLink, "openrouter", "api-key") },
      });

      expect(report.status).toBe("available");
    } finally {
      rmSync(targetConfig, { recursive: true, force: true });
    }
  });

  it("rejects a cycle in credential-directory symlinks", async () => {
    symlinkSync("cycle-two", join(configHome, "cycle-one"));
    symlinkSync("cycle-one", join(configHome, "cycle-two"));
    symlinkSync("cycle-one", join(configHome, "openrouter"));
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchUsage({
        apiKey: { store: "file", locator: join(configHome, "openrouter", "api-key") },
      }),
    ).rejects.toThrow("OpenRouter API key store no longer exists");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects dot and dot-dot paths that make a sticky directory the credential leaf", async () => {
    const stickyDir = join(configHome, "sticky-leaf");
    const child = join(stickyDir, "child");
    const credentialsLink = join(configHome, "openrouter");
    mkdirSync(stickyDir, { mode: 0o700 });
    chmodSync(stickyDir, 0o1777);
    mkdirSync(child, { mode: 0o700 });
    writeFileSync(join(stickyDir, "api-key"), `${KEY}\n`);
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    for (const target of [`${stickyDir}${sep}.`, `${child}${sep}..`]) {
      symlinkSync(target, credentialsLink);
      await expect(
        fetchUsage({ apiKey: { store: "file", locator: join(credentialsLink, "api-key") } }),
      ).rejects.toThrow("OpenRouter API key store no longer exists");
      expect(fetchMock).not.toHaveBeenCalled();
      rmSync(credentialsLink, { force: true });
    }
  });

  it("validates nested symlink targets before reading credentials", async () => {
    const targetConfig = join(configHome, "managed-config");
    const writableParent = join(configHome, "untrusted-parent");
    mkdirSync(targetConfig, { mode: 0o700 });
    mkdirSync(join(targetConfig, "openrouter"), { mode: 0o700 });
    writeFileSync(join(targetConfig, "openrouter", "api-key"), `${KEY}\n`);
    mkdirSync(writableParent, { mode: 0o700 });
    chmodSync(writableParent, 0o777);
    symlinkSync(targetConfig, join(writableParent, "nested-link"));
    symlinkSync(
      join(writableParent, "nested-link", "openrouter"),
      join(configHome, "openrouter"),
    );
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchUsage({
        apiKey: { store: "file", locator: join(configHome, "openrouter", "api-key") },
      }),
    ).rejects.toThrow("OpenRouter API key store no longer exists");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads through a symlinked XDG_CONFIG_HOME with a safe link parent", async () => {
    const targetConfig = join(configHome, "dotfiles-config");
    const configLink = join(configHome, "config-link");
    mkdirSync(targetConfig, { mode: 0o700 });
    mkdirSync(join(targetConfig, "openrouter"), { mode: 0o700 });
    writeFileSync(join(targetConfig, "openrouter", "api-key"), `${KEY}\n`);
    symlinkSync(targetConfig, configLink);
    vi.stubEnv("XDG_CONFIG_HOME", configLink);
    vi.stubEnv("HOME", "relative-home");
    stubApi({ "/api/v1/key": { key: KEY, body: keyBody({ limit_reset: null }) } });

    const report = await fetchUsage({
      apiKey: { store: "file", locator: join(configLink, "openrouter", "api-key") },
    });

    expect(report.status).toBe("available");
  });

  it("refuses keys located below an unsafe credential directory", async () => {
    const credentialsDir = join(configHome, "openrouter");
    mkdirSync(credentialsDir, { mode: 0o700 });
    writeFileSync(join(credentialsDir, "api-key"), `${KEY}\n`);
    chmodSync(credentialsDir, 0o777);
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchUsage({ apiKey: { store: "file", locator: join(credentialsDir, "api-key") } }),
    ).rejects.toThrow("OpenRouter API key store no longer exists");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds key-file reads and refuses invalid environment key characters", async () => {
    const credentialsDir = join(configHome, "openrouter");
    mkdirSync(credentialsDir, { mode: 0o700 });
    writeFileSync(join(credentialsDir, "api-key"), "x".repeat(10_000));
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchUsage({ apiKey: { store: "file", locator: join(credentialsDir, "api-key") } }),
    ).rejects.toThrow("OpenRouter API key store no longer exists");

    vi.stubEnv("OPENROUTER_API_KEY", `${KEY}\nInjected: yes`);
    await expect(
      fetchUsage({ apiKey: { store: "env", locator: "OPENROUTER_API_KEY" } }),
    ).rejects.toThrow("OpenRouter API key store no longer exists");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads a key from the canonical file locator", async () => {
    stubApi({ "/api/v1/key": { key: KEY, body: keyBody({ limit_reset: null }) } });
    mkdirSafeCredentialsDir();
    writeFileSync(join(configHome, "openrouter", "api-key"), `${KEY}\n`);

    const report = await fetchUsage({
      apiKey: { store: "file", locator: join(configHome, "openrouter", "api-key") },
    });

    expect(report.status).toBe("available");
  });

  it("reads an existing permissive credential file without changing its permissions", async () => {
    if (process.platform === "win32") return;
    stubApi({ "/api/v1/key": { key: KEY, body: keyBody({ limit_reset: null }) } });
    mkdirSafeCredentialsDir();
    const path = join(configHome, "openrouter", "api-key");
    writeFileSync(path, `${KEY}\n`, { mode: 0o644 });
    chmodSync(path, 0o644);

    const report = await fetchUsage({
      apiKey: { store: "file", locator: path },
    });

    expect(report.status).toBe("available");
    expect(statSync(path).mode & 0o777).toBe(0o644);
  });

  it("guards a redirect response from a fetch implementation that ignores redirect:error", async () => {
    stubApi({ "/api/v1/key": { key: KEY, status: 302 } });
    vi.stubEnv("OPENROUTER_API_KEY", KEY);

    await expect(
      fetchUsage({ apiKey: { store: "env", locator: "OPENROUTER_API_KEY" } }),
    ).rejects.toThrow("OpenRouter redirected the request");
  });

  it("cancels an oversized Content-Length response before parsing its body", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(body as never, {
          status: 200,
          headers: { "content-length": "1000001" },
        }),
      ),
    );
    vi.stubEnv("OPENROUTER_API_KEY", KEY);

    await expect(
      fetchUsage({ apiKey: { store: "env", locator: "OPENROUTER_API_KEY" } }),
    ).rejects.toThrow("OpenRouter returned an unexpected response");
    expect(cancel).toHaveBeenCalled();
  });

  it("sanitizes malformed JSON and schema-invalid response bodies", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", KEY);
    for (const body of [`{"credential":"${KEY}"`, JSON.stringify({ data: { credential: KEY } })]) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));
      const error = await fetchUsage({
        apiKey: { store: "env", locator: "OPENROUTER_API_KEY" },
      }).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("OpenRouter returned an unexpected response");
      expect((error as Error).message).not.toContain(KEY);
    }
  });

  it("reads a body at the size limit and rejects a larger streamed body", async () => {
    let padded = JSON.stringify({ data: keyBody().data, pad: "" });
    padded = JSON.stringify({ data: keyBody().data, pad: " ".repeat(1_000_000 - padded.length) });
    expect(Buffer.byteLength(padded)).toBe(1_000_000);

    const fetchMock = vi.fn(async () => new Response(padded, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("OPENROUTER_API_KEY", KEY);
    await expect(
      fetchUsage({ apiKey: { store: "env", locator: "OPENROUTER_API_KEY" } }),
    ).resolves.toMatchObject({ status: "available" });

    // Streamed, no Content-Length: 1,000,001 bytes is one past the limit.
    const cancel = vi.fn();
    const overflow = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1_000_000).fill(0x20));
        controller.enqueue(new Uint8Array([0x20]));
      },
      cancel,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(overflow as never, { status: 200 })),
    );
    await expect(
      fetchUsage({ apiKey: { store: "env", locator: "OPENROUTER_API_KEY" } }),
    ).rejects.toThrow("OpenRouter returned an unexpected response");
    expect(cancel).toHaveBeenCalled();
  });

  it("throws on a server error", async () => {
    stubApi({ "/api/v1/key": { key: KEY, status: 500 } });
    vi.stubEnv("OPENROUTER_API_KEY", KEY);

    await expect(
      fetchUsage({ apiKey: { store: "env", locator: "OPENROUTER_API_KEY" } }),
    ).rejects.toThrow("OpenRouter /key returned 500");
  });
});
