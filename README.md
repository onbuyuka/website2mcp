# website2mcp

Turn any website into an MCP server, so AI assistants (VS Code Copilot, Claude, Cursor, and others) can search and read it.

```sh
npx website2mcp https://docs.example.com     # any public site
npx website2mcp                              # inside your site's project folder
```

It needs no API keys, no vector database, and no LLM. website2mcp builds a local keyword index and exposes it through a handful of read-only tools.

**Release:** [`website2mcp@1.0.0`](https://www.npmjs.com/package/website2mcp) is published on npm. The GitHub Action is available as `onbuyuka/website2mcp@v1`.

## Avoid crawling when you own the site

Crawling is the last resort. website2mcp tries these first:

1. **Source or build output.** When you run it in a project folder, it detects the framework, reads the build output (or Markdown content), and works out the public URL. JavaScript apps are rendered locally with a headless browser. There is no crawl of your live site, although your app's JavaScript may still request external APIs or assets.
2. **A published index.** Owners can ship `/.well-known/website2mcp.json` with their site (one command, or a Vite/Astro plugin, or a GitHub Action). Anyone pointing website2mcp at that site gets the index in one request.
3. **llms.txt.** If the site lists Markdown pages in `llms.txt`, website2mcp reads those instead of crawling HTML.
4. **A polite crawl.** It follows robots.txt and crawl-delay, uses sitemaps, sends an honest user agent, retries on 429/503 with backoff, and uses conditional requests on re-crawls. Results are cached for 6 hours, so restarting your editor doesn't re-crawl.

website2mcp never tries to get around bot protection. If a site refuses automated requests, it tells you so, and points the site owner to options 1 and 2.

## Use it in your AI client

VS Code (`.vscode/mcp.json`):

```json
{
  "servers": {
    "example-docs": { "type": "stdio", "command": "npx", "args": ["-y", "website2mcp", "https://docs.example.com"] }
  }
}
```

Claude Code:

```sh
claude mcp add example-docs -- npx -y website2mcp https://docs.example.com
```

Or run `npx website2mcp init` in your project folder. It writes a `website2mcp.config.json` and prints these snippets for that project.

## Sources

| Source | What happens |
| --- | --- |
| `https://example.com` | Uses the site's published index if there is one; otherwise reads llms.txt or crawls. Single-page apps are rendered. |
| `https://example.com/website2mcp.json` | Loads a published index directly. |
| `.` or `./my-site` | Detects Vite, Next.js (static export), Astro, Docusaurus, VitePress, Hugo, Jekyll, Eleventy, MkDocs, SvelteKit, Gatsby, Nuxt, CRA, and plain HTML. Indexes the build output, or the Markdown when there is no build. |
| `./dist` | Indexes a build folder. Hash-router and history-router apps both work. |
| `site.index.json` | Serves a saved index. |

Run `npx website2mcp inspect [source]` to see what gets indexed, what was skipped, and why.

For local projects, pass `--build` to run the project's build command first, and `--watch` to re-index when files change. If the public URL can't be detected (from `homepage`, the framework config, `CNAME`, or a GitHub Pages remote), pass `--base-url https://example.com/`.

## Tools

| Tool | Purpose |
| --- | --- |
| `search` | Ranked keyword search with snippets. It can be filtered by path prefix or content kind (html, pdf, markdown). |
| `fetch` | A page's text as Markdown, paged with `offset`/`maxLength` for long documents. Accepts an id, a URL, or a path. |
| `list_pages` | Browse pages with a cursor, optionally under a path prefix. |
| `site_info` | Site name, sections, content kinds, structured data types, and index freshness. |
| `query_items` | Structured data found on pages (JSON-LD such as products, events, FAQs, recipes, articles, plus HTML tables). |

PDFs and Markdown files linked from the site are indexed too.

## For site owners: publish an index

Shipping an index with your site makes website2mcp fast for everyone and means nobody needs to crawl you.

```sh
npx website2mcp build ./dist --publish          # writes dist/.well-known/website2mcp.json
```

Private pages are never written to the published file. Re-running on an unchanged build reuses the previous index.

**Vite**

```js
// vite.config.js
import website2mcp from "website2mcp/vite";
export default { plugins: [website2mcp()] };
```

**Astro**

```js
// astro.config.mjs
import website2mcp from "website2mcp/astro";
export default { site: "https://example.com", integrations: [website2mcp()] };
```

Both plugins accept `baseUrl`, `include`, `exclude`, `private`, `render`, `maxPages`, and `strict` (fail the build on errors instead of warning).

**GitHub Action**

```yaml
- run: npm run build
- uses: onbuyuka/website2mcp@v1
  with:
    directory: dist
    base-url: https://example.com/
```

## Host a remote MCP server

```sh
npx website2mcp https://docs.example.com --http --port 3000
# MCP endpoint: http://127.0.0.1:3000/mcp
```

The endpoint is stateless Streamable HTTP. It also serves `/healthz` and `/.well-known/mcp.json`. Crawled sites are refreshed in the background every cache period.

- **Docker:** `docker build -t website2mcp .` then `docker run -p 3000:3000 website2mcp https://docs.example.com`. Add `--build-arg WITH_BROWSER=true` for sites that need JavaScript rendering.
- **Cloudflare Workers:** `createFetchHandler` from `website2mcp/handler` serves a prebuilt index without crawling at request time. The example uses `nodejs_compat` and is tested in the local Workers runtime. See [examples/cloudflare-worker](examples/cloudflare-worker). Other runtimes need compatible Node built-ins; Deno and Bun have not been verified.

When bound to localhost, the server rejects requests whose `Host` header isn't local, to block DNS-rebinding attacks.

## Private content

Mark pages private with `--private "/internal/**"`, a `"private"` list in the config, or `<meta name="website2mcp" content="private">` on the page. Pages crawled with credentials (`-H "Authorization: Bearer ${env:TOKEN}"`) are private by default.

- Over **stdio** (your own machine), private pages are visible.
- Over **HTTP**, anonymous clients see public pages only. Clients with a valid token (`--token`, or `WEBSITE2MCP_TOKENS=a,b`) see everything. Add `--require-auth` to reject anonymous clients entirely.
- Published indexes never contain private pages.
- Path/privacy rules also apply when serving saved or published indexes. Credentialed crawl caches are separated by header values, so changing accounts cannot reuse another account's content.

Saved (unpublished) indexes and local caches can contain private text. Keep them out of source control and serve remote endpoints over HTTPS using your hosting platform or reverse proxy.

## Actions (owner-approved)

Site owners can expose specific forms or API calls as tools, such as "contact sales" or "check order status". Draft them from an existing form:

```sh
npx website2mcp actions suggest https://example.com/contact
```

If you have an OpenAPI description, import from a local JSON/YAML file or a URL instead of discovering forms:

```sh
npx website2mcp actions import ./openapi.yaml
npx website2mcp actions import https://example.com/openapi.json
npx website2mcp actions import ./openapi.yaml --base-url https://api.example.com/v1 > actions.draft.json
```

This prints `{"actions":[...]}` to stdout and review notes/skipped operations to stderr. It never calls the API operations, edits your configuration, or enables actions. Review the draft, then copy only the actions you want. If the API uses a different origin from your website, explicitly add it to `allowedActionOrigins`; importing does not grant that permission.

The importer supports OpenAPI **3.0/3.1**, local `$ref`s, scalar path/query parameters, and flat JSON or URL-encoded bodies. It uses operation/path/document servers in that order (the first server at that level); relative servers resolve against the description URL. Use `--base-url` to select another server, or for local files without an absolute server URL.

Bearer and header API-key schemes become `${env:WEBSITE2MCP_<SCHEME_NAME>}` header placeholders; set those environment variables on the MCP server yourself. Credential examples and sensitive input defaults are not copied. Every draft has `confirm: true`; non-GET operations are conservatively marked destructive.

Unsupported operations are skipped with a reason, not partially imported: Swagger 2, external/circular references, complex or nullable schemas, mixed query+body inputs, dynamic header/cookie parameters, multipart uploads, boolean form fields, and OAuth/basic/query-key authentication need manual configuration or a compatible API endpoint. When an operation lists several authentication options, anonymous access is used if allowed; otherwise the first supported option is used and the others are reported. Additional numeric/string constraints remain the API's responsibility and are reported. Importing does not discover APIs that have no description. Input documents are limited to 5 MiB.

Then add them to `website2mcp.config.json`:

```json
{
  "actions": [
    {
      "name": "contact_sales",
      "description": "Send a message to the sales team.",
      "method": "POST",
      "url": "https://example.com/api/contact",
      "bodyType": "json",
      "input": {
        "email": { "type": "string", "format": "email", "required": true },
        "message": { "type": "string", "required": true }
      }
    }
  ]
}
```

Confirmation is required by default, unless the owner sets `"confirm": false`:

- Passing `confirmed: false` always returns a preview without sending a request or opening an approval form, even when confirmation is disabled.
- Otherwise, clients supporting MCP form elicitation are asked "Send this request?" with a default of no. Execution requires an accepted form with `approved: true`; an empty, negative, invalid, cancelled, or failed response never sends the request. Passing `confirmed: true` does not bypass this form.
- Clients without form elicitation receive a preview and must call again with `confirmed: true` after user approval.

Approval depends on the client faithfully collecting the user's choice. In particular, the `confirmed: true` fallback is a client assertion, not server-enforced user authorization. A client's general tool-permission prompt is separate from website2mcp's action confirmation. Protect sensitive endpoints with authentication and server-side authorization.

Requests can only go to the site's own origin (or origins listed in `allowedActionOrigins`). Header values can use `${env:NAME}`, so secrets stay out of the config file. Responses are cut off after 20,000 characters; set `"maxResponseChars"` (up to 200,000) on an action that returns more.

## Analytics

```sh
npx website2mcp https://docs.example.com --analytics usage.jsonl
npx website2mcp stats usage.jsonl --since 7d
```

`stats` summarizes:
- tool calls, errors, and clients
- top searches, and searches that found nothing (your content gaps)
- the most-fetched pages
- latency

Add `--redact-queries` to store a hash instead of the search text.

## Config file

`website2mcp.config.json` is picked up from the current folder (or pass `--config`). CLI flags override it.

```json
{
  "source": "https://docs.example.com",
  "name": "Example Docs",
  "maxPages": 500,
  "include": ["/docs/**"],
  "exclude": ["/docs/archive/**"],
  "private": ["/docs/internal/**"],
  "headers": { "Authorization": "Bearer ${env:DOCS_TOKEN}" },
  "cacheTtl": "6h",
  "http": { "port": 3000, "tokens": ["${env:WEBSITE2MCP_TOKEN}"] },
  "analytics": { "file": "usage.jsonl", "redactQueries": true },
  "actions": []
}
```

Other keys:
- `baseUrl`, `outDir`, `build`, `render`
- `maxDepth`, `concurrency`
- `userAgent`
- `published`, `llmsTxt`
- `cache`, `includeDrafts`
- `allowedActionOrigins`

Path patterns use globs: `*` matches within one path segment and `**` across segments. They match the full path or the path relative to the site's base URL. Hash routes such as `/#/team/**` work.

Run `npx website2mcp --help` for every flag.

## Library

```ts
import { crawlSite, buildSiteIndex, createSiteMcpServer, createFetchHandler, startHttpServer } from "website2mcp";

const site = await crawlSite("https://docs.example.com", { maxPages: 200 });
const server = await startHttpServer(createFetchHandler(site), { port: 3000 });
console.log(`${server.url}/mcp`);
```

## Limits

- The search is keyword search (BM25 with fuzzy and prefix matching), not semantic search.
- Crawls default to 100 pages and local builds to 500. Raise this with `--max-pages`, up to 5000.
- Rendering JavaScript sites needs Edge, Chrome, or `npx playwright install chromium`. Without a browser, website2mcp indexes the static HTML and warns you.
- Only `http`/`https` URLs are supported. Requests to private network addresses are blocked unless the source itself is local.
- Project detection does not turn arbitrary application source code into pages. Server-rendered apps need a static export, Markdown content, or a running server URL (including a local development server).
- Rendering follows anchor links, including hash and history routes. Button-only navigation, login flows, interactive state, external data APIs, and image-only PDFs may need owner-provided content or additional configuration.
- No crawler can guarantee access to every website. A published index or local source/build avoids crawling; otherwise access restrictions and robots.txt still apply.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

Requires Node.js 22 or newer.

### Reproducible verification

```sh
npm run verify -- --report verification.json
# Optional checks against public sites, actual framework builds, and the Workers runtime:
npm run verify -- --live --frameworks --worker --report verification.json
# Also verify an existing owner project without changing its files:
npm run verify -- --site-project ../my-site --report verification.json
```

The verifier builds and packs the package, installs the tarball into an isolated consumer, and exercises the installed CLI and MCP transports. It checks local HTML/Markdown/PDF, structured search, incremental updates, privacy, action confirmation, analytics, publishing, browser rendering, watch updates, and authenticated reloads. A browser (Edge, Chrome, or Playwright Chromium) is required; rendering checks fail rather than silently skip.

The JSON report retains source/package hashes, commands and output, durations, assertions, and failures. Temporary fixtures and servers are removed. `--live` makes a bounded crawl of three public websites; `--frameworks` installs Vite/Astro into the temporary consumer and runs actual builds; `--worker` installs Wrangler into a temporary copy of the example and checks both its bundle and local runtime. These optional checks need network access.

CI is configured to run unit and installed-package checks on Windows and Linux and upload the JSON reports. Local verification does not deploy anything, publish to npm, or test the Docker image; Docker and hosted deployment still need their respective environments.

## License

MIT
