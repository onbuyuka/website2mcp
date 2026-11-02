import { describe, expect, it } from "vitest";
import { extractPage } from "../src/extract.js";

describe("extractPage", () => {
  it("extracts readable content and same-origin links", () => {
    const result = extractPage(
      `<!doctype html>
      <html><head>
        <title>Old title</title>
        <meta property="og:title" content="Example page">
        <meta name="description" content="A useful description">
        <link rel="canonical" href="/about">
      </head><body>
        <nav>Navigation noise</nav>
        <main><h1>About the project</h1><p>We build reliable websites.</p>
        <a href="/contact#form">Contact</a>
        <a href="https://elsewhere.test/">External</a>
        <script>secretNoise()</script></main>
        <footer>Footer noise</footer>
      </body></html>`,
      new URL("https://example.test/"),
    );

    expect(result.page).toMatchObject({
      id: "/about",
      title: "Example page",
      url: "https://example.test/about",
      description: "A useful description",
    });
    expect(result.page.text).toContain("# About the project");
    expect(result.page.text).toContain("reliable websites");
    expect(result.page.text).not.toContain("Navigation noise");
    expect(result.page.text).not.toContain("secretNoise");
    expect(result.links).toContain("https://example.test/contact");
    expect(result.links).not.toContain("https://elsewhere.test/");
  });

  it("flags a likely client-rendered empty shell", () => {
    const result = extractPage(
      "<html><head><title>App</title></head><body><div id='root'></div></body></html>",
      new URL("https://example.test/"),
    );

    expect(result.isLikelyClientRendered).toBe(true);
  });

  it.each(["", "<!doctype html>\n"])("extracts generated HTML fragments with prefix %j", (prefix) => {
    const result = extractPage(
      `${prefix}<h1>Astro guide</h1><p>Build and publish an Astro documentation site.</p><a href="../start/">Start</a>`,
      new URL("https://example.test/docs/guide/"),
    );
    expect(result.page.title).toBe("Astro guide");
    expect(result.page.text).toContain("# Astro guide");
    expect(result.page.text).toContain("Astro documentation");
    expect(result.links).toEqual(["https://example.test/docs/start/"]);
    expect(result.isLikelyClientRendered).toBe(false);
  });

  it("preserves metadata but excludes it from fragment content", () => {
    const result = extractPage(
      '<head><title>Page title</title><meta name="website2mcp" content="private"></head><h1>Heading</h1><p>Visible content.</p>',
      new URL("https://example.test/docs/"),
    );
    expect(result.page.title).toBe("Page title");
    expect(result.markedPrivate).toBe(true);
    expect(result.page.text).toContain("Visible content.");
    expect(result.page.text).not.toContain("Page title");
  });
});
