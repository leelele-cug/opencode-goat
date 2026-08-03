import { mkdir, stat, chmod, open, unlink } from "node:fs/promises";
import { posix, win32, resolve } from "node:path";
import { join } from "node:path";

export type Platform = "win32" | "darwin" | "linux";
export type Environment = Readonly<Record<string, string | undefined>>;

export function resolveDataHome(platform: Platform, env: Environment): string {
  const path = platform === "win32" ? win32 : posix;
  if (env.OPENCODE_GOAT_HOME) {
    if (!path.isAbsolute(env.OPENCODE_GOAT_HOME)) throw new TypeError("OPENCODE_GOAT_HOME must be absolute");
    return path.normalize(env.OPENCODE_GOAT_HOME);
  }
  if (platform === "win32") { if (!env.LOCALAPPDATA) throw new TypeError("LOCALAPPDATA is required"); return win32.join(env.LOCALAPPDATA, "opencode-goat"); }
  if (platform === "darwin") { if (!env.HOME) throw new TypeError("HOME is required"); return posix.join(env.HOME, "Library", "Application Support", "opencode-goat"); }
  if (env.XDG_DATA_HOME) return posix.join(env.XDG_DATA_HOME, "opencode-goat");
  if (!env.HOME) throw new TypeError("HOME or XDG_DATA_HOME is required");
  return posix.join(env.HOME, ".local", "share", "opencode-goat");
}

export async function prepareDataHome(path: string): Promise<{ ok: true; path: string } | { ok: false; code: "invalid-data-home" | "create-failed" | "write-failed" | "cleanup-failed"; path: string }> {
  const style = /^[a-zA-Z]:[\\/]|^\\\\/.test(path) ? win32 : posix;
  if (!path || path.includes("\0") || !style.isAbsolute(path) || style.parse(path).root === style.normalize(path) || (style === posix && resolve(path) !== path)) return { ok: false, code: "invalid-data-home", path };
  const probe = join(path, `.goat-phase0-probe-${crypto.randomUUID()}`);
  try {
    try { await stat(path); } catch { /* mkdir below creates the missing path */ }
    await mkdir(path, { recursive: true });
    const info = await stat(path);
    if (!info.isDirectory()) return { ok: false, code: "invalid-data-home", path };
    try { await chmod(path, 0o700); } catch { /* Windows and restricted filesystems may not support chmod. */ }
    const secured = await stat(path);
    if (style === posix && (secured.mode & 0o077) !== 0) return { ok: false, code: "create-failed", path };
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try { handle = await open(probe, "wx", 0o600); } catch { return { ok: false, code: "create-failed", path }; }
    try { await handle.writeFile("goat-phase0"); await handle.sync(); } catch {
      try { await handle.close(); await unlink(probe); } catch { return { ok: false, code: "cleanup-failed", path }; }
      return { ok: false, code: "write-failed", path };
    }
    try { await handle.close(); } catch { try { await unlink(probe); } catch { /* cleanup failure is reported below */ } return { ok: false, code: "cleanup-failed", path }; }
    try { await unlink(probe); } catch { return { ok: false, code: "cleanup-failed", path }; }
    return { ok: true, path };
  } catch {
    return { ok: false, code: "create-failed", path };
  }
}
