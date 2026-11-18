import { randomBytes } from "node:crypto";
import { constants as fsConstants, promises as fs, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import type { Store } from "../shared/input.js";
import { MAX_OPENROUTER_KEY_LENGTH, type KeyKind } from "../shared/keys.js";

function configDir(): string {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  // XDG_CONFIG_HOME is required to be absolute. Ignore a relative value so a later chdir cannot
  // redirect credential reads or writes to a different working-directory-relative tree.
  if (xdgConfigHome && isAbsolute(xdgConfigHome)) return resolve(xdgConfigHome, "openrouter");
  const home = homedir();
  if (!isAbsolute(home)) throw new Error("OpenRouter credential home directory must be absolute");
  return resolve(home, ".config", "openrouter");
}

const LOCATIONS: Record<KeyKind, { env: string; file: string }> = {
  apiKey: { env: "OPENROUTER_API_KEY", file: "api-key" },
  managementKey: { env: "OPENROUTER_MANAGEMENT_KEY", file: "management-key" },
};

export function environmentStore(kind: KeyKind): Store {
  return { store: "env", locator: LOCATIONS[kind].env };
}

export function fileStore(kind: KeyKind): Store {
  return { store: "file", locator: resolve(configDir(), LOCATIONS[kind].file) };
}

/** The stores for one key, in precedence order: the daemon's environment, then the key file. */
export function keyStores(kind: KeyKind): [env: Store, file: Store] {
  return [environmentStore(kind), fileStore(kind)];
}

function trustedStore(kind: KeyKind, candidate: Store): Store {
  const env = environmentStore(kind);
  if (candidate.store === "env" && candidate.locator === env.locator) return env;

  const canonicalFile = fileStore(kind).locator;
  if (
    candidate.store === "file" &&
    isAbsolute(candidate.locator) &&
    resolve(candidate.locator) === canonicalFile
  )
    return { store: "file", locator: canonicalFile };

  const label = kind === "apiKey" ? "API key" : "management key";
  throw new Error(`OpenRouter ${label} locator was not provided by this plugin`);
}

function normalizeKey(value: string | undefined): string | undefined {
  const key = value?.trim();
  return key && key.length <= MAX_OPENROUTER_KEY_LENGTH && /^[\x21-\x7e]+$/.test(key)
    ? key
    : undefined;
}

export async function readKey(kind: KeyKind, candidate: Store): Promise<string | undefined> {
  // Validate and normalize here, at the only file/env access point, so future callers cannot
  // accidentally bypass the approved-source boundary or open a client-supplied relative path.
  const store = trustedStore(kind, candidate);
  if (store.store === "env") return normalizeKey(process.env[store.locator]);
  try {
    // Resolve and validate the whole credential directory chain before opening the file. This
    // keeps reads and writes under the same ownership/permission policy, including symlink dirs.
    const dir = await resolveSafeDirectory(dirname(store.locator));
    if (!dir) return undefined;
    const path = join(dir, basename(store.locator));
    // O_NOFOLLOW closes the lstat/open race where supported; inode/link checks are a portable
    // second guard against symlinks, hardlinks, and special files.
    const before = await fs.lstat(path);
    if (!before.isFile() || before.nlink !== 1) return undefined;
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    const handle = await fs.open(path, flags);
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino
      )
        return undefined;
      const buffer = Buffer.alloc(MAX_OPENROUTER_KEY_LENGTH + 3);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      if (bytesRead > MAX_OPENROUTER_KEY_LENGTH + 2) return undefined;
      return normalizeKey(buffer.subarray(0, bytesRead).toString("utf8"));
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

async function resolveSafeDirectory(
  path: string,
  allowMissing = false,
  allowStickyLeaf = false,
  seenLinks: Set<string> = new Set(),
): Promise<string | undefined> {
  // Keep `..` components from symlink targets intact: POSIX resolves any preceding symlink
  // before applying `..`, which a lexical path.resolve() would incorrectly collapse.
  const absolute = isAbsolute(path) ? path : resolve(path);
  const root = parse(absolute).root;
  const separator = process.platform === "win32" ? /[\\/]+/ : sep;
  const components = absolute.slice(root.length).split(separator).filter(Boolean);
  const isWindows = process.platform === "win32";
  let current = root;

  const checkOwner = (stat: Stats) => {
    if (!isWindows) {
      const uid = process.getuid?.();
      if (uid === undefined || (stat.uid !== uid && stat.uid !== 0))
        throw new Error("credential path component is not owned by the daemon or root");
    }
  };
  const checkDirectory = (
    stat: Stats,
    isLeaf: boolean,
  ) => {
    if (!stat.isDirectory()) throw new Error("credential path component is not a directory");
    checkOwner(stat);
    if (!isWindows) {
      const writableByOthers = (stat.mode & 0o022) !== 0;
      const sticky = (stat.mode & 0o1000) !== 0;
      if (writableByOthers && (!sticky || (isLeaf && !allowStickyLeaf)))
        throw new Error("credential path has an unprotected writable component");
    }
  };

  const rootStat = await fs.lstat(root);
  checkDirectory(rootStat, components.length === 0);
  for (let index = 0; index < components.length; index++) {
    const component = components[index];
    if (component === ".") continue;
    if (component === "..") {
      current = dirname(current);
      continue;
    }
    const candidate = join(current, component);
    let stat: Stats;
    try {
      stat = await fs.lstat(candidate);
    } catch (cause) {
      if (allowMissing && hasErrorCode(cause, "ENOENT")) return undefined;
      throw cause;
    }

    checkOwner(stat);
    if (stat.isSymbolicLink()) {
      const linkPath = resolve(candidate);
      if (seenLinks.has(linkPath) || seenLinks.size >= 40)
        throw new Error("credential symlink chain is invalid");
      const linkTarget = await fs.readlink(candidate);
      if (process.platform === "win32" && /^[A-Za-z]:/.test(linkTarget) && !isAbsolute(linkTarget))
        throw new Error("drive-relative credential symlink is unsupported");
      const targetPath = isAbsolute(linkTarget)
        ? linkTarget
        : `${dirname(candidate)}${sep}${linkTarget}`;
      const nextSeen = new Set(seenLinks);
      nextSeen.add(linkPath);
      const hasRemainingComponent = components.slice(index + 1).some((part) => part !== ".");
      const resolvedTarget = await resolveSafeDirectory(
        targetPath,
        allowMissing,
        allowStickyLeaf || hasRemainingComponent,
        nextSeen,
      );
      if (!resolvedTarget) {
        if (allowMissing) return undefined;
        throw new Error("credential symlink target is unavailable");
      }
      current = resolvedTarget;
      continue;
    }

    checkDirectory(stat, index === components.length - 1);
    current = candidate;
  }
  try {
    checkDirectory(await fs.lstat(current), true);
  } catch (cause) {
    if (allowMissing && hasErrorCode(cause, "ENOENT")) return undefined;
    throw cause;
  }
  return current;
}

/**
 * Writes an owner-only temp file beside the target and atomically renames it into place. A
 * symlinked credential directory is supported when its resolved target is owned by this daemon
 * and not writable by group/other; existing safe directory modes are not changed. Every POSIX
 * path component must be owned by the daemon or root, and untrusted writable ancestors are
 * rejected. Windows ACLs are not represented by stat mode bits, so that check is best-effort there.
 * Same-user code remains within the daemon's trust boundary.
 */
export async function writeKeyFile(
  kind: KeyKind,
  candidate: Store,
  key: string,
): Promise<void> {
  let path: string;
  try {
    const store = trustedStore(kind, candidate);
    if (store.store !== "file") throw new Error("not a key file");
    path = store.locator;
  } catch {
    throw new Error("Could not write the key file");
  }
  const requestedDir = dirname(path);
  let dir: string | undefined;
  let temp: string | undefined;
  let target: string | undefined;
  let handle: fs.FileHandle | undefined;
  try {
    await resolveSafeDirectory(requestedDir, true);
    await fs.mkdir(requestedDir, { recursive: true, mode: 0o700 });
    dir = await resolveSafeDirectory(requestedDir);
    if (!dir) throw new Error("credential directory is unavailable");

    target = join(dir, basename(path));
    try {
      const existing = await fs.lstat(target);
      if (!existing.isFile() || existing.nlink !== 1)
        throw new Error("credential target is not a single-link regular file");
    } catch (cause) {
      if (!hasErrorCode(cause, "ENOENT")) throw cause;
    }
    temp = join(dir, `.${basename(path)}.${randomBytes(16).toString("hex")}.tmp`);
    handle = await fs.open(temp, "wx", 0o600);
    await handle.writeFile(`${key}\n`);
    const created = await handle.stat();
    await handle.close();
    handle = undefined;

    // Refuse a replaced temp entry before the atomic rename.
    const current = await fs.lstat(temp);
    if (
      current.ino !== created.ino ||
      current.dev !== created.dev ||
      current.nlink !== 1 ||
      !current.isFile()
    )
      throw new Error("temporary key file was replaced");

    await fs.rename(temp, target);
  } catch {
    // Close before unlinking so cleanup also works on platforms that reject removal of open files.
    await handle?.close().catch(() => {});
    handle = undefined;
    if (temp) await fs.rm(temp, { force: true }).catch(() => {});
    // Sanitized: filesystem errors carry raw paths and permission details.
    throw new Error("Could not write the key file");
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function removeKeyFile(kind: KeyKind, candidate: Store): Promise<void> {
  try {
    const store = trustedStore(kind, candidate);
    if (store.store !== "file") throw new Error("not a key file");
    const dir = await resolveSafeDirectory(dirname(store.locator), true);
    if (!dir) return;
    await fs.rm(join(dir, basename(store.locator)), { force: true });
  } catch {
    throw new Error("Could not remove the key file");
  }
}

function hasErrorCode(cause: unknown, code: string): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code?: unknown }).code === code
  );
}
