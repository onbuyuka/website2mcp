import { fileURLToPath } from "node:url";
import { publishIndex, type PublishOptions } from "./publish.js";

export type Site2McpAstroOptions = Omit<PublishOptions, "projectRoot" | "log"> & {
  strict?: boolean;
};

interface AstroLogger {
  info(message: string): void;
  warn(message: string): void;
}

// Astro integration: after `astro build`, writes .well-known/site2mcp.json into the output folder.
export default function site2mcp(options: Site2McpAstroOptions = {}) {
  let site: string | undefined;
  let base = "/";
  let root: string | undefined;
  return {
    name: "site2mcp",
    hooks: {
      "astro:config:done": ({ config }: { config: { site?: string; base?: string; root: URL } }) => {
        site = config.site;
        base = config.base ?? "/";
        root = fileURLToPath(config.root);
      },
      "astro:build:done": async ({ dir, logger }: { dir: URL; logger: AstroLogger }) => {
        const baseUrl = options.baseUrl ?? (site ? new URL(base.endsWith("/") ? base : `${base}/`, site).href : undefined);
        try {
          await publishIndex(fileURLToPath(dir), {
            ...options,
            baseUrl,
            projectRoot: root,
            log: (message) => logger.info(message),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (options.strict) throw new Error(`[site2mcp] ${message}`);
          logger.warn(message);
        }
      },
    },
  };
}

export { site2mcp };
