import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({
  options: {
    report: { type: "string", default: "verification.json" },
    live: { type: "boolean", default: false },
    worker: { type: "boolean", default: false },
    frameworks: { type: "boolean", default: false },
    "site-project": { type: "string" },
  },
});
const reportFile = path.resolve(values.report);
const report = { startedAt: new Date().toISOString(), node: process.version, platform: process.platform, checks: [], commands: [] };
const temp = await mkdtemp(path.join(os.tmpdir(), "site2mcp-verify-"));
const consumer = path.join(temp, "consumer");
const env = {
  ...process.env,
  SITE2MCP_CACHE_DIR: path.join(temp, "cache"),
  SITE2MCP_TOKENS: "",
  WRANGLER_SEND_METRICS: "false",
  ASTRO_TELEMETRY_DISABLED: "1",
};
const cleanups = [];
const html = (title, body, head = "") =>
  `<!doctype html><html><head><title>${title}</title>${head}</head><body><main><h1>${title}</h1>${body}</main></body></html>`;

async function command(executable, args, cwd = root) {
  const started = Date.now();
  const entry = { executable, args, cwd };
  report.commands.push(entry);
  try {
    const result = await exec(executable, args, { cwd, env, timeout: 240_000, maxBuffer: 8 * 1024 * 1024 });
    Object.assign(entry, { exitCode: 0, durationMs: Date.now() - started, ...result });
    return result.stdout.trim();
  } catch (error) {
    Object.assign(entry, { exitCode: error.code, durationMs: Date.now() - started, stdout: error.stdout, stderr: error.stderr });
    throw error;
  }
}

function npm(args, cwd = root) {
  assert.ok(process.env.npm_execpath, "Run this script with npm run verify.");
  return command(process.execPath, [process.env.npm_execpath, ...args], cwd);
}

async function check(name, run) {
  const started = Date.now();
  try {
    const details = await run();
    report.checks.push({ name, status: "passed", durationMs: Date.now() - started, details });
    console.log(`PASS ${name}`);
    return details;
  } catch (error) {
    report.checks.push({ name, status: "failed", durationMs: Date.now() - started, error: error.stack });
    throw error;
  }
}

async function save(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof content === "string" || Buffer.isBuffer(content) ? content : JSON.stringify(content));
}

async function waitFor(probe, description) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function sourceDigest() {
  const hash = createHash("sha256");
  async function add(relative) {
    const full = path.join(root, relative);
    for (const entry of (await readdir(full, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) await add(file);
      else hash.update(file).update(await readFile(path.join(root, file)));
    }
  }
  for (const dir of ["src", "test", "scripts"]) await add(dir);
  for (const file of ["package.json", "package-lock.json", "tsconfig.json", "tsup.config.ts"]) {
    hash.update(file).update(await readFile(path.join(root, file)));
  }
  return hash.digest("hex");
}

function pdf() {
  const text = "BT /F1 24 Tf 72 720 Td (Annual revenue grew 25 percent) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let content = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(content.length);
    content += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = content.length;
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) content += `${String(offset).padStart(10, "0")} 00000 n \n`;
  content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(content, "latin1");
}

async function main() {
  report.sourceSha256 = await sourceDigest();
  await check("production build", () => npm(["run", "build"]));
  await mkdir(consumer);
  await save(path.join(consumer, "package.json"), { name: "site2mcp-verification-consumer", private: true, type: "module" });
  let tarball;
  await check("pack, clean install, and executable", async () => {
    const [packed] = JSON.parse(await npm(["pack", "--json", "--pack-destination", temp]));
    tarball = path.join(temp, packed.filename);
    report.package = { version: packed.version, integrity: packed.integrity, files: packed.files.map((file) => file.path) };
    assert.ok(packed.files.every((file) => !/^(src|test|node_modules)\//.test(file.path)));
    await npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], consumer);
    assert.equal(await npm(["exec", "--offline", "--", "site2mcp", "--version"], consumer), packed.version);
    return { version: packed.version, integrity: packed.integrity, files: packed.files.length };
  });
  const loader = path.join(consumer, "loader.mjs");
  await save(loader, "export const load = (name) => import(name);\n");
  const { load } = await import(pathToFileURL(loader).href);
  const api = await load("site2mcp");
  const { Client } = await load("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await load("@modelcontextprotocol/sdk/client/stdio.js");
  const { StreamableHTTPClientTransport } = await load("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const cliFile = path.join(consumer, "node_modules", "site2mcp", "dist", "cli.js");
  const cli = (args, cwd = consumer) => command(process.execPath, [cliFile, ...args], cwd);
  const call = async (client, name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return result.structuredContent;
  };
  async function stdio(args, run) {
    const transport = new StdioClientTransport({ command: process.execPath, args: [cliFile, ...args], cwd: consumer, env, stderr: "pipe" });
    const client = new Client({ name: "verification-stdio", version: "1.0" });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => { stderr += chunk; });
    try {
      await client.connect(transport);
      return await run(client);
    } finally {
      await client.close();
      report.commands.push({ transport: "stdio", args, stderr });
    }
  }
  async function http(endpoint, token, run) {
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      ...(token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : {}),
    });
    const client = new Client({ name: "verification-http", version: "1.0" });
    try {
      await client.connect(transport);
      return await run(client);
    } finally {
      await client.close();
    }
  }

  const project = path.join(temp, "static-project");
  const out = path.join(project, "dist");
  const indexFile = path.join(temp, "full.index.json");
  const hits = [];
  const actionsReceived = [];
  const openApiSpec = {
    openapi: "3.1.0", servers: [{ url: "/docs" }],
    paths: { "/api/contact": { post: {
      operationId: "contact", summary: "Send a test contact request",
      requestBody: {
        required: true,
        content: { "application/json": { schema: {
          type: "object", properties: { message: { type: "string" } }, required: ["message"],
        } } },
      },
    } } },
  };
  let published;
  let guideVersion = 1;
  const home = html("Acme docs", '<p>Welcome to the Acme website documentation.</p><a href="guide/">Guide</a><a href="report.pdf">Report</a><a href="secret/">Internal</a>');
  const guide = html("Installation guide", "<p>Install the Acme widget using the installation guide.</p>", '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Acme widget","sku":"W-1"}</script>');
  const secret = html("Internal roadmap", "<p>Confidential roadmap for the next product launch.</p>", '<meta name="site2mcp" content="private">');
  const app = '<!doctype html><html><head><title>Browser app</title></head><body><div id="root"></div><script src="app.js"></script></body></html>';
  const appScript = `function render() {
    const detail = location.hash === "#/detail" || location.pathname.endsWith("/detail");
    document.getElementById("root").innerHTML = detail
      ? '<main><h1>Rendered detail</h1><p>Browser execution loaded this detailed content.</p></main>'
      : '<main><h1>Rendered home</h1><p>The app was rendered by a real browser.</p><a href="#/detail">Hash route</a><a href="detail">History route</a></main>';
  } render(); addEventListener("hashchange", render);`;
  const fixture = await api.startHttpServer(async (request) => {
    const url = new URL(request.url);
    hits.push({ path: url.pathname, conditional: request.headers.get("if-none-match") });
    if (url.pathname === "/docs/openapi.json") return Response.json(openApiSpec);
    if (url.pathname === "/docs/.well-known/site2mcp.json" && published) return Response.json(published);
    if (url.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /blocked/\n");
    if (url.pathname === "/llms/llms.txt") return new Response("# Markdown docs\n> Owner-provided content\n\n[A](a.md)\n[B](b.md)\n[C](c.md)");
    if (/^\/llms\/[abc]\.md$/.test(url.pathname)) {
      return new Response(`# Topic ${url.pathname}\n\nMarkdown-first owner content for ${url.pathname}.`, { headers: { "content-type": "text/markdown" } });
    }
    if (url.pathname === "/denied/") return new Response("Automated access denied", { status: 403 });
    if (url.pathname === "/docs/api/contact" && request.method === "POST") {
      actionsReceived.push(await request.json());
      return Response.json({ accepted: true });
    }
    if (url.pathname === "/spa/app.js") return new Response(appScript, { headers: { "content-type": "text/javascript" } });
    if (url.pathname === "/spa/" || url.pathname === "/spa/detail") return new Response(app, { headers: { "content-type": "text/html" } });
    if (url.pathname === "/docs/report.pdf") return new Response(pdf(), { headers: { "content-type": "application/pdf" } });
    const pages = { "/docs/": home, "/docs/guide/": guide.replace("Installation guide", `Installation guide ${guideVersion}`), "/docs/secret/": secret };
    if (pages[url.pathname]) {
      const etag = `"${url.pathname === "/docs/guide/" ? guideVersion : 1}"`;
      if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
      return new Response(pages[url.pathname], { headers: { "content-type": "text/html", etag } });
    }
    return new Response("Not found", { status: 404 });
  }, { port: 0 });
  cleanups.push(() => fixture.close());
  const baseUrl = `${fixture.url}/docs/`;
  await save(path.join(project, "package.json"), { homepage: baseUrl, scripts: { build: "vite build" }, devDependencies: { vite: "*" } });
  await save(path.join(out, "index.html"), home);
  await save(path.join(out, "guide", "index.html"), guide);
  await save(path.join(out, "secret", "index.html"), secret);
  await save(path.join(out, "report.pdf"), pdf());

  let localSite;
  let importedActions;
  await check("zero-config project, PDF, structured data, and incremental build", async () => {
    const inspect = JSON.parse(await cli(["inspect", project, "--json", "--no-cache"]));
    assert.equal(inspect.pageCount, 4);
    assert.equal(inspect.privatePages, 1);
    assert.equal(inspect.kinds.pdf, 1);
    assert.equal(inspect.itemTypes.Product, 1);
    await cli(["build", project, "--output", indexFile]);
    localSite = await api.readSiteIndex(indexFile);
    assert.match(localSite.pages.find((page) => page.kind === "pdf").text, /Annual revenue grew 25 percent/);
    await cli(["build", project, "--output", indexFile]);
    assert.equal((await api.readSiteIndex(indexFile)).diagnostics.reusedPages, 4);
    await save(path.join(out, "guide", "index.html"), guide.replaceAll("Acme widget", "Acme upgraded widget"));
    await cli(["build", project, "--output", indexFile]);
    localSite = await api.readSiteIndex(indexFile);
    assert.equal(localSite.diagnostics.reusedPages, 0);
    assert.match(localSite.pages.find((page) => page.id.endsWith("/guide/")).text, /upgraded widget/);
    return inspect;
  });
  await check("Markdown source without a build or live website", async () => {
    const source = path.join(temp, "markdown-project");
    await save(path.join(source, "docs", "intro.md"), "---\ntitle: Source introduction\n---\n\nRead source files without crawling.");
    await save(path.join(source, "docs", "draft.md"), "---\ndraft: true\n---\n\nUnpublished draft.");
    const inspect = JSON.parse(await cli(["inspect", source, "--base-url", "https://source.example/", "--json"]));
    assert.equal(inspect.pageCount, 1);
    assert.equal(inspect.mode, "source");
    assert.equal(inspect.kinds.markdown, 1);
    return inspect;
  });
  const analyticsFile = path.join(temp, "usage.jsonl");
  await check("installed stdio MCP: all tools, pagination, private content, analytics", async () => {
    return stdio([indexFile, "--analytics", analyticsFile], async (client) => {
      const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
      assert.deepEqual(tools, ["fetch", "list_pages", "query_items", "search", "site_info"]);
      assert.equal((await call(client, "search", { query: "installation" })).results[0].id, "/docs/guide/");
      assert.match((await call(client, "fetch", { id: "/" })).text, /Acme/);
      assert.match((await call(client, "fetch", { id: "secret/" })).text, /Confidential/);
      const first = await call(client, "list_pages", { limit: 2 });
      const next = await call(client, "list_pages", { limit: 2, cursor: first.nextCursor });
      assert.equal(first.pages.length + next.pages.length, 4);
      assert.equal((await call(client, "query_items", { type: "Product" })).total, 1);
      assert.equal((await call(client, "search", { query: "unfindablezzzzzz" })).results.length, 0);
      assert.equal((await call(client, "site_info")).pageCount, 4);
      return { tools, pages: 4, pagination: true, privateVisible: true };
    });
  });
  await check("analytics persisted and stats CLI", async () => {
    const { events, invalidLines } = await api.readAnalytics(analyticsFile);
    assert.equal(invalidLines, 0);
    assert.ok(events.length >= 8);
    const summary = api.summarizeAnalytics(events);
    assert.ok(summary.zeroResultQueries.some((entry) => entry.query === "unfindablezzzzzz"));
    assert.equal(summary.errorCalls, 0);
    const stats = await cli(["stats", analyticsFile]);
    assert.match(stats, /unfindablezzzzzz/);
    return summary;
  });
  await check("OpenAPI: installed CLI imports JSON/YAML files and URL without invoking operations", async () => {
    const jsonFile = path.join(temp, "openapi.json");
    const yamlFile = path.join(temp, "openapi.yaml");
    await save(jsonFile, openApiSpec);
    await save(yamlFile, `openapi: 3.0.3
paths:
  /api/contact:
    post:
      operationId: contact
      summary: Send a test contact request
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                message:
                  type: string
              required: [message]
`);
    const remote = JSON.parse(await cli(["actions", "import", `${baseUrl}openapi.json`]));
    const local = JSON.parse(await cli(["actions", "import", jsonFile, "--base-url", baseUrl]));
    const yaml = JSON.parse(await cli(["actions", "import", yamlFile, "--base-url", baseUrl]));
    assert.deepEqual(remote, local);
    assert.deepEqual(yaml, local);
    importedActions = api.validateActions(remote.actions, baseUrl);
    assert.equal(importedActions.length, 1);
    assert.equal(importedActions[0].confirm, true);
    assert.equal(importedActions[0].url, `${baseUrl}api/contact`);
    assert.equal(actionsReceived.length, 0);
    const library = api.importOpenApiActions(api.parseOpenApiDocument(await readFile(yamlFile, "utf8")), { baseUrl });
    assert.deepEqual(library.actions, importedActions);
    await assert.rejects(cli(["actions", "import", jsonFile]), /Nothing imported/);
    return { formats: ["json", "yaml"], sources: ["file", "url"], drafts: importedActions.length, requestsSent: 0 };
  });
  await check("real HTTP MCP: anonymous, bearer, auth-required, imported actions", async () => {
    const analytics = api.createMemoryAnalytics();
    const actions = importedActions;
    const server = await api.startHttpServer(api.createFetchHandler(localSite, {
      tokens: ["verification-token"], actions, analytics, actionOptions: { allowPrivateHosts: true },
    }), { port: 0 });
    try {
      assert.equal((await fetch(`${server.url}/healthz`)).status, 200);
      const discovery = await (await fetch(`${server.url}/.well-known/mcp.json`)).json();
      assert.equal(discovery.transport, "streamable-http");
      for (const token of [undefined, "wrong"]) {
        await http(`${server.url}/mcp`, token, async (client) => {
          assert.equal((await call(client, "list_pages")).total, 3);
          assert.equal((await call(client, "search", { query: "Confidential" })).results.length, 0);
          assert.equal((await client.callTool({ name: "fetch", arguments: { id: "secret/" } })).isError, true);
        });
      }
      await http(`${server.url}/mcp`, "verification-token", async (client) => {
        assert.equal((await call(client, "list_pages")).total, 4);
        const preview = await client.callTool({ name: "action_contact", arguments: { message: "verification only", confirmed: false } });
        assert.match(JSON.stringify(preview), /confirm/i);
        assert.equal(actionsReceived.length, 0);
        const result = await call(client, "action_contact", { message: "verification only", confirmed: true });
        assert.equal(result.status, 200);
        assert.deepEqual(actionsReceived, [{ message: "verification only" }]);
      });
      const required = api.createFetchHandler(localSite, { tokens: ["verification-token"], requireAuth: true });
      assert.equal((await required(new Request(`${server.url}/mcp`, { method: "POST" }))).status, 401);
      assert.ok(analytics.events.some((event) => event.tool === "action_contact" && event.ok));
      return { anonymousPages: 3, authenticatedPages: 4, unauthorizedStatus: 401, actionRequests: actionsReceived.length };
    } finally {
      await server.close();
    }
  });
  await check("CLI HTTP readiness, watch updates, and authenticated reload", async () => {
    const args = [cliFile, project, "--http", "--port", "0", "--watch", "--no-cache", "--token", "verification-token"];
    const child = spawn(process.execPath, args, { cwd: consumer, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let startupError;
    child.on("error", (error) => { startupError = error; });
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const closed = new Promise((resolve) => child.once("close", resolve));
    try {
      const endpoint = await waitFor(() => {
        if (startupError) throw startupError;
        assert.equal(child.exitCode, null, output);
        return /MCP endpoint: (http:\/\/[^\s]+)/.exec(output)?.[1];
      }, "CLI HTTP endpoint");
      const serverUrl = new URL("/", endpoint).href;
      await waitFor(async () => {
        const health = await (await fetch(`${serverUrl}healthz`)).json();
        return health.pages === 4 && !health.loading;
      }, "CLI ready index");
      await save(path.join(out, "guide", "index.html"), guide.replaceAll("Acme widget", "Acme watched widget"));
      await waitFor(() => output.includes("Re-indexed after a change"), "watch-triggered reload");
      await http(endpoint, undefined, async (client) => {
        const fetched = await call(client, "fetch", { id: "guide/" });
        assert.match(fetched.text, /watched widget/);
      });
      assert.equal((await fetch(`${serverUrl}admin/reload`, { method: "POST" })).status, 401);
      const reloaded = await fetch(`${serverUrl}admin/reload`, { method: "POST", headers: { authorization: "Bearer verification-token" } });
      assert.equal(reloaded.status, 200);
      assert.equal((await reloaded.json()).pages, 4);
      return { pages: 4, watchUpdatedContent: true, unauthorizedReload: 401, authorizedReload: 200 };
    } finally {
      child.kill();
      await closed;
      report.commands.push({ transport: "http-cli", args: args.slice(1), output });
    }
  });
  await check("polite crawling and HTTP conditional refresh", async () => {
    const options = { allowPrivateHosts: true, usePublishedIndex: false, delayMs: 0 };
    const first = await api.crawlSite(baseUrl, options);
    assert.equal(first.pages.length, 4);
    guideVersion = 2;
    const next = await api.crawlSite(baseUrl, { ...options, previous: first });
    assert.equal(next.diagnostics.reusedPages, 2);
    assert.match(next.pages.find((page) => page.id === "/docs/guide/").title, /2/);
    assert.equal(next.pages.find((page) => page.id === "/docs/secret/").visibility, "private");
    const denied = await api.crawlSite(`${fixture.url}/blocked/`, options);
    assert.equal(denied.pages.length, 0);
    assert.ok(denied.diagnostics.skipped.some((page) => page.reason.includes("robots.txt")));
    assert.ok(!hits.some((hit) => hit.path === "/blocked/"));
    await assert.rejects(api.crawlSite(`${fixture.url}/denied/`, options), /refused automated requests.*source/);
    return { pages: first.pages.length, unchangedReused: next.diagnostics.reusedPages, robotsRespected: true, blockedHint: true };
  });
  await check("llms.txt bypasses HTML crawling", async () => {
    hits.length = 0;
    const site = await api.crawlSite(`${fixture.url}/llms/`, { allowPrivateHosts: true, delayMs: 0 });
    assert.equal(site.pages.length, 3);
    assert.ok(site.pages.every((page) => page.kind === "markdown"));
    assert.ok(!hits.some((hit) => hit.path === "/llms/"));
    return { pages: site.pages.length, requests: [...hits] };
  });
  await check("publish, discover in one request, and enforce private filters", async () => {
    await cli(["build", project, "--publish"]);
    published = await api.readSiteIndex(path.join(out, ".well-known", "site2mcp.json"));
    assert.equal(published.pages.length, 3);
    assert.ok(!JSON.stringify(published).includes("Confidential"));
    assert.ok(!JSON.stringify(published).includes("sourceFile"));
    hits.length = 0;
    const inspect = JSON.parse(await cli(["inspect", baseUrl, "--json", "--no-cache"]));
    assert.equal(inspect.mode, "published");
    assert.equal(inspect.pageCount, 3);
    assert.deepEqual(hits.map((hit) => hit.path), ["/docs/.well-known/site2mcp.json"]);
    const filtered = JSON.parse(await cli(["inspect", baseUrl, "--private", "/guide/**", "--max-pages", "2", "--json", "--no-cache"]));
    assert.equal(filtered.pageCount, 2);
    assert.equal(filtered.privatePages, 1);
    return { pages: inspect.pageCount, requestsForDiscovery: 1, privateRemoved: true };
  });
  await check("real browser: automatic local and live SPA rendering", async () => {
    const appDir = path.join(temp, "spa");
    await save(path.join(appDir, "index.html"), app);
    await save(path.join(appDir, "app.js"), appScript);
    const local = JSON.parse(await cli(["inspect", appDir, "--base-url", `${fixture.url}/spa/`, "--json", "--no-cache"]));
    const live = JSON.parse(await cli(["inspect", `${fixture.url}/spa/`, "--json", "--no-cache"]));
    for (const result of [local, live]) {
      assert.equal(result.rendered, true);
      assert.equal(result.pageCount, 2);
      assert.equal(result.warnings.length, 0);
      assert.ok(result.pages.some((page) => /Rendered detail/.test(page.title)));
    }
    return { local, live };
  });
  await check("installed framework plugin exports", async () => {
    const { default: vite } = await load("site2mcp/vite");
    const { default: astro } = await load("site2mcp/astro");
    const logger = { info() {}, warn(message) { throw new Error(message); } };
    const plugin = vite({ baseUrl, render: false, strict: true });
    plugin.configResolved({ root: project, base: "/", command: "build", build: { outDir: "dist" }, logger });
    await plugin.closeBundle();
    assert.equal((await api.readSiteIndex(path.join(out, ".well-known", "site2mcp.json"))).pages.length, 3);
    const integration = astro({ render: false, strict: true });
    integration.hooks["astro:config:done"]({ config: { root: pathToFileURL(`${project}${path.sep}`), site: fixture.url, base: "/docs" } });
    await integration.hooks["astro:build:done"]({ dir: pathToFileURL(`${out}${path.sep}`), logger });
    assert.equal((await api.readSiteIndex(path.join(out, ".well-known", "site2mcp.json"))).pages.length, 3);
    assert.equal(typeof (await load("site2mcp/handler")).createFetchHandler, "function");
    return { vite: true, astro: true, fetchHandler: true };
  });

  if (values.frameworks) {
    await check("real Vite and Astro builds publish usable indexes", async () => {
      const manifestFile = path.join(consumer, "package.json");
      const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
      manifest.devDependencies = { vite: "^6.2.0", astro: "^5.0.0" };
      await save(manifestFile, manifest);
      await npm(["install", "--no-audit", "--no-fund"], consumer);

      const viteDir = path.join(consumer, "vite-fixture");
      await save(path.join(viteDir, "package.json"), { type: "module", homepage: "https://fixture.example/docs/", devDependencies: { vite: "^6.2.0" } });
      await save(path.join(viteDir, "index.html"), app.replace('src="app.js"', 'type="module" src="/app.js"'));
      await save(path.join(viteDir, "app.js"), appScript);
      await save(path.join(viteDir, "secret.html"), secret);
      await save(path.join(viteDir, "vite.config.mjs"), `
import site2mcp from "site2mcp/vite";
export default {
  base: "/docs/",
  plugins: [site2mcp({ strict: true })],
  build: { rollupOptions: { input: { main: "index.html", secret: "secret.html" } } },
};
`);
      await npm(["exec", "--offline", "--", "vite", "build"], viteDir);
      const viteIndex = await api.readSiteIndex(path.join(viteDir, "dist", ".well-known", "site2mcp.json"));
      assert.equal(viteIndex.pages.length, 2);
      assert.equal(viteIndex.url, "https://fixture.example/docs/");
      assert.ok(viteIndex.pages.some((page) => page.text.includes("Browser execution loaded")));
      assert.ok(!JSON.stringify(viteIndex).includes("Confidential"));

      const astroDir = path.join(consumer, "astro-fixture");
      await save(path.join(astroDir, "package.json"), { type: "module", dependencies: { astro: "^5.0.0" } });
      await save(path.join(astroDir, "astro.config.mjs"), `
import site2mcp from "site2mcp/astro";
export default { site: "https://astro.example", base: "/docs", integrations: [site2mcp({ strict: true })] };
`);
      await save(path.join(astroDir, "src", "pages", "index.astro"), home);
      await save(path.join(astroDir, "src", "pages", "guide.md"), "---\ntitle: Astro guide\n---\n\n# Astro guide\n\nBuild and publish an Astro documentation site.");
      await save(path.join(astroDir, "src", "pages", "secret.astro"), secret);
      await npm(["exec", "--offline", "--", "astro", "build"], astroDir);
      const astroIndex = await api.readSiteIndex(path.join(astroDir, "dist", ".well-known", "site2mcp.json"));
      assert.equal(astroIndex.pages.length, 2);
      assert.equal(astroIndex.url, "https://astro.example/docs/");
      assert.ok(astroIndex.pages.some((page) => page.text.includes("Astro documentation")));
      assert.ok(!JSON.stringify(astroIndex).includes("Confidential"));
      return { vitePages: 2, astroPages: 2, renderedViteContent: true, privateRemoved: true };
    });
  }

  if (values["site-project"]) {
    await check("real owner project: automatic indexing and stdio search/fetch", async () => {
      const siteProject = path.resolve(values["site-project"]);
      const before = await command("git", ["--no-pager", "status", "--porcelain"], siteProject);
      const inspect = JSON.parse(await cli(["inspect", siteProject, "--json", "--no-cache"]));
      assert.ok(inspect.pageCount > 0);
      if (path.basename(siteProject) === "world-cup-2026") assert.equal(inspect.pageCount, 51);
      const file = path.join(temp, "owner.index.json");
      await cli(["build", siteProject, "--output", file]);
      const results = await stdio([file], async (client) => {
        const info = await call(client, "site_info");
        assert.equal(info.pageCount, inspect.pageCount);
        const pages = await call(client, "list_pages", { limit: 100 });
        assert.equal(pages.total, inspect.pageCount);
        const searchTerm = path.basename(siteProject) === "world-cup-2026" ? "Brazil" : pages.pages[0].title;
        const search = await call(client, "search", { query: searchTerm });
        assert.ok(search.results.length > 0);
        const fetched = await call(client, "fetch", { id: search.results[0].id });
        assert.ok(fetched.text.length > 100);
        if (searchTerm === "Brazil") {
          assert.match(fetched.text, /Carlo Ancelotti/);
          assert.match(fetched.text, /Alisson/);
        }
        return { searchTerm, firstHit: search.results[0], fetchedCharacters: fetched.text.length, pages: pages.total };
      });
      assert.equal(await command("git", ["--no-pager", "status", "--porcelain"], siteProject), before);
      return { inspect, ...results, ownerWorktreeUnchanged: true };
    });
  }
  if (values.worker) {
    await check("Cloudflare Worker example: bundle and real local runtime", async () => {
      const workerDir = path.join(temp, "worker");
      const example = path.join(root, "examples", "cloudflare-worker");
      const manifest = JSON.parse(await readFile(path.join(example, "package.json"), "utf8"));
      manifest.dependencies.site2mcp = pathToFileURL(tarball).href;
      await save(path.join(workerDir, "package.json"), manifest);
      for (const file of ["wrangler.toml", path.join("src", "worker.ts")]) {
        await save(path.join(workerDir, file), await readFile(path.join(example, file)));
      }
      await save(path.join(workerDir, "src", "site.index.json"), localSite);
      await npm(["install", "--no-audit", "--no-fund"], workerDir);
      await npm(["exec", "--offline", "--", "wrangler", "deploy", "--dry-run", "--outdir", "bundle"], workerDir);
      const runner = path.join(workerDir, "verify.mjs");
      await save(runner, `
import assert from "node:assert/strict";
import { unstable_dev } from "wrangler";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const worker = await unstable_dev("src/worker.ts", {
  local: true, ip: "127.0.0.1", port: 0,
  vars: { SITE2MCP_TOKENS: "worker-verification" },
  experimental: { disableExperimentalWarning: true },
});
try {
  assert.equal((await worker.fetch("/healthz")).status, 200);
  for (const [token, count] of [[undefined, 3], ["worker-verification", 4]]) {
    const client = new Client({ name: "worker-verification", version: "1.0" });
    const transport = new StreamableHTTPClientTransport(new URL("http://worker.test/mcp"), {
      fetch: (url, init) => worker.fetch(new URL(url).pathname, init),
      ...(token ? { requestInit: { headers: { authorization: "Bearer " + token } } } : {}),
    });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: "list_pages", arguments: {} });
      assert.equal(result.structuredContent.total, count);
    } finally { await client.close(); }
  }
  console.log("Worker MCP: 3 anonymous pages, 4 authenticated pages");
} finally { await worker.stop(); }
`);
      const result = await command(process.execPath, [runner], workerDir);
      assert.match(result, /Worker MCP: 3 anonymous pages, 4 authenticated pages/);
      return { dryRun: true, anonymousPages: 3, authenticatedPages: 4 };
    });
  }
  if (values.live) {
    for (const url of ["https://example.com", "https://modelcontextprotocol.io", "https://vitejs.dev"]) {
      await check(`public live site: ${url}`, async () => {
        const inspect = JSON.parse(await cli(["inspect", url, "--max-pages", "8", "--no-cache", "--json"]));
        assert.ok(inspect.pageCount > 0 && inspect.pageCount <= 8);
        if (url.includes("modelcontextprotocol")) assert.equal(inspect.kinds.markdown, inspect.pageCount);
        if (url.includes("vitejs.dev")) assert.equal(new URL(inspect.url).hostname, "vite.dev");
        return inspect;
      });
    }
  }
}

try {
  await main();
} catch (error) {
  report.error = error.stack;
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
    } catch (error) {
      report.cleanupError = String(error);
      process.exitCode = 1;
    }
  }
  await rm(temp, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  report.ok = !process.exitCode;
  report.temporaryFilesRemoved = true;
  await save(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Verification report: ${reportFile}`);
}
