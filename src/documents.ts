import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { extractText, getDocumentProxy, getMeta } from "unpdf";
import { contentHash } from "./hash.js";
import type { SitePage } from "./types.js";

type PdfProxy = Awaited<ReturnType<typeof getDocumentProxy>>;
type FrontMatterValue = string | boolean;
type FrontMatter = Record<string, FrontMatterValue>;

export interface MarkdownPage {
  page: SitePage;
  draft: boolean;
  permalink?: string;
}

export interface MarkdownSourceOptions {
  maxPages?: number;
  includeDrafts?: boolean;
}

const PDF_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_PAGES = 1000;
const MARKDOWN_EXTENSION = /\.(md|mdx|markdown)$/i;
const SKIPPED_MARKDOWN_STEMS = new Set([
  "changelog",
  "license",
  "code_of_conduct",
]);
const INDEX_STEMS = new Set(["index", "readme", "_index"]);
const DOCUMENT_EXTENSION =
  /\.(docx?|pptx?|xlsx?|pdf|odt|odp|ods|rtf|txt|tex|dvi|indd|pages|key|numbers|html?|ps|md)$/i;
const JUNK_TITLE =
  /^(untitled\b.*|(document|doc|presentation|book|workbook|slide|title)\s*\d*|unknown|none|null|n\/a|default|anonymous)$/i;

export async function extractPdf(
  bytes: Uint8Array,
  url: URL,
): Promise<SitePage> {
  const hash = contentHash(bytes);
  let pdf: PdfProxy | undefined;
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const work = (async () => {
    // pdf.js transfers (detaches) the buffer it is given, so pass a copy.
    const proxy = await getDocumentProxy(new Uint8Array(bytes), {
      verbosity: 0,
    });
    if (timedOut) {
      await proxy.loadingTask.destroy().catch(() => undefined);
      throw new Error("timed out");
    }
    pdf = proxy;
    const meta = await getMeta(proxy);
    const { text } = await extractText(proxy, { mergePages: false });
    return { info: meta.info, metadata: meta.metadata as unknown, text };
  })();
  work.catch(() => undefined);
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`timed out after ${PDF_TIMEOUT_MS / 1000}s`));
    }, PDF_TIMEOUT_MS);
    timer.unref?.();
  });
  timeout.catch(() => undefined);

  let result: Awaited<typeof work>;
  try {
    result = await Promise.race([work, timeout]);
  } catch (error) {
    throw new Error(`Could not read PDF: ${describePdfError(error)}`, {
      cause: error,
    });
  } finally {
    clearTimeout(timer);
    const opened = pdf as PdfProxy | undefined;
    if (opened) await opened.loadingTask.destroy().catch(() => undefined);
  }

  const info = (result.info ?? {}) as Record<string, unknown>;
  const title =
    cleanPdfTitle(stringValue(info.Title)) ??
    cleanPdfTitle(xmpValue(result.metadata, "dc:title")) ??
    titleFromName(lastSegment(url), url);
  const description =
    normalizeInline(stringValue(info.Subject) ?? "") ||
    normalizeInline(xmpValue(result.metadata, "dc:description") ?? "") ||
    undefined;
  const lastModified =
    parsePdfDate(stringValue(info.ModDate)) ??
    parsePdfDate(stringValue(info.CreationDate));
  const text = result.text
    .map((pageText) => normalizeText(pageText))
    .filter(Boolean)
    .join("\n\n");

  return withoutUndefined({
    id: url.pathname + url.search,
    title,
    url: url.href,
    description,
    text,
    lastModified,
    kind: "pdf" as const,
    hash,
  });
}

export function extractMarkdown(
  source: string,
  url: URL,
  fileName?: string,
): MarkdownPage {
  const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const { data, body: rawBody } = splitFrontMatter(normalized);
  const isMdx = /\.mdx$/i.test(fileName ?? url.pathname);
  const body = (isMdx ? stripMdx(rawBody) : rawBody).trim();

  const name = fileName
    ? stripOrderingPrefix(
        path.basename(fileName).replace(/^\d{4}-\d{2}-\d{2}-(?=.)/, ""),
      )
    : lastSegment(url);
  const title =
    normalizeInline(stringField(data, "title") ?? "") ||
    firstHeading(body) ||
    titleFromName(name, url);
  const description =
    normalizeInline(
      stringField(data, "description") ??
        stringField(data, "summary") ??
        stringField(data, "excerpt") ??
        "",
    ) || undefined;
  let lastModified: string | undefined;
  for (const key of ["lastmod", "last_modified", "updated", "date"]) {
    lastModified = parseDateValue(stringField(data, key));
    if (lastModified) break;
  }
  const draft =
    isTruthy(data.draft) || data.published === false || isFalsy(data.published);
  const permalinkValue =
    stringField(data, "permalink") ?? stringField(data, "slug");
  const permalink = permalinkValue?.trim() || undefined;

  return withoutUndefined({
    page: withoutUndefined({
      id: url.pathname + url.search,
      title,
      url: url.href,
      description,
      text: body,
      lastModified,
      kind: "markdown" as const,
      hash: contentHash(source),
    }),
    draft,
    permalink,
  });
}

export async function indexMarkdownSource(
  dirs: string[],
  baseUrl: URL,
  options: MarkdownSourceOptions = {},
): Promise<{ pages: SitePage[]; warnings: string[] }> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const base = new URL(baseUrl.href);
  base.search = "";
  base.hash = "";
  if (!base.pathname.endsWith("/")) base.pathname += "/";

  const pages: SitePage[] = [];
  const warnings: string[] = [];
  const seen = new Map<string, string>();
  let emptyCount = 0;

  outer: for (const dir of dirs) {
    const root = path.resolve(dir);
    const rootName = path.basename(root);
    let files: string[];
    try {
      files = await findMarkdownFiles(root, "", warnings);
    } catch (error) {
      warnings.push(`Could not read directory ${dir}: ${errorMessage(error)}`);
      continue;
    }
    files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    for (const relative of files) {
      const sourceFile = rootName ? `${rootName}/${relative}` : relative;
      let source: string;
      try {
        source = await readFile(path.join(root, relative), "utf8");
      } catch (error) {
        warnings.push(`Could not read ${sourceFile}: ${errorMessage(error)}`);
        continue;
      }

      const mapped = mapMarkdownPath(relative);
      const defaultUrl = new URL(mapped.path || "./", base);
      let result: MarkdownPage;
      try {
        result = extractMarkdown(source, defaultUrl, path.basename(relative));
      } catch (error) {
        warnings.push(`Could not parse ${sourceFile}: ${errorMessage(error)}`);
        continue;
      }
      if ((result.draft || mapped.draft) && !options.includeDrafts) continue;
      if (!result.page.text) {
        emptyCount += 1;
        continue;
      }

      const finalUrl = result.permalink
        ? (resolvePermalink(result.permalink, mapped.path, base) ?? defaultUrl)
        : defaultUrl;
      const page: SitePage = {
        ...result.page,
        id: finalUrl.pathname + finalUrl.search,
        url: finalUrl.href,
        sourceFile,
      };

      const existing = seen.get(page.id);
      if (existing) {
        warnings.push(
          `Duplicate page id ${page.id} from ${sourceFile} (already provided by ${existing}); skipped.`,
        );
        continue;
      }
      if (pages.length >= maxPages) {
        warnings.push(
          `Reached maxPages limit (${maxPages}); remaining Markdown files were skipped.`,
        );
        break outer;
      }
      seen.set(page.id, sourceFile);
      pages.push(page);
    }
  }

  if (emptyCount > 0) {
    warnings.push(
      `Skipped ${emptyCount} Markdown file${emptyCount === 1 ? "" : "s"} with no content.`,
    );
  }
  return { pages, warnings };
}

async function findMarkdownFiles(
  root: string,
  relative: string,
  warnings: string[],
): Promise<string[]> {
  const entries = await readdir(path.join(root, relative), {
    withFileTypes: true,
  });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      try {
        files.push(...(await findMarkdownFiles(root, childRelative, warnings)));
      } catch (error) {
        warnings.push(
          `Could not read directory ${childRelative}: ${errorMessage(error)}`,
        );
      }
    } else if (entry.isFile() && MARKDOWN_EXTENSION.test(entry.name)) {
      const stem = entry.name.replace(MARKDOWN_EXTENSION, "").toLowerCase();
      if (!SKIPPED_MARKDOWN_STEMS.has(stem)) files.push(childRelative);
    }
  }
  return files;
}

function mapMarkdownPath(relative: string): { path: string; draft: boolean } {
  const segments = relative.split("/").filter(Boolean);
  const fileName = segments.pop() ?? "";
  const draft = segments.includes("_drafts");
  const folders = segments
    .filter((segment) => segment !== "_posts" && segment !== "_drafts")
    .map(stripOrderingPrefix);
  const stem = fileName.replace(MARKDOWN_EXTENSION, "");

  const post = /^(\d{4})-(\d{2})-(\d{2})-(.+)$/.exec(stem);
  if (post) {
    folders.push(post[1], post[2], post[3], post[4]);
  } else if (!INDEX_STEMS.has(stem.toLowerCase())) {
    folders.push(stripOrderingPrefix(stem));
  }
  const encoded = folders.map((segment) => encodeURIComponent(segment));
  return { path: encoded.length ? `${encoded.join("/")}/` : "", draft };
}

function stripOrderingPrefix(segment: string): string {
  const stripped = segment.replace(/^\d+[-_. ]+/, "");
  return stripped || segment;
}

function resolvePermalink(
  permalink: string,
  mappedPath: string,
  base: URL,
): URL | undefined {
  if (permalink.includes(":") || /[?#]/.test(permalink)) return undefined;
  try {
    if (permalink.startsWith("/")) {
      return new URL(encodePath(permalink.replace(/^\/+/, "")) || "./", base);
    }
    const segments = mappedPath.split("/").filter(Boolean);
    segments.pop();
    const slug = encodePath(permalink.replace(/\/+$/, ""));
    if (!slug) return undefined;
    return new URL([...segments, slug].join("/") + "/", base);
  } catch {
    return undefined;
  }
}

function encodePath(value: string): string {
  return value
    .split("/")
    .map((segment) => encodeURIComponent(safeDecode(segment)))
    .join("/");
}

function splitFrontMatter(source: string): { data: FrontMatter; body: string } {
  const match = /^(---|\+\+\+)[ \t]*\n/.exec(source);
  if (!match) return { data: {}, body: source };
  const fence = match[1];
  const lines = source.slice(match[0].length).split("\n");
  const closers = fence === "---" ? ["---", "..."] : ["+++"];
  const end = lines.findIndex((line) => closers.includes(line.trimEnd()));
  if (end < 0) return { data: {}, body: source };
  const block = lines.slice(0, end);
  const body = lines.slice(end + 1).join("\n");
  try {
    return {
      data: fence === "---" ? parseYamlFrontMatter(block) : parseToml(block),
      body,
    };
  } catch {
    return { data: {}, body };
  }
}

function parseYamlFrontMatter(lines: string[]): FrontMatter {
  const data: FrontMatter = {};
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([A-Za-z_][\w.-]*)\s*:(?:\s+(.*))?$/.exec(lines[index]);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const raw = (match[2] ?? "").trim();
    if (!raw || raw.startsWith("#")) continue;

    const block = /^([|>])[+-]?\d*[+-]?\s*(#.*)?$/.exec(raw);
    if (block) {
      const collected: string[] = [];
      while (index + 1 < lines.length && /^(\s|$)/.test(lines[index + 1])) {
        collected.push(lines[index + 1].trim());
        index += 1;
      }
      data[key] =
        block[1] === "|"
          ? collected.join("\n").trim()
          : collected.join(" ").replace(/\s+/g, " ").trim();
      continue;
    }

    if (raw.startsWith('"') || raw.startsWith("'")) {
      let quoted = raw;
      while (
        closingQuoteIndex(quoted) < 0 &&
        index + 1 < lines.length &&
        /^\s/.test(lines[index + 1])
      ) {
        quoted += ` ${lines[index + 1].trim()}`;
        index += 1;
      }
      data[key] = parseQuoted(quoted);
      continue;
    }

    let value = raw.replace(/\s+#.*$/, "");
    while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1])) {
      value += ` ${lines[index + 1].trim()}`;
      index += 1;
    }
    if (/^(null|~)$/i.test(value)) continue;
    if (/^true$/i.test(value)) data[key] = true;
    else if (/^false$/i.test(value)) data[key] = false;
    else data[key] = value;
  }
  return data;
}

function parseToml(lines: string[]): FrontMatter {
  const data: FrontMatter = {};
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.startsWith("[")) break;
    const match = /^([A-Za-z_][\w-]*|"[^"]+"|'[^']+')\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].replace(/^["']|["']$/g, "").toLowerCase();
    let raw = match[2].trim();

    const multi = /^("""|''')/.exec(raw);
    if (multi) {
      const delimiter = multi[1];
      let content = raw.slice(3);
      while (!content.includes(delimiter) && index + 1 < lines.length) {
        index += 1;
        content += `\n${lines[index]}`;
      }
      data[key] = content
        .slice(0, Math.max(0, content.indexOf(delimiter)))
        .replace(/^\n/, "")
        .trim();
      continue;
    }
    if (raw.startsWith('"') || raw.startsWith("'")) {
      data[key] = parseQuoted(raw);
      continue;
    }
    raw = raw.replace(/\s+#.*$/, "");
    if (raw === "true") data[key] = true;
    else if (raw === "false") data[key] = false;
    else if (raw) data[key] = raw;
  }
  return data;
}

function closingQuoteIndex(value: string): number {
  const quote = value[0];
  for (let index = 1; index < value.length; index += 1) {
    if (quote === '"' && value[index] === "\\") {
      index += 1;
      continue;
    }
    if (value[index] === quote) {
      if (quote === "'" && value[index + 1] === "'") {
        index += 1;
        continue;
      }
      return index;
    }
  }
  return -1;
}

function parseQuoted(value: string): string {
  const quote = value[0];
  const end = closingQuoteIndex(value);
  const inner = value.slice(1, end < 0 ? undefined : end);
  if (quote === "'") return inner.replace(/''/g, "'");
  try {
    return JSON.parse(`"${inner.replace(/\t/g, "\\t")}"`) as string;
  } catch {
    return inner;
  }
}

function stripMdx(body: string): string {
  const lines = body.split("\n");
  const output: string[] = [];
  let fence: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fence) {
      if (closesFence(trimmed, fence)) fence = undefined;
      output.push(line);
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      output.push(line);
      continue;
    }
    if (isModuleLine(line)) {
      index = moduleStatementEnd(lines, index);
      continue;
    }
    if (/^<[A-Z][\w.]*(\s[^<>]*)?\/>$/.test(trimmed)) continue;
    if (/^\{\/\*.*\*\/\}$/.test(trimmed)) continue;
    output.push(line);
  }
  return output.join("\n");
}

function closesFence(trimmed: string, fence: string): boolean {
  const match = /^(`{3,}|~{3,})$/.exec(trimmed);
  return Boolean(
    match && match[1][0] === fence[0] && match[1].length >= fence.length,
  );
}

function isModuleLine(line: string): boolean {
  return (
    /^import\s+(type\s+)?([\w$*{}\s,]+\s+from\s+)?["'][^"']+["'];?\s*$/.test(
      line,
    ) ||
    /^import\s+(type\s+)?\{[^}]*$/.test(line) ||
    /^export\s+(const|let|var|function|async|class|default|type|interface|\{|\*)/.test(
      line,
    )
  );
}

function moduleStatementEnd(lines: string[], start: number): number {
  let depth = 0;
  const limit = Math.min(lines.length, start + 200);
  for (let index = start; index < limit; index += 1) {
    for (const char of lines[index]) {
      if ("{([".includes(char)) depth += 1;
      else if ("})]".includes(char)) depth -= 1;
    }
    if (depth <= 0) return index;
  }
  return start;
}

function firstHeading(body: string): string | undefined {
  const lines = body.split("\n");
  let fence: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fence) {
      if (closesFence(trimmed, fence)) fence = undefined;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      continue;
    }
    const atx = /^ {0,3}#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(lines[index]);
    if (atx) return cleanHeading(atx[1]) || undefined;
    if (trimmed && /^ {0,3}=+[ \t]*$/.test(lines[index + 1] ?? "")) {
      return cleanHeading(trimmed) || undefined;
    }
  }
  return undefined;
}

function cleanHeading(value: string): string {
  return normalizeInline(
    value
      .replace(/\s*\{#[^}]*\}\s*$/, "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/(\*\*|__|`)/g, "")
      .replace(/<[^>]+>/g, ""),
  );
}

function cleanPdfTitle(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let title = normalizeInline(value.replace(/\u0000/g, ""));
  if (/^[a-z]:\\|^\/|\\/i.test(title)) return undefined;
  title = title
    .replace(/^Microsoft\s+(Word|PowerPoint|Excel)\s+-\s+/i, "")
    .replace(DOCUMENT_EXTENSION, "")
    .trim();
  if (!title || JUNK_TITLE.test(title)) return undefined;
  return title;
}

function titleFromName(name: string, url: URL): string {
  const decoded = safeDecode(name);
  const stem = decoded.replace(/\.(pdf|md|mdx|markdown)$/i, "");
  if (!stem || INDEX_STEMS.has(stem.toLowerCase())) {
    const segment = lastSegment(url);
    if (segment && segment !== name) return titleFromName(segment, url);
    return url.hostname || "Untitled";
  }
  return (
    stem.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim() ||
    url.hostname ||
    "Untitled"
  );
}

function lastSegment(url: URL): string {
  const segments = url.pathname.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

function parsePdfDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match =
    /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?\s*(?:(Z)|([+-])(\d{2})'?(\d{2})?'?)?/.exec(
      value.trim(),
    );
  if (!match) return undefined;
  const [year, month = 1, day = 1, hour = 0, minute = 0, second = 0] = match
    .slice(1, 7)
    .map((part) => (part === undefined ? undefined : Number(part)));
  if (
    year === undefined ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return undefined;
  }
  let time = Date.UTC(year, month - 1, day, hour, minute, second);
  if (match[8]) {
    const offset = (Number(match[9]) * 60 + Number(match[10] ?? 0)) * 60_000;
    time += match[8] === "+" ? -offset : offset;
  }
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function parseDateValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const match =
    /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/i.exec(
      trimmed,
    );
  let candidate: string;
  if (match) {
    if (!match[2]) {
      candidate = `${match[1]}T00:00:00Z`;
    } else {
      const zone = (match[6] ?? "Z").replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
      candidate = `${match[1]}T${match[2].padStart(2, "0")}:${match[3]}:${match[4] ?? "00"}${match[5] ?? ""}${zone.toUpperCase()}`;
    }
  } else if (/\d{4}/.test(trimmed)) {
    candidate = trimmed;
  } else {
    return undefined;
  }
  const time = Date.parse(candidate);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

function normalizeText(value: string): string {
  return value
    .split(/\r\n?|\n/)
    .map((line) => line.replace(/[ \t\f\v\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeInline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringField(data: FrontMatter, key: string): string | undefined {
  const value = data[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function xmpValue(metadata: unknown, key: string): string | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const getter = (metadata as { get?: unknown }).get;
  if (typeof getter !== "function") return undefined;
  try {
    return stringValue(getter.call(metadata, key));
  } catch {
    return undefined;
  }
}

function isTruthy(value: FrontMatterValue | undefined): boolean {
  return (
    value === true ||
    (typeof value === "string" && /^(true|yes|on)$/i.test(value))
  );
}

function isFalsy(value: FrontMatterValue | undefined): boolean {
  return typeof value === "string" && /^(no|off)$/i.test(value);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function describePdfError(error: unknown): string {
  if (error instanceof Error && error.name === "PasswordException") {
    return "the document is password-protected";
  }
  return errorMessage(error);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

function withoutUndefined<T extends object>(value: T): T {
  for (const key of Object.keys(value) as Array<keyof T>) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}
