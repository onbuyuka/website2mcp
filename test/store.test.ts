import { describe, expect, it } from "vitest";
import { SiteStore } from "../src/store.js";
import type { SiteIndex } from "../src/types.js";

const site: SiteIndex = {
  version: 2,
  name: "App",
  url: "https://example.com/app/",
  indexedAt: "2026-01-01T00:00:00.000Z",
  warnings: [],
  pages: [
    { id: "/app/", title: "Home", url: "https://example.com/app/", text: "Home page." },
    { id: "/app/guide", title: "Guide", url: "https://example.com/app/guide", text: "Guide page." },
    { id: "/app/#/teams", title: "Teams", url: "https://example.com/app/#/teams", text: "Teams page." },
    { id: "/app/secret", title: "Secret", url: "https://example.com/app/secret", text: "Hidden.", visibility: "private" },
  ],
};

describe("SiteStore.page lookup", () => {
  const store = new SiteStore(site);
  const title = (key: string, includePrivate = true) => store.page(key, includePrivate)?.title;

  it("finds pages by id, URL, or trailing-slash variant", () => {
    expect(title("/app/guide")).toBe("Guide");
    expect(title("/app/guide/")).toBe("Guide");
    expect(title("https://example.com/app/guide")).toBe("Guide");
    expect(title("https://example.com/app/#/teams")).toBe("Teams");
  });

  it("resolves paths relative to the site's base URL", () => {
    expect(title("/")).toBe("Home");
    expect(title("guide")).toBe("Guide");
    expect(title("/guide")).toBe("Guide");
    expect(title("#/teams")).toBe("Teams");
    expect(title("/#/teams")).toBe("Teams");
  });

  it("hides private pages unless allowed", () => {
    expect(title("secret", false)).toBeUndefined();
    expect(title("secret", true)).toBe("Secret");
    expect(title("/nope")).toBeUndefined();
  });
});
