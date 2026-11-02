import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { PageCollector } from "./collector.js";
import type { PathRules, SiteIndex } from "./types.js";

const itemSchema = z.object({
  type: z.string(),
  name: z.string().optional(),
  source: z.enum(["json-ld", "microdata", "table"]),
  data: z.record(z.string(), z.unknown()),
});

const pageSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string().url(),
  description: z.string().optional(),
  text: z.string(),
  lastModified: z.string().optional(),
  kind: z.enum(["html", "pdf", "markdown", "text"]).optional(),
  visibility: z.enum(["public", "private"]).optional(),
  markedPrivate: z.boolean().optional(),
  hash: z.string().optional(),
  etag: z.string().optional(),
  sourceFile: z.string().optional(),
  items: z.array(itemSchema).optional(),
});

const actionFieldSchema = z.object({
  type: z.enum(["string", "number", "integer", "boolean"]),
  description: z.string().optional(),
  enum: z.array(z.string()).optional(),
  format: z.enum(["email", "uri", "date"]).optional(),
  required: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

const siteIndexSchema = z.object({
  version: z.literal(2).optional(),
  name: z.string(),
  description: z.string().optional(),
  url: z.string().url(),
  indexedAt: z.string(),
  pages: z.array(pageSchema),
  warnings: z.array(z.string()),
  diagnostics: z
    .object({
      mode: z.enum(["crawl", "build", "source", "published"]),
      durationMs: z.number(),
      rendered: z.boolean(),
      reusedPages: z.number(),
      skipped: z.array(z.object({ url: z.string(), reason: z.string() })),
      notes: z.array(z.string()),
    })
    .optional(),
  fingerprint: z.string().optional(),
  actions: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
        url: z.string(),
        input: z.record(z.string(), actionFieldSchema).optional(),
        bodyType: z.enum(["json", "form", "query"]).optional(),
        headers: z.record(z.string(), z.string()).optional(),
        confirm: z.boolean().optional(),
        destructive: z.boolean().optional(),
        maxResponseChars: z.number().int().min(1000).max(200_000).optional(),
      }),
    )
    .optional(),
});

export function parseSiteIndex(value: unknown, label = "index"): SiteIndex {
  const result = siteIndexSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
    throw new Error(`${label} is not a valid site2mcp index${where}: ${issue?.message ?? "invalid"}`, {
      cause: result.error,
    });
  }
  return result.data;
}

export async function readSiteIndex(filePath: string): Promise<SiteIndex> {
  const contents = await readFile(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Index file is not valid JSON: ${filePath}`, { cause: error });
  }
  return parseSiteIndex(parsed, `Index file ${filePath}`);
}

export async function writeSiteIndex(filePath: string, site: SiteIndex): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(site)}\n`, "utf8");
  await rename(temporary, filePath);
}

export function publicOnly(site: SiteIndex): SiteIndex {
  const { diagnostics: _diagnostics, actions: _actions, ...rest } = site;
  return {
    ...rest,
    pages: site.pages
      .filter((page) => page.visibility !== "private")
      .map(({ sourceFile: _sourceFile, etag: _etag, ...page }) => page),
    warnings: [],
  };
}

export function applyIndexRules(site: SiteIndex, options: PathRules & { maxPages?: number }): SiteIndex {
  if (!options.include?.length && !options.exclude?.length && !options.private?.length && options.maxPages === undefined) {
    return site;
  }
  const collector = new PageCollector(new URL(site.url), options);
  for (const page of site.pages) {
    if (options.maxPages !== undefined && collector.size >= options.maxPages) break;
    collector.add({ ...page });
  }
  return {
    ...site,
    pages: collector.pages,
    ...(site.diagnostics ? {
      diagnostics: { ...site.diagnostics, skipped: [...site.diagnostics.skipped, ...collector.skipped] },
    } : {}),
  };
}
