import {
  chmodSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  promises as fsPromises,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getKeysStatus, removeKeyFileFor, saveKeyFile } from "./keys.js";
import { saveKey } from "../shared/keys.js";
import { keyStores } from "./stores.js";

let configHome: string;
const keyFile = (name: string) => join(configHome, "openrouter", name);
const credentialsDir = () => join(configHome, "openrouter");

function mkdirSafeCredentialsDir() {
  mkdirSync(credentialsDir(), { mode: 0o700 });
  chmodSync(credentialsDir(), 0o700);
}

const UNREACHABLE = "Could not reach OpenRouter. Check the network on the daemon host and try again.";
const SAVE_FAILED = "Could not save the key file. Check the daemon host's permissions.";

function stubStatus(status: number, body: unknown = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

const keyBody = {
  data: {
    limit: null,
    limit_remaining: null,
    limit_reset: null,
    usage: 0,
    usage_daily: 0,
    usage_weekly: 0,
    usage_monthly: 0,
  },
};

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

describe("credential paths", () => {
  it("rejects a relative home when a file path is required", () => {
    if (process.platform === "win32") return;
    vi.stubEnv("XDG_CONFIG_HOME", "");
    for (const home of ["relative-home", ""]) {
      vi.stubEnv("HOME", home);
      expect(() => keyStores("apiKey")).toThrow(
        "OpenRouter credential home directory must be absolute",
      );
    }
  });

  it("keeps environment-only key status available with an invalid home", async () => {
    if (process.platform === "win32") return;
    vi.stubEnv("XDG_CONFIG_HOME", "");
    vi.stubEnv("HOME", "relative-home");
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-v1-good");

    const status = await getKeysStatus();

    expect(status.apiKey.source).toBe("env");
    expect(status.apiKey.file).toBe("");
  });
});

describe("saveKey input", () => {
  it("accepts bounded visible ASCII keys and rejects oversized/control-character values", () => {
    expect(saveKey.input.safeParse({ kind: "apiKey", key: "sk-or-v1-good" }).success).toBe(true);

    const oversized = `sk-or-v1-${"x".repeat(300)}`;
    const tooLong = saveKey.input.safeParse({ kind: "apiKey", key: oversized });
    expect(tooLong.success).toBe(false);
    if (!tooLong.success) expect(tooLong.error.message).not.toContain(oversized);

    const injected = saveKey.input.safeParse({ kind: "apiKey", key: "sk-or-v1-good\r\nX-Evil: yes" });
    expect(injected.success).toBe(false);
  });
});

describe("getKeysStatus", () => {
  it("reports where each key comes from, the environment first", async () => {
    mkdirSafeCredentialsDir();
    writeFileSync(keyFile("api-key"), "file-key\n");
    writeFileSync(keyFile("management-key"), "file-key\n");
    vi.stubEnv("OPENROUTER_MANAGEMENT_KEY", "env-key");

    const status = await getKeysStatus();
    expect(status).toEqual({
      apiKey: { source: "file", envVar: "OPENROUTER_API_KEY", file: keyFile("api-key") },
      managementKey: {
        source: "env",
        envVar: "OPENROUTER_MANAGEMENT_KEY",
        file: keyFile("management-key"),
      },
    });
    expect(JSON.stringify(status)).not.toContain("file-key");
    expect(JSON.stringify(status)).not.toContain("env-key");
  });
});

describe("saveKeyFile", () => {
  it("saves a key OpenRouter accepts, owner-only", async () => {
    stubStatus(200, keyBody);

    expect(await saveKeyFile({ kind: "apiKey", key: "sk-or-v1-good" })).toEqual({ ok: true });
    expect(readFileSync(keyFile("api-key"), "utf8")).toBe("sk-or-v1-good\n");
    expect(statSync(keyFile("api-key")).mode & 0o777).toBe(0o600);
    expect(statSync(credentialsDir()).mode & 0o777).toBe(0o700);
  });

  it("leaves no temporary files behind after a successful save", async () => {
    stubStatus(200, keyBody);

    await saveKeyFile({ kind: "apiKey", key: "sk-or-v1-good" });

    expect(readdirSync(credentialsDir())).toEqual(["api-key"]);
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

  it("refuses a redirect instead of following it, and requests no-follow fetching", async () => {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) =>
        new Response("", {
          status: 302,
          headers: { location: "https://attacker.example/harvest" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(saveKeyFile({ kind: "apiKey", key: "sk-or-v1-good" })).resolves.toEqual({
      ok: false,
      error: UNREACHABLE,
    });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "error" });
  });

  it("sanitizes network errors instead of echoing the raw cause", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(
          `connect ECONNREFUSED /home/daemon/.config/openrouter failed for key sk-or-v1-good`,
        );
      }),
    );

    const result = await saveKeyFile({ kind: "apiKey", key: "sk-or-v1-good" });

    expect(result).toEqual({ ok: false, error: UNREACHABLE });
    expect(JSON.stringify(result)).not.toContain("sk-or-v1-good");
    expect(JSON.stringify(result)).not.toContain("/home/daemon");
  });

  it("sanitizes a filesystem error during the save", async () => {
    stubStatus(200, keyBody);
    mkdirSafeCredentialsDir();
    // A directory where the key file belongs makes the atomic replacement fail.
    mkdirSync(keyFile("api-key"));

    expect(await saveKeyFile({ kind: "apiKey", key: "sk-or-v1-good" })).toEqual({
      ok: false,
      error: SAVE_FAILED,
    });
    expect(readdirSync(credentialsDir())).toEqual(["api-key"]);
  });

  it("refuses a symlink at the save target without altering it or its victim", async () => {
    stubStatus(200, keyBody);
    mkdirSafeCredentialsDir();
    const victim = join(configHome, "victim");
    writeFileSync(victim, "victim\n");
    symlinkSync(victim, keyFile("api-key"));

    expect(await saveKeyFile({ kind: "apiKey", key: "sk-or-v1-good" })).toEqual({
      ok: false,
      error: SAVE_FAILED,
    });

    expect(readFileSync(victim, "utf8")).toBe("victim\n");
    expect(lstatSync(keyFile("api-key")).isSymbolicLink()).toBe(true);
  });

  it("supports a safe symlinked credentials directory without changing its permissions", async () => {
    stubStatus(200, keyBody);
    const elsewhere = join(configHome, "dotfiles-openrouter");
    mkdirSync(elsewhere, { mode: 0o750 });
    chmodSync(elsewhere, 0o750);
    symlinkSync(elsewhere, credentialsDir());

    expect(await saveKeyFile({ kind: "apiKey", key: "sk-or-v1-good" })).toEqual({ ok: true });

    expect(readFileSync(join(elsewhere, "api-key"), "utf8")).toBe("sk-or-v1-good\n");
    expect(statSync(elsewhere).mode & 0o777).toBe(0o750);
  });

  it("saves through a safe symlinked XDG_CONFIG_HOME", async () => {
    stubStatus(200, keyBody);
    const actual = join(configHome, "managed-xdg-config");
    const alias = join(configHome, "xdg-config-link");
    mkdirSync(actual, { mode: 0o700 });
    symlinkSync(actual, alias);
    vi.stubEnv("XDG_CONFIG_HOME", alias);

    expect(await saveKeyFile({ kind: "apiKey", key: "sk-or-v1-good" })).toEqual({ ok: true });
    expect(readFileSync(join(actual, "openrouter", "api-key"), "utf8")).toBe("sk-or-v1-good\n");
  });

  it("refuses a hardlink at the save target", async () => {
    stubStatus(200, keyBody);
    mkdirSafeCredentialsDir();
    const victim = join(configHome, "victim");
    writeFileSync(victim, "victim\n");
    linkSync(victim, keyFile("api-key"));

    expect(await saveKeyFile({ kind: "apiKey", key: "sk-or-v1-good" })).toEqual({
      ok: false,
      error: SAVE_FAILED,
    });
    expect(readFileSync(victim, "utf8")).toBe("victim\n");
    expect(readdirSync(credentialsDir())).toEqual(["api-key"]);
  });

  it("cleans temporary key files when atomic rename fails", async () => {
    stubStatus(200, keyBody);
    mkdirSafeCredentialsDir();
    const renameSpy = vi.spyOn(fsPromises, "rename").mockRejectedValueOnce(new Error("sensitive path"));

    try {
      expect(await saveKeyFile({ kind: "apiKey", key: "sk-or-v1-good" })).toEqual({
        ok: false,
        error: SAVE_FAILED,
      });
      expect(readdirSync(credentialsDir())).toEqual([]);
    } finally {
      renameSpy.mockRestore();
    }
  });

  it("refuses to write inside a group/world-writable credentials directory", async () => {
    stubStatus(200, keyBody);
    mkdirSafeCredentialsDir();
    chmodSync(credentialsDir(), 0o777);

    expect(await saveKeyFile({ kind: "apiKey", key: "sk-or-v1-good" })).toEqual({
      ok: false,
      error: SAVE_FAILED,
    });
    expect(readdirSync(credentialsDir())).toEqual([]);
  });

  it("refuses a sticky group/world-writable credential leaf", async () => {
    stubStatus(200, keyBody);
    mkdirSafeCredentialsDir();
    chmodSync(credentialsDir(), 0o1777);

    expect(await saveKeyFile({ kind: "apiKey", key: "sk-or-v1-good" })).toEqual({
      ok: false,
      error: SAVE_FAILED,
    });
    expect(readdirSync(credentialsDir())).toEqual([]);
  });

  it("refuses to write below a group/world-writable non-sticky parent", async () => {
    stubStatus(200, keyBody);
    mkdirSafeCredentialsDir();
    chmodSync(configHome, 0o777);

    expect(await saveKeyFile({ kind: "apiKey", key: "sk-or-v1-good" })).toEqual({
      ok: false,
      error: SAVE_FAILED,
    });
    expect(readdirSync(credentialsDir())).toEqual([]);
  });
});

describe("removeKeyFileFor", () => {
  it("deletes the saved key and tolerates a missing one", async () => {
    mkdirSafeCredentialsDir();
    writeFileSync(keyFile("management-key"), "key\n");

    await removeKeyFileFor({ kind: "managementKey" });
    await removeKeyFileFor({ kind: "managementKey" });

    expect((await getKeysStatus()).managementKey.source).toBe("none");
  });

  it("treats removal through a dangling credentials-directory symlink as a no-op", async () => {
    symlinkSync(join(configHome, "missing-target"), credentialsDir());

    await expect(removeKeyFileFor({ kind: "managementKey" })).resolves.toEqual({});
    expect(lstatSync(credentialsDir()).isSymbolicLink()).toBe(true);
  });

  it("refuses removal from an unsafe credential directory", async () => {
    mkdirSafeCredentialsDir();
    writeFileSync(keyFile("management-key"), "key\n");
    chmodSync(credentialsDir(), 0o777);

    await expect(removeKeyFileFor({ kind: "managementKey" })).rejects.toThrow(
      "Could not remove the key file. Check the daemon host's permissions.",
    );
    expect(readFileSync(keyFile("management-key"), "utf8")).toBe("key\n");
  });

  it("sanitizes a filesystem error during removal", async () => {
    // A file where the credentials directory belongs makes every removal fail with ENOTDIR.
    writeFileSync(credentialsDir(), "not a directory");

    await expect(removeKeyFileFor({ kind: "managementKey" })).rejects.toThrow(
      "Could not remove the key file. Check the daemon host's permissions.",
    );
  });
});
