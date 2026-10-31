import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Store } from "../shared/input.js";
import type { KeyKind } from "../shared/keys.js";

function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "openrouter");
}

const LOCATIONS: Record<KeyKind, { env: string; file: string }> = {
  apiKey: { env: "OPENROUTER_API_KEY", file: "api-key" },
  managementKey: { env: "OPENROUTER_MANAGEMENT_KEY", file: "management-key" },
};

/** The stores for one key, in precedence order: the daemon's environment, then the key file. */
export function keyStores(kind: KeyKind): [env: Store, file: Store] {
  const { env, file } = LOCATIONS[kind];
  return [
    { store: "env", locator: env },
    { store: "file", locator: join(configDir(), file) },
  ];
}

export const apiKeyStores = () => keyStores("apiKey");
export const managementKeyStores = () => keyStores("managementKey");

export async function readKey(store: Store): Promise<string | undefined> {
  if (store.store === "env") return process.env[store.locator]?.trim() || undefined;
  try {
    return (await fs.readFile(store.locator, "utf8")).trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function firstStore(stores: Store[]): Promise<Store | undefined> {
  for (const store of stores) if (await readKey(store)) return store;
  return undefined;
}

/** Owner-only, written to a temporary file and renamed so a reader never sees a partial key. */
export async function writeKeyFile(path: string, key: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${key}\n`, { mode: 0o600 });
  await fs.rename(temp, path);
}

export async function removeKeyFile(path: string): Promise<void> {
  await fs.rm(path, { force: true });
}
