import { describe, expect, it } from "vitest";
import { createPageSearcher, searchPages } from "../src/search.js";
import type { SiteIndex, SitePage } from "../src/types.js";

function page(id: string, title: string, text: string, overrides: Partial<SitePage> = {}): SitePage {
  return { id, title, url: `https://example.test${id}`, text, ...overrides };
}

describe("createPageSearcher sections", () => {
  const search = createPageSearcher([
    page(
      "/handbook",
      "Handbook",
      [
        "Welcome to the company handbook.",
        "## Vacation policy",
        "Employees receive twenty vacation days per year.",
        "## Expense reports",
        "Submit receipts within thirty days.",
      ].join("\n"),
    ),
    page("/faq", "FAQ", "# FAQ\nAnswers to common questions about receipts.", { description: "Frequently asked questions" }),
  ]);

  it("returns the best matching section name and a snippet from that section", () => {
    const [first] = search("vacation days");

    expect(first).toMatchObject({ id: "/handbook", section: "Vacation policy" });
    expect(first?.snippet).toContain("twenty vacation days");
    expect(first?.snippet).not.toContain("receipts");
  });

  it("returns one result per page", () => {
    const results = search("receipts");

    expect(results.map(({ id }) => id).sort()).toEqual(["/faq", "/handbook"]);
    expect(results.find(({ id }) => id === "/handbook")?.section).toBe("Expense reports");
  });

  it("omits the section when the heading repeats the page title and includes the description in the snippet", () => {
    const result = search("common questions").find(({ id }) => id === "/faq");

    expect(result).toBeDefined();
    expect(result).not.toHaveProperty("section");
    expect(result?.snippet.startsWith("Frequently asked questions")).toBe(true);
  });

  it("returns nothing for blank or stop-word-only queries", () => {
    expect(search("   ")).toEqual([]);
    expect(search("the and of")).toEqual([]);
  });

  it("adds ellipses around snippets cut from long text", () => {
    const long = createPageSearcher([
      page("/long", "Long", `${"filler words here ".repeat(30)}needle sentence ${"more filler text ".repeat(30)}`),
    ]);
    const [result] = long("needle");

    expect(result?.snippet.startsWith("…")).toBe(true);
    expect(result?.snippet.endsWith("…")).toBe(true);
    expect(result?.snippet).toContain("needle sentence");
  });
});

describe("createPageSearcher filters", () => {
  const pages = [
    page("/docs/widgets", "Docs", "Configure the widget dashboard."),
    page("/blog/widgets", "Blog", "Our widget launch story."),
    page("/files/widgets.pdf", "Spec", "Widget specification sheet.", { kind: "pdf" }),
    page("/team/widgets", "Team", "Internal widget roadmap.", { visibility: "private" }),
  ];
  const search = createPageSearcher(pages);

  it("filters by path prefix", () => {
    expect(search("widget", { pathPrefix: "/docs/" }).map(({ id }) => id)).toEqual(["/docs/widgets"]);
  });

  it("filters by kind, treating pages without a kind as html", () => {
    const pdf = search("widget", { kind: "pdf" });
    expect(pdf.map(({ id }) => id)).toEqual(["/files/widgets.pdf"]);
    expect(pdf[0]?.kind).toBe("pdf");

    const htmlResults = search("widget", { kind: "html" });
    expect(htmlResults.map(({ id }) => id).sort()).toEqual(["/blog/widgets", "/docs/widgets", "/team/widgets"]);
    expect(htmlResults.every((result) => !("kind" in result))).toBe(true);
  });

  it("includes private pages by default and can exclude them", () => {
    expect(search("widget").map(({ id }) => id)).toContain("/team/widgets");
    expect(search("widget", { includePrivate: false }).map(({ id }) => id)).not.toContain("/team/widgets");
  });

  it("accepts a numeric limit and an options limit", () => {
    expect(search("widget", 2)).toHaveLength(2);
    expect(search("widget", { limit: 1 })).toHaveLength(1);
    expect(() => search("widget", { limit: 51 })).toThrow("limit");
  });

  it("is used by searchPages for a site index", () => {
    const site: SiteIndex = { name: "Site", url: "https://example.test/", indexedAt: "2026-01-01T00:00:00.000Z", pages, warnings: [] };

    expect(searchPages(site, "widget", { pathPrefix: "/blog/" }).map(({ id }) => id)).toEqual(["/blog/widgets"]);
  });
});

describe("createPageSearcher matching", () => {
  const search = createPageSearcher([
    page("/offices", "Offices", "Our São Paulo office opened in Brazil. Visit the Zürich team too."),
    page("/platform", "Platform", "We deploy everything on kubernetes clusters."),
    page("/ascii", "Ascii", "The Sao Paulo meetup notes."),
  ]);

  it("folds diacritics in both directions", () => {
    expect(search("sao paulo").map(({ id }) => id)).toEqual(expect.arrayContaining(["/offices", "/ascii"]));
    expect(search("zurich").map(({ id }) => id)).toEqual(["/offices"]);
    expect(search("São").map(({ id }) => id)).toEqual(expect.arrayContaining(["/offices", "/ascii"]));
    expect(search("sao paulo").find(({ id }) => id === "/offices")?.snippet).toContain("São Paulo");
  });

  it("matches prefixes of at least three characters", () => {
    expect(search("kuber").map(({ id }) => id)).toEqual(["/platform"]);
    expect(search("ku")).toEqual([]);
  });

  it("matches typos in longer terms but not in short ones", () => {
    expect(search("kubernetis").map(({ id }) => id)).toEqual(["/platform"]);
    expect(search("clusterz").map(({ id }) => id)).toEqual(["/platform"]);
    expect(search("taem")).toEqual([]);
  });

  it("ranks an exact phrase above the same words in another order", () => {
    const phraseSearch = createPageSearcher([
      page("/reversed", "Beta", "Source open tools for teams."),
      page("/phrase", "Alpha", "Open source tools for teams."),
    ]);

    const results = phraseSearch("open source");

    expect(results.map(({ id }) => id)).toEqual(["/phrase", "/reversed"]);
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  it("ranks pages that match more query terms higher", () => {
    const coverage = createPageSearcher([
      page("/one", "One", "Billing questions answered here."),
      page("/both", "Both", "Billing and refunds explained here."),
    ]);

    expect(coverage("billing refunds")[0]?.id).toBe("/both");
  });
});
