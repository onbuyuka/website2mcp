import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const CONFIG_FILE = "website2mcp.config.json";

const stringList = z.union([z.string(), z.array(z.string())]).transform((value) => (Array.isArray(value) ? value : [value]));

const configSchema = z.strictObject({
  $schema: z.string().optional(),
  source: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  baseUrl: z.string().optional(),
  outDir: z.string().optional(),
  build: z.boolean().optional(),
  render: z.boolean().optional(),
  maxPages: z.number().int().min(1).max(5000).optional(),
  maxDepth: z.number().int().min(0).max(20).optional(),
  concurrency: z.number().int().min(1).max(8).optional(),
  include: stringList.optional(),
  exclude: stringList.optional(),
  private: stringList.optional(),
  headers: z.record(z.string(), z.string()).optional(),
  userAgent: z.string().optional(),
  published: z.boolean().optional(),
  llmsTxt: z.boolean().optional(),
  cache: z.boolean().optional(),
  cacheTtl: z.union([z.string(), z.number()]).optional(),
  includeDrafts: z.boolean().optional(),
  http: z
    .strictObject({
      port: z.number().int().min(0).max(65535).optional(),
      host: z.string().optional(),
      tokens: stringList.optional(),
      requireAuth: z.boolean().optional(),
    })
    .optional(),
  analytics: z
    .union([z.string(), z.strictObject({ file: z.string(), redactQueries: z.boolean().optional() })])
    .optional(),
  actions: z.array(z.unknown()).optional(),
  allowedActionOrigins: z.array(z.string()).optional(),
});

export type FileConfig = z.infer<typeof configSchema>;

export interface Settings {
  source?: string;
  name?: string;
  description?: string;
  baseUrl?: string;
  outDir?: string;
  build?: boolean;
  render?: boolean;
  maxPages?: number;
  maxDepth?: number;
  concurrency?: number;
  include?: string[];
  exclude?: string[];
  private?: string[];
  headers?: Record<string, string>;
  userAgent?: string;
  published?: boolean;
  llmsTxt?: boolean;
  cache?: boolean;
  cacheTtlMs?: number;
  refresh?: boolean;
  includeDrafts?: boolean;
  watch?: boolean;
  http?: boolean;
  port?: number;
  host?: string;
  tokens?: string[];
  requireAuth?: boolean;
  analyticsFile?: string;
  redactQueries?: boolean;
  actions?: unknown[];
  allowedActionOrigins?: string[];
  configDir?: string;
}

export interface LoadedConfig {
  file: string;
  settings: Settings;
}

export async function loadConfig(file: string, env: NodeJS.ProcessEnv = process.env): Promise<LoadedConfig> {
  const resolved = path.resolve(file);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(resolved, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Config file not found: ${resolved}`);
    throw new Error(`Could not read ${resolved}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`${resolved} is invalid: ${issues}`);
  }
  return { file: resolved, settings: fromFileConfig(parsed.data, path.dirname(resolved), env) };
}

// Looks for website2mcp.config.json in each folder, first match wins.
export async function findConfig(dirs: string[]): Promise<string | undefined> {
  for (const dir of dirs) {
    const candidate = path.resolve(dir, CONFIG_FILE);
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

function fromFileConfig(config: FileConfig, dir: string, env: NodeJS.ProcessEnv): Settings {
  const analytics = typeof config.analytics === "string" ? { file: config.analytics } : config.analytics;
  const source = config.source && !/^https?:\/\//i.test(config.source) ? path.resolve(dir, config.source) : config.source;
  return dropUndefined({
    source,
    name: config.name,
    description: config.description,
    baseUrl: config.baseUrl,
    outDir: config.outDir,
    build: config.build,
    render: config.render,
    maxPages: config.maxPages,
    maxDepth: config.maxDepth,
    concurrency: config.concurrency,
    include: config.include,
    exclude: config.exclude,
    private: config.private,
    headers: config.headers ? expandHeaders(config.headers, env) : undefined,
    userAgent: config.userAgent,
    published: config.published,
    llmsTxt: config.llmsTxt,
    cache: config.cache,
    cacheTtlMs: config.cacheTtl === undefined ? undefined : parseDuration(config.cacheTtl),
    includeDrafts: config.includeDrafts,
    port: config.http?.port,
    host: config.http?.host,
    tokens: config.http?.tokens?.map((token) => expandEnv(token, env)).filter(Boolean),
    requireAuth: config.http?.requireAuth,
    analyticsFile: analytics ? path.resolve(dir, analytics.file) : undefined,
    redactQueries: analytics?.redactQueries,
    actions: config.actions,
    allowedActionOrigins: config.allowedActionOrigins,
    configDir: dir,
  });
}

export function mergeSettings(...layers: Settings[]): Settings {
  const result: Settings = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined) continue;
      if (Array.isArray(value) && value.length === 0 && key !== "actions") continue;
      if (key === "headers") {
        result.headers = { ...result.headers, ...(value as Record<string, string>) };
        continue;
      }
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

export function expandEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const resolved = env[name];
    if (resolved === undefined) throw new Error(`Environment variable ${name} is not set.`);
    return resolved;
  });
}

export function expandHeaders(headers: Record<string, string>, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, expandEnv(value, env)]));
}

export function parseHeaderFlag(value: string, env: NodeJS.ProcessEnv = process.env): [string, string] {
  const separator = value.indexOf(":");
  if (separator <= 0) throw new Error(`--header must look like "Name: value" (got "${value}").`);
  const name = value.slice(0, separator).trim();
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new Error(`Invalid header name "${name}".`);
  return [name, expandEnv(value.slice(separator + 1).trim(), env)];
}

export function parseDuration(value: string | number): number {
  if (typeof value === "number") return value * 1000;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$/i.exec(value);
  if (!match) throw new Error(`Invalid duration "${value}". Use values like 30s, 15m, 6h, or 1d.`);
  const amount = Number(match[1]);
  const unit = (match[2] ?? "s").toLowerCase();
  const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 1000;
  return Math.round(amount * factor);
}

function dropUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
