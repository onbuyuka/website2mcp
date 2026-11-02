import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import astroPlugin, { website2mcp as astroNamed } from "../src/astro.js";
import { parseSiteIndex } from "../src/index-file.js";
import { publishIndex, PUBLISHED_INDEX_PATH } from "../src/publish.js";
import vitePlugin, { website2mcp as viteNamed } from "../src/vite.js";

const page = (title: string, body: string, head = "") =>
  `<!doctype html><html><head><title>${title}</title>${head}</head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;

let root: string;
let outDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "s2m-plugin-"));
  outDir = path.join(root, "dist");
  await mkdir(path.join(outDir, "guide"), { recursive: true });
  await writeFile(path.join(outDir, "index.html"), page("Home", "Welcome to the example site with plenty of text."));
  await writeFile(path.join(outDir, "guide", "index.html"), page("Guide", "How to install and configure the product."));
  await writeFile(
    path.join(outDir, "notes.html"),
    page("Notes", "Internal notes that should never ship.", '<meta name="website2mcp" content="private">'),
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function readPublished() {
  const file = path.join(outDir, PUBLISHED_INDEX_PATH);
  return parseSiteIndex(JSON.parse(await readFile(file, "utf8")), file);
}

function logger() {
  const messages: string[] = [];
  return { messages, info: (m: string) => messages.push(`info ${m}`), warn: (m: string) => messages.push(`warn ${m}`) };
}

describe("publishIndex", () => {
  it("writes a public-only index into the build folder", async () => {
    const result = await publishIndex(outDir, { baseUrl: "https://example.com/docs/", render: false });
    const site = await readPublished();
    expect(result.file).toBe(path.join(outDir, PUBLISHED_INDEX_PATH));
    expect(site.url).toBe("https://example.com/docs/");
    expect(site.pages.map((p) => p.url).sort()).toEqual(["https://example.com/docs/", "https://example.com/docs/guide/"]);
    expect(JSON.stringify(site)).not.toContain("Internal notes");
    expect(JSON.stringify(site)).not.toContain("sourceFile");
  });

  it("explains how to fix a missing base URL", async () => {
    await expect(publishIndex(outDir, { render: false, projectRoot: root })).rejects.toThrow(/public URL/);
  });
});

describe("vite plugin", () => {
  it("exports the plugin as default and named import", () => {
    expect(viteNamed).toBe(vitePlugin);
    expect(vitePlugin().name).toBe("website2mcp");
  });

  const resolved = (overrides: Record<string, unknown> = {}) => ({
    root,
    base: "/",
    command: "build" as const,
    build: { outDir: "dist" },
    logger: logger(),
    ...overrides,
  });

  it("publishes after the bundle is written", async () => {
    const plugin = vitePlugin({ baseUrl: "https://example.com/", render: false });
    const config = resolved();
    plugin.configResolved(config);
    await plugin.closeBundle();
    expect((await readPublished()).pages).toHaveLength(2);
    expect(config.logger.messages.some((m) => m.includes("Published 2 pages"))).toBe(true);
  });

  it("uses an absolute Vite base as the site URL", async () => {
    const plugin = vitePlugin({ render: false });
    plugin.configResolved(resolved({ base: "https://cdn.example.com/app/" }));
    await plugin.closeBundle();
    expect((await readPublished()).url).toBe("https://cdn.example.com/app/");
  });

  it("warns instead of failing the build unless strict", async () => {
    const config = resolved();
    const lenient = vitePlugin({ render: false });
    lenient.configResolved(config);
    await lenient.closeBundle();
    expect(config.logger.messages.some((m) => m.startsWith("warn [website2mcp]") && m.includes("public URL"))).toBe(true);

    const strict = vitePlugin({ render: false, strict: true });
    strict.configResolved(resolved());
    await expect(strict.closeBundle()).rejects.toThrow(/public URL/);
  });

  it("skips SSR builds", async () => {
    const plugin = vitePlugin({ baseUrl: "https://example.com/", render: false });
    plugin.configResolved(resolved({ build: { outDir: "dist", ssr: true } }));
    await plugin.closeBundle();
    await expect(readFile(path.join(outDir, PUBLISHED_INDEX_PATH))).rejects.toThrow();
  });
});

describe("astro integration", () => {
  it("exports the integration as default and named import", () => {
    expect(astroNamed).toBe(astroPlugin);
    expect(astroPlugin().name).toBe("website2mcp");
  });

  it("combines site and base into the published URL", async () => {
    const integration = astroPlugin({ render: false });
    const log = logger();
    integration.hooks["astro:config:done"]({
      config: { site: "https://example.com", base: "/docs", root: pathToFileURL(`${root}${path.sep}`) },
    });
    await integration.hooks["astro:build:done"]({ dir: pathToFileURL(`${outDir}${path.sep}`), logger: log });
    const site = await readPublished();
    expect(site.url).toBe("https://example.com/docs/");
    expect(site.pages.map((p) => p.url)).toContain("https://example.com/docs/guide/");
  });

  it("warns when the Astro config has no site", async () => {
    const integration = astroPlugin({ render: false });
    const log = logger();
    integration.hooks["astro:config:done"]({ config: { root: pathToFileURL(`${root}${path.sep}`) } });
    await integration.hooks["astro:build:done"]({ dir: pathToFileURL(`${outDir}${path.sep}`), logger: log });
    expect(log.messages.some((m) => m.startsWith("warn") && m.includes("public URL"))).toBe(true);
  });
});
