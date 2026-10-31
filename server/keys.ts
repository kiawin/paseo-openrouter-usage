import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { KeyKind, KeyStatus, removeKey, saveKey } from "../shared/keys.js";
import { CreditsResponseSchema, KeyResponseSchema, getJson } from "./api.js";
import { keyStores, readKey, removeKeyFile, writeKeyFile } from "./stores.js";

async function status(kind: KeyKind): Promise<KeyStatus> {
  const [env, file] = keyStores(kind);
  let source: KeyStatus["source"] = "none";
  if (await readKey(env)) source = "env";
  else if (await readKey(file)) source = "file";
  return { source, envVar: env.locator, file: file.locator };
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
  } catch (cause) {
    error = `Could not reach OpenRouter: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
  if (error) return { ok: false, error };
  await writeKeyFile(keyStores(kind)[1].locator, key);
  return { ok: true };
}

export async function removeKeyFileFor({ kind }: RpcInput<typeof removeKey>) {
  await removeKeyFile(keyStores(kind)[1].locator);
  return {};
}
