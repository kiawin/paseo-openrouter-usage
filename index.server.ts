import type { PluginServerContext } from "@getpaseo/plugin/server";
import { inputSchema } from "./shared/input.js";
import { keysStatus, removeKey, saveKey } from "./shared/keys.js";
import { getKeysStatus, removeKeyFileFor, saveKeyFile } from "./server/keys.js";
import { discover, fetchUsage } from "./server/usage.js";

export default function contribute(server: PluginServerContext) {
  server.registerUsageSource({
    id: "openrouter",
    label: "OpenRouter",
    icon: "icon.svg",
    input: inputSchema,
    discover,
    fetch: fetchUsage,
  });
  server.handle(keysStatus, getKeysStatus);
  server.handle(saveKey, saveKeyFile);
  server.handle(removeKey, removeKeyFileFor);
  return () => {};
}
