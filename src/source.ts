import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { buildSiteIndex } from "./build-index.js";
import { cacheKey, DEFAULT_CACHE_TTL_MS, formatAge, readCachedIndex, writeCachedIndex } from "./cache.js";
import { PageCollector } from "./collector.js";
import type { Settings } from "./config.js";
import { crawlSite, DEFAULT_USER_AGENT } from "./crawl.js";
import { indexMarkdownSource } from "./documents.js";
import { applyIndexRules, parseSiteIndex, publicOnly, readSiteIndex } from "./index-file.js";
import { detectProject, hasHtmlIndex, type ProjectInfo } from "./project.js";
import type { SiteIndex } from "./types.js";
import { assertPublicHost, isPublicIp, normalizeUrl } from "./url.js";

export type SourceMode = "crawl" | "published" | "index-file" | "build" | "markdown";

export interface ResolvedSource {
  mode: SourceMode;
  label: string;
  siteUrl: string;
  notes: string[];
  watchPaths: string[];
  // Build output folder, when there is one; build --publish writes the index into it.
  outputDir?: string;
  project?: ProjectInfo;
  initial(): Promise<{ site: SiteIndex; stale: boolean }>;
  reload(previous?: SiteIndex): Promise<SiteIndex>;
}

export interface ResolveOptions {
  log?: (message: string) => void;
  forBuild?: boolean;
}

const FALLBACK_BASE_URL = "http://localhost/";
const MAX_PUBLISHED_BYTES = 50 * 1024 * 1024;

export async function resolveSource(
  input: string | undefined,
  settings: Settings,
  options: ResolveOptions = {},
): Promise<ResolvedSource> {
  const log = options.log ?? (() => {});
  const target = input ?? settings.source ?? ".";

  if (/^https?:\/\//i.test(target)) {
    const url = normalizeUrl(target);
    if (!url) throw new Error(`Not a valid web address: ${target}`);
    return /\.json$/i.test(url.pathname) ? publishedSource(url, settings) : crawlSource(url, settings, log);
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) && !/^[a-z]:[\\/]/i.test(target)) {
    throw new Error(`Only http and https URLs are supported (got ${target}).`);
  }

  const resolved = path.resolve(target);
  const info = await stat(resolved).catch(() => undefined);
  if (!info) {
    if (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(target)) {
      throw new Error(`"${target}" isn't a local path. Did you mean https://${target} ?`);
    }
    throw new Error(`Not found: ${resolved}`);
  }
  if (info.isFile()) {
    if (!/\.json$/i.test(resolved)) throw new Error(`Expected a website2mcp index (.json), a folder, or a URL: ${resolved}`);
    return indexFileSource(resolved, settings);
  }
  return directorySource(resolved, settings, log, options.forBuild ?? false);
}

function crawlSource(url: URL, settings: Settings, log: (message: string) => void): ResolvedSource {
  const allowPrivateHosts = isPrivateTarget(url.hostname) || undefined;
  const crawlOptions = {
    maxPages: settings.maxPages,
    maxDepth: settings.maxDepth,
    concurrency: settings.concurrency,
    include: settings.include,
    exclude: settings.exclude,
    private: settings.private,
    headers: settings.headers,
    userAgent: settings.userAgent,
    render: settings.render,
    usePublishedIndex: settings.published,
    useLlmsTxt: settings.llmsTxt,
    allowPrivateHosts,
  };
  const key = cacheKey(url.hostname, {
    url: url.href,
    ...crawlOptions,
    headers: Object.entries(settings.headers ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  });
  const ttl = settings.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const useCache = settings.cache !== false;

  const reload = async (previous?: SiteIndex) => {
    const site = applyOverrides(await crawlSite(url.href, { ...crawlOptions, previous, log }), settings);
    if (useCache) await writeCachedIndex(key, site).catch((error: unknown) => log(`Could not write cache: ${String(error)}`));
    return site;
  };

  return {
    mode: "crawl",
    label: url.href,
    siteUrl: url.href,
    notes: allowPrivateHosts ? ["Private network address: crawling local/intranet hosts is allowed for this source."] : [],
    watchPaths: [],
    reload,
    async initial() {
      const cached = useCache ? await readCachedIndex(key) : undefined;
      if (cached && !settings.refresh) {
        const stale = cached.ageMs > ttl;
        log(`Using cached index (${cached.site.pages.length} pages, indexed ${formatAge(cached.ageMs)})${stale ? "; refreshing in the background" : ""}.`);
        return { site: applyOverrides(cached.site, settings), stale };
      }
      try {
        return { site: await reload(cached?.site), stale: false };
      } catch (error) {
        if (!cached) throw error;
        log(`Refresh failed (${error instanceof Error ? error.message : String(error)}); using the cached index.`);
        return { site: applyOverrides(cached.site, settings), stale: false };
      }
    },
  };
}

function publishedSource(url: URL, settings: Settings): ResolvedSource {
  const load = async () => applyOverrides(applyIndexRules(await fetchPublishedIndex(url, settings), settings), settings);
  return {
    mode: "published",
    label: url.href,
    siteUrl: new URL("/", url).href,
    notes: [],
    watchPaths: [],
    reload: load,
    initial: async () => ({ site: await load(), stale: false }),
  };
}

function indexFileSource(file: string, settings: Settings): ResolvedSource {
  const load = async () => applyOverrides(applyIndexRules(await readSiteIndex(file), settings), settings);
  return {
    mode: "index-file",
    label: file,
    siteUrl: settings.baseUrl ?? FALLBACK_BASE_URL,
    notes: [],
    watchPaths: [file],
    reload: load,
    initial: async () => ({ site: await load(), stale: false }),
  };
}

async function directorySource(
  dir: string,
  settings: Settings,
  log: (message: string) => void,
  forBuild: boolean,
): Promise<ResolvedSource> {
  let project = await detectProject(dir);
  let outputDir = settings.outDir ? path.resolve(dir, settings.outDir) : project.outputDir;
  const notes: string[] = [];

  if (settings.build) {
    if (!project.buildCommand) throw new Error(`--build was given, but no build command was found in ${project.root}.`);
    await runBuild(project, log);
    project = await detectProject(dir);
    outputDir = settings.outDir ? path.resolve(dir, settings.outDir) : project.outputDir;
    if (!outputDir) throw new Error(`The build finished, but no HTML output was found (looked in ${project.outputCandidates.join(", ")}).`);
  }

  // A bare build folder (e.g. ./dist) usually has no config of its own, so look one level up for the site URL.
  let baseUrlHint = { url: project.baseUrl, source: project.baseUrlSource };
  if (!baseUrlHint.url && outputDir && path.resolve(outputDir) === project.root) {
    const parent = await detectProject(path.dirname(project.root)).catch(() => undefined);
    if (parent?.baseUrl) baseUrlHint = { url: parent.baseUrl, source: parent.baseUrlSource };
  }
  const baseUrl = settings.baseUrl ?? baseUrlHint.url;
  if (!settings.baseUrl && baseUrlHint.url) notes.push(`Site URL ${baseUrlHint.url} (from ${baseUrlHint.source ?? "project settings"}).`);
  const effectiveBaseUrl = baseUrl ?? FALLBACK_BASE_URL;
  if (!baseUrl) {
    notes.push(`Couldn't work out the public URL, so links will use ${FALLBACK_BASE_URL}. Pass --base-url https://your-site.example to fix that.`);
  }

  if (outputDir && (await hasAnyHtml(outputDir))) {
    if (project.framework !== "static" && project.framework !== "unknown") {
      notes.push(`Detected ${project.framework}; indexing build output in ${path.relative(process.cwd(), outputDir) || "."}.`);
    }
    if (!settings.build && project.buildCommand && !forBuild) {
      notes.push("Using the existing build output. Pass --build to rebuild first.");
    }
    return buildSource(outputDir, effectiveBaseUrl, settings, log, notes, project);
  }

  if (project.contentDirs.length > 0) {
    notes.push(`No build output found; indexing Markdown sources in ${project.contentDirs.map((d) => path.relative(process.cwd(), d) || ".").join(", ")}.`);
    if (project.buildCommand) notes.push("For the fully rendered site, build it first or pass --build.");
    return markdownSource(project, effectiveBaseUrl, settings, notes);
  }

  const hint = project.notes.find((note) => note.startsWith("No build output")) ?? "No website found in this folder.";
  throw new Error(
    `${hint}\nwebsite2mcp can serve a URL (website2mcp https://example.com), a build folder with HTML, a project with Markdown content, or a website2mcp index file.`,
  );
}

function buildSource(
  outputDir: string,
  baseUrl: string,
  settings: Settings,
  log: (message: string) => void,
  notes: string[],
  project: ProjectInfo,
): ResolvedSource {
  const buildOptions = {
    render: settings.render,
    maxPages: settings.maxPages,
    concurrency: settings.concurrency,
    include: settings.include,
    exclude: settings.exclude,
    private: settings.private,
    log,
  };
  const key = cacheKey(path.basename(outputDir), { outputDir, baseUrl, render: settings.render });
  const useCache = settings.cache !== false;

  const reload = async (previous?: SiteIndex) => {
    const site = applyOverrides(await buildSiteIndex(outputDir, baseUrl, { ...buildOptions, previous }), settings);
    if (useCache) await writeCachedIndex(key, site).catch((error: unknown) => log(`Could not write cache: ${String(error)}`));
    return site;
  };

  return {
    mode: "build",
    label: outputDir,
    siteUrl: baseUrl,
    notes,
    watchPaths: [outputDir],
    outputDir,
    project,
    reload,
    async initial() {
      const cached = useCache && !settings.refresh ? await readCachedIndex(key) : undefined;
      return { site: await reload(cached?.site), stale: false };
    },
  };
}

function markdownSource(project: ProjectInfo, baseUrl: string, settings: Settings, notes: string[]): ResolvedSource {
  const load = async () => {
    const started = Date.now();
    const base = new URL(baseUrl);
    const { pages, warnings } = await indexMarkdownSource(project.contentDirs, base, {
      maxPages: settings.maxPages,
      includeDrafts: settings.includeDrafts,
    });
    const collector = new PageCollector(base, settings);
    for (const page of pages) collector.add(page);
    return applyOverrides(
      {
        version: 2,
        name: path.basename(project.root),
        url: base.href,
        indexedAt: new Date().toISOString(),
        pages: collector.pages,
        warnings,
        diagnostics: {
          mode: "source",
          durationMs: Date.now() - started,
          rendered: false,
          reusedPages: 0,
          skipped: collector.skipped,
          notes,
        },
      },
      settings,
    );
  };
  return {
    mode: "markdown",
    label: project.root,
    siteUrl: baseUrl,
    notes,
    watchPaths: project.contentDirs,
    project,
    reload: load,
    initial: async () => ({ site: await load(), stale: false }),
  };
}

async function fetchPublishedIndex(url: URL, settings: Settings): Promise<SiteIndex> {
  if (!isPrivateTarget(url.hostname)) await assertPublicHost(url.hostname);
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": settings.userAgent ?? DEFAULT_USER_AGENT, ...settings.headers },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Could not load ${url.href}: HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_PUBLISHED_BYTES) throw new Error(`${url.href} is too large (${length} bytes).`);
  const text = await response.text();
  if (text.length > MAX_PUBLISHED_BYTES) throw new Error(`${url.href} is too large.`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${url.href} is not JSON.`);
  }
  const site = parseSiteIndex(value, url.href);
  return settings.headers && Object.keys(settings.headers).length ? site : publicOnly(site);
}

async function runBuild(project: ProjectInfo, log: (message: string) => void): Promise<void> {
  const { command, args } = project.buildCommand!;
  const commandLine = [command, ...args].map((part) => (/[\s"]/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part)).join(" ");
  log(`Building the site: ${commandLine}`);
  await new Promise<void>((resolve, reject) => {
    // stdout is the MCP channel, so build output goes to stderr.
    const child = spawn(commandLine, { cwd: project.root, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Build command failed with exit code ${code}: ${commandLine}`))));
  });
}

async function hasAnyHtml(dir: string): Promise<boolean> {
  if (await hasHtmlIndex(dir)) return true;
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries.some((entry) => /\.html?$/i.test(entry));
}

function applyOverrides(site: SiteIndex, settings: Settings): SiteIndex {
  if (!settings.name && !settings.description) return site;
  return {
    ...site,
    ...(settings.name ? { name: settings.name } : {}),
    ...(settings.description ? { description: settings.description } : {}),
  };
}

export function isPrivateTarget(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (isIP(host)) return !isPublicIp(host);
  return !host.includes(".");
}
