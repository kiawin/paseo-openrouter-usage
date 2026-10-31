import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getKeysStatus, removeKeyFileFor, saveKeyFile } from "./keys.js";

let configHome: string;
const keyFile = (name: string) => join(configHome, "openrouter", name);

function stubStatus(status: number, body: unknown = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

beforeEach(() => {
  configHome = mkdtempSync(join(tmpdir(), "openrouter-keys-"));
  vi.stubEnv("XDG_CONFIG_HOME", configHome);
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.stubEnv("OPENROUTER_MANAGEMENT_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(configHome, { recursive: true, force: true });
});

describe("getKeysStatus", () => {
  it("reports where each key comes from, the environment first", async () => {
    mkdirSync(join(configHome, "openrouter"));
    writeFileSync(keyFile("api-key"), "file-key\n");
    writeFileSync(keyFile("management-key"), "file-key\n");
    vi.stubEnv("OPENROUTER_MANAGEMENT_KEY", "env-key");

    expect(await getKeysStatus()).toEqual({
      apiKey: { source: "file", envVar: "OPENROUTER_API_KEY", file: keyFile("api-key") },
      managementKey: {
        source: "env",
        envVar: "OPENROUTER_MANAGEMENT_KEY",
        file: keyFile("management-key"),
      },
    });
  });
});

describe("saveKeyFile", () => {
  it("saves a key OpenRouter accepts, owner-only", async () => {
    stubStatus(200, {
      data: {
        limit: null,
        limit_remaining: null,
        limit_reset: null,
        usage: 0,
        usage_daily: 0,
        usage_weekly: 0,
        usage_monthly: 0,
      },
    });

    expect(await saveKeyFile({ kind: "apiKey", key: "sk-or-v1-good" })).toEqual({ ok: true });
    expect(readFileSync(keyFile("api-key"), "utf8")).toBe("sk-or-v1-good\n");
    expect(statSync(keyFile("api-key")).mode & 0o777).toBe(0o600);
    expect(statSync(join(configHome, "openrouter")).mode & 0o777).toBe(0o700);
  });

  it("refuses a rejected key and leaves the file alone", async () => {
    stubStatus(401);

    expect(await saveKeyFile({ kind: "apiKey", key: "sk-or-v1-bad" })).toEqual({
      ok: false,
      error: "OpenRouter rejected this API key.",
    });
    expect(() => statSync(keyFile("api-key"))).toThrow();
  });

  it("explains when a normal key is saved as the management key", async () => {
    stubStatus(403);

    expect(await saveKeyFile({ kind: "managementKey", key: "sk-or-v1-normal" })).toEqual({
      ok: false,
      error: "This is not a management key. Create one in your OpenRouter account settings.",
    });
  });

  it("reports an unreachable OpenRouter", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch failed");
      }),
    );

    expect(await saveKeyFile({ kind: "apiKey", key: "sk-or-v1-good" })).toEqual({
      ok: false,
      error: "Could not reach OpenRouter: fetch failed",
    });
  });
});

describe("removeKeyFileFor", () => {
  it("deletes the saved key and tolerates a missing one", async () => {
    mkdirSync(join(configHome, "openrouter"));
    writeFileSync(keyFile("management-key"), "key\n");

    await removeKeyFileFor({ kind: "managementKey" });
    await removeKeyFileFor({ kind: "managementKey" });

    expect((await getKeysStatus()).managementKey.source).toBe("none");
  });
});
