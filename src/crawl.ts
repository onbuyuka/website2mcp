import { XMLParser } from "fast-xml-parser";
import { createRequire } from "node:module";
import { PageCollector } from "./collector.js";
import { extractMarkdown, extractPdf } from "./documents.js";
import { extractPage } from "./extract.js";
import { applyIndexRules, parseSiteIndex, publicOnly } from "./index-file.js";
import { createLiveRenderer, type PageRenderer } from "./render.js";
import { renderSite } from "./rendered-crawl.js";
import type { CrawlOptions, SiteIndex, SitePage } from "./types.js";
import { assertPublicHost, normalizeUrl } from "./url.js";

interface RobotsRules {
  getSitemaps(): string[];
  getCrawlDelay(userAgent?: string): number | undefined;
  isAllowed(url: string, userAgent?: string): boolean | undefined;
}

const robotsParser = createRequire(import.meta.url)("robots-parser") as (
  url: string,
  contents: string,
) => RobotsRules;

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (compatible; website2mcp/1.0; +https://github.com/onbuyuka/website2mcp)";
const ROBOTS_AGENT = "website2mcp";
const MAX_REDIRECTS = 5;
const MAX_SITEMAPS = 20;
const MAX_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 30_000;
const MAX_CRAWL_DELAY_MS = 30_000;
const MAX_ROBOTS_BYTES = 512 * 1024;
const MAX_SITEMAP_BYTES = 5 * 1024 * 1024;
const MAX_PAGE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_PUBLISHED_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const BLOCKED_STATUSES = new Set([401, 403, 429, 503]);
const CHALLENGE_TITLE = /just a moment|attention required|access denied|verify you are human|are you a robot|captcha|request blocked/i;

interface QueueItem {
  url: URL;
  depth: number;
}

interface FetchResult {
  response: Response;
  url: URL;
}

type Fetcher = (url: URL, headers?: Record<string, string>) => Promise<FetchResult>;

class CrossOriginRedirectError extends Error {
  constructor(
    readonly from: URL,
    readonly to: URL,
  ) {
    super(`Refusing unsafe redirect from ${from.href}.`);
  }
}

const MIN_LLMS_MARKDOWN_LINKS = 3;

export async function crawlSite(input: string, options: CrawlOptions = {}, redirectHops = 0): Promise<SiteIndex> {
  const started = Date.now();
  const startUrl = normalizeUrl(input);
  if (!startUrl) throw new Error("Provide a valid http or https URL.");
  const scope = new URL(startUrl.href);
  scope.search = "";
  scope.pathname = startUrl.pathname.replace(/[^/]*$/, "");

  const maxPages = boundedInteger(options.maxPages ?? 100, 1, 5000, "maxPages");
  const maxDepth = boundedInteger(options.maxDepth ?? 3, 0, 20, "maxDepth");
  const timeoutMs = boundedInteger(options.timeoutMs ?? 15_000, 100, 120_000, "timeoutMs");
  let delayMs = boundedInteger(options.delayMs ?? 200, 0, 60_000, "delayMs");
  let concurrency = boundedInteger(options.concurrency ?? 2, 1, 16, "concurrency");
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const log = options.log ?? (() => {});
  const warnings: string[] = [];
  const notes: string[] = [];
  let totalBytes = 0;

  const get: Fetcher = (url, headers = {}) =>
    fetchWithRetry(url, {
      fetchImpl: options.fetchImpl ?? fetch,
      lookupImpl: options.lookupImpl,
      allowPrivateHosts: options.allowPrivateHosts,
      timeoutMs,
      userAgent,
      origin: startUrl.origin,
      headers: { ...options.headers, ...headers },
    });

  if (options.usePublishedIndex !== false) {
    const published = await findPublishedIndex(scope, get);
    if (published) {
      log(`Using the site's published index (${published.pages.length} pages).`);
      return applyIndexRules({
        ...publicOnly(published),
        diagnostics: {
          mode: "published",
          durationMs: Date.now() - started,
          rendered: false,
          reusedPages: 0,
          skipped: [],
          notes: ["Loaded the index the site owner published at /.well-known/website2mcp.json; no crawling was needed."],
        },
      }, options);
    }
  }

  const robotsUrl = new URL("/robots.txt", startUrl);
  let robotsText = "";
  try {
    const robotsResult = await get(robotsUrl);
    if (robotsResult.response.ok) {
      robotsText = await readText(robotsResult.response, robotsUrl, MAX_ROBOTS_BYTES);
    } else {
      await robotsResult.response.body?.cancel();
    }
  } catch (error) {
    warnings.push(`Could not read robots.txt: ${errorMessage(error)}`);
  }
  const robots = robotsParser(robotsUrl.href, robotsText);
  const canCrawl = (url: URL) => robots.isAllowed(url.href, ROBOTS_AGENT) !== false;
  const inScope = (url: URL) => url.origin === scope.origin && url.pathname.startsWith(scope.pathname);
  const crawlDelay = robots.getCrawlDelay(ROBOTS_AGENT);
  if (crawlDelay && crawlDelay > 0) {
    delayMs = Math.max(delayMs, Math.min(crawlDelay * 1000, MAX_CRAWL_DELAY_MS));
    concurrency = 1;
    notes.push(`Respected robots.txt crawl-delay of ${crawlDelay}s.`);
  }

  const seeds = new Set<string>();
  const addSeed = (href: string) => {
    const url = normalizeUrl(href, startUrl);
    if (url && inScope(url) && canCrawl(url) && url.href !== startUrl.href) seeds.add(url.href);
  };

  const llms = await readLlmsTxt(scope, get, canCrawl);
  const hasCredentials = Boolean(options.headers && Object.keys(options.headers).length);
  const llmsMarkdown = llms.links.filter((href) => {
    const url = new URL(href);
    return /\.(md|markdown)$/i.test(url.pathname) && inScope(url) && canCrawl(url);
  });
  // Sites that list Markdown in llms.txt are telling AI tools exactly what to read, so skip the HTML crawl.
  const markdownFirst =
    options.useLlmsTxt !== false && options.render !== true && llmsMarkdown.length >= MIN_LLMS_MARKDOWN_LINKS;

  if (markdownFirst) {
    notes.push(`llms.txt lists ${llmsMarkdown.length} Markdown pages, so those were read instead of crawling HTML.`);
  } else {
    for (const link of llms.links) addSeed(link);
    if (llms.links.length) notes.push(`Used ${llms.links.length} links from llms.txt.`);
    const sitemapUrls = await readSitemaps(robots, startUrl, get, warnings);
    for (const href of sitemapUrls) addSeed(href);
    if (sitemapUrls.length) notes.push(`Found ${sitemapUrls.length} URLs in sitemaps.`);
  }

  const previousByUrl = new Map<string, SitePage>();
  for (const page of options.previous?.pages ?? []) {
    previousByUrl.set(page.url, page);
    if (!markdownFirst && !new URL(page.url).hash) addSeed(page.url);
  }

  const collector = new PageCollector(scope, options, hasCredentials);
  if (hasCredentials) {
    notes.push("Pages were fetched with credentials, so they are marked private by default.");
  }
  let reusedPages = 0;
  let rendered = false;
  let startStatus: number | undefined;
  let challengeDetected = false;
  let movedTo: URL | undefined;
  const blockedStatuses = new Map<number, number>();

  // Plain HTTP pass. Returns true when the start page needs JavaScript rendering.
  const queue: QueueItem[] = markdownFirst
    ? llmsMarkdown.map((href) => ({ url: new URL(href), depth: maxDepth }))
    : [{ url: startUrl, depth: 0 }, ...[...seeds].slice(0, maxPages * 2).map((href) => ({ url: new URL(href), depth: 1 }))];
  const queued = new Set(queue.map(({ url }) => url.href));
  const visited = new Set<string>();
  let needsRendering = options.render === true;

  const fetchItem = async (item: QueueItem) => {
    const previous = previousByUrl.get(item.url.href);
    const conditional: Record<string, string> = {};
    if (previous?.etag) conditional["if-none-match"] = previous.etag;
    else if (previous?.lastModified) conditional["if-modified-since"] = new Date(previous.lastModified).toUTCString();
    return get(item.url, conditional);
  };

  while (queue.length > 0 && collector.size < maxPages && !needsRendering) {
    const batch: QueueItem[] = [];
    while (queue.length > 0 && batch.length < Math.min(concurrency, maxPages - collector.size)) {
      const item = queue.shift();
      if (!item || visited.has(item.url.href)) continue;
      visited.add(item.url.href);
      if (collector.isExcluded(item.url)) {
        collector.skip(item.url.href, "matched an exclude rule");
        continue;
      }
      if (!canCrawl(item.url)) {
        collector.skip(item.url.href, "disallowed by robots.txt");
        continue;
      }
      batch.push(item);
    }
    if (batch.length === 0) continue;

    const results = await Promise.allSettled(batch.map(fetchItem));
    for (const [index, settled] of results.entries()) {
      const item = batch[index];
      const isStart = item.url.href === startUrl.href;
      if (settled.status === "rejected") {
        if (isStart && settled.reason instanceof CrossOriginRedirectError) {
          movedTo = settled.reason.to;
          queue.length = 0;
          break;
        }
        collector.skip(item.url.href, errorMessage(settled.reason));
        warnings.push(`${item.url.href}: ${errorMessage(settled.reason)}`);
        continue;
      }
      const { response, url } = settled.value;
      if (isStart) startStatus = response.status;
      const previous = previousByUrl.get(item.url.href);
      if (response.status === 304 && previous) {
        await response.body?.cancel();
        const { visibility: _visibility, markedPrivate, ...page } = previous;
        if (collector.add(page, { url, markedPrivate })) reusedPages += 1;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (BLOCKED_STATUSES.has(response.status)) {
          blockedStatuses.set(response.status, (blockedStatuses.get(response.status) ?? 0) + 1);
        }
        collector.skip(item.url.href, `HTTP ${response.status}`);
        continue;
      }

      try {
        const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
        const robotsHeader = (response.headers.get("x-robots-tag") ?? "").toLowerCase();
        const headerNoindex = /\b(noindex|none)\b/.test(robotsHeader);
        const etag = response.headers.get("etag") ?? undefined;
        const httpModified = toIso(response.headers.get("last-modified"));
        const withHttpMeta = (page: SitePage): SitePage => ({
          ...page,
          ...(etag ? { etag } : {}),
          ...(!page.lastModified && httpModified ? { lastModified: httpModified } : {}),
        });

        if (contentType.includes("application/pdf") || /\.pdf$/i.test(url.pathname)) {
          const bytes = await readBytes(response, url, MAX_PDF_BYTES);
          totalBytes += bytes.byteLength;
          collector.add(withHttpMeta(await extractPdf(bytes, url)), { url, noindex: headerNoindex });
          continue;
        }
        if (contentType.includes("markdown") || /\.(md|markdown)$/i.test(url.pathname)) {
          const text = await readText(response, url, MAX_PAGE_BYTES);
          totalBytes += Buffer.byteLength(text);
          const { page, draft } = extractMarkdown(text, url);
          // X-Robots-Tag on Markdown usually just keeps search engines off duplicate content.
          collector.add(withHttpMeta(page), { url, noindex: draft || (headerNoindex && !markdownFirst) });
          continue;
        }
        if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
          await response.body?.cancel();
          collector.skip(url.href, `unsupported content type ${contentType || "(none)"}`);
          continue;
        }

        const html = await readText(response, url, MAX_PAGE_BYTES);
        totalBytes += Buffer.byteLength(html);
        const extracted = extractPage(html, url);
        if (CHALLENGE_TITLE.test(extracted.page.title) && extracted.page.text.length < 1500) {
          challengeDetected = true;
          collector.skip(url.href, "bot challenge page");
          continue;
        }
        if (extracted.isLikelyClientRendered) {
          if (isStart && options.render !== false) {
            needsRendering = true;
            break;
          }
          warnings.push(`${url.href} appears to require JavaScript rendering; try --render.`);
        }
        collector.add(withHttpMeta(extracted.page), {
          url,
          noindex: extracted.noindex || headerNoindex,
          markedPrivate: extracted.markedPrivate,
        });

        if (item.depth < maxDepth) {
          for (const href of extracted.links) {
            const link = normalizeUrl(href, url);
            if (link && inScope(link) && !queued.has(link.href) && queued.size < maxPages * 3) {
              queued.add(link.href);
              queue.push({ url: link, depth: item.depth + 1 });
            }
          }
        }
      } catch (error) {
        collector.skip(url.href, errorMessage(error));
        warnings.push(`${url.href}: ${errorMessage(error)}`);
      }
      if (totalBytes > MAX_TOTAL_BYTES) {
        warnings.push(`Stopped after downloading ${MAX_TOTAL_BYTES} bytes.`);
        queue.length = 0;
        break;
      }
    }

    if (!needsRendering && delayMs > 0 && queue.length > 0) await sleep(delayMs);
  }

  if (movedTo) {
    if (hasCredentials) {
      throw new Error(`${startUrl.href} redirects to ${movedTo.href}. Use that URL directly; credentials are not sent to another site.`);
    }
    if (redirectHops >= 2) throw new Error(`${startUrl.href} redirects too many times between sites.`);
    log(`${startUrl.origin} redirects to ${movedTo.origin}; indexing ${movedTo.href} instead.`);
    const moved = await crawlSite(movedTo.href, options, redirectHops + 1);
    const movedNotes = [`Followed the redirect from ${startUrl.href} to ${movedTo.href}.`, ...(moved.diagnostics?.notes ?? [])];
    return { ...moved, ...(moved.diagnostics ? { diagnostics: { ...moved.diagnostics, notes: movedNotes } } : {}) };
  }

  if (markdownFirst && collector.size === 0) {
    const fallback = await crawlSite(input, { ...options, useLlmsTxt: false, usePublishedIndex: false }, redirectHops);
    return { ...fallback, warnings: [...new Set([...warnings, "None of the Markdown pages in llms.txt could be read, so the HTML was crawled instead.", ...fallback.warnings])] };
  }

  if (needsRendering) {
    let renderer: PageRenderer | undefined;
    try {
      renderer = options.rendererFactory
        ? await options.rendererFactory()
        : await createLiveRenderer({
            origin: startUrl.origin,
            headers: options.headers,
            lookupImpl: options.lookupImpl,
            allowPrivateHosts: options.allowPrivateHosts,
            ...(options.userAgent ? { userAgent: options.userAgent } : {}),
          });
    } catch (error) {
      if (options.render === true) throw error;
      warnings.push(`This site needs JavaScript rendering, but no browser was available: ${errorMessage(error).split("\n")[0]}`);
    }
    if (renderer) {
      rendered = true;
      log("Rendering pages with a headless browser…");
      try {
        const result = await renderSite({
          baseUrl: scope,
          seeds: [startUrl, ...[...seeds].map((href) => new URL(href))],
          renderer,
          collector,
          maxPages,
          concurrency,
          delayMs,
          canVisit: canCrawl,
          log,
        });
        warnings.push(...result.warnings);
        for (const href of result.documentLinks.slice(0, Math.max(0, maxPages - collector.size))) {
          const url = new URL(href);
          if (!canCrawl(url)) continue;
          try {
            const { response, url: finalUrl } = await get(url);
            if (!response.ok) {
              await response.body?.cancel();
              collector.skip(href, `HTTP ${response.status}`);
              continue;
            }
            if (/\.pdf$/i.test(finalUrl.pathname)) {
              collector.add(await extractPdf(await readBytes(response, finalUrl, MAX_PDF_BYTES), finalUrl));
            } else {
              const { page, draft } = extractMarkdown(await readText(response, finalUrl, MAX_PAGE_BYTES), finalUrl);
              collector.add(page, { noindex: draft });
            }
          } catch (error) {
            collector.skip(href, errorMessage(error));
          }
        }
      } finally {
        await renderer.close();
      }
    } else {
      // Fall back to the plain HTML we can get, keeping the warnings collected so far.
      const fallback = await crawlSite(input, { ...options, render: false, usePublishedIndex: false });
      return { ...fallback, warnings: [...new Set([...warnings, ...fallback.warnings])] };
    }
  }

  if (queue.length > 0 && collector.size >= maxPages) {
    warnings.push(`Stopped after indexing ${maxPages} pages; more pages may be available (raise --max-pages).`);
  }

  const blockedCount = [...blockedStatuses.values()].reduce((sum, count) => sum + count, 0);
  const blockHint =
    "If you own this site, index it from source instead (run website2mcp in the project folder) or publish an index with `website2mcp build --publish`.";
  if (collector.size === 0 && (challengeDetected || (startStatus !== undefined && BLOCKED_STATUSES.has(startStatus)))) {
    throw new Error(
      `${startUrl.href} refused automated requests (${challengeDetected ? "bot challenge page" : `HTTP ${startStatus}`}). ${blockHint}`,
    );
  }
  if (blockedCount > 0 || challengeDetected) {
    warnings.push(`${blockedCount + (challengeDetected ? 1 : 0)} requests were blocked or rate limited. ${blockHint}`);
  }
  if (reusedPages > 0) notes.push(`Reused ${reusedPages} unchanged pages (HTTP 304).`);
  if (rendered) notes.push("Rendered pages with a headless browser because the site needs JavaScript.");

  const home = collector.pages.find((page) => page.url === startUrl.href) ?? collector.pages[0];
  const siteName = (markdownFirst && llms.title) || home?.title || startUrl.hostname;
  const siteDescription = (markdownFirst && llms.summary) || home?.description;
  return {
    version: 2,
    name: siteName,
    ...(siteDescription ? { description: siteDescription } : {}),
    url: scope.href,
    indexedAt: new Date().toISOString(),
    pages: collector.pages,
    warnings,
    diagnostics: {
      mode: "crawl",
      durationMs: Date.now() - started,
      rendered,
      reusedPages,
      skipped: collector.skipped,
      notes,
    },
  };
}

async function findPublishedIndex(scope: URL, get: Fetcher): Promise<SiteIndex | undefined> {
  const candidates = [
    new URL(".well-known/website2mcp.json", scope).href,
    new URL("/.well-known/website2mcp.json", scope).href,
  ];
  for (const href of [...new Set(candidates)]) {
    try {
      const { response, url } = await get(new URL(href), { accept: "application/json" });
      if (!response.ok) {
        await response.body?.cancel();
        continue;
      }
      const index = parseSiteIndex(JSON.parse(await readText(response, url, MAX_PUBLISHED_BYTES)), href);
      const indexUrl = new URL(index.url);
      if (indexUrl.origin === scope.origin && scope.pathname.startsWith(indexUrl.pathname)) return index;
    } catch {
      // Not published or not valid; fall back to crawling.
    }
  }
  return undefined;
}

interface LlmsTxt {
  links: string[];
  title?: string;
  summary?: string;
}

async function readLlmsTxt(scope: URL, get: Fetcher, canCrawl: (url: URL) => boolean): Promise<LlmsTxt> {
  const url = new URL("llms.txt", scope);
  if (!canCrawl(url)) return { links: [] };
  try {
    const { response, url: finalUrl } = await get(url, { accept: "text/plain, text/markdown" });
    const type = response.headers.get("content-type") ?? "";
    if (!response.ok || type.includes("text/html")) {
      await response.body?.cancel();
      return { links: [] };
    }
    const text = await readText(response, finalUrl, MAX_ROBOTS_BYTES);
    const links = [...text.matchAll(/\[[^\]]*\]\(([^)\s]+)/g)].map((match) => match[1]);
    return {
      links: [
        ...new Set(
          links
            .map((href) => normalizeUrl(href, finalUrl))
            .filter((link): link is URL => link !== undefined && link.origin === scope.origin)
            .map((link) => link.href),
        ),
      ],
      title: text.match(/^#\s+(.+)$/m)?.[1]?.trim(),
      summary: text.match(/^>\s+(.+)$/m)?.[1]?.trim(),
    };
  } catch {
    return { links: [] };
  }
}

async function readSitemaps(
  robots: RobotsRules,
  startUrl: URL,
  get: Fetcher,
  warnings: string[],
): Promise<string[]> {
  const pages = new Set<string>();
  const queue = robots.getSitemaps();
  if (queue.length === 0) queue.push(new URL("/sitemap.xml", startUrl).href);
  const visited = new Set<string>();

  while (queue.length > 0 && visited.size < MAX_SITEMAPS) {
    const sitemapUrl = queue.shift();
    if (!sitemapUrl || visited.has(sitemapUrl)) continue;
    visited.add(sitemapUrl);
    const normalized = normalizeUrl(sitemapUrl, startUrl);
    if (!normalized || normalized.origin !== startUrl.origin) continue;

    try {
      const result = await get(normalized, { accept: "application/xml, text/xml" });
      if (result.response.status === 404 || result.response.status === 410) {
        await result.response.body?.cancel();
        continue;
      }
      if (!result.response.ok) {
        await result.response.body?.cancel();
        warnings.push(`Sitemap ${normalized.href} returned HTTP ${result.response.status}.`);
        continue;
      }
      const sitemap = parseSitemap(await readText(result.response, normalized, MAX_SITEMAP_BYTES));
      for (const child of sitemap.sitemaps) {
        const childUrl = normalizeUrl(child, startUrl);
        if (childUrl?.origin === startUrl.origin && !visited.has(childUrl.href)) queue.push(childUrl.href);
      }
      for (const page of sitemap.pages) pages.add(page);
    } catch (error) {
      warnings.push(`Could not read sitemap ${normalized.href}: ${errorMessage(error)}`);
    }
  }
  if (queue.length > 0) warnings.push(`Stopped after reading ${MAX_SITEMAPS} sitemaps.`);
  return [...pages];
}

async function fetchWithRetry(
  url: URL,
  options: Parameters<typeof fetchSafe>[1],
): Promise<FetchResult> {
  for (let attempt = 0; ; attempt += 1) {
    let result: FetchResult;
    try {
      result = await fetchSafe(url, options);
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (attempt < 1 && (name === "TypeError" || name === "TimeoutError")) {
        await sleep(500);
        continue;
      }
      throw error;
    }
    const status = result.response.status;
    if ((status === 429 || status === 503) && attempt < MAX_RETRIES) {
      const wait = retryAfterMs(result.response.headers.get("retry-after")) ?? 1000 * 2 ** attempt;
      if (wait <= MAX_RETRY_WAIT_MS) {
        await result.response.body?.cancel();
        await sleep(wait);
        continue;
      }
    }
    return result;
  }
}

async function fetchSafe(
  initialUrl: URL,
  options: {
    fetchImpl: typeof fetch;
    lookupImpl?: CrawlOptions["lookupImpl"];
    allowPrivateHosts?: boolean;
    timeoutMs: number;
    userAgent: string;
    origin: string;
    headers: Record<string, string>;
  },
): Promise<FetchResult> {
  let url = initialUrl;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (url.origin !== options.origin) {
      throw new Error(`Refusing to leave the starting origin: ${url.href}`);
    }
    if (!options.allowPrivateHosts) await assertPublicHost(url.hostname, options.lookupImpl);

    const response = await options.fetchImpl(url, {
      headers: {
        "user-agent": options.userAgent,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/markdown;q=0.9,application/pdf;q=0.8,*/*;q=0.5",
        "accept-language": "en;q=0.9, *;q=0.5",
        ...options.headers,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs),
    });

    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url };
    const location = response.headers.get("location");
    if (!location) return { response, url };
    await response.body?.cancel();
    if (redirects === MAX_REDIRECTS) throw new Error(`Too many redirects for ${initialUrl.href}`);

    const redirectUrl = normalizeUrl(location, url);
    if (redirectUrl && redirectUrl.origin !== options.origin && /^https?:$/.test(redirectUrl.protocol)) {
      throw new CrossOriginRedirectError(url, redirectUrl);
    }
    if (!redirectUrl || redirectUrl.origin !== options.origin) {
      throw new Error(`Refusing unsafe redirect from ${url.href}.`);
    }
    url = redirectUrl;
  }

  throw new Error(`Too many redirects for ${initialUrl.href}`);
}

async function readBytes(response: Response, url: URL, maxBytes: number): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`${url.href} returned HTTP ${response.status}.`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new Error(`${url.href} exceeds the ${maxBytes}-byte response limit.`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error(`${url.href} exceeds the ${maxBytes}-byte response limit.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function readText(response: Response, url: URL, maxBytes: number): Promise<string> {
  const bytes = await readBytes(response, url, maxBytes);
  const charset = /charset=["']?([\w-]+)/i.exec(response.headers.get("content-type") ?? "")?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function parseSitemap(xml: string): { pages: string[]; sitemaps: string[] } {
  const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true });
  const document = parser.parse(xml) as Record<string, unknown>;
  const sitemapIndex = document.sitemapindex;
  if (sitemapIndex !== undefined) {
    const sitemaps: string[] = [];
    collectLocations(sitemapIndex, sitemaps);
    return { pages: [], sitemaps };
  }
  const pages: string[] = [];
  collectLocations(document.urlset ?? document, pages);
  return { pages, sitemaps: [] };
}

function collectLocations(value: unknown, result: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectLocations(item, result);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "loc") {
      for (const location of Array.isArray(child) ? child : [child]) {
        if (typeof location === "string") result.push(location.trim());
      }
    } else {
      collectLocations(child, result);
    }
  }
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function toIso(value: string | null): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
