export type PageVisibility = "public" | "private";
export type ContentKind = "html" | "pdf" | "markdown" | "text";

export interface StructuredItem {
  type: string;
  name?: string;
  source: "json-ld" | "microdata" | "table";
  data: Record<string, unknown>;
}

export interface SitePage {
  id: string;
  title: string;
  url: string;
  description?: string;
  text: string;
  lastModified?: string;
  kind?: ContentKind;
  visibility?: PageVisibility;
  // Set when the page itself asked to be private (meta tag), so a 304 reuse can keep it private.
  markedPrivate?: boolean;
  hash?: string;
  etag?: string;
  sourceFile?: string;
  items?: StructuredItem[];
}

export interface SkippedPage {
  url: string;
  reason: string;
}

export interface IndexDiagnostics {
  mode: "crawl" | "build" | "source" | "published";
  durationMs: number;
  rendered: boolean;
  reusedPages: number;
  skipped: SkippedPage[];
  notes: string[];
}

export interface ActionField {
  type: "string" | "number" | "integer" | "boolean";
  description?: string;
  enum?: string[];
  format?: "email" | "uri" | "date";
  required?: boolean;
  default?: string | number | boolean;
}

export interface ActionDefinition {
  name: string;
  description: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  input?: Record<string, ActionField>;
  bodyType?: "json" | "form" | "query";
  headers?: Record<string, string>;
  confirm?: boolean;
  destructive?: boolean;
  maxResponseChars?: number;
}

export interface SiteIndex {
  version?: 2;
  name: string;
  description?: string;
  url: string;
  indexedAt: string;
  pages: SitePage[];
  warnings: string[];
  diagnostics?: IndexDiagnostics;
  fingerprint?: string;
  actions?: ActionDefinition[];
}

export interface PathRules {
  include?: string[];
  exclude?: string[];
  private?: string[];
}

export interface CrawlOptions extends PathRules {
  maxPages?: number;
  maxDepth?: number;
  delayMs?: number;
  timeoutMs?: number;
  concurrency?: number;
  userAgent?: string;
  headers?: Record<string, string>;
  render?: boolean;
  allowPrivateHosts?: boolean;
  previous?: SiteIndex;
  usePublishedIndex?: boolean;
  // Read the Markdown pages listed in llms.txt instead of crawling HTML (default true).
  useLlmsTxt?: boolean;
  fetchImpl?: typeof fetch;
  lookupImpl?: (
    hostname: string,
  ) => Promise<Array<{ address: string; family: number }>>;
  rendererFactory?: () => Promise<import("./render.js").PageRenderer>;
  log?: (message: string) => void;
}