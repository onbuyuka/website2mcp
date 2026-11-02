#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { watch, type FSWatcher } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { suggestActionsFromHtml, validateActions } from "./actions.js";
import { createJsonlAnalytics, formatAnalyticsSummary, readAnalytics, summarizeAnalytics } from "./analytics.js";
import { cacheDir, clearCache, DEFAULT_CACHE_TTL_MS } from "./cache.js";
import { CONFIG_FILE, findConfig, loadConfig, mergeSettings, parseDuration, parseHeaderFlag, type Settings } from "./config.js";
import { DEFAULT_USER_AGENT } from "./crawl.js";
import { createFetchHandler } from "./handler.js";
import { startHttpServer } from "./http.js";
import { publicOnly, readSiteIndex, writeSiteIndex } from "./index-file.js";
import { createSiteMcpServer, VERSION } from "./mcp.js";
import { importOpenApiActions, loadOpenApiDocument } from "./openapi.js";
import { isPrivateTarget, resolveSource, type ResolvedSource } from "./source.js";
import { SiteStore } from "./store.js";
import type { ActionDefinition, SiteIndex } from "./types.js";
import { assertPublicHost } from "./url.js";

const HELP = `site2mcp ${VERSION} - turn a website into a read-only MCP server

Usage:
  site2mcp [source] [options]           Serve an MCP server (stdio by default)
  site2mcp build [source] [--publish]   Write an index file (owners: publish it with your site)
  site2mcp inspect [source] [--json]    Show what gets indexed and why pages were skipped
  site2mcp init [source]                Create ${CONFIG_FILE} and print client setup
  site2mcp actions suggest <url|file>   Draft action definitions from a page's forms
  site2mcp actions import <url|file>    Draft actions from an OpenAPI 3 JSON/YAML description
                                      Use --base-url to override its API server
  site2mcp stats <analytics.jsonl>      Summarize usage analytics
  site2mcp cache clear                  Delete cached crawls

Source (defaults to the current folder):
  https://example.com          Crawl a live site (uses the site's published index if it has one)
  https://example.com/x.json   Load a published site2mcp index
  ./my-project                 Detect the framework and index its build output or Markdown
  ./dist                       Index a build folder (JavaScript apps are rendered automatically)
  site.index.json              Serve a saved index

Indexing:
  --base-url <url>        Public URL of a local build (usually detected automatically)
  --out-dir <dir>         Build output folder, if detection picks the wrong one
  --build                 Run the project's build command first
  --render / --no-render  Force or disable JavaScript rendering (default: automatic)
  --max-pages <n>         Page limit (default 100 for crawls, 500 for local builds)
  --max-depth <n>         Link depth for crawls (default 3)
  --concurrency <n>       Parallel requests or renders (default 2)
  --include <glob>        Only index matching paths, e.g. "/docs/**" (repeatable)
  --exclude <glob>        Skip matching paths (repeatable)
  --private <glob>        Mark matching paths private (repeatable)
  --header "Name: value"  Send a header when crawling; \${env:VAR} is expanded (repeatable).
                          Pages fetched with credentials are private by default.
  --user-agent <ua>       Override the crawler user agent
  --drafts                Include Markdown drafts
  --name <text>           Override the site name

Caching and updates:
  --refresh               Ignore the cache and re-index now
  --cache-ttl <time>      Re-crawl after this long, e.g. 30m, 6h (default 6h)
  --no-cache              Don't read or write the crawl cache
  --no-published          Don't use a published /.well-known/site2mcp.json
  --no-llms-txt           Crawl HTML even when llms.txt lists Markdown pages
  --watch                 Re-index when local files change

Serving:
  --http                  Serve Streamable HTTP instead of stdio
  --port <n> / --host <h> HTTP address (default 127.0.0.1:3000)
  --token <secret>        Bearer token that unlocks private pages and /admin/reload
                          (repeatable; also read from SITE2MCP_TOKENS, comma-separated)
  --require-auth          Reject requests without a valid token
  --analytics <file>      Append tool-call analytics to a JSONL file
  --redact-queries        Don't store search text in analytics
  --config <file>         Settings file (default: ./${CONFIG_FILE} if present)
  --quiet                 Only log errors

Examples:
  npx site2mcp https://docs.example.com
  npx site2mcp                                   (inside your site's project folder)
  npx site2mcp build ./dist --publish            (writes dist/.well-known/site2mcp.json)
  npx site2mcp https://example.com --http --port 8080
`;

const options = {
  "base-url": { type: "string" },
  "out-dir": { type: "string" },
  build: { type: "boolean" },
  render: { type: "boolean" },
  "no-render": { type: "boolean" },
  "max-pages": { type: "string" },
  "max-depth": { type: "string" },
  concurrency: { type: "string" },
  include: { type: "string", multiple: true },
  exclude: { type: "string", multiple: true },
  private: { type: "string", multiple: true },
  header: { type: "string", multiple: true, short: "H" },
  "user-agent": { type: "string" },
  drafts: { type: "boolean" },
  name: { type: "string" },
  description: { type: "string" },
  refresh: { type: "boolean" },
  "cache-ttl": { type: "string" },
  "no-cache": { type: "boolean" },
  "no-published": { type: "boolean" },
  "no-llms-txt": { type: "boolean" },
  watch: { type: "boolean", short: "w" },
  http: { type: "boolean" },
  port: { type: "string", short: "p" },
  host: { type: "string" },
  token: { type: "string", multiple: true },
  "require-auth": { type: "boolean" },
  analytics: { type: "string" },
  "redact-queries": { type: "boolean" },
  config: { type: "string", short: "c" },
  output: { type: "string", short: "o" },
  publish: { type: "boolean" },
  json: { type: "boolean" },
  since: { type: "string" },
  quiet: { type: "boolean", short: "q" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

type Flags = ReturnType<typeof parseCli>["values"];

function parseCli(args: string[]) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nRun site2mcp --help for usage.`);
  }
}

let quiet = false;
const log = (message: string) => {
  if (!quiet) process.stderr.write(`site2mcp: ${message}\n`);
};

async function main(argv: string[]): Promise<void> {
  const { values: flags, positionals } = parseCli(argv);
  quiet = Boolean(flags.quiet);
  if (flags.help) {
    process.stdout.write(HELP);
    return;
  }
  if (flags.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const [command, ...rest] = positionals;
  const single = (usage: string) => {
    if (rest.length > 1) throw new Error(`Unexpected argument "${rest[1]}". Usage: ${usage}`);
    return rest[0];
  };
  switch (command) {
    case "build":
      return buildCommand(single("site2mcp build [source]"), flags);
    case "inspect":
      return inspectCommand(single("site2mcp inspect [source]"), flags);
    case "crawl":
      return inspectCommand(single("site2mcp crawl <url>"), { ...flags, json: true });
    case "init":
      return initCommand(single("site2mcp init [source]"), flags);
    case "stats":
      return statsCommand(single("site2mcp stats <file>"), flags);
    case "actions":
      if (rest.length !== 2 || !["suggest", "import"].includes(rest[0])) {
        throw new Error("Usage: site2mcp actions suggest <url|file.html> | actions import <url|file> [--base-url <api-url>]");
      }
      return rest[0] === "import" ? importActionsCommand(rest[1], flags) : suggestCommand(rest[1], flags);
    case "cache":
      return cacheCommand(single("site2mcp cache clear"));
    case "serve":
      return serveCommand(single("site2mcp serve [source]"), flags);
    case "help":
      process.stdout.write(HELP);
      return;
    default:
      if (rest.length > 0) throw new Error(`Unexpected argument "${rest[0]}". Run site2mcp --help for usage.`);
      return serveCommand(command, flags);
  }
}

async function loadSettings(input: string | undefined, flags: Flags): Promise<Settings> {
  const flagSettings = settingsFromFlags(flags);
  let configFile = flags.config;
  if (!configFile) {
    const dirs = [process.cwd()];
    if (input && !/^https?:\/\//i.test(input)) {
      const info = await stat(input).catch(() => undefined);
      if (info?.isDirectory()) dirs.unshift(path.resolve(input));
    }
    configFile = await findConfig(dirs);
  }
  if (!configFile) return flagSettings;
  const config = await loadConfig(configFile);
  log(`Using settings from ${path.relative(process.cwd(), config.file) || config.file}.`);
  return mergeSettings(config.settings, flagSettings);
}

function settingsFromFlags(flags: Flags): Settings {
  if (flags.render && flags["no-render"]) throw new Error("Use only one of --render or --no-render.");
  const headers: Record<string, string> = {};
  for (const header of flags.header ?? []) {
    const [name, value] = parseHeaderFlag(header);
    headers[name] = value;
  }
  const envTokens = (process.env.SITE2MCP_TOKENS ?? "").split(",").map((token) => token.trim()).filter(Boolean);
  const tokens = [...(flags.token ?? []), ...envTokens];
  return {
    baseUrl: flags["base-url"],
    outDir: flags["out-dir"],
    build: flags.build,
    render: flags.render ? true : flags["no-render"] ? false : undefined,
    maxPages: integerFlag(flags["max-pages"], "--max-pages", 1, 5000),
    maxDepth: integerFlag(flags["max-depth"], "--max-depth", 0, 20),
    concurrency: integerFlag(flags.concurrency, "--concurrency", 1, 8),
    include: flags.include,
    exclude: flags.exclude,
    private: flags.private,
    headers: Object.keys(headers).length ? headers : undefined,
    userAgent: flags["user-agent"],
    includeDrafts: flags.drafts,
    name: flags.name,
    description: flags.description,
    refresh: flags.refresh,
    cacheTtlMs: flags["cache-ttl"] ? parseDuration(flags["cache-ttl"]) : undefined,
    cache: flags["no-cache"] ? false : undefined,
    published: flags["no-published"] ? false : undefined,
    llmsTxt: flags["no-llms-txt"] ? false : undefined,
    watch: flags.watch,
    http: flags.http,
    port: integerFlag(flags.port, "--port", 0, 65535),
    host: flags.host,
    tokens: tokens.length ? tokens : undefined,
    requireAuth: flags["require-auth"],
    analyticsFile: flags.analytics ? path.resolve(flags.analytics) : undefined,
    redactQueries: flags["redact-queries"],
  };
}

async function serveCommand(input: string | undefined, flags: Flags): Promise<void> {
  const settings = await loadSettings(input, flags);
  const source = await resolveSource(input, settings, { log });
  for (const note of source.notes) log(note);

  const store = SiteStore.placeholder(source.siteUrl, settings.name);
  const quick = source.mode !== "crawl" && source.mode !== "build";
  const initial = source.initial();
  // Local indexes load fast; crawls and builds load in the background so the client can connect right away.
  if (quick) {
    store.replace((await initial).site);
  } else {
    log(`Indexing ${source.label} ...`);
    void store.load(
      initial.then(({ site, stale }) => {
        if (stale) setImmediate(() => refreshInBackground(source, store));
        return site;
      }),
    );
  }
  const loaded = initial.then(
    ({ site }) => reportReady(site, source),
    (error: unknown) => log(`Indexing failed: ${error instanceof Error ? error.message : String(error)}`),
  );

  const actions = loadActions(settings, quick ? store.site.url : source.siteUrl);
  if (actions.length) log(`Enabled ${actions.length} action(s): ${actions.map((action) => action.name).join(", ")}.`);
  const analytics = settings.analyticsFile
    ? createJsonlAnalytics(settings.analyticsFile, { redactQueries: settings.redactQueries })
    : undefined;
  const watchers = settings.watch ? watchSource(source, store) : [];

  const cleanups: Array<() => Promise<void>> = [
    async () => watchers.forEach((watcher) => watcher.close()),
    async () => analytics?.close(),
  ];
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    for (const cleanup of cleanups) await cleanup().catch(() => {});
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  if (settings.http) {
    const tokens = settings.tokens ?? [];
    if (settings.requireAuth && tokens.length === 0) throw new Error("--require-auth needs at least one --token (or SITE2MCP_TOKENS).");
    const handler = createFetchHandler(store, {
      tokens,
      requireAuth: settings.requireAuth,
      analytics,
      actions,
      onReload: async () => store.replace(await source.reload(store.site)),
    });
    const server = await startHttpServer(handler, { port: settings.port ?? 3000, host: settings.host ?? "127.0.0.1" });
    cleanups.unshift(() => server.close());
    log(`MCP endpoint: ${server.url}/mcp`);
    if (tokens.length === 0) log("No tokens set, so clients only see public pages.");
    if (source.mode === "crawl") {
      setInterval(() => refreshInBackground(source, store), settings.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS).unref();
    }
    await loaded;
    return;
  }

  const server = createSiteMcpServer(store, { access: "all", analytics, transport: "stdio", actions });
  await server.connect(new StdioServerTransport());
  process.stdin.once("close", () => void shutdown());
  if (process.stdin.isTTY) {
    const target = input ? (/^https?:/i.test(input) ? input : path.resolve(input)) : process.cwd();
    process.stderr.write(
      `\nThis is an MCP server that talks over stdin/stdout, so an MCP client should start it.\n` +
        `For VS Code, add this to .vscode/mcp.json:\n` +
        `  ${JSON.stringify({ servers: { site: { type: "stdio", command: "npx", args: ["-y", "site2mcp", target] } } })}\n` +
        `To poke at it over HTTP instead: site2mcp ${input ?? "."} --http\n` +
        `Press Ctrl+C to stop.\n\n`,
    );
  }
  await loaded;
}

function reportReady(site: SiteIndex, source: ResolvedSource): void {
  const privatePages = site.pages.filter((page) => page.visibility === "private").length;
  const details = [
    site.diagnostics?.mode === "published" ? "from the site's published index" : undefined,
    site.diagnostics?.rendered ? "rendered" : undefined,
    privatePages ? `${privatePages} private` : undefined,
    site.diagnostics?.skipped.length ? `${site.diagnostics.skipped.length} skipped` : undefined,
  ].filter(Boolean);
  log(`Ready: ${site.pages.length} pages from ${source.label}${details.length ? ` (${details.join(", ")})` : ""}.`);
  for (const warning of site.warnings.slice(0, 3)) log(`warning: ${warning}`);
  if (site.warnings.length > 3) log(`...and ${site.warnings.length - 3} more warnings (run site2mcp inspect for details).`);
}

let refreshing = false;
function refreshInBackground(source: ResolvedSource, store: SiteStore): void {
  if (refreshing) return;
  refreshing = true;
  source
    .reload(store.site)
    .then((site) => {
      store.replace(site);
      log(`Refreshed: ${site.pages.length} pages.`);
    })
    .catch((error: unknown) => log(`Refresh failed: ${error instanceof Error ? error.message : String(error)}`))
    .finally(() => {
      refreshing = false;
    });
}

function watchSource(source: ResolvedSource, store: SiteStore): FSWatcher[] {
  if (source.watchPaths.length === 0) {
    log("--watch only applies to local folders and index files.");
    return [];
  }
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let queued = false;
  const run = async () => {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      await store.ready().catch(() => {});
      const site = await source.reload(store.site);
      store.replace(site);
      log(`Re-indexed after a change: ${site.pages.length} pages.`);
    } catch (error) {
      log(`Re-index failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
      if (queued) {
        queued = false;
        void run();
      }
    }
  };
  const watchers: FSWatcher[] = [];
  for (const target of source.watchPaths) {
    try {
      const isFile = /\.json$/i.test(target);
      watchers.push(
        watch(target, { recursive: !isFile }, () => {
          clearTimeout(timer);
          timer = setTimeout(() => void run(), 400);
        }),
      );
    } catch (error) {
      log(`Can't watch ${target}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  log(`Watching ${source.watchPaths.map((target) => path.relative(process.cwd(), target) || ".").join(", ")} for changes.`);
  return watchers;
}

function loadActions(settings: Settings, siteUrl: string): ActionDefinition[] {
  if (!settings.actions?.length) return [];
  return validateActions(settings.actions, siteUrl, { allowedOrigins: settings.allowedActionOrigins });
}

async function buildCommand(input: string | undefined, flags: Flags): Promise<void> {
  const settings = mergeSettings(await loadSettings(input, flags), { cache: false });
  const source = await resolveSource(input, settings, { log, forBuild: true });
  for (const note of source.notes) log(note);
  if (flags.publish && !source.outputDir) {
    throw new Error("--publish needs a build output folder (for example ./dist) so the index ships with the site.");
  }
  const output = path.resolve(
    flags.output ?? (flags.publish ? path.join(source.outputDir!, ".well-known", "site2mcp.json") : "site2mcp.index.json"),
  );
  const previous = await readSiteIndex(output).catch(() => undefined);
  const site = await source.reload(previous);
  const written = flags.publish ? publicOnly(site) : site;
  await mkdir(path.dirname(output), { recursive: true });
  await writeSiteIndex(output, written);

  const privateCount = site.pages.length - written.pages.length;
  process.stdout.write(
    `Indexed ${site.pages.length} pages from ${source.label}${site.diagnostics?.rendered ? " (rendered)" : ""}.\n` +
      (site.diagnostics?.skipped.length ? `Skipped ${site.diagnostics.skipped.length} (run site2mcp inspect to see why).\n` : "") +
      site.warnings.map((warning) => `Warning: ${warning}\n`).join("") +
      (privateCount ? `Left ${privateCount} private pages out of the published file.\n` : "") +
      `Wrote ${output}\n` +
      (flags.publish
        ? `\nDeploy the folder as usual. After that, anyone can run:\n  npx site2mcp ${site.url}\n` +
          `and site2mcp will load this index instead of crawling your site.\n`
        : ""),
  );
}

async function inspectCommand(input: string | undefined, flags: Flags): Promise<void> {
  const settings = await loadSettings(input, flags);
  const source = await resolveSource(input, settings, { log });
  for (const note of source.notes) log(note);
  const { site } = await source.initial();
  const store = new SiteStore(site);
  const kinds: Record<string, number> = {};
  for (const page of site.pages) kinds[page.kind ?? "html"] = (kinds[page.kind ?? "html"] ?? 0) + 1;
  const summary = {
    name: site.name,
    url: site.url,
    source: source.label,
    mode: site.diagnostics?.mode ?? source.mode,
    indexedAt: site.indexedAt,
    durationMs: site.diagnostics?.durationMs,
    rendered: site.diagnostics?.rendered ?? false,
    reusedPages: site.diagnostics?.reusedPages ?? 0,
    pageCount: site.pages.length,
    privatePages: site.pages.filter((page) => page.visibility === "private").length,
    kinds,
    itemTypes: store.itemTypes(true),
    warnings: site.warnings,
    notes: site.diagnostics?.notes ?? [],
    skipped: site.diagnostics?.skipped ?? [],
    pages: site.pages.map(({ id, title, url, description, kind, visibility }) => ({
      id,
      title,
      url,
      ...(description ? { description } : {}),
      ...(kind && kind !== "html" ? { kind } : {}),
      ...(visibility === "private" ? { private: true } : {}),
    })),
  };
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  const timing = summary.durationMs !== undefined ? `, took ${(summary.durationMs / 1000).toFixed(1)}s` : "";
  const lines = [
    `${summary.name}  ${summary.url}`,
    `Mode: ${summary.mode}${summary.rendered ? ", rendered with a browser" : ""}${timing}${summary.reusedPages ? `, ${summary.reusedPages} unchanged pages reused` : ""}`,
    `Pages: ${summary.pageCount}${summary.privatePages ? ` (${summary.privatePages} private)` : ""}  [${formatCounts(kinds)}]`,
  ];
  if (Object.keys(summary.itemTypes).length) lines.push(`Structured data: ${formatCounts(summary.itemTypes)}`);
  if (summary.notes.length) lines.push("", "Notes:", ...summary.notes.map((note) => `  - ${note}`));
  if (summary.warnings.length) lines.push("", "Warnings:", ...summary.warnings.map((warning) => `  - ${warning}`));
  if (summary.skipped.length) {
    lines.push("", `Skipped (${summary.skipped.length}):`);
    for (const entry of summary.skipped.slice(0, 25)) lines.push(`  - ${entry.url}: ${entry.reason}`);
    if (summary.skipped.length > 25) lines.push(`  ...and ${summary.skipped.length - 25} more (use --json)`);
  }
  lines.push("", "Pages:");
  for (const page of summary.pages.slice(0, 40)) lines.push(`  ${page.id}  ${page.title}${page.private ? "  [private]" : ""}`);
  if (summary.pages.length > 40) lines.push(`  ...and ${summary.pages.length - 40} more (use --json)`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function initCommand(input: string | undefined, flags: Flags): Promise<void> {
  const settings = await loadSettings(input, flags);
  const source = await resolveSource(input, settings, { log, forBuild: true });
  const configPath = path.resolve(CONFIG_FILE);
  const exists = await access(configPath).then(() => true, () => false);
  if (!exists) {
    const config: Record<string, unknown> = {};
    if (input) config.source = /^https?:/i.test(input) ? input : path.relative(process.cwd(), path.resolve(input)) || ".";
    if (source.mode === "build" || source.mode === "markdown") config.baseUrl = source.siteUrl;
    Object.assign(config, { include: [], exclude: [], private: [], actions: [] });
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }
  const isUrl = Boolean(input && /^https?:/i.test(input));
  const target = isUrl ? input! : path.resolve(input ?? ".");
  const relative = isUrl ? "" : path.relative(process.cwd(), target);
  const insideCwd = !isUrl && !relative.startsWith("..") && !path.isAbsolute(relative);
  const vscodeTarget = isUrl
    ? target
    : insideCwd
      ? `\${workspaceFolder}${relative ? `/${relative.split(path.sep).join("/")}` : ""}`
      : target;
  const claudeTarget = isUrl ? target : insideCwd ? relative.split(path.sep).join("/") || "." : target;
  const serverName =
    source.mode === "crawl" || source.mode === "published"
      ? new URL(source.siteUrl).hostname.replace(/^www\./, "")
      : path.basename(source.project?.root ?? target);
  const vscode = { servers: { [serverName]: { type: "stdio", command: "npx", args: ["-y", "site2mcp", vscodeTarget] } } };
  process.stdout.write(
    `${exists ? `${CONFIG_FILE} already exists, so I left it alone.` : `Created ${CONFIG_FILE}.`}\n` +
      source.notes.map((note) => `  ${note}\n`).join("") +
      `\nVS Code (.vscode/mcp.json):\n${JSON.stringify(vscode, null, 2)}\n` +
      `\nClaude Code (run in this folder):\n  claude mcp add --scope project ${serverName} -- npx -y site2mcp ${shellQuote(claudeTarget)}\n` +
      `\nCheck what will be indexed:\n  npx site2mcp inspect${input ? ` ${input}` : ""}\n` +
      (source.outputDir
        ? `\nTo let anyone use your site without crawling it, publish an index with each deploy:\n  npx site2mcp build${input ? ` ${input}` : ""} --publish\n`
        : ""),
  );
}

function shellQuote(value: string): string {
  return /^[\w@%+=:,./\\-]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`;
}

async function statsCommand(file: string | undefined, flags: Flags): Promise<void> {
  if (!file) throw new Error("Usage: site2mcp stats <analytics.jsonl> [--since 7d] [--json]");
  const { events, invalidLines } = await readAnalytics(file);
  const since = flags.since ? new Date(Date.now() - parseDuration(flags.since)) : undefined;
  const summary = summarizeAnalytics(events, { since });
  if (flags.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  else process.stdout.write(formatAnalyticsSummary(summary));
  if (invalidLines) log(`Ignored ${invalidLines} unreadable line(s).`);
}

async function importActionsCommand(target: string, flags: Flags): Promise<void> {
  const { document, documentUrl } = await loadOpenApiDocument(target, { userAgent: flags["user-agent"] });
  const result = importOpenApiActions(document, { documentUrl, baseUrl: flags["base-url"] });
  for (const warning of result.warnings) process.stderr.write(`site2mcp: ${warning}\n`);
  if (!result.actions.length) throw new Error("Nothing imported. Review the diagnostics above.");
  process.stdout.write(`${JSON.stringify({ actions: result.actions }, null, 2)}\n`);
  log(`Drafted ${result.actions.length} action(s). Review URLs, inputs and auth, then copy selected actions into ${CONFIG_FILE}. Nothing was enabled or executed.`);
}

async function suggestCommand(target: string, flags: Flags): Promise<void> {
  let html: string;
  let pageUrl: URL;
  if (/^https?:\/\//i.test(target)) {
    pageUrl = new URL(target);
    if (!isPrivateTarget(pageUrl.hostname)) await assertPublicHost(pageUrl.hostname);
    const response = await fetch(pageUrl, {
      headers: { "user-agent": flags["user-agent"] ?? DEFAULT_USER_AGENT, accept: "text/html" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Could not load ${pageUrl.href}: HTTP ${response.status}`);
    html = await response.text();
  } else {
    html = await readFile(target, "utf8");
    pageUrl = new URL(path.basename(target), flags["base-url"] ?? "http://localhost/");
  }
  const suggestions = suggestActionsFromHtml(html, pageUrl);
  if (suggestions.length === 0) {
    process.stdout.write("No forms found on that page.\n");
    return;
  }
  for (const suggestion of suggestions) {
    for (const note of suggestion.notes) log(`${suggestion.action.name}: ${note}`);
  }
  process.stdout.write(`${JSON.stringify({ actions: suggestions.map((suggestion) => suggestion.action) }, null, 2)}\n`);
  log(`Review these, then copy the ones you want into "actions" in ${CONFIG_FILE}.`);
}

async function cacheCommand(sub: string | undefined): Promise<void> {
  if (sub === "clear") {
    const removed = await clearCache();
    process.stdout.write(`Removed ${removed} cached index(es) from ${cacheDir()}.\n`);
    return;
  }
  if (sub === "dir" || sub === undefined) {
    process.stdout.write(`${cacheDir()}\n`);
    return;
  }
  throw new Error("Usage: site2mcp cache clear | site2mcp cache dir");
}

function formatCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort((left, right) => right[1] - left[1])
    .map(([key, count]) => `${key} ${count}`)
    .join(", ");
}

function integerFlag(value: string | undefined, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be a whole number between ${min} and ${max}.`);
  }
  return parsed;
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`site2mcp: ${message}\n`);
  process.exit(1);
});
