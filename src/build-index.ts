import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { PageCollector } from "./collector.js";
import { extractPdf } from "./documents.js";
import { extractPage } from "./extract.js";
import { contentHash } from "./hash.js";
import { createBrowserRenderer, type PageRenderer } from "./render.js";
import { renderSite } from "./rendered-crawl.js";
import type { PathRules, SiteIndex, SitePage } from "./types.js";
import { normalizeUrl } from "./url.js";

export { routeKey } from "./rendered-crawl.js";

export interface BuildOptions extends PathRules {
  render?: boolean;
  maxPages?: number;
  concurrency?: number;
  renderer?: PageRenderer;
  previous?: SiteIndex;
  log?: (message: string) => void;
}

interface SiteFile {
  file: string;
  relative: string;
  url: URL;
}

export async function buildSiteIndex(
  directory: string,
  baseUrlInput: string,
  options: BuildOptions = {},
): Promise<SiteIndex> {
  const started = Date.now();
  const baseUrl = normalizeUrl(baseUrlInput);
  if (!baseUrl || baseUrl.search || /#/.test(baseUrlInput)) {
    throw new Error("The base URL must be a valid HTTP or HTTPS URL without a query or fragment.");
  }
  if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname += "/";
  const maxPages = Math.min(Math.max(options.maxPages ?? 500, 1), 5000);
  const root = path.resolve(directory);
  const info = await stat(root).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`Build folder not found: ${root}`);

  const allFiles = await listFiles(root);
  const fingerprint = await fingerprintFiles(root, allFiles, {
    baseUrl: baseUrl.href,
    render: options.render,
    maxPages,
    include: options.include,
    exclude: options.exclude,
    private: options.private,
  });
  if (options.previous?.fingerprint === fingerprint && !options.renderer) {
    options.log?.("Build output is unchanged; reusing the previous index.");
    return {
      ...options.previous,
      diagnostics: {
        mode: "build",
        durationMs: Date.now() - started,
        rendered: options.previous.diagnostics?.rendered ?? false,
        reusedPages: options.previous.pages.length,
        skipped: options.previous.diagnostics?.skipped ?? [],
        notes: ["Build output was unchanged, so the previous index was reused."],
      },
    };
  }

  const toSiteFile = (relative: string): SiteFile => ({
    file: path.join(root, relative),
    relative,
    url: urlForFile(baseUrl, relative),
  });
  const htmlFiles = allFiles
    .filter((relative) => /\.html?$/i.test(relative))
    .map(toSiteFile)
    .sort((a, b) => a.url.pathname.localeCompare(b.url.pathname));
  const pdfFiles = allFiles.filter((relative) => /\.pdf$/i.test(relative)).map(toSiteFile);

  const collector = new PageCollector(baseUrl, options);
  const warnings: string[] = [];
  const notes: string[] = [];
  const staticPages: Array<{ page: SitePage; noindex: boolean; markedPrivate: boolean; url: URL }> = [];
  let hasClientRenderedPages = false;
  for (const { file, relative, url } of htmlFiles) {
    const extracted = extractPage(await readFile(file, "utf8"), url);
    hasClientRenderedPages ||= extracted.isLikelyClientRendered;
    staticPages.push({
      page: { ...extracted.page, sourceFile: relative },
      noindex: extracted.noindex,
      markedPrivate: extracted.markedPrivate,
      url,
    });
  }

  let shouldRender =
    options.render === true ||
    (options.render !== false && (hasClientRenderedPages || options.renderer !== undefined));
  let renderer = options.renderer;
  if (shouldRender && !renderer) {
    try {
      renderer = await createBrowserRenderer(root, baseUrl);
    } catch (error) {
      if (options.render === true) throw error;
      shouldRender = false;
      const reason = (error instanceof Error ? error.message : String(error)).split("\n")[0];
      warnings.push(`This build looks like a JavaScript app, but no browser was available to render it, so only static HTML was indexed. ${reason}`);
    }
  }
  if (shouldRender && renderer) {
    options.log?.("Rendering the JavaScript app with a headless browser…");
    try {
      const result = await renderSite({
        baseUrl,
        seeds: htmlFiles.map(({ url }) => url),
        renderer,
        collector,
        maxPages,
        concurrency: options.concurrency ?? 4,
        log: options.log,
      });
      warnings.push(...result.warnings);
    } finally {
      await renderer.close();
    }
    notes.push("Rendered the build with a headless browser because it is a JavaScript app.");
  } else {
    for (const { page, noindex, markedPrivate, url } of staticPages) {
      if (collector.size >= maxPages) {
        warnings.push(`Stopped at the ${maxPages}-page limit.`);
        break;
      }
      collector.add(page, { url, noindex, markedPrivate });
    }
  }

  for (const { file, relative, url } of pdfFiles) {
    if (collector.size >= maxPages) break;
    try {
      const page = await extractPdf(await readFile(file), url);
      collector.add({ ...page, sourceFile: relative }, { url });
    } catch (error) {
      collector.skip(url.href, error instanceof Error ? error.message : String(error));
    }
  }

  const empty = collector.skipped.filter(({ reason }) => reason === "no extractable text").length;
  if (empty > 0) {
    warnings.push(`${empty} page${empty === 1 ? "" : "s"} contained no extractable text.`);
  }

  const pages = collector.pages;
  const homePage = pages.find((page) => page.url === baseUrl.href) ?? pages[0];
  return {
    version: 2,
    name: homePage?.title || baseUrl.hostname,
    ...(homePage?.description ? { description: homePage.description } : {}),
    url: baseUrl.href,
    indexedAt: new Date().toISOString(),
    pages,
    warnings,
    diagnostics: {
      mode: "build",
      durationMs: Date.now() - started,
      rendered: shouldRender,
      reusedPages: 0,
      skipped: collector.skipped,
      notes,
    },
    fingerprint,
  };
}

export async function listFiles(root: string, relative = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(root, child)));
    else if (entry.isFile()) files.push(child);
  }
  return files.sort();
}

async function fingerprintFiles(root: string, files: string[], settings: unknown): Promise<string> {
  const parts = [JSON.stringify(settings)];
  for (const relative of files) {
    if (/^site2mcp(\.index)?\.json$/i.test(relative)) continue;
    const file = path.join(root, relative);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    parts.push(`${relative}:${hash.digest("hex")}`);
  }
  return contentHash(parts.join("\n"));
}

function urlForFile(baseUrl: URL, relativePath: string): URL {
  const segments = relativePath.split("/");
  const isIndex = /^index\.html?$/i.test(segments.at(-1) ?? "");
  if (isIndex) segments.pop();
  const encodedPath = segments.map(encodeURIComponent).join("/");
  const url = new URL(encodedPath, baseUrl);
  if (isIndex && !url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}
