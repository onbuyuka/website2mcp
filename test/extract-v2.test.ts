import { describe, expect, it } from "vitest";
import { extractPage } from "../src/extract.js";
import { contentHash } from "../src/hash.js";

const pageUrl = new URL("https://example.test/page");

function doc(body: string, head = "", title = "Page") {
  return `<!doctype html><html><head><title>${title}</title>${head}</head><body>${body}</body></html>`;
}

function ldJson(value: unknown) {
  return `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
}

describe("extractPage structured data", () => {
  it("extracts JSON-LD objects without @context", () => {
    const result = extractPage(
      doc(
        "<main><p>Content.</p></main>",
        ldJson({ "@context": "https://schema.org", "@type": "Organization", name: " Acme Corp ", url: "https://acme.test" }),
      ),
      pageUrl,
    );

    expect(result.page.items).toEqual([
      {
        type: "Organization",
        name: "Acme Corp",
        source: "json-ld",
        data: { "@type": "Organization", name: " Acme Corp ", url: "https://acme.test" },
      },
    ]);
  });

  it("flattens @graph entries and top-level arrays, joining multiple types", () => {
    const result = extractPage(
      doc(
        "<main><p>Content.</p></main>",
        ldJson({
          "@context": "https://schema.org",
          "@graph": [
            { "@type": "WebSite", name: "Example" },
            { "@type": ["Person", "Author"], name: "Jane" },
            { name: "No type is ignored" },
          ],
        }) +
          ldJson([
            { "@type": "Event", headline: "Launch day", offers: { "@type": "Offer", price: "0" } },
            { "@type": "Place", title: "Hall" },
            { "@type": "Thing" },
          ]),
      ),
      pageUrl,
    );

    expect(result.page.items?.map(({ type, name }) => [type, name])).toEqual([
      ["WebSite", "Example"],
      ["Person,Author", "Jane"],
      ["Event", "Launch day"],
      ["Place", "Hall"],
      ["Thing", undefined],
    ]);
    expect(result.page.items?.[2]?.data.offers).toEqual({ "@type": "Offer", price: "0" });
    expect(result.page.items?.every((item) => item.source === "json-ld")).toBe(true);
    expect(result.page.items?.[4]).not.toHaveProperty("name");
  });

  it("ignores malformed JSON-LD", () => {
    const result = extractPage(
      doc(
        "<main><p>Content.</p></main>",
        `<script type="application/ld+json">{ not json </script>${ldJson({ "@type": "Article", headline: "Valid" })}`,
      ),
      pageUrl,
    );

    expect(result.page.items).toEqual([
      { type: "Article", name: "Valid", source: "json-ld", data: { "@type": "Article", headline: "Valid" } },
    ]);
  });

  it("extracts top-level microdata items with their own properties", () => {
    const result = extractPage(
      doc(`<main>
        <div itemscope itemtype="https://schema.org/Product">
          <span itemprop="name">Widget</span>
          <meta itemprop="sku" content="W-1">
          <a itemprop="url" href="/widget">Widget page</a>
          <img itemprop="image" src="/widget.png" alt="">
          <time itemprop="releaseDate" datetime="2026-01-01">January 1</time>
          <span itemprop="color">Red</span>
          <span itemprop="color">Blue</span>
          <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
            <span itemprop="price">9.99</span>
          </div>
        </div>
        <div itemscope itemtype="https://schema.org/Empty"></div>
      </main>`),
      pageUrl,
    );

    expect(result.page.items).toEqual([
      {
        type: "Product",
        name: "Widget",
        source: "microdata",
        data: {
          name: "Widget",
          sku: "W-1",
          url: "/widget",
          image: "/widget.png",
          releaseDate: "2026-01-01",
          color: ["Red", "Blue"],
          offers: "9.99",
        },
      },
    ]);
  });

  it("extracts data tables with a header row, naming them from the caption or preceding heading", () => {
    const result = extractPage(
      doc(`<main>
        <h2>Pricing plans</h2>
        <table>
          <tr><th>Plan</th><th>Price</th></tr>
          <tr><td>Basic</td><td>$5</td></tr>
          <tr><td>Pro</td></tr>
        </table>
        <table>
          <caption> Team  members </caption>
          <thead><tr><th>Name</th><th></th></tr></thead>
          <tbody><tr><td>Ann</td><td>CEO</td></tr></tbody>
        </table>
        <table><tr><th>Single</th></tr><tr><td>column</td></tr></table>
        <table><tr><td>No</td><td>header</td></tr></table>
        <table><tr><th>Header</th><th>Only</th></tr></table>
      </main>
      <footer><table><tr><th>Footer</th><th>Table</th></tr><tr><td>x</td><td>y</td></tr></table></footer>`),
      pageUrl,
    );

    expect(result.page.items).toEqual([
      {
        type: "Table",
        name: "Pricing plans",
        source: "table",
        data: {
          columns: ["Plan", "Price"],
          rows: [
            { Plan: "Basic", Price: "$5" },
            { Plan: "Pro", Price: "" },
          ],
        },
      },
      {
        type: "Table",
        name: "Team members",
        source: "table",
        data: { columns: ["Name", "column2"], rows: [{ Name: "Ann", column2: "CEO" }] },
      },
    ]);
  });

  it("names a table from a heading nested in an earlier sibling", () => {
    const result = extractPage(
      doc(`<main>
        <section><h3>Section intro</h3><h4>Opening hours</h4></section>
        <div><table><tr><th>Day</th><th>Hours</th></tr><tr><td>Mon</td><td>9-5</td></tr></table></div>
      </main>`),
      pageUrl,
    );

    expect(result.page.items?.[0]).toMatchObject({ type: "Table", name: "Opening hours" });
  });

  it("omits items when the page has no structured data", () => {
    const result = extractPage(doc("<main><p>Plain text.</p></main>"), pageUrl);

    expect(result.page).not.toHaveProperty("items");
  });
});

describe("extractPage metadata", () => {
  it.each([
    ['<meta property="article:modified_time" content="2026-03-01T10:00:00Z">', "2026-03-01T10:00:00.000Z"],
    ['<meta property="og:updated_time" content="2026-04-02T00:00:00+02:00">', "2026-04-01T22:00:00.000Z"],
    ['<meta name="last-modified" content="2026-05-03">', "2026-05-03T00:00:00.000Z"],
  ])("reads lastModified from %s", (head, expected) => {
    expect(extractPage(doc("<main><p>Text.</p></main>", head), pageUrl).page.lastModified).toBe(expected);
  });

  it("prefers article:modified_time and ignores invalid dates", () => {
    const preferred = extractPage(
      doc(
        "<main><p>Text.</p></main>",
        '<meta name="last-modified" content="2020-01-01"><meta property="article:modified_time" content="2026-03-01T10:00:00Z">',
      ),
      pageUrl,
    );
    expect(preferred.page.lastModified).toBe("2026-03-01T10:00:00.000Z");

    const invalid = extractPage(doc("<main><p>Text.</p></main>", '<meta name="last-modified" content="yesterday-ish">'), pageUrl);
    expect(invalid.page).not.toHaveProperty("lastModified");
  });

  it.each([
    ['<meta name="robots" content="noindex, follow">', true, false],
    ['<meta name="robots" content="NONE">', true, false],
    ['<meta name="robots" content="index, follow">', false, false],
    ['<meta name="website2mcp" content="noindex">', true, false],
    ['<meta name="website2mcp" content="exclude">', true, false],
    ['<meta name="website2mcp" content="private">', false, true],
    ['<meta name="website2mcp" content="Private, noindex">', true, true],
    ["", false, false],
  ])("flags %s as noindex=%s markedPrivate=%s", (head, noindex, markedPrivate) => {
    const result = extractPage(doc("<main><p>Text.</p></main>", head), pageUrl);

    expect(result.noindex).toBe(noindex);
    expect(result.markedPrivate).toBe(markedPrivate);
  });

  it("sets kind html and a content hash of the raw HTML", () => {
    const source = doc("<main><p>Text.</p></main>");
    const result = extractPage(source, pageUrl);

    expect(result.page.kind).toBe("html");
    expect(result.page.hash).toBe(contentHash(source));
    expect(result.page.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(extractPage(doc("<main><p>Other.</p></main>"), pageUrl).page.hash).not.toBe(result.page.hash);
  });

  it("falls back to the hostname when there is no title", () => {
    const result = extractPage("<html><body><main><p>Untitled.</p></main></body></html>", pageUrl);

    expect(result.page.title).toBe("example.test");
  });
});

describe("extractPage app-shell detection", () => {
  it.each([
    ["an empty Next.js root", "<div id='__next'></div>"],
    ["a Vue app with a loading message", "<div id='app'>Loading…</div>"],
    ["an Angular root", "<app-root></app-root>"],
    ["a noscript JavaScript warning", "<noscript>You need to enable JavaScript to run this app.</noscript><div class='x'></div>"],
  ])("detects %s", (_label, body) => {
    expect(extractPage(doc(body), pageUrl).isLikelyClientRendered).toBe(true);
  });

  it("does not flag server-rendered content inside an app root", () => {
    const paragraph = "This page was rendered on the server and has plenty of readable text for visitors. ".repeat(2);
    const result = extractPage(doc(`<div id="root"><main><h1>Docs</h1><p>${paragraph}</p></main></div>`), pageUrl);

    expect(result.isLikelyClientRendered).toBe(false);
  });

  it("does not flag a short static page without an app root", () => {
    expect(extractPage(doc("<main><p>Short page.</p></main>"), pageUrl).isLikelyClientRendered).toBe(false);
  });
});
