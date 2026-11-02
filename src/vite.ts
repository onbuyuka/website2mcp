import path from "node:path";
import { publishIndex, type PublishOptions } from "./publish.js";

export type Site2McpViteOptions = Omit<PublishOptions, "projectRoot" | "log"> & {
  // Fail the build when indexing fails (default: only warn).
  strict?: boolean;
};

interface ViteResolvedConfig {
  root: string;
  base: string;
  command: "build" | "serve";
  build: { outDir: string; ssr?: boolean | string };
  logger: { info(message: string): void; warn(message: string): void };
}

// Vite plugin: after `vite build`, writes dist/.well-known/site2mcp.json so the deployed site carries its own index.
export default function site2mcp(options: Site2McpViteOptions = {}) {
  let config: ViteResolvedConfig | undefined;
  return {
    name: "site2mcp",
    apply: "build" as const,
    configResolved(resolved: ViteResolvedConfig) {
      config = resolved;
    },
    async closeBundle() {
      if (!config || config.build.ssr) return;
      const outDir = path.resolve(config.root, config.build.outDir);
      const baseUrl = options.baseUrl ?? (/^https?:\/\//i.test(config.base) ? config.base : undefined);
      try {
        await publishIndex(outDir, {
          ...options,
          baseUrl,
          projectRoot: config.root,
          log: (message) => config?.logger.info(`[site2mcp] ${message}`),
        });
      } catch (error) {
        const message = `[site2mcp] ${error instanceof Error ? error.message : String(error)}`;
        if (options.strict) throw new Error(message);
        config.logger.warn(message);
      }
    },
  };
}

export { site2mcp };
