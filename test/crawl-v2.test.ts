import { describe, expect, it, vi } from "vitest";
import { crawlSite } from "../src/crawl.js";
import type { PageRenderer } from "../src/render.js";
import type { CrawlOptions, SiteIndex } from "../src/types.js";

const ORIGIN = "https://example.test";

interface RouteRequest {
  url: string;
  headers: Record<string, string>;
  count: number;
}

type Route = (request: RouteRequest) => Response | Promise<Response>;

const publicLookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);

function html(title: string, body: string, init: { head?: string; headers?: Record<string, string> } = {}): Route {
  return () =>
    new Response(
      `<!doctype html><html><head><title>${title}</title>${init.head ?? ""}</head><body><main>${body}</main></body></html>`,
      { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...init.headers } },
    );
}

function text(body: string, contentType = "text/plain"): Route {
  return () => new Response(body, { status: 200, headers: { "content-type": contentType } });
}

function json(value: unknown): Route {
  return () =>
    new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function status(code: number, headers: Record<string, string> = {}): Route {
  return () => new Response(null, { status: code, headers });
}

// Builds a fetch mock from absolute URL -> route; anything unknown is a 404.
function mockSite(routes: Record<string, Route>, fallback: Route = status(404)) {
  const counts = new Map<string, number>();
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const count = (counts.get(url) ?? 0) + 1;
    counts.set(url, count);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    return (routes[url] ?? fallback)({ url, headers, count });
  });
  const requested = () => fetchImpl.mock.calls.map(([url]) => String(url));
  const requestsTo = (url: string) =>
    fetchImpl.mock.calls.filter(([input]) => String(input) === url).map(([, init]) => (init?.headers ?? {}) as Record<string, string>);
  return { fetchImpl, requested, requestsTo };
}

function options(fetchImpl: typeof fetch, extra: CrawlOptions = {}): CrawlOptions {
  return { fetchImpl, lookupImpl: publicLookup, delayMs: 0, render: false, ...extra };
}

function publishedIndex(overrides: Partial<SiteIndex> = {}): SiteIndex {
  return {
    version: 2,
    name: "Published Site",
    url: `${ORIGIN}/`,
    indexedAt: "2026-01-01T00:00:00.000Z",
    pages: [
      { id: "/", title: "Home", url: `${ORIGIN}/`, text: "Welcome to the published site." },
      { id: "/guide", title: "Guide", url: `${ORIGIN}/guide`, text: "How to use it.", visibility: "public" },
      { id: "/internal", title: "Internal", url: `${ORIGIN}/internal`, text: "Staff only.", visibility: "private" },
    ],
    warnings: [],
    ...overrides,
  };
}

const home = html("Home", "<h1>Home</h1><p>Welcome to the crawled site.</p>");

describe("crawlSite published index", () => {
  it("uses /.well-known/website2mcp.json without crawling and drops private pages", async () => {
    const site = mockSite({ [`${ORIGIN}/.well-known/website2mcp.json`]: json(publishedIndex()) });

    const result = await crawlSite(`${ORIGIN}/`, options(site.fetchImpl));

    expect(result.name).toBe("Published Site");
    expect(result.pages.map(({ id }) => id)).toEqual(["/", "/guide"]);
    expect(result.diagnostics).toMatchObject({ mode: "published", rendered: false, reusedPages: 0, skipped: [] });
    expect(result.diagnostics?.notes.join(" ")).toContain("/.well-known/website2mcp.json");
    expect(site.requested()).toEqual([`${ORIGIN}/.well-known/website2mcp.json`]);
    expect(site.requestsTo(`${ORIGIN}/.well-known/website2mcp.json`)[0]?.accept).toBe("application/json");
  });

  it("crawls instead when usePublishedIndex is false", async () => {
    const site = mockSite({
      [`${ORIGIN}/.well-known/website2mcp.json`]: json(publishedIndex()),
      [`${ORIGIN}/`]: home,
    });

    const result = await crawlSite(`${ORIGIN}/`, options(site.fetchImpl, { usePublishedIndex: false }));

    expect(result.diagnostics?.mode).toBe("crawl");
    expect(result.name).toBe("Home");
    expect(result.pages.map(({ id }) => id)).toEqual(["/"]);
    expect(site.requested()).not.toContain(`${ORIGIN}/.well-known/website2mcp.json`);
  });

  it.each([
    ["an index for another origin", () => json(publishedIndex({ url: "https://other.test/" }))],
    ["a schema-invalid index", () => json({ name: "Broken", pages: "nope" })],
    ["a non-JSON body", () => text("<html>not json</html>", "text/html")],
    ["an index with a page that has an invalid URL", () =>
      json(publishedIndex({ pages: [{ id: "/", title: "Home", url: "not a url", text: "x" }] }))],
  ])("ignores %s and falls back to crawling", async (_label, route) => {
    const site = mockSite({
      [`${ORIGIN}/.well-known/website2mcp.json`]: route(),
      [`${ORIGIN}/`]: home,
    });

    const result = await crawlSite(`${ORIGIN}/`, options(site.fetchImpl));

    expect(result.diagnostics?.mode).toBe("crawl");
    expect(result.name).toBe("Home");
    expect(result.pages.map(({ id }) => id)).toEqual(["/"]);
  });

  it("checks the scope folder then the origin root, accepting only an index that covers the scope", async () => {
    const rootIndex = mockSite({
      [`${ORIGIN}/.well-known/website2mcp.json`]: json(publishedIndex()),
    });
    const fromRoot = await crawlSite(`${ORIGIN}/docs/`, options(rootIndex.fetchImpl));
    expect(fromRoot.diagnostics?.mode).toBe("published");
    expect(rootIndex.requested().slice(0, 2)).toEqual([
      `${ORIGIN}/docs/.well-known/website2mcp.json`,
      `${ORIGIN}/.well-known/website2mcp.json`,
    ]);

    const siblingIndex = mockSite({
      [`${ORIGIN}/.well-known/website2mcp.json`]: json(publishedIndex({ url: `${ORIGIN}/blog/` })),
      [`${ORIGIN}/docs/`]: html("Docs", "<p>Documentation home.</p>"),
    });
    const crawled = await crawlSite(`${ORIGIN}/docs/`, options(siblingIndex.fetchImpl));
    expect(crawled.diagnostics?.mode).toBe("crawl");
    expect(crawled.pages.map(({ id }) => id)).toEqual(["/docs/"]);
  });
});

describe("crawlSite seeding", () => {
  it("seeds pages linked only from llms.txt and notes it", async () => {
    const site = mockSite({
      [`${ORIGIN}/`]: home,
      [`${ORIGIN}/llms.txt`]: text(
        "# Example\n\n- [Guide](https://example.test/guide): the guide\n- [FAQ](/faq)\n- [Elsewhere](https://other.test/x)\n",
      ),
      [`${ORIGIN}/guide`]: html("Guide", "<p>The guide content.</p>"),
      [`${ORIGIN}/faq`]: html("FAQ", "<p>Frequently asked questions.</p>"),
    });

    const result = await crawlSite(`${ORIGIN}/`, options(site.fetchImpl));

    expect(result.pages.map(({ id }) => id).sort()).toEqual(["/", "/faq", "/guide"]);
    expect(result.diagnostics?.notes).toContain("Used 2 links from llms.txt.");
    expect(site.requested().some((url) => url.startsWith("https://other.test"))).toBe(false);
    expect(site.requestsTo(`${ORIGIN}/llms.txt`)[0]?.accept).toBe("text/plain, text/markdown");
  });

  it("ignores an llms.txt that is really an HTML fallback page", async () => {
    const site = mockSite({
      [`${ORIGIN}/`]: home,
      [`${ORIGIN}/llms.txt`]: html("Not found", "<p>[Guide](/guide)</p>"),
      [`${ORIGIN}/guide`]: html("Guide", "<p>The guide content.</p>"),
    });

    const result = await crawlSite(`${ORIGIN}/`, options(site.fetchImpl));

    expect(result.pages.map(({ id }) => id)).toEqual(["/"]);
    expect(result.diagnostics?.notes.join(" ")).not.toContain("llms.txt");
  });

  it("falls back to /sitemap.xml and only seeds in-scope sitemap URLs", async () => {
    const site = mockSite({
      [`${ORIGIN}/docs/`]: html("Docs", "<p>Documentation home.</p>"),
      [`${ORIGIN}/sitemap.xml`]: text(
        `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>https://example.test/docs/install</loc></url>
          <url><loc>https://example.test/blog/news</loc></url>
        </urlset>`,
        "application/xml",
      ),
      [`${ORIGIN}/docs/install`]: html("Install", "<p>Install steps.</p>"),
    });

    const result = await crawlSite(`${ORIGIN}/docs/`, options(site.fetchImpl));

    expect(result.pages.map(({ id }) => id)).toEqual(["/docs/", "/docs/install"]);
    expect(result.diagnostics?.notes).toContain("Found 2 URLs in sitemaps.");
    expect(site.requested()).not.toContain(`${ORIGIN}/blog/news`);
    expect(result.url).toBe(`${ORIGIN}/docs/`);
  });
});

describe("crawlSite incremental recrawl", () => {
  const previous: SiteIndex = {
    version: 2,
    name: "Home",
    url: `${ORIGIN}/`,
    indexedAt: "2026-01-01T00:00:00.000Z",
    pages: [
      { id: "/", title: "Home", url: `${ORIGIN}/`, text: "Previously indexed home.", etag: '"home-v1"', kind: "html" },
      {
        id: "/about",
        title: "About",
        url: `${ORIGIN}/about`,
        text: "Previously indexed about.",
        lastModified: "2026-01-01T00:00:00.000Z",
      },
      { id: "/news", title: "News", url: `${ORIGIN}/news`, text: "Old news.", etag: '"news-v1"' },
    ],
    warnings: [],
  };

  it("sends conditional headers and reuses pages answered with 304", async () => {
    const site = mockSite({
      [`${ORIGIN}/`]: ({ headers }) =>
        headers["if-none-match"] === '"home-v1"' ? new Response(null, { status: 304 }) : home({} as RouteRequest),
      [`${ORIGIN}/about`]: ({ headers }) =>
        headers["if-modified-since"] ? new Response(null, { status: 304 }) : html("About", "<p>New about.</p>")({} as RouteRequest),
      [`${ORIGIN}/news`]: html("News", "<p>Fresh news.</p>", {
        headers: { etag: '"news-v2"', "last-modified": "Wed, 21 Oct 2026 07:28:00 GMT" },
      }),
    });

    const result = await crawlSite(`${ORIGIN}/`, options(site.fetchImpl, { previous, usePublishedIndex: false }));

    expect(site.requestsTo(`${ORIGIN}/`)[0]?.["if-none-match"]).toBe('"home-v1"');
    expect(site.requestsTo(`${ORIGIN}/about`)[0]?.["if-modified-since"]).toBe(
      new Date("2026-01-01T00:00:00.000Z").toUTCString(),
    );
    expect(site.requestsTo(`${ORIGIN}/news`)[0]?.["if-none-match"]).toBe('"news-v1"');

    const byId = new Map(result.pages.map((page) => [page.id, page]));
    expect([...byId.keys()].sort()).toEqual(["/", "/about", "/news"]);
    expect(byId.get("/")?.text).toBe("Previously indexed home.");
    expect(byId.get("/about")?.text).toBe("Previously indexed about.");
    expect(byId.get("/news")).toMatchObject({
      text: expect.stringContaining("Fresh news."),
      etag: '"news-v2"',
      lastModified: "2026-10-21T07:28:00.000Z",
    });
    expect(result.diagnostics?.reusedPages).toBe(2);
    expect(result.diagnostics?.notes).toContain("Reused 2 unchanged pages (HTTP 304).");
  });

  it("recomputes visibility for reused pages from the current rules", async () => {
    const withVisibility: SiteIndex = {
      ...previous,
      pages: [{ ...previous.pages[0], visibility: "private" }],
    };
    const site = mockSite({ [`${ORIGIN}/`]: status(304) });

    const result = await crawlSite(`${ORIGIN}/`, options(site.fetchImpl, { previous: withVisibility, usePublishedIndex: false }));
    expect(result.pages[0]?.visibility).toBeUndefined();

    const privateRule = await crawlSite(
      `${ORIGIN}/`,
      options(mockSite({ [`${ORIGIN}/`]: status(304) }).fetchImpl, {
        previous: previous,
        private: ["/"],
        usePublishedIndex: false,
      }),
    );
    expect(privateRule.pages.find(({ id }) => id === "/")?.visibility).toBe("private");
  });

  it("keeps a page that was marked private in its HTML private when it is reused via 304", async () => {
    const markedPrivate = html("Secret", "<p>Owner-only notes.</p>", {
      head: '<meta name="website2mcp" content="private">',
      headers: { etag: '"secret-v1"' },
    });
    const first = await crawlSite(
      `${ORIGIN}/secret`,
      options(mockSite({ [`${ORIGIN}/secret`]: markedPrivate }).fetchImpl, { usePublishedIndex: false }),
    );
    expect(first.pages[0]).toMatchObject({ id: "/secret", visibility: "private", etag: '"secret-v1"' });

    const second = await crawlSite(
      `${ORIGIN}/secret`,
      options(
        mockSite({
          [`${ORIGIN}/secret`]: ({ headers }) =>
            headers["if-none-match"] === '"secret-v1"' ? new Response(null, { status: 304 }) : markedPrivate({} as RouteRequest),
        }).fetchImpl,
        { previous: first, usePublishedIndex: false },
      ),
    );
    expect(second.diagnostics?.reusedPages).toBe(1);
    expect(second.pages[0]?.visibility).toBe("private");
  });
});

describe("crawlSite politeness", () => {
  it("retries a 429 with Retry-After and then succeeds", async () => {
    const site = mockSite({
      [`${ORIGIN}/`]: ({ count }) =>
        count === 1 ? new Response(null, { status: 429, headers: { "retry-after": "0" } }) : home({} as RouteRequest),
    });

    const result = await crawlSite(`${ORIGIN}/`, options(site.fetchImpl, { usePublishedIndex: false }));

    expect(result.pages.map(({ id }) => id)).toEqual(["/"]);
    expect(site.requestsTo(`${ORIGIN}/`)).toHaveLength(2);
    expect(result.warnings.join(" ")).not.toContain("rate limited");
  });

  it("gives up after the retry budget and reports the page as rate limited", async () => {
    const site = mockSite({
      [`${ORIGIN}/`]: html("Home", "<p>Home page.</p><a href='/busy'>Busy</a>"),
      [`${ORIGIN}/busy`]: status(429, { "retry-after": "0" }),
    });

    const result = await crawlSite(`${ORIGIN}/`, options(site.fetchImpl, { usePublishedIndex: false }));

    expect(site.requestsTo(`${ORIGIN}/busy`)).toHaveLength(3);
    expect(result.diagnostics?.skipped).toContainEqual({ url: `${ORIGIN}/busy`, reason: "HTTP 429" });
    expect(result.warnings.join(" ")).toContain("1 requests were blocked or rate limited.");
  });

  it("does not wait when Retry-After exceeds the maximum wait", async () => {
    const site = mockSite({
      [`${ORIGIN}/`]: html("Home", "<p>Home page.</p><a href='/slow'>Slow</a>"),
      [`${ORIGIN}/slow`]: status(503, { "retry-after": "3600" }),
    });

    const result = await crawlSite(`${ORIGIN}/`, options(site.fetchImpl, { usePublishedIndex: false }));

    expect(site.requestsTo(`${ORIGIN}/slow`)).toHaveLength(1);
    expect(result.diagnostics?.skipped).toContainEqual({ url: `${ORIGIN}/slow`, reason: "HTTP 503" });
  });

  it("respects robots.txt crawl-delay by noting it and fetching one page at a time", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const slowPage = (title: string): Route => async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return html(title, `<p>${title} page body.</p>`)({} as RouteRequest);
    };
    const site = mockSite({
      [`${ORIGIN}/robots.txt`]: text("User-agent: *\nCrawl-delay: 0.01\nAllow: /\n"),
      [`${ORIGIN}/`]: html("Home", "<p>Home.</p><a href='/a'>A</a><a href='/b'>B</a><a href='/c'>C</a>"),
      [`${ORIGIN}/a`]: slowPage("A"),
      [`${ORIGIN}/b`]: slowPage("B"),
      [`${ORIGIN}/c`]: slowPage("C"),
    });

    const result = await crawlSite(`${ORIGIN}/`, options(site.fetchImpl, { concurrency: 4, usePublishedIndex: false }));

    expect(result.pages).toHaveLength(4);
    expect(result.diagnostics?.notes).toContain("Respected robots.txt crawl-delay of 0.01s.");
    expect(maxInFlight).toBe(1);
  });

  it("throws a helpful error when every page is forbidden", async () => {
    const site = mockSite({}, status(403));

    await expect(crawlSite(`${ORIGIN}/`, options(site.fetchImpl))).rejects.toThrow(
      `${ORIGIN}/ refused automated requests (HTTP 403).`,
    );
  });

  it("throws when the start page is a bot challenge", async () => {
    const site = mockSite({
      [`${ORIGIN}/`]: html("Just a moment...", "<p>Checking your browser.</p>"),
    });

    await expect(crawlSite(`${ORIGIN}/`, options(site.fetchImpl, { usePublishedIndex: false }))).rejects.toThrow(
      /refused automated requests \(bot challenge page\)/,
    );
  });
});

describe("crawlSite credentials", () => {
  it("sends headers on every same-origin request and marks pages private", async () => {
    const site = mockSite({
      [`${ORIGIN}/`]: html("Home", "<p>Member home.</p><a href='/account'>Account</a><a href='/leave'>Leave</a>"),
      [`${ORIGIN}/account`]: html("Account", "<p>Your account.</p>"),
      [`${ORIGIN}/leave`]: status(302, { location: "https://other.test/" }),
    });

    const result = await crawlSite(
      `${ORIGIN}/`,
      options(site.fetchImpl, { headers: { authorization: "Bearer secret" }, usePublishedIndex: false }),
    );

    expect(result.pages.map(({ id, visibility }) => [id, visibility])).toEqual([
      ["/", "private"],
      ["/account", "private"],
    ]);
    expect(result.diagnostics?.notes).toContain(
      "Pages were fetched with credentials, so they are marked private by default.",
    );
    for (const [url, init] of site.fetchImpl.mock.calls) {
      expect(new URL(String(url)).origin).toBe(ORIGIN);
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer secret");
    }
    expect(site.requested()).not.toContain("https://other.test/");
    expect(result.warnings.join(" ")).toContain("Refusing unsafe redirect");
  });

  it("leaves pages public without credentials", async () => {
    const site = mockSite({ [`${ORIGIN}/`]: home });

    const result = await crawlSite(`${ORIGIN}/`, options(site.fetchImpl, { headers: {}, usePublishedIndex: false }));

    expect(result.pages[0]?.visibility).toBeUndefined();
    expect(result.diagnostics?.notes.join(" ")).not.toContain("credentials");
  });
});

describe("crawlSite path rules", () => {
  it("applies include, exclude, and private globs", async () => {
    const site = mockSite({
      [`${ORIGIN}/`]: html(
        "Home",
        "<p>Home.</p><a href='/docs/intro'>Intro</a><a href='/docs/team/handbook'>Handbook</a><a href='/blog/post'>Post</a><a href='/about'>About</a>",
      ),
      [`${ORIGIN}/docs/intro`]: html("Intro", "<p>Introduction.</p>"),
      [`${ORIGIN}/docs/team/handbook`]: html("Handbook", "<p>Team handbook.</p>"),
      [`${ORIGIN}/blog/post`]: html("Post", "<p>A blog post.</p>"),
      [`${ORIGIN}/about`]: html("About", "<p>About us.</p>"),
    });

    const result = await crawlSite(
      `${ORIGIN}/`,
      options(site.fetchImpl, {
        include: ["/docs/**", "/blog/**"],
        exclude: ["/blog/**"],
        private: ["docs/team/*"],
        usePublishedIndex: false,
      }),
    );

    expect(result.pages.map(({ id, visibility }) => [id, visibility])).toEqual([
      ["/docs/intro", undefined],
      ["/docs/team/handbook", "private"],
    ]);
    const skipped = result.diagnostics?.skipped ?? [];
    expect(skipped).toContainEqual({ url: `${ORIGIN}/`, reason: "did not match any include rule" });
    expect(skipped).toContainEqual({ url: `${ORIGIN}/about`, reason: "did not match any include rule" });
    expect(skipped).toContainEqual({ url: `${ORIGIN}/blog/post`, reason: "matched an exclude rule" });
    // Excluded URLs are never fetched; non-included pages are fetched so their links can be followed.
    expect(site.requested()).not.toContain(`${ORIGIN}/blog/post`);
    expect(site.requested()).toContain(`${ORIGIN}/about`);
  });

  it("skips pages disallowed by robots.txt", async () => {
    const site = mockSite({
      [`${ORIGIN}/robots.txt`]: text("User-agent: *\nDisallow: /admin\n"),
      [`${ORIGIN}/`]: html("Home", "<p>Home.</p><a href='/admin/panel'>Admin</a>"),
    });

    const result = await crawlSite(`${ORIGIN}/`, options(site.fetchImpl, { usePublishedIndex: false }));

    expect(result.diagnostics?.skipped).toContainEqual({ url: `${ORIGIN}/admin/panel`, reason: "disallowed by robots.txt" });
    expect(site.requested()).not.toContain(`${ORIGIN}/admin/panel`);
  });
});

describe("crawlSite content handling", () => {
  it("skips noindex pages from meta robots, X-Robots-Tag, and website2mcp meta but follows their links", async () => {
    const site = mockSite({
      [`${ORIGIN}/`]: html(
        "Home",
        "<p>Home.</p><a href='/meta'>Meta</a><a href='/header'>Header</a><a href='/opt-out'>Opt out</a><a href='/visible'>Visible</a><a href='/owner-private'>Owner</a>",
      ),
      [`${ORIGIN}/meta`]: html("Meta", "<p>Meta noindex.</p><a href='/deep'>Deep</a>", {
        head: '<meta name="robots" content="noindex, follow">',
      }),
      [`${ORIGIN}/header`]: html("Header", "<p>Header noindex.</p>", { headers: { "x-robots-tag": "noindex" } }),
      [`${ORIGIN}/opt-out`]: html("Opt out", "<p>Opted out.</p>", { head: '<meta name="website2mcp" content="noindex">' }),
      [`${ORIGIN}/owner-private`]: html("Owner", "<p>Owner private.</p>", { head: '<meta name="website2mcp" content="private">' }),
      [`${ORIGIN}/visible`]: html("Visible", "<p>Visible page.</p>"),
      [`${ORIGIN}/deep`]: html("Deep", "<p>Deep page.</p>"),
    });

    const result = await crawlSite(`${ORIGIN}/`, options(site.fetchImpl, { usePublishedIndex: false }));

    expect(result.pages.map(({ id }) => id).sort()).toEqual(["/", "/deep", "/owner-private", "/visible"]);
    expect(result.pages.find(({ id }) => id === "/owner-private")?.visibility).toBe("private");
    for (const path of ["/meta", "/header", "/opt-out"]) {
      expect(result.diagnostics?.skipped).toContainEqual({ url: `${ORIGIN}${path}`, reason: "page is marked noindex" });
    }
  });

  it("indexes markdown responses as markdown and skips drafts", async () => {
    const site = mockSite({
      [`${ORIGIN}/`]: html("Home", "<p>Home.</p><a href='/notes'>Notes</a><a href='/readme.md'>Readme</a><a href='/draft'>Draft</a>"),
      [`${ORIGIN}/notes`]: text("---\ntitle: Release notes\n---\n# Notes\n\nShipped version two.", "text/markdown; charset=utf-8"),
      [`${ORIGIN}/readme.md`]: text("# Readme\n\nRead me first.", "text/plain"),
      [`${ORIGIN}/draft`]: text("---\ndraft: true\n---\nNot ready.", "text/markdown"),
    });

    const result = await crawlSite(`${ORIGIN}/`, options(site.fetchImpl, { usePublishedIndex: false }));

    const notes = result.pages.find(({ id }) => id === "/notes");
    expect(notes).toMatchObject({ kind: "markdown", title: "Release notes" });
    expect(notes?.text).toContain("Shipped version two.");
    expect(result.pages.find(({ id }) => id === "/readme.md")).toMatchObject({ kind: "markdown", title: "Readme" });
    expect(result.pages.find(({ id }) => id === "/")?.kind).toBe("html");
    expect(result.diagnostics?.skipped).toContainEqual({ url: `${ORIGIN}/draft`, reason: "page is marked noindex" });
  });

  it("skips unsupported content types", async () => {
    const site = mockSite({
      [`${ORIGIN}/`]: html("Home", "<p>Home.</p><a href='/logo'>Logo</a>"),
      [`${ORIGIN}/logo`]: text("binary", "image/png"),
    });

    const result = await crawlSite(`${ORIGIN}/`, options(site.fetchImpl, { usePublishedIndex: false }));

    expect(result.diagnostics?.skipped).toContainEqual({ url: `${ORIGIN}/logo`, reason: "unsupported content type image/png" });
  });

  it("indexes duplicate content once and records why the copy was skipped", async () => {
    const same = "<h1>Pricing</h1><p>The same pricing table everywhere.</p>";
    const site = mockSite({
      [`${ORIGIN}/`]: html("Home", "<p>Home.</p><a href='/a'>A</a><a href='/b'>B</a><a href='/c'>C</a>"),
      [`${ORIGIN}/a`]: html("Pricing A", same),
      [`${ORIGIN}/b`]: html("Pricing B", same),
      [`${ORIGIN}/c`]: html("Pricing C", "<p>Different text, same canonical.</p>", {
        head: '<link rel="canonical" href="/a">',
      }),
    });

    const result = await crawlSite(`${ORIGIN}/`, options(site.fetchImpl, { usePublishedIndex: false }));

    expect(result.pages.map(({ id }) => id)).toEqual(["/", "/a"]);
    expect(result.diagnostics?.skipped).toContainEqual({ url: `${ORIGIN}/b`, reason: "same content as /a" });
    expect(result.diagnostics?.skipped).toContainEqual({ url: `${ORIGIN}/a`, reason: "duplicate of /a" });
  });

  it("never indexes more than maxPages pages", async () => {
    const site = mockSite({
      [`${ORIGIN}/`]: home,
      [`${ORIGIN}/sitemap.xml`]: text(
        "<urlset><url><loc>https://example.test/a</loc></url><url><loc>https://example.test/b</loc></url></urlset>",
        "application/xml",
      ),
      [`${ORIGIN}/a`]: html("A", "<p>Page A.</p>"),
      [`${ORIGIN}/b`]: html("B", "<p>Page B.</p>"),
    });

    const result = await crawlSite(`${ORIGIN}/`, options(site.fetchImpl, { maxPages: 1, concurrency: 2, usePublishedIndex: false }));

    expect(result.pages).toHaveLength(1);
  });
});

describe("crawlSite host safety", () => {
  const privateLookup = async () => [{ address: "127.0.0.1", family: 4 }];

  it("refuses hosts that resolve to private addresses", async () => {
    const site = mockSite({ "https://intranet.test/": html("Intranet", "<p>Internal.</p>") });

    const result = await crawlSite("https://intranet.test/", {
      ...options(site.fetchImpl),
      lookupImpl: privateLookup,
    });

    expect(site.fetchImpl).not.toHaveBeenCalled();
    expect(result.pages).toEqual([]);
    expect(result.warnings.join(" ")).toContain("Refusing to fetch a non-public host: intranet.test");
  });

  it("crawls private hosts when allowPrivateHosts is true", async () => {
    const lookupImpl = vi.fn(privateLookup);
    const site = mockSite({ "https://intranet.test/": html("Intranet", "<p>Internal.</p>") });

    const result = await crawlSite("https://intranet.test/", {
      ...options(site.fetchImpl),
      lookupImpl,
      allowPrivateHosts: true,
    });

    expect(result.pages.map(({ id }) => id)).toEqual(["/"]);
    expect(lookupImpl).not.toHaveBeenCalled();
  });
});

describe("crawlSite rendering", () => {
  const shell = html("App", "<div id='root'>Loading…</div>");

  it("renders an app shell with the provided renderer, including hash routes", async () => {
    const site = mockSite({ [`${ORIGIN}/`]: shell });
    const pages: Record<string, { html: string; links: string[] }> = {
      [`${ORIGIN}/`]: {
        html: "<html><head><title>App</title></head><body><main><h1>Welcome</h1><p>Rendered home content.</p></main></body></html>",
        links: [`${ORIGIN}/#/teams`],
      },
      [`${ORIGIN}/#/teams`]: {
        html: "<html><head><title>App</title></head><body><main><h1>Teams</h1><p>Rendered teams content.</p></main></body></html>",
        links: [],
      },
    };
    const close = vi.fn(async () => {});
    const render = vi.fn(async (url: string) => {
      const page = pages[url];
      if (!page) throw new Error(`unexpected render ${url}`);
      return { url, ...page };
    });
    const renderer: PageRenderer = { render, close };

    const result = await crawlSite(`${ORIGIN}/`, {
      ...options(site.fetchImpl),
      render: undefined,
      usePublishedIndex: false,
      rendererFactory: async () => renderer,
    });

    expect(result.pages.map(({ id, title }) => [id, title])).toEqual([
      ["/", "App"],
      ["/#/teams", "Teams – App"],
    ]);
    expect(result.diagnostics?.rendered).toBe(true);
    expect(result.diagnostics?.notes).toContain("Rendered pages with a headless browser because the site needs JavaScript.");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not render when render is false and warns about the app shell", async () => {
    const rendererFactory = vi.fn(async (): Promise<PageRenderer> => {
      throw new Error("should not be called");
    });
    const site = mockSite({ [`${ORIGIN}/`]: shell });

    const result = await crawlSite(`${ORIGIN}/`, {
      ...options(site.fetchImpl, { usePublishedIndex: false }),
      rendererFactory,
    });

    expect(rendererFactory).not.toHaveBeenCalled();
    expect(result.diagnostics?.rendered).toBe(false);
    expect(result.warnings.join(" ")).toContain("appears to require JavaScript rendering; try --render.");
  });

  it("propagates renderer failures when render is forced", async () => {
    const site = mockSite({ [`${ORIGIN}/`]: home });

    await expect(
      crawlSite(`${ORIGIN}/`, {
        ...options(site.fetchImpl, { usePublishedIndex: false }),
        render: true,
        rendererFactory: async () => {
          throw new Error("no browser installed");
        },
      }),
    ).rejects.toThrow("no browser installed");
  });

  it("falls back to plain HTML when no browser is available", async () => {
    const site = mockSite({ [`${ORIGIN}/`]: shell });

    const result = await crawlSite(`${ORIGIN}/`, {
      ...options(site.fetchImpl, { usePublishedIndex: false }),
      render: undefined,
      rendererFactory: async () => {
        throw new Error("no browser installed");
      },
    });

    expect(result.diagnostics?.rendered).toBe(false);
    expect(result.pages.map(({ id }) => id)).toEqual(["/"]);
  });

  it("reports that no browser was available when falling back to plain HTML", async () => {
    const site = mockSite({ [`${ORIGIN}/`]: shell });

    const result = await crawlSite(`${ORIGIN}/`, {
      ...options(site.fetchImpl, { usePublishedIndex: false }),
      render: undefined,
      rendererFactory: async () => {
        throw new Error("no browser installed");
      },
    });

    expect(result.warnings.join(" ")).toContain("no browser was available");
  });
});

describe("crawlSite llms.txt and moved sites", () => {
  const llms = [
    "# Example Docs",
    "",
    "> Docs for the example product.",
    "",
    `- [Intro](${ORIGIN}/docs/intro.md)`,
    `- [Install](${ORIGIN}/docs/install.md): setup`,
    `- [API](${ORIGIN}/docs/api.md)`,
    `- [Blog](${ORIGIN}/blog)`,
  ].join("\n");
  const md = (title: string) => () =>
    new Response(`# ${title}\n\nAll about ${title.toLowerCase()} in detail.`, {
      status: 200,
      headers: { "content-type": "text/markdown; charset=utf-8", "x-robots-tag": "noindex" },
    });

  it("reads the Markdown pages from llms.txt instead of crawling HTML", async () => {
    const site = mockSite({
      [`${ORIGIN}/`]: home,
      [`${ORIGIN}/llms.txt`]: text(llms),
      [`${ORIGIN}/docs/intro.md`]: md("Intro"),
      [`${ORIGIN}/docs/install.md`]: md("Install"),
      [`${ORIGIN}/docs/api.md`]: md("API"),
    });
    const result = await crawlSite(`${ORIGIN}/`, options(site.fetchImpl, { usePublishedIndex: false }));
    expect(result.pages.map((page) => page.url).sort()).toEqual([
      `${ORIGIN}/docs/api.md`,
      `${ORIGIN}/docs/install.md`,
      `${ORIGIN}/docs/intro.md`,
    ]);
    expect(result.name).toBe("Example Docs");
    expect(result.description).toBe("Docs for the example product.");
    expect(result.diagnostics?.notes.join(" ")).toMatch(/llms.txt lists 3 Markdown pages/);
    expect(site.requested()).not.toContain(`${ORIGIN}/`);
    expect(site.requested()).not.toContain(`${ORIGIN}/sitemap.xml`);
  });

  it("crawls HTML when llms.txt is disabled or the Markdown can't be read", async () => {
    const routes = { [`${ORIGIN}/`]: home, [`${ORIGIN}/llms.txt`]: text(llms) };
    const disabled = await crawlSite(`${ORIGIN}/`, options(mockSite(routes).fetchImpl, { usePublishedIndex: false, useLlmsTxt: false }));
    expect(disabled.pages.map((page) => page.url)).toContain(`${ORIGIN}/`);

    const unreadable = await crawlSite(`${ORIGIN}/`, options(mockSite(routes).fetchImpl, { usePublishedIndex: false }));
    expect(unreadable.pages.map((page) => page.url)).toContain(`${ORIGIN}/`);
    expect(unreadable.warnings.join(" ")).toMatch(/HTML was crawled instead/);
  });

  it("follows a start URL that moved to another domain", async () => {
    const site = mockSite({
      [`${ORIGIN}/guide/`]: status(301, { location: "https://new.example.test/guide/" }),
      "https://new.example.test/guide/": html("Guide", "<h1>Guide</h1><p>The new home of the guide.</p>"),
    });
    const result = await crawlSite(`${ORIGIN}/guide/`, options(site.fetchImpl, { usePublishedIndex: false }));
    expect(result.url).toBe("https://new.example.test/guide/");
    expect(result.pages.map((page) => page.url)).toEqual(["https://new.example.test/guide/"]);
    expect(result.diagnostics?.notes[0]).toMatch(/Followed the redirect/);
  });

  it("does not carry credentials to the new domain", async () => {
    const site = mockSite({ [`${ORIGIN}/`]: status(302, { location: "https://login.example.test/" }) });
    await expect(
      crawlSite(`${ORIGIN}/`, options(site.fetchImpl, { usePublishedIndex: false, headers: { authorization: "Bearer x" } })),
    ).rejects.toThrow(/credentials are not sent/);
    expect(site.requested()).not.toContain("https://login.example.test/");
  });
});
