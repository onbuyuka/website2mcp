import type { PageCollector } from "./collector.js";
import { extractPage } from "./extract.js";
import type { PageRenderer } from "./render.js";

export interface RenderSiteOptions {
  baseUrl: URL;
  seeds: URL[];
  renderer: PageRenderer;
  collector: PageCollector;
  maxPages: number;
  concurrency: number;
  delayMs?: number;
  canVisit?: (url: URL) => boolean;
  log?: (message: string) => void;
}

export interface RenderSiteResult {
  warnings: string[];
  documentLinks: string[];
}

const DOCUMENT_EXTENSIONS = /\.(pdf|md|markdown|txt)$/i;

// Hash-router paths like "/#/teams" are separate pages; plain "#section" anchors are not.
export function routeKey(url: URL): string {
  const hashRoute = /^#!?\/./.test(url.hash) ? url.hash : "";
  return `${url.pathname}${url.search}${hashRoute}`;
}

export function normalizeRouteUrl(href: string, baseUrl: URL): URL | undefined {
  let url: URL;
  try {
    url = new URL(href, baseUrl);
  } catch {
    return undefined;
  }
  if (url.origin !== baseUrl.origin || !url.pathname.startsWith(baseUrl.pathname)) return undefined;
  url.hash = /^#!?\/./.test(url.hash) ? url.hash : "";
  return url;
}

export async function renderSite(options: RenderSiteOptions): Promise<RenderSiteResult> {
  const { baseUrl, renderer, collector, maxPages } = options;
  const concurrency = Math.min(Math.max(options.concurrency, 1), 16);
  const warnings: string[] = [];
  const documentLinks = new Set<string>();
  const queue: URL[] = [];
  const queued = new Set<string>();
  const rendered = new Set<string>();
  const titles = new Set<string>();
  const missingFiles = new Set<string>();
  const maxRenders = maxPages * 3;
  let renders = 0;

  const enqueue = (href: string) => {
    const url = normalizeRouteUrl(href, baseUrl);
    if (!url) return;
    if (DOCUMENT_EXTENSIONS.test(url.pathname)) {
      if (!collector.isExcluded(url)) documentLinks.add(url.href);
      return;
    }
    if (/\.(?!html?$)[a-z0-9]+$/i.test(url.pathname)) return;
    const key = routeKey(url);
    if (queued.has(key)) return;
    queued.add(key);
    if (collector.isExcluded(url)) {
      collector.skip(url.href, "matched an exclude rule");
      return;
    }
    if (options.canVisit && !options.canVisit(url)) {
      collector.skip(url.href, "disallowed by robots.txt");
      return;
    }
    queue.push(url);
  };

  enqueue(baseUrl.href);
  for (const seed of options.seeds) enqueue(seed.href);

  while (queue.length > 0 && collector.size < maxPages && renders < maxRenders) {
    const batch = queue.splice(0, Math.min(concurrency, maxPages - collector.size));
    renders += batch.length;
    const results = await Promise.allSettled(batch.map((url) => renderer.render(url.href)));

    for (const [index, result] of results.entries()) {
      const url = batch[index];
      if (result.status === "rejected") {
        const error = result.reason;
        const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
        collector.skip(url.href, `could not render: ${message}`);
        continue;
      }

      const page = result.value;
      for (const file of page.missingFiles ?? []) missingFiles.add(file);
      const finalUrl = normalizeRouteUrl(page.url, baseUrl) ?? url;
      const key = routeKey(finalUrl);
      queued.add(key);
      for (const link of page.links) enqueue(link);
      if (rendered.has(key)) continue;
      rendered.add(key);

      const extracted = extractPage(page.html, finalUrl);
      if (finalUrl.hash) {
        extracted.page.id = key;
        extracted.page.url = finalUrl.href;
      }
      const heading = extracted.page.text.match(/^#{1,2}\s+(.+)$/m)?.[1]?.trim();
      if (titles.has(extracted.page.title) && heading && heading !== extracted.page.title) {
        extracted.page.title = `${heading} – ${extracted.page.title}`;
      }
      if (
        collector.add(extracted.page, {
          url: finalUrl,
          noindex: extracted.noindex,
          markedPrivate: extracted.markedPrivate,
        })
      ) {
        titles.add(extracted.page.title);
        if (collector.size % 25 === 0) options.log?.(`Rendered ${collector.size} pages…`);
      }
    }
    if (options.delayMs && queue.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
  }

  if (queue.length > 0) {
    warnings.push(`Stopped at the ${maxPages}-page limit; ${queue.length} more routes were found.`);
  }
  if (missingFiles.size > 0) {
    const examples = [...missingFiles].slice(0, 3).join(", ");
    warnings.push(
      `${missingFiles.size} local file request${missingFiles.size === 1 ? "" : "s"} returned 404 (${examples}). If these are app scripts or data, check that the base URL's path matches your bundler's base setting.`,
    );
  }
  return { warnings, documentLinks: [...documentLinks] };
}
