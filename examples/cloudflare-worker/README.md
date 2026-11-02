# site2mcp on Cloudflare Workers

Serves a prebuilt site index as a remote MCP server at `https://<worker>/mcp`. No crawling happens at request time.

```sh
npm install
npm run index      # edit the URL in package.json first, or point it at a build folder
npx wrangler dev   # http://localhost:8787/mcp
npm run deploy
```

Re-run `npm run index` and deploy whenever the site changes (a scheduled GitHub workflow works well).

Pages marked private are only returned to requests with `Authorization: Bearer <token>`, using tokens from the `SITE2MCP_TOKENS` secret.
