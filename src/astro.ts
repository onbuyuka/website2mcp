import { fileURLToPath } from "node:url";
import { publishIndex, type PublishOptions } from "./publish.js";

export type Website2McpAstroOptions = Omit<PublishOptions, "projectRoot" | "log"> & {
  strict?: boolean;
};

interface AstroLogger {
  info(message: string): void;
  warn(message: string): void;
}

// Astro integration: after `astro build`, writes .well-known/website2mcp.json into the output folder.
export default function website2mcp(options: Website2McpAstroOptions = {}) {
  let site: string | undefined;
  let base = "/";
  let root: string | undefined;
  return {
    name: "website2mcp",
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
          if (options.strict) throw new Error(`[website2mcp] ${message}`);
          logger.warn(message);
        }
      },
    },
  };
}

export { website2mcp };
