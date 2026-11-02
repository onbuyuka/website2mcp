import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryAnalytics } from "../src/analytics.js";
import { createSiteMcpServer, type SiteServerOptions } from "../src/mcp.js";
import { SiteStore } from "../src/store.js";
import type { SiteIndex } from "../src/types.js";

const longText = `# Guide\n\n${"Lorem ipsum dolor sit amet. ".repeat(100)}`;

const site: SiteIndex = {
  name: "Example",
  url: "https://example.test/",
  indexedAt: "2026-01-01T00:00:00.000Z",
  pages: [
    { id: "/", title: "Home", url: "https://example.test/", text: "Welcome to our site." },
    {
      id: "/about",
      title: "About",
      url: "https://example.test/about",
      text: "We build reliable integrations.",
      items: [{ type: "Organization", name: "Example Inc", source: "json-ld", data: { "@type": "Organization", name: "Example Inc" } }],
    },
    { id: "/docs/guide", title: "Guide", url: "https://example.test/docs/guide", text: longText },
    {
      id: "/docs/prices",
      title: "Prices",
      url: "https://example.test/docs/prices",
      text: "Plans and prices.",
      items: [
        {
          type: "Table",
          name: "Plans",
          source: "table",
          data: { columns: ["Plan", "Price"], rows: [{ Plan: "Basic", Price: "$5" }, { Plan: "Pro", Price: "$20" }] },
        },
      ],
    },
    { id: "/files/report.pdf", title: "Annual report", url: "https://example.test/files/report.pdf", text: "Revenue grew.", kind: "pdf" },
    {
      id: "/internal/roadmap",
      title: "Roadmap",
      url: "https://example.test/internal/roadmap",
      text: "Secret integrations roadmap.",
      visibility: "private",
    },
  ],
  warnings: [],
  diagnostics: { mode: "crawl", durationMs: 10, rendered: false, reusedPages: 0, skipped: [], notes: [] },
};

describe("MCP server", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function connect(source: SiteIndex | SiteStore, options?: SiteServerOptions) {
    const server = createSiteMcpServer(source, options);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    return client;
  }

  it("exposes read-only tools with structured results", async () => {
    const client = await connect(site);
    expect(client.getServerVersion()?.name).toBe("website2mcp");
    const listed = await client.listTools();
    expect(listed.tools.map(({ name }) => name).sort()).toEqual(["fetch", "list_pages", "query_items", "search", "site_info"]);
    expect(listed.tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(true);

    const search = await client.callTool({ name: "search", arguments: { query: "integrations" } });
    expect((search.structuredContent as { results: Array<{ id: string }> }).results.map((result) => result.id).sort()).toEqual([
      "/about",
      "/internal/roadmap",
    ]);

    const fetched = await client.callTool({ name: "fetch", arguments: { id: "/about" } });
    expect(fetched.structuredContent).toMatchObject({
      id: "/about",
      text: "We build reliable integrations.",
      totalLength: 31,
      metadata: { kind: "html", structuredItems: 1 },
    });
  });

  it("filters search by path and kind", async () => {
    const client = await connect(site);
    const docs = await client.callTool({ name: "search", arguments: { query: "prices plans", pathPrefix: "/docs/" } });
    expect((docs.structuredContent as { results: Array<{ id: string }> }).results.map((result) => result.id)).toEqual(["/docs/prices"]);

    const pdfs = await client.callTool({ name: "search", arguments: { query: "revenue", kind: "pdf" } });
    expect(pdfs.structuredContent).toMatchObject({ results: [{ id: "/files/report.pdf", kind: "pdf" }] });
  });

  it("pages long documents and accepts full URLs", async () => {
    const client = await connect(site);
    const first = await client.callTool({ name: "fetch", arguments: { id: "https://example.test/docs/guide", maxLength: 1000 } });
    const firstContent = first.structuredContent as { text: string; nextOffset?: number; totalLength: number };
    expect(firstContent.text).toHaveLength(1000);
    expect(firstContent.nextOffset).toBe(1000);

    const second = await client.callTool({ name: "fetch", arguments: { id: "/docs/guide", offset: 2000, maxLength: 1000 } });
    const secondContent = second.structuredContent as { text: string; nextOffset?: number };
    expect(secondContent.text).toBe(longText.slice(2000));
    expect(secondContent.nextOffset).toBeUndefined();

    const missing = await client.callTool({ name: "fetch", arguments: { id: "/nope" } });
    expect(missing.isError).toBe(true);
  });

  it("lists pages with cursors and reports site info", async () => {
    const client = await connect(site);
    const first = await client.callTool({ name: "list_pages", arguments: { limit: 4 } });
    expect(first.structuredContent).toMatchObject({ total: 6, nextCursor: "4" });
    const rest = await client.callTool({ name: "list_pages", arguments: { limit: 4, cursor: "4" } });
    expect((rest.structuredContent as { pages: unknown[]; nextCursor?: string }).pages).toHaveLength(2);
    expect((rest.structuredContent as { nextCursor?: string }).nextCursor).toBeUndefined();

    const docs = await client.callTool({ name: "list_pages", arguments: { pathPrefix: "/docs/" } });
    expect(docs.structuredContent).toMatchObject({ total: 2 });

    const info = await client.callTool({ name: "site_info", arguments: {} });
    expect(info.structuredContent).toMatchObject({
      name: "Example",
      pageCount: 6,
      mode: "crawl",
      itemTypes: { Organization: 1, Table: 1 },
      actions: [],
    });
    expect((info.structuredContent as { sections: Array<{ path: string; pages: number }> }).sections).toContainEqual({
      path: "/docs",
      pages: 2,
    });
  });

  it("queries structured items and filters table rows", async () => {
    const client = await connect(site);
    const orgs = await client.callTool({ name: "query_items", arguments: { type: "organization" } });
    expect(orgs.structuredContent).toMatchObject({ total: 1, items: [{ name: "Example Inc", pageId: "/about" }] });

    const rows = await client.callTool({ name: "query_items", arguments: { type: "Table", text: "pro" } });
    expect(rows.structuredContent).toMatchObject({
      items: [{ data: { rows: [{ Plan: "Pro", Price: "$20" }], matchedRows: 1, totalRows: 2 } }],
    });
  });

  it("hides private pages from public access", async () => {
    const client = await connect(site, { access: "public" });
    const search = await client.callTool({ name: "search", arguments: { query: "integrations" } });
    expect((search.structuredContent as { results: Array<{ id: string }> }).results.map((result) => result.id)).toEqual(["/about"]);
    const fetched = await client.callTool({ name: "fetch", arguments: { id: "/internal/roadmap" } });
    expect(fetched.isError).toBe(true);
    const listed = await client.callTool({ name: "list_pages", arguments: {} });
    expect(listed.structuredContent).toMatchObject({ total: 5 });
  });

  it("records analytics for each tool call", async () => {
    const analytics = createMemoryAnalytics();
    const client = await connect(site, { analytics });
    await client.callTool({ name: "search", arguments: { query: "integrations" } });
    await client.callTool({ name: "fetch", arguments: { id: "/missing" } });
    expect(analytics.events).toMatchObject([
      { tool: "search", query: "integrations", resultCount: 2, ok: true, client: "test-client 1.0.0", transport: "stdio" },
      { tool: "fetch", pageId: "/missing", ok: false },
    ]);
  });

  it("waits for a loading index and picks up replacements", async () => {
    const store = SiteStore.placeholder("https://example.test/");
    let finish!: (value: SiteIndex) => void;
    void store.load(new Promise<SiteIndex>((resolve) => (finish = resolve)));
    const client = await connect(store);

    const pending = client.callTool({ name: "search", arguments: { query: "welcome" } });
    finish(site);
    expect(await pending).toMatchObject({ structuredContent: { results: [{ id: "/" }] } });

    store.replace({ ...site, pages: [{ id: "/new", title: "New", url: "https://example.test/new", text: "Fresh welcome page." }] });
    const after = await client.callTool({ name: "search", arguments: { query: "welcome" } });
    expect(after.structuredContent).toMatchObject({ results: [{ id: "/new" }] });
  });

  it("reports a failed load as a tool error", async () => {
    const store = SiteStore.placeholder("https://example.test/");
    void store.load(Promise.reject(new Error("site refused automated requests")));
    const client = await connect(store);
    const result = await client.callTool({ name: "search", arguments: { query: "x" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("site refused automated requests");
  });

  it("registers owner-defined actions", async () => {
    const client = await connect(site, {
      actions: [
        {
          name: "subscribe",
          description: "Subscribe to the newsletter.",
          method: "POST",
          url: "https://example.test/api/subscribe",
          input: { email: { type: "string", format: "email", required: true } },
        },
      ],
    });
    const listed = await client.listTools();
    const action = listed.tools.find((tool) => tool.name === "action_subscribe");
    expect(action?.annotations?.readOnlyHint).toBe(false);
    const info = await client.callTool({ name: "site_info", arguments: {} });
    expect(info.structuredContent).toMatchObject({ actions: ["action_subscribe"] });
  });

  it("explains an empty index in site_info", async () => {
    const empty: SiteIndex = {
      ...site,
      pages: [],
      diagnostics: { ...site.diagnostics!, skipped: [{ url: "https://example.test/", reason: "page is marked noindex" }] },
    };
    const client = await connect(empty);
    const info = await client.callTool({ name: "site_info", arguments: {} });
    expect(info.structuredContent).toMatchObject({
      pageCount: 0,
      warnings: ["No pages were indexed. Skipped: https://example.test/ (page is marked noindex)."],
    });
  });
});
