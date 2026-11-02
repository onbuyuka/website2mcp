import { contentHash } from "./hash.js";
import { createPageSearcher, type SearchOptions, type SearchResult } from "./search.js";
import type { SiteIndex, SitePage, StructuredItem } from "./types.js";

export interface ItemEntry extends StructuredItem {
  pageId: string;
  pageUrl: string;
  private: boolean;
}

export interface ItemQuery {
  type?: string;
  text?: string;
  pathPrefix?: string;
  includePrivate: boolean;
}

interface Snapshot {
  site: SiteIndex;
  search: ReturnType<typeof createPageSearcher>;
  byId: Map<string, SitePage>;
  byUrl: Map<string, SitePage>;
  items: ItemEntry[];
}

// Holds the current index and lets servers swap in a fresh one without restarting.
export class SiteStore {
  private snapshot: Snapshot;
  private readonly listeners = new Set<(site: SiteIndex) => void>();
  private loading?: Promise<void>;
  private loadError?: Error;

  constructor(site: SiteIndex) {
    this.snapshot = createSnapshot(site);
  }

  static placeholder(url: string, name = new URL(url).hostname): SiteStore {
    return new SiteStore({ name, url, indexedAt: new Date(0).toISOString(), pages: [], warnings: [] });
  }

  get site(): SiteIndex {
    return this.snapshot.site;
  }

  get isLoading(): boolean {
    return this.loading !== undefined;
  }

  replace(site: SiteIndex): void {
    this.snapshot = createSnapshot(site);
    this.loadError = undefined;
    for (const listener of this.listeners) listener(site);
  }

  // Lets a server start answering before indexing finishes; tool calls wait on ready().
  load(promise: Promise<SiteIndex>): Promise<void> {
    const loading: Promise<void> = promise.then(
      (site) => this.replace(site),
      (error: unknown) => {
        this.loadError = error instanceof Error ? error : new Error(String(error));
      },
    ).finally(() => {
      if (this.loading === loading) this.loading = undefined;
    });
    this.loading = loading;
    return loading;
  }

  async ready(): Promise<void> {
    while (this.loading) await this.loading;
    if (this.loadError && this.snapshot.site.pages.length === 0) throw this.loadError;
  }

  onChange(listener: (site: SiteIndex) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  pages(includePrivate: boolean): SitePage[] {
    return includePrivate
      ? this.snapshot.site.pages
      : this.snapshot.site.pages.filter((page) => page.visibility !== "private");
  }

  page(idOrUrl: string, includePrivate: boolean): SitePage | undefined {
    const { byId, byUrl } = this.snapshot;
    const find = (key: string) =>
      byId.get(key) ??
      byUrl.get(key) ??
      byId.get(key.endsWith("/") ? key.slice(0, -1) : `${key}/`) ??
      byUrl.get(key.endsWith("/") ? key.slice(0, -1) : `${key}/`);
    let page = find(idOrUrl);
    if (!page) {
      try {
        const url = new URL(idOrUrl);
        page = find(url.href) ?? byId.get(`${url.pathname}${url.search}`);
      } catch {
        // Paths relative to the site's base URL, e.g. "/" or "guide/" for a site under /docs/.
        try {
          const resolved = new URL(idOrUrl.replace(/^\/+/, ""), this.site.url);
          page = find(resolved.href) ?? find(`${resolved.pathname}${resolved.search}${resolved.hash}`);
        } catch {
          page = undefined;
        }
      }
    }
    if (page && !includePrivate && page.visibility === "private") return undefined;
    return page;
  }

  search(query: string, options: SearchOptions): SearchResult[] {
    return this.snapshot.search(query, options);
  }

  items(query: ItemQuery): ItemEntry[] {
    const type = query.type?.toLowerCase();
    const text = query.text ? fold(query.text) : undefined;
    const results: ItemEntry[] = [];
    for (const item of this.snapshot.items) {
      if (!query.includePrivate && item.private) continue;
      if (query.pathPrefix && !item.pageId.startsWith(query.pathPrefix)) continue;
      if (type && !item.type.toLowerCase().split(",").some((candidate) => candidate.trim() === type)) continue;
      if (!text) {
        results.push(item);
        continue;
      }
      if (item.source === "table" && Array.isArray(item.data.rows)) {
        const rows = item.data.rows as Array<Record<string, unknown>>;
        const headerMatch = fold(`${item.name ?? ""} ${JSON.stringify(item.data.columns)}`).includes(text);
        const matching = headerMatch ? rows : rows.filter((row) => fold(JSON.stringify(row)).includes(text));
        if (matching.length === 0) continue;
        results.push({
          ...item,
          data: { ...item.data, rows: matching, matchedRows: matching.length, totalRows: rows.length },
        });
      } else if (fold(`${item.type} ${item.name ?? ""} ${JSON.stringify(item.data)}`).includes(text)) {
        results.push(item);
      }
    }
    return results;
  }

  itemTypes(includePrivate: boolean): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const item of this.snapshot.items) {
      if (!includePrivate && item.private) continue;
      counts[item.type] = (counts[item.type] ?? 0) + 1;
    }
    return counts;
  }
}

function createSnapshot(site: SiteIndex): Snapshot {
  const items: ItemEntry[] = [];
  const seen = new Set<string>();
  for (const page of site.pages) {
    for (const item of page.items ?? []) {
      const key = contentHash(JSON.stringify([item.type, item.data]));
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ ...item, pageId: page.id, pageUrl: page.url, private: page.visibility === "private" });
    }
  }
  return {
    site,
    search: createPageSearcher(site.pages),
    byId: new Map(site.pages.map((page) => [page.id, page])),
    byUrl: new Map(site.pages.map((page) => [page.url, page])),
    items,
  };
}

function fold(value: string): string {
  return value.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
}
