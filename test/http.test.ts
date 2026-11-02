import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { createFetchHandler } from "../src/handler.js";
import { startHttpServer } from "../src/http.js";
import { SiteStore } from "../src/store.js";
import type { SiteIndex } from "../src/types.js";

const site: SiteIndex = {
  name: "Example",
  url: "https://example.test/",
  indexedAt: "2026-01-01T00:00:00.000Z",
  pages: [
    { id: "/", title: "Home", url: "https://example.test/", text: "Public welcome page." },
    { id: "/team", title: "Team handbook", url: "https://example.test/team", text: "Private welcome notes.", visibility: "private" },
  ],
  warnings: [],
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function connect(handler: (request: Request) => Promise<Response>, token?: string) {
  const transport = new StreamableHTTPClientTransport(new URL("http://site.test/mcp"), {
    fetch: (url, init) => handler(new Request(url, init)),
    ...(token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : {}),
  });
  const client = new Client({ name: "http-test", version: "1.0.0" });
  await client.connect(transport);
  cleanups.push(() => client.close());
  return client;
}

async function searchIds(client: Client, query: string): Promise<string[]> {
  const result = await client.callTool({ name: "search", arguments: { query } });
  return (result.structuredContent as { results: Array<{ id: string }> }).results.map((entry) => entry.id).sort();
}

describe("fetch handler", () => {
  it("serves public pages anonymously and everything with a token", async () => {
    const handler = createFetchHandler(site, { tokens: ["s3cret"] });
    expect(await searchIds(await connect(handler), "welcome")).toEqual(["/"]);
    expect(await searchIds(await connect(handler, "s3cret"), "welcome")).toEqual(["/", "/team"]);
    expect(await searchIds(await connect(handler, "wrong"), "welcome")).toEqual(["/"]);
  });

  it("rejects anonymous requests when auth is required", async () => {
    const handler = createFetchHandler(site, { tokens: ["s3cret"], requireAuth: true });
    const response = await handler(
      new Request("http://site.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    expect(await searchIds(await connect(handler, "s3cret"), "welcome")).toEqual(["/", "/team"]);
  });

  it("answers health, discovery, and method checks", async () => {
    const handler = createFetchHandler(site);
    const health = await handler(new Request("http://site.test/healthz"));
    expect(await health.json()).toMatchObject({ ok: true, pages: 2 });

    const discovery = await handler(new Request("http://site.test/.well-known/mcp.json"));
    expect(await discovery.json()).toMatchObject({
      name: "website2mcp", endpoint: "http://site.test/mcp", transport: "streamable-http", authentication: "none",
    });

    const home = await handler(new Request("http://site.test/"));
    expect(await home.text()).toMatch(/^website2mcp: Example\n/);
    expect((await connect(handler)).getServerVersion()?.name).toBe("website2mcp");

    expect((await handler(new Request("http://site.test/mcp"))).status).toBe(405);
    expect((await handler(new Request("http://site.test/nope"))).status).toBe(404);
    const preflight = await handler(new Request("http://site.test/mcp", { method: "OPTIONS" }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("mcp-protocol-version");
  });

  it("reloads the index through the admin endpoint", async () => {
    const store = new SiteStore(site);
    const handler = createFetchHandler(store, {
      tokens: ["s3cret"],
      onReload: async () => store.replace({ ...site, pages: site.pages.slice(0, 1) }),
    });
    const anonymous = await handler(new Request("http://site.test/admin/reload", { method: "POST" }));
    expect(anonymous.status).toBe(401);
    const reloaded = await handler(
      new Request("http://site.test/admin/reload", { method: "POST", headers: { authorization: "Bearer s3cret" } }),
    );
    expect(await reloaded.json()).toMatchObject({ ok: true, pages: 1 });
  });
});

describe("node http server", () => {
  it("serves MCP over a real socket and blocks foreign Host headers", async () => {
    const server = await startHttpServer(createFetchHandler(site), { port: 0 });
    cleanups.push(() => server.close());

    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
    const client = new Client({ name: "socket-test", version: "1.0.0" });
    await client.connect(transport);
    cleanups.unshift(() => client.close());
    expect(await searchIds(client, "welcome")).toEqual(["/"]);

    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const outgoing = request(`${server.url}/healthz`, { headers: { host: "attacker.example" } }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      outgoing.on("error", reject);
      outgoing.end();
    });
    expect(status).toBe(403);
  });
});
