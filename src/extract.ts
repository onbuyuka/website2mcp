import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { contentHash } from "./hash.js";
import type { SitePage, StructuredItem } from "./types.js";
import { normalizeUrl } from "./url.js";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

const REMOVE_SELECTORS = [
  "head",
  "title",
  "script",
  "style",
  "noscript",
  "svg",
  "iframe",
  "template",
  "nav",
  "header",
  "footer",
  "aside",
  "[role=navigation]",
  "[aria-hidden=true]",
];

const APP_ROOTS =
  "#root, #app, #__next, #__nuxt, #___gatsby, #svelte, app-root, [data-reactroot], [ng-version], [ng-app]";
const MAX_ITEMS_PER_PAGE = 50;
const MAX_TABLE_ROWS = 200;
const MAX_ITEM_JSON = 20_000;

type Element = ReturnType<ReturnType<typeof parseHTML>["document"]["querySelector"]> & {};

export interface ExtractedPage {
  page: SitePage;
  links: string[];
  isLikelyClientRendered: boolean;
  noindex: boolean;
  markedPrivate: boolean;
}

export function extractPage(html: string, pageUrl: URL): ExtractedPage {
  let { document } = parseHTML(html);
  // Some static generators emit fragments; linkedom does not add the browser's implicit body.
  if (document.documentElement?.localName !== "html") {
    document = parseHTML(`<html><body>${html}</body></html>`).document;
  }
  const meta = (selector: string) =>
    document.querySelector(selector)?.getAttribute("content")?.trim() || undefined;
  const title =
    meta('meta[property="og:title"]') ||
    document.querySelector("title")?.textContent?.trim() ||
    document.querySelector("h1")?.textContent?.trim() ||
    pageUrl.hostname;
  const description = meta('meta[name="description"]') || meta('meta[property="og:description"]');
  const lastModified = toIsoDate(
    meta('meta[property="article:modified_time"]') ||
      meta('meta[property="og:updated_time"]') ||
      meta('meta[name="last-modified"]'),
  );
  const robots = (meta('meta[name="robots"]') ?? "").toLowerCase();
  const website2mcp = (meta('meta[name="website2mcp"]') ?? "").toLowerCase();
  const canonicalHref = document.querySelector('link[rel="canonical"]')?.getAttribute("href");
  const canonicalUrl = canonicalHref ? normalizeUrl(canonicalHref, pageUrl) : undefined;
  const url = canonicalUrl?.origin === pageUrl.origin ? canonicalUrl : pageUrl;
  const id = `${url.pathname}${url.search}` || "/";

  const links = Array.from(document.querySelectorAll("a[href]"))
    .map((anchor) => anchor.getAttribute("href"))
    .filter((href): href is string => Boolean(href))
    .map((href) => normalizeUrl(href, pageUrl))
    .filter((link): link is URL => link !== undefined && link.origin === pageUrl.origin)
    .map((link) => link.href);

  const items = [...extractJsonLd(document), ...extractMicrodata(document)];

  const content =
    document.querySelector("main") ??
    document.querySelector("article") ??
    document.querySelector('[role="main"]') ??
    document.body;

  const noscriptText = Array.from(document.querySelectorAll("noscript"))
    .map((element) => element.textContent ?? "")
    .join(" ");
  for (const selector of REMOVE_SELECTORS) {
    for (const element of content.querySelectorAll(selector)) {
      element.remove();
    }
  }
  items.push(...extractTables(content));

  const text = turndown.turndown(content.innerHTML).trim();
  const plainText = content.textContent?.replace(/\s+/g, " ").trim() ?? "";
  const isLikelyClientRendered =
    (plainText.length < 80 && Boolean(document.querySelector(APP_ROOTS))) ||
    (plainText.length < 200 && /enable javascript|requires javascript/i.test(noscriptText));

  return {
    page: {
      id,
      title: title || pageUrl.hostname,
      url: url.href,
      ...(description ? { description } : {}),
      text,
      ...(lastModified ? { lastModified } : {}),
      kind: "html",
      hash: contentHash(html),
      ...(items.length ? { items: items.slice(0, MAX_ITEMS_PER_PAGE) } : {}),
    },
    links: [...new Set(links)],
    isLikelyClientRendered,
    noindex: /\b(noindex|none)\b/.test(robots) || /\b(noindex|exclude)\b/.test(website2mcp),
    markedPrivate: /\bprivate\b/.test(website2mcp),
  };
}

function extractJsonLd(document: { querySelectorAll(selector: string): Iterable<Element> }) {
  const items: StructuredItem[] = [];
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(script.textContent ?? "");
    } catch {
      continue;
    }
    const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
    while (queue.length > 0 && items.length < MAX_ITEMS_PER_PAGE) {
      const value = queue.shift();
      if (!isRecord(value)) continue;
      if (Array.isArray(value["@graph"])) queue.push(...value["@graph"]);
      const type = value["@type"];
      const typeName = Array.isArray(type) ? type.join(",") : typeof type === "string" ? type : "";
      if (!typeName) continue;
      const { "@context": _context, "@graph": _graph, ...data } = value;
      items.push({
        type: typeName,
        ...nameOf(data),
        source: "json-ld",
        data: limitSize(data),
      });
    }
  }
  return items;
}

function extractMicrodata(document: { querySelectorAll(selector: string): Iterable<Element> }) {
  const items: StructuredItem[] = [];
  for (const scope of document.querySelectorAll("[itemscope][itemtype]")) {
    if (scope.parentElement?.closest("[itemscope]")) continue;
    const typeUrl = scope.getAttribute("itemtype") ?? "";
    const type = typeUrl.split(/[/#]/).filter(Boolean).at(-1);
    if (!type) continue;
    const data: Record<string, unknown> = {};
    for (const prop of scope.querySelectorAll("[itemprop]")) {
      if (prop.parentElement?.closest("[itemscope]") !== scope) continue;
      const name = prop.getAttribute("itemprop");
      if (!name) continue;
      const value =
        prop.getAttribute("content") ??
        prop.getAttribute("datetime") ??
        (prop.hasAttribute("itemscope")
          ? prop.textContent?.replace(/\s+/g, " ").trim()
          : (prop.getAttribute("href") ?? prop.getAttribute("src") ?? prop.textContent?.replace(/\s+/g, " ").trim()));
      if (!value) continue;
      const existing = data[name];
      data[name] = existing === undefined ? value : [...(Array.isArray(existing) ? existing : [existing]), value];
    }
    if (Object.keys(data).length === 0) continue;
    items.push({ type, ...nameOf(data), source: "microdata", data: limitSize(data) });
    if (items.length >= MAX_ITEMS_PER_PAGE) break;
  }
  return items;
}

function extractTables(content: Element) {
  const items: StructuredItem[] = [];
  for (const table of content.querySelectorAll("table")) {
    const rows = Array.from(table.querySelectorAll("tr")).filter(
      (row) => row.closest("table") === table,
    );
    const headerRow = rows.find((row) => row.querySelector("th") && !row.querySelector("td")) ??
      (table.querySelector("thead tr") as Element | null);
    if (!headerRow) continue;
    const columns = cellTexts(headerRow).map((column, index) => column || `column${index + 1}`);
    if (columns.length < 2) continue;
    const records = rows
      .filter((row) => row !== headerRow && row.querySelector("td"))
      .slice(0, MAX_TABLE_ROWS)
      .map((row) => {
        const cells = cellTexts(row);
        return Object.fromEntries(columns.map((column, index) => [column, cells[index] ?? ""]));
      });
    if (records.length === 0) continue;
    const name =
      table.querySelector("caption")?.textContent?.replace(/\s+/g, " ").trim() || precedingHeading(table);
    items.push({
      type: "Table",
      ...(name ? { name } : {}),
      source: "table",
      data: { columns, rows: records },
    });
  }
  return items;
}

function cellTexts(row: Element): string[] {
  return Array.from(row.children)
    .filter((cell) => cell.tagName === "TH" || cell.tagName === "TD")
    .map((cell) => cell.textContent?.replace(/\s+/g, " ").trim() ?? "");
}

function precedingHeading(element: Element): string | undefined {
  let current: Element | null = element;
  while (current) {
    let sibling = current.previousElementSibling;
    while (sibling) {
      if (/^H[1-6]$/.test(sibling.tagName)) return sibling.textContent?.replace(/\s+/g, " ").trim();
      const nested = sibling.querySelectorAll("h1, h2, h3, h4, h5, h6");
      const last = Array.from(nested).at(-1);
      if (last) return last.textContent?.replace(/\s+/g, " ").trim();
      sibling = sibling.previousElementSibling;
    }
    current = current.parentElement;
  }
  return undefined;
}

function nameOf(data: Record<string, unknown>): { name?: string } {
  const value = data.name ?? data.headline ?? data.title;
  return typeof value === "string" && value.trim() ? { name: value.trim() } : {};
}

function limitSize(data: Record<string, unknown>): Record<string, unknown> {
  if (JSON.stringify(data).length <= MAX_ITEM_JSON) return data;
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => typeof value !== "object" || value === null),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toIsoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
