import { createFetchHandler } from "site2mcp/handler";
import site from "./site.index.json";

interface Env {
  // Comma-separated bearer tokens that unlock private pages. Set with `wrangler secret put SITE2MCP_TOKENS`.
  SITE2MCP_TOKENS?: string;
}

let handler: ReturnType<typeof createFetchHandler> | undefined;

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    handler ??= createFetchHandler(site as Parameters<typeof createFetchHandler>[0], {
      tokens: env.SITE2MCP_TOKENS?.split(",").map((token) => token.trim()),
    });
    return handler(request);
  },
};
