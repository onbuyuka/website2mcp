import { mkdir, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { contentHash } from "./hash.js";
import { readSiteIndex, writeSiteIndex } from "./index-file.js";
import type { SiteIndex } from "./types.js";

export const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SITE2MCP_CACHE_DIR) return path.resolve(env.SITE2MCP_CACHE_DIR);
  if (process.platform === "win32" && env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, "site2mcp", "cache");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "site2mcp");
  return path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "site2mcp");
}

export function cacheKey(label: string, settings: unknown): string {
  const prefix = label.replace(/[^a-z0-9.-]/gi, "_").slice(0, 60) || "site";
  return `${prefix}-${contentHash(JSON.stringify(settings))}`;
}

export interface CachedIndex {
  site: SiteIndex;
  ageMs: number;
  file: string;
}

export async function readCachedIndex(key: string, dir = cacheDir()): Promise<CachedIndex | undefined> {
  const file = path.join(dir, `${key}.json`);
  try {
    const info = await stat(file);
    const site = await readSiteIndex(file);
    return { site, ageMs: Date.now() - info.mtimeMs, file };
  } catch {
    return undefined;
  }
}

export async function writeCachedIndex(key: string, site: SiteIndex, dir = cacheDir()): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${key}.json`);
  await writeSiteIndex(file, site);
  return file;
}

export async function clearCache(dir = cacheDir()): Promise<number> {
  let removed = 0;
  for (const entry of await readdir(dir).catch(() => [] as string[])) {
    if (!entry.endsWith(".json")) continue;
    await rm(path.join(dir, entry), { force: true });
    removed += 1;
  }
  return removed;
}

export function formatAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}
