import type { PluginClientContext } from "@getpaseo/plugin/client";
import { KeySettings } from "./client/key-settings";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({
    id: "keys",
    title: "OpenRouter keys",
    icon: "KeyRound",
    Component: KeySettings,
  });
  client.addCommandCenterItem({
    id: "keys",
    title: "Set OpenRouter usage keys",
    icon: "KeyRound",
    context: "global",
    onSelect({ openSettings }) {
      openSettings("keys");
    },
  });
  return () => {};
}
