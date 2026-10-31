import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  useToast,
  type SettingsInputHandle,
} from "@getpaseo/plugin/client/ui";
import { keysStatus, removeKey, saveKey, type KeyKind, type KeyStatus } from "../shared/keys";

const COPY: Record<KeyKind, { title: string; info: string; placeholder: string }> = {
  apiKey: {
    title: "API key",
    info: "Any OpenRouter API key. Shows the key's spending limit and spend.",
    placeholder: "sk-or-v1-…",
  },
  managementKey: {
    title: "Management key",
    info: "Optional. Shows the account's credits, which OpenRouter serves only to management keys.",
    placeholder: "sk-or-v1-…",
  },
};

function sourceHint(status: KeyStatus): string {
  if (status.source === "env")
    return `From ${status.envVar} in the daemon's environment, which takes precedence over a saved key.`;
  if (status.source === "file") return `Saved on the daemon host in ${status.file}.`;
  return "Not set.";
}

function KeyCard({
  kind,
  status,
  onChanged,
}: {
  kind: KeyKind;
  status: KeyStatus;
  onChanged(): void;
}) {
  const save = useRpc(saveKey);
  const remove = useRpc(removeKey);
  const toast = useToast();
  const input = useRef<SettingsInputHandle>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const copy = COPY[kind];
  const fromEnv = status.source === "env";

  const onSave = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await save({ kind, key: draft });
      if (!result.ok) return setError(result.error);
      input.current?.replaceText("");
      setDraft("");
      toast.show(`${copy.title} saved`, { variant: "success" });
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [save, kind, draft, toast, copy.title, onChanged]);

  const onRemove = useCallback(async () => {
    setBusy(true);
    try {
      await remove({ kind });
      toast.show(`${copy.title} removed`);
      onChanged();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [remove, kind, toast, copy.title, onChanged]);

  return (
    <SettingsSection title={copy.title} info={copy.info}>
      <SettingsCard>
        <SettingsRow label="In use" hint={sourceHint(status)} />
        <SettingsInput
          ref={input}
          label={status.source === "file" ? "Replace key" : "Key"}
          hint={fromEnv ? `Remove ${status.envVar} from the daemon to use a saved key.` : undefined}
          placeholder={copy.placeholder}
          secureTextEntry
          disabled={busy || fromEnv}
          error={error}
          onChangeText={setDraft}
        />
        <SettingsAction
          label="Checks the key with OpenRouter before saving"
          actionLabel={busy ? "Checking…" : "Save"}
          disabled={busy || fromEnv || draft.trim() === ""}
          onPress={onSave}
        />
        {status.source === "file" ? (
          <SettingsAction
            label="Delete the saved key file"
            actionLabel="Remove"
            disabled={busy}
            onPress={onRemove}
          />
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}

export function KeySettings({ theme }: PluginSurfaceProps) {
  const getStatus = useRpc(keysStatus);
  const [status, setStatus] = useState<Awaited<ReturnType<typeof getStatus>>>();
  const [error, setError] = useState<string>();
  const style = useMemo(() => ({ color: theme.colors.foregroundMuted }), [theme]);

  const load = useCallback(() => {
    getStatus({}).then(
      (next) => {
        setStatus(next);
        setError(undefined);
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [getStatus]);
  useEffect(load, [load]);

  if (error)
    return (
      <SettingsSection title="OpenRouter keys">
        <Text style={style}>{error}</Text>
        <SettingsAction label="Try again" actionLabel="Reload" onPress={load} />
      </SettingsSection>
    );
  if (!status) return <Text style={style}>Loading…</Text>;
  return (
    <>
      <KeyCard kind="apiKey" status={status.apiKey} onChanged={load} />
      <KeyCard kind="managementKey" status={status.managementKey} onChanged={load} />
      <Text style={style}>
        Keys stay on the daemon host and are sent only to openrouter.ai. The Usage card picks up a
        change on its next refresh.
      </Text>
    </>
  );
}
