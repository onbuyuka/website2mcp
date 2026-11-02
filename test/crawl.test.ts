import { describe, expect, it, vi } from "vitest";
import { crawlSite } from "../src/crawl.js";

describe("crawlSite", () => {
  it("uses robots rules, sitemap pages, and same-origin links", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/robots.txt")) {
        return new Response(
          "User-agent: *\nAllow: /\nDisallow: /private\nSitemap: https://example.test/sitemap.xml",
          { status: 200 },
        );
      }
      if (url.endsWith("/sitemap.xml")) {
        return new Response(
          `<?xml version="1.0"?><urlset><url><loc>https://example.test/about</loc></url></urlset>`,
          { status: 200, headers: { "content-type": "application/xml" } },
        );
      }
      if (url === "https://example.test/") {
        return new Response(
          "<html><head><title>Home</title></head><body><main><h1>Home</h1><a href='/private'>Private</a></main></body></html>",
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
      if (url === "https://example.test/about") {
        return new Response(
          "<html><head><title>About</title></head><body><main><p>About this site</p></main></body></html>",
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const site = await crawlSite("https://example.test/", {
      fetchImpl,
      lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
      delayMs: 0,
    });

    expect(site.pages.map(({ id }) => id)).toEqual(["/", "/about"]);
    expect(site.name).toBe("Home");
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).not.toContain(
      "https://example.test/private",
    );
  });

  it("rejects redirects outside the starting origin for pages after the start URL", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /");
      if (url.endsWith("/sitemap.xml")) return new Response("", { status: 404 });
      if (url === "https://example.test/") {
        return new Response('<html><head><title>Home</title></head><body><main><p>Welcome home.</p><a href="/away">Away</a></main></body></html>', {
          headers: { "content-type": "text/html" },
        });
      }
      if (url === "https://example.test/away") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://other.test/" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const site = await crawlSite("https://example.test/", {
      fetchImpl,
      lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
      delayMs: 0,
      render: false,
    });

    expect(site.pages.map((page) => page.url)).toEqual(["https://example.test/"]);
    expect(site.warnings.join(" ")).toContain("Refusing unsafe redirect");
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).not.toContain("https://other.test/");
  });

  it("follows sitemap indexes to their page sitemaps", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/robots.txt")) {
        return new Response("User-agent: *\nAllow: /\nSitemap: https://example.test/sitemap.xml");
      }
      if (url.endsWith("/sitemap.xml")) {
        return new Response(
          "<sitemapindex><sitemap><loc>https://example.test/pages.xml</loc></sitemap></sitemapindex>",
        );
      }
      if (url.endsWith("/pages.xml")) {
        return new Response(
          "<urlset><url><loc>https://example.test/about</loc></url></urlset>",
        );
      }
      if (url === "https://example.test/") {
        return new Response(
          "<html><head><title>Home</title></head><body><main>Home page content.</main></body></html>",
          { headers: { "content-type": "text/html" } },
        );
      }
      if (url === "https://example.test/about") {
        return new Response(
          "<html><head><title>About</title></head><body><main>About page content.</main></body></html>",
          { headers: { "content-type": "text/html" } },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const site = await crawlSite("https://example.test/", {
      fetchImpl,
      lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
      delayMs: 0,
    });

    expect(site.pages.map(({ id }) => id)).toEqual(["/", "/about"]);
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toContain(
      "https://example.test/pages.xml",
    );
  });
});
