import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSiteIndex, routeKey } from "../src/build-index.js";
import { readSiteIndex } from "../src/index-file.js";
import type { PageRenderer, RenderedPage } from "../src/render.js";

const directories: string[] = [];

describe("routeKey", () => {
  it("keeps hash-router routes and drops plain anchors", () => {
    expect(routeKey(new URL("https://me.test/app/#/teams?x=1"))).toBe("/app/#/teams?x=1");
    expect(routeKey(new URL("https://me.test/app/#!/teams"))).toBe("/app/#!/teams");
    expect(routeKey(new URL("https://me.test/app/#/"))).toBe("/app/");
    expect(routeKey(new URL("https://me.test/app/#section"))).toBe("/app/");
  });
});

describe("buildSiteIndex with rendering", () => {
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ));
  });

  it("follows hash routes, skips out-of-scope links, and dedupes redirects", async () => {
    const root = await createSite();
    await writeFile(path.join(root, "index.html"), "<html><body><div id='root'></div></body></html>");
    const base = "https://me.test/app/";
    const shell = (heading: string, body: string) =>
      `<html><head><title>World Cup</title></head><body><nav>Menu</nav><main><h1>${heading}</h1><p>${body}</p></main></body></html>`;
    const routes: Record<string, RenderedPage> = {
      [base]: {
        url: `${base}#/`,
        html: shell("Bracket", "Knockout bracket."),
        links: [
          `${base}#/teams`,
          `${base}#/team/br`,
          `${base}#section`,
          "https://me.test/other/",
          "https://elsewhere.test/",
          `${base}logo.png`,
          `${base}#/bogus`,
        ],
      },
      [`${base}#/teams`]: {
        url: `${base}#/teams`,
        html: shell("Teams", "All 48 teams."),
        links: [`${base}#/team/br`],
      },
      [`${base}#/team/br`]: {
        url: `${base}#/team/br`,
        html: shell("Brazil", "Group C."),
        links: [],
      },
      [`${base}#/bogus`]: { url: `${base}#/`, html: shell("Bracket", "Knockout bracket."), links: [] },
    };
    const renderer = fakeRenderer(routes);

    const site = await buildSiteIndex(root, base, { renderer });

    expect(site.pages.map(({ id, title, url }) => ({ id, title, url }))).toEqual([
      { id: "/app/", title: "World Cup", url: base },
      { id: "/app/#/teams", title: "Teams – World Cup", url: `${base}#/teams` },
      { id: "/app/#/team/br", title: "Brazil – World Cup", url: `${base}#/team/br` },
    ]);
    expect(site.pages[2].text).toContain("Group C.");
    expect(site.pages[2].text).not.toContain("Menu");
    expect(renderer.render.mock.calls.map(([url]) => url)).toEqual([
      base,
      `${base}#/teams`,
      `${base}#/team/br`,
      `${base}#/bogus`,
    ]);
    expect(renderer.close).toHaveBeenCalledOnce();
    expect(site.warnings).toEqual([]);
  });

  it("reports render failures and the page limit", async () => {
    const root = await createSite();
    const base = "https://me.test/";
    const renderer = fakeRenderer({
      [base]: {
        url: base,
        html: "<html><head><title>Home</title></head><body><main>Home text.</main></body></html>",
        links: [`${base}#/a`, `${base}#/b`, `${base}#/c`],
        missingFiles: ["/assets/app.js"],
      },
    });

    const site = await buildSiteIndex(root, base, { renderer, maxPages: 1 });
    expect(site.pages.map(({ id }) => id)).toEqual(["/"]);
    expect(site.warnings).toEqual([
      "Stopped at the 1-page limit; 3 more routes were found.",
      "1 local file request returned 404 (/assets/app.js). If these are app scripts or data, check that the base URL's path matches your bundler's base setting.",
    ]);

    const failing = await buildSiteIndex(root, base, { renderer, maxPages: 2 });
    expect(failing.pages).toHaveLength(1);
    expect(failing.diagnostics?.skipped).toContainEqual({
      url: `${base}#/a`,
      reason: `could not render: No route for ${base}#/a`,
    });
  });

  it("automatically renders a detected JavaScript app shell", async () => {
    const root = await createSite();
    const base = "https://me.test/";
    await writeFile(
      path.join(root, "index.html"),
      "<html><head><title>App</title></head><body><div id='root'></div></body></html>",
    );
    const renderer = fakeRenderer({
      [base]: {
        url: base,
        html: "<html><head><title>App</title></head><body><main><h1>Rendered home</h1><p>App content.</p></main></body></html>",
        links: [],
      },
    });

    const site = await buildSiteIndex(root, base, { renderer });

    expect(renderer.render).toHaveBeenCalledWith(base);
    expect(site.pages).toHaveLength(1);
    expect(site.pages[0].text).toContain("App content.");
    expect(site.warnings).toEqual([]);
  });

  it("allows automatic rendering to be disabled", async () => {
    const root = await createSite();
    await writeFile(
      path.join(root, "index.html"),
      "<html><head><title>App</title></head><body><div id='root'></div></body></html>",
    );

    const site = await buildSiteIndex(root, "https://me.test/", { render: false });

    expect(site.pages).toHaveLength(0);
    expect(site.diagnostics?.rendered).toBe(false);
    expect(site.diagnostics?.skipped).toEqual([{ url: "https://me.test/", reason: "no extractable text" }]);
    expect(site.warnings).toEqual(["1 page contained no extractable text."]);
  });
});

function fakeRenderer(routes: Record<string, RenderedPage>) {
  return {
    render: vi.fn<PageRenderer["render"]>(async (url) => {
      const page = routes[url];
      if (!page) throw new Error(`No route for ${url}`);
      return page;
    }),
    close: vi.fn<PageRenderer["close"]>(async () => {}),
  };
}

describe("buildSiteIndex", () => {
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ));
  });

  it("indexes generated HTML and maps index files to pretty URLs", async () => {
    const root = await createSite();
    await mkdir(path.join(root, "about"), { recursive: true });
    await writeFile(
      path.join(root, "index.html"),
      `<html><head><title>Home</title><meta name="description" content="Built site"></head><body><main><h1>Welcome</h1></main></body></html>`,
    );
    await writeFile(
      path.join(root, "about", "index.html"),
      `<html><head><title>About</title></head><body><main><p>About our project.</p></main></body></html>`,
    );
    await writeFile(
      path.join(root, "terms & privacy.html"),
      `<html><head><title>Terms</title></head><body><main><p>Terms and privacy.</p></main></body></html>`,
    );

    const site = await buildSiteIndex(root, "https://example.test");

    expect(site).toMatchObject({
      name: "Home",
      description: "Built site",
      url: "https://example.test/",
      pages: [
        { id: "/", url: "https://example.test/", title: "Home" },
        { id: "/about/", url: "https://example.test/about/", title: "About" },
        {
          id: "/terms%20%26%20privacy.html",
          url: "https://example.test/terms%20%26%20privacy.html",
          title: "Terms",
        },
      ],
      warnings: [],
    });
    expect(site.pages[1].text).toContain("About our project.");
  });

  it("writes indexes that can be loaded for serving", async () => {
    const root = await createSite();
    await writeFile(
      path.join(root, "index.html"),
      "<html><head><title>Home</title></head><body><main>Welcome.</main></body></html>",
    );
    const site = await buildSiteIndex(root, "https://example.test");
    const indexPath = path.join(root, "website2mcp.index.json");
    await writeFile(indexPath, JSON.stringify(site));

    await expect(readSiteIndex(indexPath)).resolves.toMatchObject({
      name: "Home",
      pages: [{ id: "/", text: "Welcome." }],
    });
    await expect(readFile(indexPath, "utf8")).resolves.toContain('"pages"');
  });

  it("invalidates unchanged-size assets larger than 2 MiB", async () => {
    const root = await createSite();
    await writeFile(path.join(root, "index.html"), "<html><body><main>Home content.</main></body></html>");
    const asset = path.join(root, "data.json");
    const large = Buffer.alloc(2 * 1024 * 1024 + 1, "a");
    await writeFile(asset, large);
    const first = await buildSiteIndex(root, "https://example.test");
    expect((await buildSiteIndex(root, "https://example.test", { previous: first })).diagnostics?.reusedPages).toBe(1);
    large[large.length - 1] = "b".charCodeAt(0);
    await writeFile(asset, large);
    const changed = await buildSiteIndex(root, "https://example.test", { previous: first });
    expect(changed.fingerprint).not.toBe(first.fingerprint);
    expect(changed.diagnostics?.reusedPages).toBe(0);
  });

  it("rejects invalid base URLs and malformed index files", async () => {
    const root = await createSite();
    await expect(buildSiteIndex(root, "file:///private")).rejects.toThrow(
      "base URL must be a valid HTTP or HTTPS URL",
    );
    const invalidIndex = path.join(root, "invalid.json");
    await writeFile(invalidIndex, "{");
    await expect(readSiteIndex(invalidIndex)).rejects.toThrow("not valid JSON");
    await writeFile(invalidIndex, JSON.stringify({ pages: [] }));
    await expect(readSiteIndex(invalidIndex)).rejects.toThrow(
      "is not a valid website2mcp index",
    );
  });
});

async function createSite(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "website2mcp-build-"));
  directories.push(directory);
  return directory;
}
