# website2mcp on Cloudflare Workers

Serves a prebuilt site index as a remote MCP server at `https://<worker>/mcp`. No crawling happens at request time.

The `website2mcp` package is not published to npm yet. Until then, build and pack the repository and install that tarball here instead of the registry dependency.

```sh
npm install
npm run index      # edit the URL in package.json first, or point it at a build folder
npx wrangler dev   # http://localhost:8787/mcp
npm run deploy
```

Re-run `npm run index` and deploy whenever the site changes (a scheduled GitHub workflow works well).

Pages marked private are only returned to requests with `Authorization: Bearer <token>`, using tokens from the `WEBSITE2MCP_TOKENS` secret.
