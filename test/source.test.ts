import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expandEnv, loadConfig, mergeSettings, parseDuration, parseHeaderFlag } from "../src/config.js";
import { writeSiteIndex } from "../src/index-file.js";
import { isPrivateTarget, resolveSource } from "../src/source.js";
import type { SiteIndex } from "../src/types.js";

const directories: string[] = [];
async function tempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "site2mcp-src-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("config", () => {
  it("parses durations, env references, and header flags", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("15m")).toBe(900_000);
    expect(parseDuration("6h")).toBe(21_600_000);
    expect(parseDuration("1d")).toBe(86_400_000);
    expect(parseDuration(5)).toBe(5000);
    expect(() => parseDuration("soon")).toThrow("Invalid duration");

    expect(expandEnv("Bearer ${env:TOKEN}", { TOKEN: "abc" })).toBe("Bearer abc");
    expect(() => expandEnv("${env:MISSING}", {})).toThrow("MISSING is not set");
    expect(parseHeaderFlag("Authorization: Bearer ${env:T}", { T: "x" })).toEqual(["Authorization", "Bearer x"]);
    expect(() => parseHeaderFlag("no-colon")).toThrow("Name: value");
  });

  it("merges layers with later values winning and headers combined", () => {
    expect(
      mergeSettings(
        { maxPages: 10, headers: { A: "1" }, include: ["/docs/**"] },
        { maxPages: 20, headers: { B: "2" }, include: [], render: undefined },
      ),
    ).toEqual({ maxPages: 20, headers: { A: "1", B: "2" }, include: ["/docs/**"] });
  });

  it("loads a config file relative to its folder", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "site2mcp.config.json");
    await writeFile(
      file,
      JSON.stringify({
        source: "./dist",
        baseUrl: "https://me.example/",
        include: "/docs/**",
        headers: { Authorization: "Bearer ${env:SITE_TOKEN}" },
        cacheTtl: "1h",
        http: { port: 8080, tokens: ["${env:SITE_TOKEN}"] },
        analytics: "usage.jsonl",
      }),
    );
    const { settings } = await loadConfig(file, { SITE_TOKEN: "t0k" });
    expect(settings).toMatchObject({
      source: path.join(dir, "dist"),
      baseUrl: "https://me.example/",
      include: ["/docs/**"],
      headers: { Authorization: "Bearer t0k" },
      cacheTtlMs: 3_600_000,
      port: 8080,
      tokens: ["t0k"],
      analyticsFile: path.join(dir, "usage.jsonl"),
    });
  });

  it("explains invalid config files", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "site2mcp.config.json");
    await writeFile(file, JSON.stringify({ maxPages: "lots", typo: true }));
    await expect(loadConfig(file)).rejects.toThrow(/maxPages|typo/);
    await expect(loadConfig(path.join(dir, "missing.json"))).rejects.toThrow("Config file not found");
  });
});

describe("resolveSource", () => {
  beforeEach(async () => {
    vi.stubEnv("SITE2MCP_CACHE_DIR", await tempDir());
  });

  it("serves a saved index file", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "site.index.json");
    await writeSiteIndex(file, sampleSite("https://me.example/"));
    const source = await resolveSource(file, {});
    expect(source.mode).toBe("index-file");
    expect(source.watchPaths).toEqual([file]);
    const { site } = await source.initial();
    expect(site.pages).toHaveLength(2);
  });

  it("applies path, privacy, and page limits to saved indexes", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "site.index.json");
    await writeSiteIndex(file, sampleSite("https://me.example/"));
    const load = async (settings: Parameters<typeof resolveSource>[1]) =>
      (await (await resolveSource(file, settings)).initial()).site;
    expect((await load({ exclude: ["/secret"] })).pages.map((page) => page.id)).toEqual(["/"]);
    expect((await load({ include: ["/secret"] })).pages.map((page) => page.id)).toEqual(["/secret"]);
    expect((await load({ private: ["/"] })).pages.every((page) => page.visibility === "private")).toBe(true);
    expect((await load({ maxPages: 1 })).pages).toHaveLength(1);
  });

  it("indexes a build folder and falls back to localhost without a base URL", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, "index.html"), "<html><head><title>Home</title></head><body><main><h1>Hi</h1><p>Static home page.</p></main></body></html>");
    const source = await resolveSource(dir, { render: false });
    expect(source.mode).toBe("build");
    expect(source.outputDir).toBe(dir);
    expect(source.notes.join(" ")).toContain("--base-url");
    const { site } = await source.initial();
    expect(site.url).toBe("http://localhost/");
    expect(site.pages[0].text).toContain("Static home page.");

    const withBase = await resolveSource(dir, { render: false, baseUrl: "https://me.example/blog/" });
    expect((await withBase.initial()).site.pages[0].url).toBe("https://me.example/blog/");
  });

  it("finds the build output inside a project folder", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: { build: "vite build" }, devDependencies: { vite: "^6" } }));
    await mkdir(path.join(dir, "dist"));
    await writeFile(path.join(dir, "dist", "index.html"), "<html><head><title>App</title></head><body><main><p>Built page.</p></main></body></html>");
    const source = await resolveSource(dir, { render: false, baseUrl: "https://me.example/" });
    expect(source.mode).toBe("build");
    expect(source.outputDir).toBe(path.join(dir, "dist"));
    expect(source.notes.join(" ")).toContain("--build");
  });

  it("indexes Markdown sources when there is no build output", async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, "docs"));
    await writeFile(path.join(dir, "docs", "intro.md"), "---\ntitle: Introduction\n---\n\nHow to get started.");
    const source = await resolveSource(dir, { baseUrl: "https://docs.example/" });
    expect(source.mode).toBe("markdown");
    const { site } = await source.initial();
    expect(site.diagnostics?.mode).toBe("source");
    expect(site.pages).toMatchObject([{ title: "Introduction", kind: "markdown" }]);
  });

  it("gives helpful errors for unusable sources", async () => {
    const dir = await tempDir();
    await expect(resolveSource(dir, {})).rejects.toThrow("site2mcp can serve");
    await expect(resolveSource(path.join(dir, "missing"), {})).rejects.toThrow("Not found");
    await expect(resolveSource("example.com", {})).rejects.toThrow("Did you mean https://example.com");
    await expect(resolveSource("ftp://example.com/", {})).rejects.toThrow("Only http and https");
  });

  it("caches crawls and reuses them until they go stale", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/") {
        return new Response("<html><head><title>Local</title></head><body><main><p>Local dev server page.</p></main></body></html>", {
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("missing", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await resolveSource("http://localhost:4321/", {});
    expect(first.mode).toBe("crawl");
    const crawled = await first.initial();
    expect(crawled.stale).toBe(false);
    expect(crawled.site.pages[0].text).toContain("Local dev server page.");
    const calls = fetchMock.mock.calls.length;
    expect(calls).toBeGreaterThan(0);

    const cached = await (await resolveSource("http://localhost:4321/", {})).initial();
    expect(cached.site.pages).toHaveLength(1);
    expect(fetchMock.mock.calls.length).toBe(calls);

    const stale = await (await resolveSource("http://localhost:4321/", { cacheTtlMs: 0 })).initial();
    expect(stale.stale).toBe(true);

    await (await resolveSource("http://localhost:4321/", { refresh: true })).initial();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(calls);
  });

  it("loads a published index URL without private pages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(sampleSite("http://localhost:4321/")), { headers: { "content-type": "application/json" } })),
    );
    const source = await resolveSource("http://localhost:4321/.well-known/site2mcp.json", {});
    expect(source.mode).toBe("published");
    const { site } = await source.initial();
    expect(site.pages.map((page) => page.id)).toEqual(["/"]);
  });

  it("isolates cached content by credential values, not just header names", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname !== "/") return new Response("missing", { status: 404 });
      const account = new Headers(init?.headers).get("authorization");
      return new Response(`<html><body><main><p>Content for ${account}</p></main></body></html>`, {
        headers: { "content-type": "text/html" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const load = async (account: string) =>
      (await (await resolveSource("http://localhost:4321/", { headers: { Authorization: account } })).initial()).site;
    expect((await load("account-a")).pages[0].text).toContain("account-a");
    expect((await load("account-b")).pages[0].text).toContain("account-b");
    const calls = fetchMock.mock.calls.length;
    expect((await load("account-a")).pages[0].text).toContain("account-a");
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it("applies rules when discovering or directly loading a published index", async () => {
    const index = sampleSite("http://localhost:4321/");
    index.pages[1].visibility = "public";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(index))));
    for (const url of [index.url, `${index.url}.well-known/site2mcp.json`]) {
      const load = async (settings: Parameters<typeof resolveSource>[1]) =>
        (await (await resolveSource(url, { ...settings, cache: false })).initial()).site;
      expect((await load({ exclude: ["/secret"] })).pages.map((page) => page.id)).toEqual(["/"]);
      expect((await load({ private: ["/secret"] })).pages[1].visibility).toBe("private");
      expect((await load({ maxPages: 1 })).pages).toHaveLength(1);
    }
  });
});

describe("isPrivateTarget", () => {
  it("recognizes local and intranet hosts", () => {
    expect(isPrivateTarget("localhost")).toBe(true);
    expect(isPrivateTarget("127.0.0.1")).toBe(true);
    expect(isPrivateTarget("[::1]")).toBe(true);
    expect(isPrivateTarget("10.1.2.3")).toBe(true);
    expect(isPrivateTarget("wiki")).toBe(true);
    expect(isPrivateTarget("intranet.local")).toBe(true);
    expect(isPrivateTarget("example.com")).toBe(false);
    expect(isPrivateTarget("8.8.8.8")).toBe(false);
  });
});

function sampleSite(url: string): SiteIndex {
  return {
    name: "Sample",
    url,
    indexedAt: "2026-01-01T00:00:00.000Z",
    pages: [
      { id: "/", title: "Home", url, text: "Home page." },
      { id: "/secret", title: "Secret", url: new URL("secret", url).href, text: "Hidden.", visibility: "private" },
    ],
    warnings: [],
  };
}
