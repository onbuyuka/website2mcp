import { contentHash } from "./hash.js";
import { applyPathRules } from "./paths.js";
import type { PathRules, SitePage, SkippedPage } from "./types.js";

const MAX_SKIPPED = 200;

export interface CollectMeta {
  url?: URL;
  noindex?: boolean;
  markedPrivate?: boolean;
}

// Applies path rules, noindex, privacy, and duplicate detection consistently across modes.
export class PageCollector {
  readonly pages: SitePage[] = [];
  readonly skipped: SkippedPage[] = [];
  private skippedCount = 0;
  private readonly ids = new Set<string>();
  private readonly texts = new Map<string, string>();

  constructor(
    private readonly baseUrl: URL,
    private readonly rules: PathRules = {},
    private readonly defaultPrivate = false,
  ) {}

  get size(): number {
    return this.pages.length;
  }

  get totalSkipped(): number {
    return this.skippedCount;
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  isExcluded(url: URL): boolean {
    return applyPathRules(url, this.baseUrl, { exclude: this.rules.exclude }).excluded;
  }

  skip(url: string, reason: string): void {
    this.skippedCount += 1;
    if (this.skipped.length < MAX_SKIPPED) this.skipped.push({ url, reason });
  }

  add(page: SitePage, meta: CollectMeta = {}): boolean {
    const url = meta.url ?? new URL(page.url);
    const decision = applyPathRules(url, this.baseUrl, this.rules);
    if (decision.excluded) {
      this.skip(page.url, decision.reason ?? "excluded");
      return false;
    }
    if (meta.noindex) {
      this.skip(page.url, "page is marked noindex");
      return false;
    }
    if (!page.text.trim()) {
      this.skip(page.url, "no extractable text");
      return false;
    }
    if (this.ids.has(page.id)) {
      this.skip(page.url, `duplicate of ${page.id}`);
      return false;
    }
    const textHash = contentHash(page.text);
    const duplicateOf = this.texts.get(textHash);
    if (duplicateOf) {
      this.skip(page.url, `same content as ${duplicateOf}`);
      return false;
    }
    if (meta.markedPrivate) page.markedPrivate = true;
    if (decision.private || meta.markedPrivate || this.defaultPrivate) page.visibility = "private";
    this.ids.add(page.id);
    this.texts.set(textHash, page.id);
    this.pages.push(page);
    return true;
  }
}
