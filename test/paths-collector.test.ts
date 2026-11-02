import { describe, expect, it } from "vitest";
import { PageCollector } from "../src/collector.js";
import { applyPathRules, compileGlob, matchesAny, pathCandidates } from "../src/paths.js";
import type { SitePage } from "../src/types.js";

const root = new URL("https://example.test/");
const docsBase = new URL("https://example.test/docs/");

function page(path: string, text = `Text for ${path}`, overrides: Partial<SitePage> = {}): SitePage {
  return { id: path, title: path, url: new URL(path, root).href, text, ...overrides };
}

describe("compileGlob", () => {
  it.each([
    ["/docs/**", ["/docs", "/docs/", "/docs/a", "/docs/a/b/c"], ["/docsx", "/doc", "/other/docs/a"]],
    ["docs/*", ["/docs/a", "/docs/"], ["/docs/a/b", "/docs"]],
    ["/blog/", ["/blog", "/blog/", "/blog/2026/post"], ["/blogs"]],
    ["/v?/api", ["/v1/api", "/v2/api"], ["/v10/api", "/v/api", "/v//api"]],
    ["/**/*.pdf", ["/files/report.pdf", "/a/b/c.pdf"], ["/files/report.pdfx", "/files/reportXpdf"]],
    ["/a.b+c", ["/a.b+c"], ["/aXb+c", "/a.bbc"]],
    ["/#/teams", ["/#/teams"], ["/teams"]],
    ["/**", ["", "/", "/anything/at/all"], []],
  ])("compiles %s", (pattern, matches, misses) => {
    const regex = compileGlob(pattern);
    for (const path of matches) expect(regex.test(path), `${pattern} should match ${path}`).toBe(true);
    for (const path of misses) expect(regex.test(path), `${pattern} should not match ${path}`).toBe(false);
  });

  it("is case-insensitive, trims whitespace, and caches compiled patterns", () => {
    expect(compileGlob("  /Docs/**  ").test("/docs/intro")).toBe(true);
    expect(compileGlob("/cache-me/*")).toBe(compileGlob("/cache-me/*"));
  });

  it("lets **/ match zero directories", () => {
    expect(compileGlob("/docs/**/intro").test("/docs/intro")).toBe(true);
    expect(compileGlob("**/*.pdf").test("/report.pdf")).toBe(true);
  });
});

describe("pathCandidates and matchesAny", () => {
  it("adds base-relative paths and hash routes", () => {
    expect(pathCandidates(new URL("https://example.test/docs/guide/a"), docsBase)).toEqual(["/docs/guide/a", "/guide/a"]);
    expect(pathCandidates(new URL("https://example.test/app/#/teams"), root)).toEqual(["/app/#/teams"]);
    expect(pathCandidates(new URL("https://example.test/app/#!/teams"), root)).toEqual(["/app/#!/teams"]);
    expect(pathCandidates(new URL("https://example.test/docs/#/x"), docsBase)).toEqual(["/docs/#/x", "/#/x"]);
  });

  it("ignores plain fragment anchors and query strings", () => {
    expect(pathCandidates(new URL("https://example.test/page?x=1#section"), root)).toEqual(["/page"]);
    expect(pathCandidates(new URL("https://example.test/page#/"), root)).toEqual(["/page"]);
  });

  it("does not add a relative candidate for URLs outside the base path", () => {
    expect(pathCandidates(new URL("https://example.test/blog/a"), docsBase)).toEqual(["/blog/a"]);
  });

  it("matches patterns against either candidate", () => {
    const url = new URL("https://example.test/docs/guide/a");
    expect(matchesAny(url, docsBase, ["/guide/**"])).toBe(true);
    expect(matchesAny(url, docsBase, ["/docs/guide/*"])).toBe(true);
    expect(matchesAny(url, root, ["/guide/**"])).toBe(false);
    expect(matchesAny(url, docsBase, [])).toBe(false);
    expect(matchesAny(url, docsBase, undefined)).toBe(false);
    expect(matchesAny(new URL("https://example.test/#/admin/users"), root, ["/#/admin/**"])).toBe(true);
  });
});

describe("applyPathRules", () => {
  const url = new URL("https://example.test/docs/team/handbook");

  it("allows everything with no rules", () => {
    expect(applyPathRules(url, docsBase, {})).toEqual({ excluded: false, private: false });
    expect(applyPathRules(url, docsBase, { include: [], exclude: [], private: [] })).toEqual({
      excluded: false,
      private: false,
    });
  });

  it("gives exclude rules precedence over include and private rules", () => {
    expect(applyPathRules(url, docsBase, { include: ["/team/**"], exclude: ["/team/**"], private: ["/team/**"] })).toEqual({
      excluded: true,
      reason: "matched an exclude rule",
      private: false,
    });
  });

  it("excludes URLs that miss every include rule", () => {
    expect(applyPathRules(url, docsBase, { include: ["/blog/**", "/api/*"] })).toEqual({
      excluded: true,
      reason: "did not match any include rule",
      private: false,
    });
    expect(applyPathRules(url, docsBase, { include: ["/blog/**", "team/*"] }).excluded).toBe(false);
  });

  it("marks matches of private rules as private", () => {
    expect(applyPathRules(url, docsBase, { private: ["/team/**"] })).toEqual({ excluded: false, private: true });
    expect(applyPathRules(new URL("https://example.test/#/admin"), root, { private: ["/#/admin"] }).private).toBe(true);
  });
});

describe("PageCollector", () => {
  it("adds public pages without a visibility field", () => {
    const collector = new PageCollector(root);
    const added = page("/a");

    expect(collector.add(added)).toBe(true);
    expect(collector.size).toBe(1);
    expect(collector.has("/a")).toBe(true);
    expect(collector.pages[0]).not.toHaveProperty("visibility");
  });

  it("skips excluded and non-included pages with a reason", () => {
    const collector = new PageCollector(docsBase, { include: ["/guide/**"], exclude: ["/guide/old/**"] });

    expect(collector.add(page("/docs/guide/old/a"))).toBe(false);
    expect(collector.add(page("/docs/blog/b"))).toBe(false);
    expect(collector.add(page("/docs/guide/new"))).toBe(true);
    expect(collector.skipped).toEqual([
      { url: "https://example.test/docs/guide/old/a", reason: "matched an exclude rule" },
      { url: "https://example.test/docs/blog/b", reason: "did not match any include rule" },
    ]);
  });

  it("only treats exclude rules as exclusions in isExcluded", () => {
    const collector = new PageCollector(root, { include: ["/docs/**"], exclude: ["/tmp/**"] });

    expect(collector.isExcluded(new URL("https://example.test/tmp/x"))).toBe(true);
    expect(collector.isExcluded(new URL("https://example.test/blog/x"))).toBe(false);
  });

  it("uses meta.url instead of page.url for path rules", () => {
    const collector = new PageCollector(root, { private: ["/members/**"] });
    const canonical = page("/public-copy");

    expect(collector.add(canonical, { url: new URL("https://example.test/members/profile") })).toBe(true);
    expect(canonical.visibility).toBe("private");
  });

  it("skips noindex pages and pages without text", () => {
    const collector = new PageCollector(root);

    expect(collector.add(page("/hidden"), { noindex: true })).toBe(false);
    expect(collector.add(page("/blank", " \n\t "))).toBe(false);
    expect(collector.size).toBe(0);
    expect(collector.skipped).toEqual([
      { url: "https://example.test/hidden", reason: "page is marked noindex" },
      { url: "https://example.test/blank", reason: "no extractable text" },
    ]);
  });

  it("skips duplicate ids and duplicate text", () => {
    const collector = new PageCollector(root);

    expect(collector.add(page("/a", "Shared text"))).toBe(true);
    expect(collector.add(page("/a", "Different text", { url: "https://example.test/a?copy" }))).toBe(false);
    expect(collector.add(page("/b", "Shared text"))).toBe(false);
    expect(collector.add(page("/c", "Other text"))).toBe(true);
    expect(collector.pages.map(({ id }) => id)).toEqual(["/a", "/c"]);
    expect(collector.skipped).toEqual([
      { url: "https://example.test/a?copy", reason: "duplicate of /a" },
      { url: "https://example.test/b", reason: "same content as /a" },
    ]);
  });

  it("marks pages private from rules, page markers, or the collector default", () => {
    const byRule = new PageCollector(root, { private: ["/internal/*"] });
    byRule.add(page("/internal/a"));
    byRule.add(page("/public"));
    byRule.add(page("/flagged"), { markedPrivate: true });
    expect(byRule.pages.map(({ id, visibility }) => [id, visibility])).toEqual([
      ["/internal/a", "private"],
      ["/public", undefined],
      ["/flagged", "private"],
    ]);

    const byDefault = new PageCollector(root, {}, true);
    byDefault.add(page("/any"));
    expect(byDefault.pages[0]?.visibility).toBe("private");
  });

  it("does not count rejected pages as private or as seen", () => {
    const collector = new PageCollector(root, {}, true);
    const rejected = page("/x");

    collector.add(rejected, { noindex: true });
    expect(rejected).not.toHaveProperty("visibility");
    expect(collector.has("/x")).toBe(false);
    expect(collector.add(page("/x"))).toBe(true);
  });

  it("caps the stored skip list but keeps counting", () => {
    const collector = new PageCollector(root);

    for (let index = 0; index < 250; index += 1) collector.skip(`https://example.test/${index}`, "test");

    expect(collector.skipped).toHaveLength(200);
    expect(collector.skipped.at(-1)).toEqual({ url: "https://example.test/199", reason: "test" });
    expect(collector.totalSkipped).toBe(250);
  });
});
