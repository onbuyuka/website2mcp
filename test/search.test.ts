import { describe, expect, it } from "vitest";
import { searchPages } from "../src/search.js";
import type { SiteIndex } from "../src/types.js";

const site: SiteIndex = {
  name: "Example",
  url: "https://example.test",
  indexedAt: "2026-01-01T00:00:00.000Z",
  pages: [
    {
      id: "/",
      title: "Home",
      url: "https://example.test/",
      text: "Welcome to our site.",
    },
    {
      id: "/projects",
      title: "Projects",
      url: "https://example.test/projects",
      text: "We build business integrations and useful tools.",
    },
  ],
  warnings: [],
};

describe("searchPages", () => {
  it("returns relevant pages with canonical URLs and snippets", () => {
    const results = searchPages(site, "integration");

    expect(results[0]).toMatchObject({
      id: "/projects",
      title: "Projects",
      url: "https://example.test/projects",
    });
    expect(results[0]?.snippet).toContain("integrations");
  });

  it("validates the result limit", () => {
    expect(() => searchPages(site, "tools", 0)).toThrow("limit");
  });
});
