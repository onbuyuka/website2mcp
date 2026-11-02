import MiniSearch from "minisearch";
import type { ContentKind, SiteIndex, SitePage } from "./types.js";

export interface SearchResult {
  id: string;
  title: string;
  url: string;
  snippet: string;
  section?: string;
  kind?: ContentKind;
  score: number;
}

export interface SearchOptions {
  limit?: number;
  pathPrefix?: string;
  kind?: ContentKind;
  includePrivate?: boolean;
}

interface SectionDoc {
  id: string;
  pageId: string;
  title: string;
  heading: string;
  description: string;
  text: string;
  private: boolean;
  kind: string;
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in", "is", "it",
  "of", "on", "or", "the", "to", "what", "when", "where", "which", "who", "with",
]);

export function searchPages(site: SiteIndex, query: string, options: number | SearchOptions = {}) {
  return createPageSearcher(site.pages)(query, options);
}

export function createPageSearcher(pages: SitePage[]) {
  const sections = pages.flatMap(splitSections);
  const sectionsById = new Map(sections.map((section) => [section.id, section]));
  const pagesById = new Map(pages.map((page) => [page.id, page]));
  const index = new MiniSearch<SectionDoc>({
    fields: ["title", "heading", "description", "text"],
    storeFields: ["pageId"],
    processTerm: (term) => {
      const folded = fold(term);
      return folded.length > 1 && !STOP_WORDS.has(folded) ? folded : null;
    },
    searchOptions: {
      boost: { title: 3, heading: 2, description: 1.5 },
      prefix: (term) => term.length >= 3,
      fuzzy: (term) => (term.length >= 5 ? 0.2 : false),
    },
  });
  index.addAll(sections);

  return (query: string, options: number | SearchOptions = {}): SearchResult[] => {
    const { limit = 10, pathPrefix, kind, includePrivate = true } =
      typeof options === "number" ? { limit: options } : options;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new Error("limit must be an integer between 1 and 50.");
    }
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return [];
    const queryTerms = new Set(
      fold(normalizedQuery).split(/[^\p{L}\p{N}]+/u).filter((term) => term.length > 1 && !STOP_WORDS.has(term)),
    );
    const phrase = fold(normalizedQuery).replace(/\s+/g, " ");

    const hits = index.search(normalizedQuery, {
      filter: (result) => {
        const section = sectionsById.get(result.id);
        if (!section) return false;
        if (!includePrivate && section.private) return false;
        if (kind && section.kind !== kind) return false;
        if (pathPrefix && !section.pageId.startsWith(pathPrefix)) return false;
        return true;
      },
    });

    const byPage = new Map<string, { best: { section: SectionDoc; score: number }; total: number }>();
    for (const hit of hits) {
      const section = sectionsById.get(hit.id);
      if (!section) continue;
      const coverage = queryTerms.size ? new Set(hit.queryTerms).size / queryTerms.size : 1;
      const phraseBonus = queryTerms.size > 1 && fold(`${section.heading} ${section.text}`).includes(phrase) ? 1.5 : 1;
      const score = hit.score * (0.5 + coverage) * phraseBonus;
      const entry = byPage.get(section.pageId);
      if (!entry) {
        byPage.set(section.pageId, { best: { section, score }, total: score });
      } else {
        entry.total += score;
        if (score > entry.best.score) entry.best = { section, score };
      }
    }

    return [...byPage.entries()]
      .map(([pageId, { best, total }]) => ({
        pageId,
        best,
        score: best.score + 0.25 * (total - best.score),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map(({ pageId, best, score }) => {
        const page = pagesById.get(pageId);
        if (!page) throw new Error(`Search index returned unknown page id: ${pageId}`);
        return {
          id: page.id,
          title: page.title,
          url: page.url,
          snippet: makeSnippet(best.section, [...queryTerms]),
          ...(best.section.heading && best.section.heading !== page.title ? { section: best.section.heading } : {}),
          ...(page.kind && page.kind !== "html" ? { kind: page.kind } : {}),
          score: Math.round(score * 100) / 100,
        };
      });
  };
}

function splitSections(page: SitePage): SectionDoc[] {
  const parts: Array<{ heading: string; text: string }> = [];
  let heading = "";
  let lines: string[] = [];
  const flush = () => {
    const text = lines.join("\n").trim();
    if (text || heading) parts.push({ heading, text });
  };
  for (const line of page.text.split("\n")) {
    const match = /^#{1,4}\s+(.+?)\s*#*$/.exec(line);
    if (match) {
      flush();
      heading = match[1].replace(/[*_`]/g, "").trim();
      lines = [];
    } else {
      lines.push(line);
    }
  }
  flush();
  if (parts.length === 0) parts.push({ heading: "", text: "" });

  return parts.map((part, index) => ({
    id: `${page.id}\u0000${index}`,
    pageId: page.id,
    title: page.title,
    heading: part.heading,
    description: index === 0 ? (page.description ?? "") : "",
    text: part.text,
    private: page.visibility === "private",
    kind: page.kind ?? "html",
  }));
}

function fold(value: string): string {
  return value.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
}

function makeSnippet(section: SectionDoc, terms: string[]): string {
  const text = `${section.description} ${section.text}`.replace(/\s+/g, " ").trim();
  const folded = fold(text);
  const sameLength = folded.length === text.length;
  const haystack = sameLength ? folded : text.toLowerCase();
  const matchAt = terms
    .map((term) => haystack.indexOf(term))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  const start = Math.max(0, (matchAt ?? 0) - 70);
  const snippet = text.slice(start, start + 220).trim();
  return `${start > 0 ? "…" : ""}${snippet}${start + 220 < text.length ? "…" : ""}`;
}
