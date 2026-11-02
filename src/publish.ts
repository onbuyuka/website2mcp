import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { buildSiteIndex } from "./build-index.js";
import { parseSiteIndex, publicOnly, writeSiteIndex } from "./index-file.js";
import { detectProject } from "./project.js";
import type { PathRules, SiteIndex } from "./types.js";

export const PUBLISHED_INDEX_PATH = ".well-known/site2mcp.json";

export interface PublishOptions extends PathRules {
  // Public URL of the deployed site, e.g. https://example.com/docs/. Detected from the project when omitted.
  baseUrl?: string;
  render?: boolean;
  maxPages?: number;
  // Path inside the build folder; defaults to .well-known/site2mcp.json.
  output?: string;
  projectRoot?: string;
  log?: (message: string) => void;
}

export interface PublishResult {
  file: string;
  site: SiteIndex;
}

// Indexes a finished build folder and writes the public index into it so it deploys with the site.
export async function publishIndex(outDir: string, options: PublishOptions = {}): Promise<PublishResult> {
  const log = options.log ?? (() => {});
  const baseUrl = options.baseUrl ?? (await detectBaseUrl(options.projectRoot ?? path.dirname(path.resolve(outDir))));
  if (!baseUrl) {
    throw new Error("site2mcp needs the site's public URL. Set the baseUrl option (for example https://example.com/).");
  }
  const file = path.resolve(outDir, options.output ?? PUBLISHED_INDEX_PATH);
  const previous = await readFile(file, "utf8")
    .then((text) => parseSiteIndex(JSON.parse(text), file))
    .catch(() => undefined);
  const site = await buildSiteIndex(outDir, baseUrl, {
    render: options.render,
    maxPages: options.maxPages,
    include: options.include,
    exclude: options.exclude,
    private: options.private,
    previous,
    log,
  });
  const published = publicOnly(site);
  await mkdir(path.dirname(file), { recursive: true });
  await writeSiteIndex(file, published);
  log(`Published ${published.pages.length} pages to ${path.relative(process.cwd(), file) || file}`);
  for (const warning of site.warnings) log(`warning: ${warning}`);
  return { file, site: published };
}

async function detectBaseUrl(root: string): Promise<string | undefined> {
  try {
    return (await detectProject(root)).baseUrl;
  } catch {
    return undefined;
  }
}
