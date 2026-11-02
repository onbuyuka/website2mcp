import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export interface BuildCommand {
  command: string;
  args: string[];
}

export interface ProjectInfo {
  root: string;
  framework: string;
  outputDir?: string;
  outputCandidates: string[];
  baseUrl?: string;
  baseUrlSource?: string;
  buildCommand?: BuildCommand;
  contentDirs: string[];
  notes: string[];
}

interface PackageJson {
  homepage?: unknown;
  scripts?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  packageManager?: unknown;
}

interface ConfigFile {
  file: string;
  text: string;
}

interface ConfigHit {
  framework: string;
  file: string;
  siteKey?: string;
  site?: string;
  baseKey?: string;
  base?: string;
}

interface PathBase {
  path: string;
  source: string;
}

interface GitHubRepo {
  owner: string;
  repo: string;
}

interface BaseUrlResult {
  baseUrl?: string;
  source?: string;
  notes: string[];
}

const CONFIG_EXTS = [".js", ".mjs", ".cjs", ".ts", ".mts"];
const GENERIC_OUTPUTS = ["dist", "build", "out", "public", "_site", "site", "www"];
// Frameworks where public/ holds source assets (e.g. the CRA index.html template), not build output.
const PUBLIC_IS_SOURCE = new Set(["next", "astro", "nuxt", "vite", "create-react-app"]);
const CONTENT_DIRS = ["docs", "content", "src/content", "src/pages", "_posts", "posts", "blog", "pages", "guides"];
const CNAME_DIRS = [".", "public", "static", "docs", "source"];
const MAX_CONTENT_DEPTH = 6;
const VITEPRESS_CONFIGS = ["docs/.vitepress/config", ".vitepress/config"];
const HUGO_FILES = [
  "hugo.toml",
  "hugo.yaml",
  "hugo.yml",
  "hugo.json",
  "config/_default/hugo.toml",
  "config/_default/hugo.yaml",
  "config/_default/config.toml",
  "config/_default/config.yaml",
];
const HUGO_LEGACY_FILES = ["config.toml", "config.yaml", "config.yml"];

const DEPENDENCY_FRAMEWORKS: Array<[string, string]> = [
  ["next", "next"],
  ["astro", "astro"],
  ["@docusaurus/core", "docusaurus"],
  ["vitepress", "vitepress"],
  ["gatsby", "gatsby"],
  ["@sveltejs/kit", "sveltekit"],
  ["nuxt", "nuxt"],
  ["@11ty/eleventy", "eleventy"],
  ["react-scripts", "create-react-app"],
  ["vite", "vite"],
];

const CONFIG_FRAMEWORKS: Array<[string, string]> = [
  ["next.config", "next"],
  ["astro.config", "astro"],
  ["docusaurus.config", "docusaurus"],
  ["docs/.vitepress/config", "vitepress"],
  [".vitepress/config", "vitepress"],
  ["gatsby-config", "gatsby"],
  ["svelte.config", "sveltekit"],
  ["nuxt.config", "nuxt"],
  ["eleventy.config", "eleventy"],
  [".eleventy", "eleventy"],
  ["vite.config", "vite"],
];

const FRAMEWORK_OUTPUTS: Record<string, string[]> = {
  next: ["out"],
  astro: ["dist"],
  docusaurus: ["build"],
  vitepress: ["docs/.vitepress/dist", ".vitepress/dist", "dist"],
  gatsby: ["public"],
  sveltekit: ["build"],
  nuxt: [".output/public", "dist"],
  eleventy: ["_site"],
  "create-react-app": ["build"],
  vite: ["dist"],
  hugo: ["public"],
  jekyll: ["_site"],
  mkdocs: ["site"],
  static: ["."],
};

export async function detectProject(dir: string): Promise<ProjectInfo> {
  const root = path.resolve(dir);
  let isDirectory: boolean;
  try {
    isDirectory = (await stat(root)).isDirectory();
  } catch {
    throw new Error(`Project directory does not exist: ${root}`);
  }
  if (!isDirectory) throw new Error(`Project path is not a directory: ${root}`);

  const notes: string[] = [];
  const pkg = await readPackageJson(root, notes);
  const framework = await detectFramework(root, pkg);
  const outputCandidates = await outputCandidatesFor(root, framework);
  const outputDir = await pickOutputDir(outputCandidates);
  const buildCommand = await detectBuildCommand(root, framework, pkg);
  const base = await detectBaseUrl(root, framework, pkg);
  const contentDirs = await detectContentDirs(root);

  if (framework === "unknown") {
    notes.push("Could not detect a static-site framework; only generic output folders were checked.");
  }
  if (!outputDir) {
    if (buildCommand) {
      const primary = displayPath(root, outputCandidates[0]);
      notes.push(`No build output found in ${primary}. Run \`${formatCommand(buildCommand)}\` first, or pass --build.`);
    } else {
      const looked = outputCandidates.map((candidate) => displayPath(root, candidate)).join(", ");
      notes.push(`No build output found (looked in ${looked}). Build the site first, or point website2mcp at the output folder.`);
    }
  }
  notes.push(...base.notes);

  return {
    root,
    framework,
    outputDir,
    outputCandidates,
    baseUrl: base.baseUrl,
    baseUrlSource: base.source,
    buildCommand,
    contentDirs,
    notes,
  };
}

export async function hasHtmlIndex(dir: string): Promise<boolean> {
  return (await isFile(path.join(dir, "index.html"))) || (await isFile(path.join(dir, "index.htm")));
}

async function readPackageJson(root: string, notes: string[]): Promise<PackageJson | undefined> {
  const text = await readText(path.join(root, "package.json"));
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (isRecord(value)) return value as PackageJson;
  } catch {
    // Fall through to the note below.
  }
  notes.push("package.json could not be parsed; ignoring it.");
  return undefined;
}

async function detectFramework(root: string, pkg: PackageJson | undefined): Promise<string> {
  const deps = new Set([...recordKeys(pkg?.dependencies), ...recordKeys(pkg?.devDependencies)]);
  for (const [dep, framework] of DEPENDENCY_FRAMEWORKS) {
    if (deps.has(dep)) return framework;
  }
  if (await findFile(root, HUGO_FILES)) return "hugo";
  for (const name of HUGO_LEGACY_FILES) {
    const text = await readText(path.join(root, name));
    if (text && /^\s*baseurl\s*[:=]/im.test(text)) return "hugo";
  }
  if (await isFile(path.join(root, "_config.yml"))) return "jekyll";
  if ((await isFile(path.join(root, "mkdocs.yml"))) || (await isFile(path.join(root, "mkdocs.yaml")))) return "mkdocs";
  for (const [name, framework] of CONFIG_FRAMEWORKS) {
    if (await findConfig(root, [name])) return framework;
  }
  if (await hasHtmlIndex(root)) return "static";
  return "unknown";
}

async function outputCandidatesFor(root: string, framework: string): Promise<string[]> {
  const relative = [...(FRAMEWORK_OUTPUTS[framework] ?? [])];
  if (framework === "vite") {
    const config = await findConfig(root, ["vite.config"]);
    const outDir = config ? /outDir:\s*['"]([^'"]+)['"]/.exec(config.text)?.[1] : undefined;
    if (outDir && !isTemplated(outDir)) relative.unshift(outDir);
  }
  for (const generic of GENERIC_OUTPUTS) {
    if (generic === "public" && PUBLIC_IS_SOURCE.has(framework)) continue;
    relative.push(generic);
  }
  return [...new Set(relative.map((entry) => path.resolve(root, entry)))];
}

async function pickOutputDir(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await hasHtmlIndex(candidate)) return candidate;
  }
  for (const candidate of candidates) {
    if (await hasTopLevelHtml(candidate)) return candidate;
  }
  return undefined;
}

async function detectBuildCommand(
  root: string,
  framework: string,
  pkg: PackageJson | undefined,
): Promise<BuildCommand | undefined> {
  const scripts = pkg?.scripts;
  if (isRecord(scripts) && typeof scripts.build === "string" && scripts.build.trim()) {
    return { command: await detectPackageManager(root, pkg), args: ["run", "build"] };
  }
  if (framework === "hugo") return { command: "hugo", args: [] };
  if (framework === "jekyll") return { command: "bundle", args: ["exec", "jekyll", "build"] };
  if (framework === "mkdocs") return { command: "mkdocs", args: ["build"] };
  return undefined;
}

async function detectPackageManager(root: string, pkg: PackageJson | undefined): Promise<string> {
  if (await isFile(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (await isFile(path.join(root, "yarn.lock"))) return "yarn";
  if ((await isFile(path.join(root, "bun.lockb"))) || (await isFile(path.join(root, "bun.lock")))) return "bun";
  if (await isFile(path.join(root, "package-lock.json"))) return "npm";
  const declared = typeof pkg?.packageManager === "string" ? /^(pnpm|yarn|bun|npm)@/.exec(pkg.packageManager)?.[1] : undefined;
  return declared ?? "npm";
}
async function detectBaseUrl(
  root: string,
  framework: string,
  pkg: PackageJson | undefined,
): Promise<BaseUrlResult> {
  const notes: string[] = [];
  const homepage = typeof pkg?.homepage === "string" ? absoluteUrl(pkg.homepage) : undefined;
  if (homepage) return { baseUrl: homepage, source: "package.json homepage", notes };

  const hits = await collectConfigHits(root);
  for (const hit of hits) {
    const url = absoluteUrl(hit.site, hit.base);
    if (url) return { baseUrl: url, source: `${hit.file} ${hit.siteKey}`, notes };
  }

  const pathBase = pickPathBase(hits, framework);
  const cname = await findCname(root);
  if (cname) {
    const url = absoluteUrl(`https://${cname}/`, pathBase?.path);
    if (url) return { baseUrl: url, source: pathBase ? `${pathBase.source} + CNAME` : "CNAME", notes };
  }
  const github = await readGitHubRemote(root);
  if (github) {
    const owner = github.owner.toLowerCase();
    const origin = `https://${owner}.github.io`;
    const userSite = github.repo.toLowerCase() === `${owner}.github.io`;
    const url = absoluteUrl(pathBase ? `${origin}${pathBase.path}` : userSite ? `${origin}/` : `${origin}/${github.repo}/`);
    if (url) {
      notes.push("Base URL was guessed from the git remote (GitHub Pages); pass --base-url if the site is hosted elsewhere.");
      const source = pathBase ? `${pathBase.source} + git remote (GitHub Pages)` : "git remote (GitHub Pages)";
      return { baseUrl: url, source, notes };
    }
  }

  if (pathBase) {
    notes.push(`Found base path ${pathBase.path} in ${pathBase.source}, but no host (CNAME file or GitHub remote) to combine it with.`);
  }
  notes.push("Could not infer the site's public URL. Pass --base-url <url> or set baseUrl in website2mcp.config.json.");
  return { notes };
}

async function collectConfigHits(root: string): Promise<ConfigHit[]> {
  const hits: ConfigHit[] = [];
  const addJs = async (framework: string, names: string[], siteKey: string | undefined, baseKey: string) => {
    const config = await findConfig(root, names);
    if (!config) return;
    hits.push({
      framework,
      file: config.file,
      siteKey,
      site: siteKey ? jsString(config.text, siteKey) : undefined,
      baseKey,
      base: jsString(config.text, baseKey),
    });
  };

  await addJs("astro", ["astro.config"], "site", "base");
  await addJs("docusaurus", ["docusaurus.config"], "url", "baseUrl");
  await addJs("gatsby", ["gatsby-config"], "siteUrl", "pathPrefix");

  for (const name of [...HUGO_FILES, ...HUGO_LEGACY_FILES]) {
    const text = await readText(path.join(root, name));
    const site = text ? hugoBaseUrl(text, name) : undefined;
    if (site) {
      hits.push({ framework: "hugo", file: name, siteKey: "baseURL", site });
      break;
    }
  }

  const jekyll = await readText(path.join(root, "_config.yml"));
  if (jekyll !== undefined) {
    hits.push({
      framework: "jekyll",
      file: "_config.yml",
      siteKey: "url",
      site: yamlValue(jekyll, "url"),
      baseKey: "baseurl",
      base: yamlValue(jekyll, "baseurl"),
    });
  }

  const mkdocs = await findFile(root, ["mkdocs.yml", "mkdocs.yaml"]);
  if (mkdocs) {
    hits.push({ framework: "mkdocs", file: mkdocs.file, siteKey: "site_url", site: yamlValue(mkdocs.text, "site_url") });
  }

  await addJs("vitepress", VITEPRESS_CONFIGS, "hostname", "base");
  await addJs("vite", ["vite.config"], undefined, "base");
  await addJs("next", ["next.config"], undefined, "basePath");
  await addJs("sveltekit", ["svelte.config"], undefined, "base");
  await addJs("nuxt", ["nuxt.config"], undefined, "baseURL");
  return hits;
}

function pickPathBase(hits: ConfigHit[], framework: string): PathBase | undefined {
  const order = ["vite", "next", "sveltekit", "nuxt", "vitepress", "astro", "docusaurus", "gatsby", "jekyll"];
  const rank = (hit: ConfigHit): number => (hit.framework === framework ? 0 : 100) + order.indexOf(hit.framework);
  const ranked = hits.filter((hit) => hit.baseKey && order.includes(hit.framework)).sort((a, b) => rank(a) - rank(b));
  for (const hit of ranked) {
    const base = normalizeBasePath(hit.base);
    if (base && base !== "/") return { path: base, source: `${hit.file} ${hit.baseKey}` };
  }
  return undefined;
}

async function findCname(root: string): Promise<string | undefined> {
  for (const dir of CNAME_DIRS) {
    const text = await readText(path.join(root, dir, "CNAME"));
    const line = text?.split(/\r?\n/).map((entry) => entry.trim()).find(Boolean);
    if (!line) continue;
    const host = line.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
    if (/^[a-z0-9.-]+(?::\d+)?$/.test(host) && host.includes(".")) return host;
  }
  return undefined;
}

async function readGitHubRemote(root: string): Promise<GitHubRepo | undefined> {
  const config = await readGitConfig(root);
  if (!config) return undefined;
  const remotes = parseRemotes(config);
  const url = remotes.get("origin") ?? remotes.values().next().value;
  return url ? parseGitHubUrl(url) : undefined;
}

async function readGitConfig(root: string): Promise<string | undefined> {
  const dotGit = path.join(root, ".git");
  const direct = await readText(path.join(dotGit, "config"));
  if (direct !== undefined) return direct;
  const pointer = await readText(dotGit);
  const gitDirMatch = pointer ? /^gitdir:\s*(.+)$/m.exec(pointer) : null;
  if (!gitDirMatch) return undefined;
  const gitDir = path.resolve(root, gitDirMatch[1].trim());
  const commonDir = await readText(path.join(gitDir, "commondir"));
  if (commonDir?.trim()) {
    const shared = await readText(path.join(path.resolve(gitDir, commonDir.trim()), "config"));
    if (shared !== undefined) return shared;
  }
  return readText(path.join(gitDir, "config"));
}

function parseRemotes(config: string): Map<string, string> {
  const remotes = new Map<string, string>();
  let current: string | undefined;
  for (const line of config.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)\]/.exec(line);
    if (section) {
      current = /^\s*remote\s+"(.+)"\s*$/.exec(section[1])?.[1];
      continue;
    }
    const url = current ? /^\s*url\s*=\s*(.+?)\s*$/.exec(line)?.[1] : undefined;
    if (current && url && !remotes.has(current)) remotes.set(current, url.replace(/^"(.*)"$/, "$1"));
  }
  return remotes;
}

function parseGitHubUrl(url: string): GitHubRepo | undefined {
  const match = /(?:^|[@/])github\.com[:/]+([^/\s:]+)\/([^/\s]+?)(?:\.git)?\/*$/i.exec(url.trim());
  return match ? { owner: match[1], repo: match[2] } : undefined;
}

async function detectContentDirs(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const relative of CONTENT_DIRS) {
    const dir = path.resolve(root, relative);
    if (await containsMarkdown(dir, 0)) found.push(dir);
  }
  return found;
}

async function containsMarkdown(dir: string, depth: number): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  if (entries.some((entry) => entry.isFile() && /\.mdx?$/i.test(entry.name))) return true;
  if (depth >= MAX_CONTENT_DEPTH) return false;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    if (await containsMarkdown(path.join(dir, entry.name), depth + 1)) return true;
  }
  return false;
}

function jsString(text: string, key: string): string | undefined {
  const body = text
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join("\n");
  const prefix = `(?<![\\w$.])["']?${key}["']?\\s*:\\s*`;
  const direct = new RegExp(`${prefix}(["'\`])([^"'\`\\n]*)\\1`).exec(body);
  if (direct) return cleanValue(direct[2]);
  const ternary = new RegExp(`${prefix}[^,\\n{}]*?\\?\\s*(["'\`])([^"'\`\\n]*)\\1`).exec(body);
  return ternary ? cleanValue(ternary[2]) : undefined;
}

function yamlValue(text: string, key: string, ignoreCase = false): string | undefined {
  const match = new RegExp(`^${key}[ \\t]*:[ \\t]*(.*)$`, ignoreCase ? "im" : "m").exec(text);
  if (!match) return undefined;
  let value = match[1].trim();
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const end = value.indexOf(quote, 1);
    value = end > 0 ? value.slice(1, end) : value.slice(1);
  } else {
    value = value.replace(/\s+#.*$/, "");
  }
  return cleanValue(value);
}

function hugoBaseUrl(text: string, file: string): string | undefined {
  if (file.endsWith(".json")) return cleanValue(/"baseURL"\s*:\s*"([^"]*)"/i.exec(text)?.[1]);
  if (file.endsWith(".toml")) return cleanValue(/^\s*baseURL\s*=\s*(["'])(.*?)\1/im.exec(text)?.[2]);
  return yamlValue(text, "baseURL", true);
}

function cleanValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && !isTemplated(trimmed) ? trimmed : undefined;
}

function isTemplated(value: string): boolean {
  return /\$\{|process\.env|import\.meta\.env|\{\{|\{%/.test(value);
}

function absoluteUrl(value: string | undefined, basePath?: string): string | undefined {
  let candidate = cleanValue(value);
  if (!candidate) return undefined;
  if (candidate.startsWith("//")) candidate = `https:${candidate}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return undefined;
  const base = normalizeBasePath(basePath);
  if (base && base !== "/") url.pathname = base;
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  url.search = "";
  url.hash = "";
  url.username = "";
  url.password = "";
  return url.href;
}

function normalizeBasePath(value: string | undefined): string | undefined {
  const trimmed = cleanValue(value);
  if (!trimmed || trimmed.startsWith(".") || trimmed.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return undefined;
  }
  const parts = trimmed.split(/[?#]/)[0].split("/").filter(Boolean);
  return parts.length ? `/${parts.join("/")}/` : "/";
}

async function findConfig(root: string, names: string[]): Promise<ConfigFile | undefined> {
  return findFile(
    root,
    names.flatMap((name) => CONFIG_EXTS.map((ext) => `${name}${ext}`)),
  );
}

async function findFile(root: string, names: string[]): Promise<ConfigFile | undefined> {
  for (const file of names) {
    const text = await readText(path.join(root, file));
    if (text !== undefined) return { file, text };
  }
  return undefined;
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function hasTopLevelHtml(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && /\.html?$/i.test(entry.name));
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordKeys(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value) : [];
}

function displayPath(root: string, target: string | undefined): string {
  if (!target) return ".";
  return path.relative(root, target).split(path.sep).join("/") || ".";
}

function formatCommand(command: BuildCommand): string {
  return [command.command, ...command.args].join(" ");
}
