import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { KeyKind, KeyStatus, removeKey, saveKey } from "../shared/keys.js";
import { CreditsResponseSchema, KeyResponseSchema, getJson } from "./api.js";
import {
  environmentStore,
  fileStore,
  readKey,
  removeKeyFile,
  writeKeyFile,
} from "./stores.js";

async function status(kind: KeyKind): Promise<KeyStatus> {
  const env = environmentStore(kind);
  let source: KeyStatus["source"] = (await readKey(kind, env)) ? "env" : "none";
  let file = "";
  try {
    const store = fileStore(kind);
    file = store.locator;
    if (source === "none" && (await readKey(kind, store))) source = "file";
  } catch {
    // Environment-only configurations remain usable even when the daemon home is invalid.
  }
  return { source, envVar: env.locator, file };
}

export async function getKeysStatus() {
  const [apiKey, managementKey] = await Promise.all([status("apiKey"), status("managementKey")]);
  return { apiKey, managementKey };
}

async function checkKey(kind: KeyKind, key: string): Promise<string | undefined> {
  if (kind === "apiKey") {
    const result = await getJson("/key", key, KeyResponseSchema);
    return result.ok ? undefined : "OpenRouter rejected this API key.";
  }
  const result = await getJson("/credits", key, CreditsResponseSchema);
  if (result.ok) return undefined;
  return result.status === 403
    ? "This is not a management key. Create one in your OpenRouter account settings."
    : "OpenRouter rejected this management key.";
}

export async function saveKeyFile({
  kind,
  key,
}: RpcInput<typeof saveKey>): Promise<RpcOutput<typeof saveKey>> {
  let error: string | undefined;
  try {
    error = await checkKey(kind, key);
  } catch {
    // Sanitized: network and filesystem errors can carry URLs, paths, or response bodies.
    error = "Could not reach OpenRouter. Check the network on the daemon host and try again.";
  }
  if (error) return { ok: false, error };
  try {
    await writeKeyFile(kind, fileStore(kind), key);
  } catch {
    return { ok: false, error: "Could not save the key file. Check the daemon host's permissions." };
  }
  return { ok: true };
}

export async function removeKeyFileFor({ kind }: RpcInput<typeof removeKey>) {
  try {
    await removeKeyFile(kind, fileStore(kind));
  } catch {
    // Sanitized: filesystem errors carry the raw paths and permission details.
    throw new Error("Could not remove the key file. Check the daemon host's permissions.");
  }
  return {};
}
