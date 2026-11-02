import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerActionTools } from "./actions.js";
import type { AnalyticsEvent, AnalyticsSink } from "./analytics.js";
import { SiteStore } from "./store.js";
import type { ActionDefinition, CrawlOptions, SiteIndex, SitePage } from "./types.js";

export const VERSION = "1.0.0";
const DEFAULT_FETCH_LENGTH = 40_000;

const kindSchema = z.enum(["html", "pdf", "markdown", "text"]);

const searchResultSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
  section: z.string().optional(),
  kind: kindSchema.optional(),
  score: z.number(),
});

const pageSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  description: z.string().optional(),
  lastModified: z.string().optional(),
  kind: kindSchema.optional(),
});

const pageContentSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  text: z.string(),
  totalLength: z.number().int(),
  nextOffset: z.number().int().optional(),
  metadata: z.object({
    kind: z.string(),
    description: z.string().optional(),
    lastModified: z.string().optional(),
    private: z.boolean().optional(),
    structuredItems: z.number().int().optional(),
  }),
});

const itemResultSchema = z.object({
  pageId: z.string(),
  pageUrl: z.string(),
  type: z.string(),
  name: z.string().optional(),
  source: z.string(),
  data: z.record(z.string(), z.unknown()),
});

const siteInfoSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  url: z.string(),
  pageCount: z.number().int(),
  indexedAt: z.string(),
  mode: z.string().optional(),
  rendered: z.boolean().optional(),
  sections: z.array(z.object({ path: z.string(), pages: z.number().int() })),
  itemTypes: z.record(z.string(), z.number()),
  actions: z.array(z.string()),
  warnings: z.array(z.string()),
});

export interface SiteServerOptions {
  // "all" serves private pages too (local stdio or authenticated HTTP).
  access?: "all" | "public";
  analytics?: AnalyticsSink;
  transport?: "stdio" | "http";
  actions?: ActionDefinition[];
  actionOptions?: {
    fetchImpl?: typeof fetch;
    env?: Record<string, string | undefined>;
    lookupImpl?: CrawlOptions["lookupImpl"];
    allowPrivateHosts?: boolean;
  };
}

export function createSiteMcpServer(source: SiteIndex | SiteStore, options: SiteServerOptions = {}): McpServer {
  const store = source instanceof SiteStore ? source : new SiteStore(source);
  const includePrivate = (options.access ?? "all") === "all";
  const server = new McpServer(
    { name: "website2mcp", version: VERSION },
    {
      instructions:
        `Read-only access to the website "${store.site.name}" (${store.site.url}). ` +
        "Use search to find relevant pages, then fetch to read them. Cite page URLs in answers. " +
        "Use query_items for structured data such as products, events, or tables.",
    },
  );

  const track = <A extends Record<string, unknown>, R>(
    tool: string,
    describe: (args: A, result: unknown) => Partial<AnalyticsEvent>,
    handler: (args: A) => Promise<R>,
  ) => {
    return async (args: A): Promise<R> => {
      const started = performance.now();
      let result: R | undefined;
      let error: string | undefined;
      try {
        await store.ready();
        result = await handler(args);
        return result;
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
        throw caught;
      } finally {
        if (options.analytics) {
          const client = server.server.getClientVersion();
          const isError = Boolean((result as { isError?: boolean } | undefined)?.isError);
          options.analytics.record({
            ts: new Date().toISOString(),
            tool,
            ...(client ? { client: `${client.name} ${client.version}` } : {}),
            transport: options.transport ?? "stdio",
            auth: includePrivate && options.transport === "http" ? "token" : "anonymous",
            ok: !error && !isError,
            ...(error ? { error } : {}),
            durationMs: Math.round(performance.now() - started),
            ...describe(args, result),
          });
        }
      }
    };
  };

  server.registerTool(
    "search",
    {
      title: "Search the website",
      description:
        "Search this website. Returns the best-matching pages with a snippet from the most relevant section. Use fetch with a result id to read the full page.",
      inputSchema: {
        query: z.string().min(1).max(500).describe("Keywords or a question."),
        limit: z.number().int().min(1).max(50).default(10).describe("Maximum results (1-50)."),
        pathPrefix: z.string().max(2048).optional().describe("Only return pages whose id starts with this path, e.g. /docs/."),
        kind: kindSchema.optional().describe("Only return one content type, e.g. pdf."),
      },
      outputSchema: { results: z.array(searchResultSchema) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    track(
      "search",
      (args, result) => ({
        query: args.query.slice(0, 200),
        ...(args.pathPrefix ? { pathPrefix: args.pathPrefix } : {}),
        resultCount: countOf(result, "results"),
      }),
      async ({ query, limit, pathPrefix, kind }) => {
        const results = store.search(query, { limit, pathPrefix, kind, includePrivate });
        return structuredResult({ results });
      },
    ),
  );

  server.registerTool(
    "fetch",
    {
      title: "Read a page",
      description:
        "Fetch the full text (Markdown) of a page by the id from search or list_pages. A full page URL also works. Long pages are paged: pass nextOffset as offset to continue.",
      inputSchema: {
        id: z.string().min(1).max(4096).describe("Page id (e.g. /about/) or full URL."),
        offset: z.number().int().min(0).default(0).describe("Character offset to start from."),
        maxLength: z.number().int().min(500).max(200_000).default(DEFAULT_FETCH_LENGTH).describe("Maximum characters to return."),
      },
      outputSchema: pageContentSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    track(
      "fetch",
      (args, result) => ({ pageId: args.id, resultCount: (result as { isError?: boolean } | undefined)?.isError ? 0 : 1 }),
      async ({ id, offset, maxLength }) => {
        const page = store.page(id, includePrivate);
        if (!page) return toolError(`Unknown page "${id}". Use search or list_pages to find a valid id.`);
        return structuredResult(toPageContent(page, offset, maxLength));
      },
    ),
  );

  server.registerTool(
    "list_pages",
    {
      title: "List pages",
      description: "List indexed pages, optionally under a path. Use nextCursor to continue.",
      inputSchema: {
        pathPrefix: z.string().max(2048).optional().describe("Only list pages whose id starts with this path."),
        kind: kindSchema.optional(),
        cursor: z.string().regex(/^\d+$/).optional(),
        limit: z.number().int().min(1).max(200).default(50),
      },
      outputSchema: z.object({
        pages: z.array(pageSummarySchema),
        total: z.number().int(),
        nextCursor: z.string().optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    track(
      "list_pages",
      (args, result) => ({
        ...(args.pathPrefix ? { pathPrefix: args.pathPrefix } : {}),
        resultCount: countOf(result, "pages"),
      }),
      async ({ pathPrefix, kind, cursor, limit }) => {
        const filtered = store
          .pages(includePrivate)
          .filter((page) => (!pathPrefix || page.id.startsWith(pathPrefix)) && (!kind || (page.kind ?? "html") === kind));
        const offset = cursor ? Number(cursor) : 0;
        const pages = filtered.slice(offset, offset + limit).map(toPageSummary);
        const nextOffset = offset + pages.length;
        const nextCursor = nextOffset < filtered.length ? String(nextOffset) : undefined;
        return structuredResult({ pages, total: filtered.length, ...(nextCursor ? { nextCursor } : {}) });
      },
    ),
  );

  server.registerTool(
    "site_info",
    {
      title: "About this website",
      description:
        "Get the site's name, URL, page count, main sections, structured data types, available actions, and indexing warnings.",
      inputSchema: {},
      outputSchema: siteInfoSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    track("site_info", () => ({}), async () => {
      const site = store.site;
      const pages = store.pages(includePrivate);
      return structuredResult({
        name: site.name,
        ...(site.description ? { description: site.description } : {}),
        url: site.url,
        pageCount: pages.length,
        indexedAt: site.indexedAt,
        ...(site.diagnostics ? { mode: site.diagnostics.mode, rendered: site.diagnostics.rendered } : {}),
        sections: topSections(pages, site.url),
        itemTypes: store.itemTypes(includePrivate),
        actions: (options.actions ?? []).map((action) => `action_${action.name}`),
        warnings: [...emptyIndexWarnings(site), ...site.warnings].slice(0, 20),
      });
    }),
  );

  server.registerTool(
    "query_items",
    {
      title: "Query structured data",
      description:
        "Query structured data found on the site: schema.org JSON-LD/microdata (Product, Event, Recipe, Person, FAQPage, …) and data tables (type Table). Filter by type and/or text. site_info lists the available types.",
      inputSchema: {
        type: z.string().max(200).optional().describe("Item type, e.g. Product, Event, or Table."),
        text: z.string().max(500).optional().describe("Case-insensitive text to match; for tables, only matching rows are returned."),
        pathPrefix: z.string().max(2048).optional(),
        cursor: z.string().regex(/^\d+$/).optional(),
        limit: z.number().int().min(1).max(100).default(20),
      },
      outputSchema: z.object({ items: z.array(itemResultSchema), total: z.number().int(), nextCursor: z.string().optional() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    track(
      "query_items",
      (args, result) => ({
        ...(args.text ? { query: args.text.slice(0, 200) } : {}),
        ...(args.type ? { itemType: args.type } : {}),
        resultCount: countOf(result, "items"),
      }),
      async ({ type, text, pathPrefix, cursor, limit }) => {
        const all = store.items({ type, text, pathPrefix, includePrivate });
        const offset = cursor ? Number(cursor) : 0;
        const items = all
          .slice(offset, offset + limit)
          .map(({ private: _private, ...item }) => item);
        const nextOffset = offset + items.length;
        const nextCursor = nextOffset < all.length ? String(nextOffset) : undefined;
        return structuredResult({ items, total: all.length, ...(nextCursor ? { nextCursor } : {}) });
      },
    ),
  );

  if (options.actions?.length) {
    registerActionTools(server, options.actions, {
      siteUrl: store.site.url,
      ...options.actionOptions,
      onRun: (event) => {
        options.analytics?.record({
          ts: new Date().toISOString(),
          tool: `action_${event.action}`,
          transport: options.transport ?? "stdio",
          ok: event.ok,
          ...(event.error ? { error: event.error } : {}),
          durationMs: Math.round(event.durationMs),
        });
      },
    });
  }

  return server;
}

function toPageContent(page: SitePage, offset: number, maxLength: number) {
  const text = page.text.slice(offset, offset + maxLength);
  const nextOffset = offset + text.length < page.text.length ? offset + text.length : undefined;
  return {
    id: page.id,
    title: page.title,
    url: page.url,
    text,
    totalLength: page.text.length,
    ...(nextOffset !== undefined ? { nextOffset } : {}),
    metadata: {
      kind: page.kind ?? "html",
      ...(page.description ? { description: page.description } : {}),
      ...(page.lastModified ? { lastModified: page.lastModified } : {}),
      ...(page.visibility === "private" ? { private: true } : {}),
      ...(page.items?.length ? { structuredItems: page.items.length } : {}),
    },
  };
}

function toPageSummary(page: SitePage) {
  return {
    id: page.id,
    title: page.title,
    url: page.url,
    ...(page.description ? { description: page.description } : {}),
    ...(page.lastModified ? { lastModified: page.lastModified } : {}),
    ...(page.kind && page.kind !== "html" ? { kind: page.kind } : {}),
  };
}

function topSections(pages: SitePage[], siteUrl: string) {
  const basePath = new URL(siteUrl).pathname;
  const counts = new Map<string, number>();
  for (const page of pages) {
    const relative = page.id.startsWith(basePath) ? page.id.slice(basePath.length) : page.id.replace(/^\//, "");
    const first = relative.replace(/^#!?\//, "").split(/[/?#]/)[0];
    const hashPrefix = /^#!?\//.exec(relative)?.[0] ?? "";
    const key = first ? `${basePath}${hashPrefix}${first}` : basePath;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 15)
    .map(([path, count]) => ({ path, pages: count }));
}

function emptyIndexWarnings(site: SiteIndex): string[] {
  if (site.pages.length > 0) return [];
  const skipped = site.diagnostics?.skipped ?? [];
  if (skipped.length === 0) return ["No pages were indexed."];
  const shown = skipped.slice(0, 3).map((page) => `${page.url} (${page.reason})`).join(", ");
  const more = skipped.length > 3 ? ` and ${skipped.length - 3} more` : "";
  return [`No pages were indexed. Skipped: ${shown}${more}.`];
}

function countOf(result: unknown, key: string): number | undefined {
  const content = (result as { structuredContent?: Record<string, unknown> } | undefined)?.structuredContent;
  const value = content?.[key];
  return Array.isArray(value) ? value.length : undefined;
}

function structuredResult<T extends Record<string, unknown>>(value: T) {
  return {
    structuredContent: value,
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

function toolError(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}
