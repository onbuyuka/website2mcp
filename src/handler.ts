import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AnalyticsSink } from "./analytics.js";
import { createSiteMcpServer, VERSION, type SiteServerOptions } from "./mcp.js";
import { SiteStore } from "./store.js";
import type { ActionDefinition, SiteIndex } from "./types.js";

export { SiteStore } from "./store.js";

export interface FetchHandlerOptions {
  tokens?: string[];
  requireAuth?: boolean;
  analytics?: AnalyticsSink;
  actions?: ActionDefinition[];
  actionOptions?: SiteServerOptions["actionOptions"];
  onReload?: () => Promise<void>;
  path?: string;
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-session-id, mcp-protocol-version, last-event-id",
  "access-control-expose-headers": "mcp-session-id",
};

// Stateless Streamable HTTP endpoint that works anywhere with Request/Response (Node, Workers, Deno, Bun).
export function createFetchHandler(source: SiteIndex | SiteStore, options: FetchHandlerOptions = {}) {
  const store = source instanceof SiteStore ? source : new SiteStore(source);
  const mcpPath = options.path ?? "/mcp";
  const tokens = (options.tokens ?? []).filter(Boolean);

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

    if (url.pathname === mcpPath) {
      const authorized = isAuthorized(request, tokens);
      if (options.requireAuth && !authorized) return unauthorized();
      if (request.method === "GET" || request.method === "DELETE") {
        return json({ error: "This endpoint is stateless; send JSON-RPC requests with POST." }, 405, { allow: "POST, OPTIONS" });
      }
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      const server = createSiteMcpServer(store, {
        access: authorized ? "all" : "public",
        analytics: options.analytics,
        transport: "http",
        actions: options.actions,
        actionOptions: options.actionOptions,
      });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      try {
        await server.connect(transport);
        const response = await transport.handleRequest(request);
        const body = await response.arrayBuffer();
        return new Response(body.byteLength ? body : null, {
          status: response.status,
          headers: withCors(response.headers),
        });
      } finally {
        await server.close().catch(() => {});
      }
    }

    if (url.pathname === "/admin/reload" && request.method === "POST") {
      if (!options.onReload || tokens.length === 0) return json({ error: "Not found" }, 404);
      if (!isAuthorized(request, tokens)) return unauthorized();
      await options.onReload();
      return json({ ok: true, pages: store.site.pages.length, indexedAt: store.site.indexedAt });
    }

    if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "Method not allowed" }, 405);

    if (url.pathname === "/healthz") {
      if (store.isLoading) return json({ ok: true, loading: true, pages: 0 });
      return json({ ok: true, pages: store.site.pages.length, indexedAt: store.site.indexedAt });
    }

    if (url.pathname === "/.well-known/mcp.json" || url.pathname === "/.well-known/mcp/server.json") {
      return json({
        name: "website2mcp",
        title: store.site.name,
        description: store.site.description ?? `Read-only MCP access to ${store.site.url}`,
        version: VERSION,
        website: store.site.url,
        endpoint: new URL(mcpPath, url).href,
        transport: "streamable-http",
        authentication: options.requireAuth ? "bearer" : tokens.length ? "optional-bearer" : "none",
        tools: ["search", "fetch", "list_pages", "site_info", "query_items", ...(options.actions ?? []).map((a) => `action_${a.name}`)],
      });
    }

    if (url.pathname === "/") {
      const endpoint = new URL(mcpPath, url).href;
      return new Response(
        `website2mcp: ${store.site.name}\n` +
          `Website: ${store.site.url}\n` +
          `Pages: ${store.pages(false).length}\n` +
          `MCP endpoint (Streamable HTTP): ${endpoint}\n` +
          `Add it to an MCP client, e.g. VS Code: { "servers": { "site": { "type": "http", "url": "${endpoint}" } } }\n`,
        { headers: { "content-type": "text/plain; charset=utf-8", ...CORS_HEADERS } },
      );
    }

    return json({ error: "Not found" }, 404);
  };
}

function isAuthorized(request: Request, tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  return tokens.some((token) => constantTimeEqual(match[1], token));
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

function unauthorized(): Response {
  return json({ error: "A valid bearer token is required." }, 401, { "www-authenticate": 'Bearer realm="website2mcp"' });
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS, ...headers },
  });
}

function withCors(headers: Headers): Headers {
  const result = new Headers(headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) result.set(key, value);
  return result;
}
