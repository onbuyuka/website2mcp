import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { actionInputShape, buildActionRequest, validateActions } from "../src/actions.js";
import { importOpenApiActions, loadOpenApiDocument, parseOpenApiDocument } from "../src/openapi.js";
import { z } from "zod";

const BASE = "https://api.example.test/v1";
const scalar = { type: "string" };
const param = (name: string, location = "query", schema: unknown = scalar) => ({
  name, in: location, ...(location === "path" ? { required: true } : {}), schema,
});
const body = (properties: Record<string, unknown>, mediaType = "application/json") => ({
  required: true,
  content: { [mediaType]: { schema: { type: "object", properties, required: Object.keys(properties) } } },
});
const spec = (paths: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  openapi: "3.1.0", servers: [{ url: BASE }], paths, ...extra,
});
const publicLookup = async () => [{ address: "93.184.215.14", family: 4 }];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("importOpenApiActions", () => {
  it("imports typed path/query inputs and produces the exact request", () => {
    const result = importOpenApiActions(spec({
      "/items/{id}": { get: {
        operationId: "Get Item", summary: "Find an item.",
        parameters: [
          param("id", "path"), param("q"),
          { ...param("limit", "query", { type: "integer", default: 10 }), description: "Result count." },
        ],
      } },
    }));
    expect(result.warnings).toEqual([]);
    const [action] = result.actions;
    expect(action).toMatchObject({
      name: "get_item", method: "GET", confirm: true, destructive: false, bodyType: "query",
      input: { id: { type: "string", required: true }, limit: { default: 10, description: "Result count." } },
    });
    expect(validateActions(result.actions, BASE)).toEqual(result.actions);
    const schema = z.object(actionInputShape(action));
    expect(schema.safeParse({ id: "x", limit: 1.5 }).success).toBe(false);
    const request = buildActionRequest(action, { id: "a/b", q: "a b" });
    expect(request.url).toBe(`${BASE}/items/a%2Fb?q=a+b&limit=10`);
    expect(request.body).toBeUndefined();
  });

  it("imports JSON writes with path parameters, enums and formats", () => {
    const { actions, warnings } = importOpenApiActions(spec({
      "/users/{id}": { patch: {
        parameters: [param("id", "path")],
        requestBody: body({
          email: { type: "string", format: "email" },
          active: { type: "boolean", default: false },
          plan: { type: "string", enum: ["free", "paid"] },
          created: { type: "string", readOnly: true },
        }),
      } },
    }));
    expect(warnings).toEqual([]);
    expect(actions[0]).toMatchObject({ method: "PATCH", bodyType: "json", destructive: true, confirm: true });
    expect(actions[0].input).not.toHaveProperty("created");
    const input = z.object(actionInputShape(actions[0])).parse({ id: "42", email: "a@b.test", plan: "free" });
    const request = buildActionRequest(actions[0], input);
    expect(request.url).toBe(`${BASE}/users/42`);
    expect(JSON.parse(request.body!)).toEqual({ email: "a@b.test", active: false, plan: "free" });
    expect(request.headers["content-type"]).toBe("application/json");
  });

  it("imports URL-encoded fields without changing their locations", () => {
    const [action] = importOpenApiActions(spec({ "/contact": {
      post: { requestBody: body({ message: scalar, count: { type: "integer" } }, "application/x-www-form-urlencoded") },
    } })).actions;
    expect(buildActionRequest(action, { message: "one & two", count: 2 }).body).toBe("message=one+%26+two&count=2");
  });

  it("reuses parameter values in repeated path placeholders without sending them in the body", () => {
    const [action] = importOpenApiActions(spec({ "/items/{id}/related/{id}": {
      post: { parameters: [param("id", "path")], requestBody: body({ message: scalar }) },
    } })).actions;
    const request = buildActionRequest(action, { id: "a/b", message: "hello" });
    expect(request.url).toBe(`${BASE}/items/a%2Fb/related/a%2Fb`);
    expect(request.body).toBe('{"message":"hello"}');
  });

  it("honors operation parameter overrides and internal references", () => {
    const result = importOpenApiActions(spec({
      "/items": { $ref: "#/components/pathItems/Items" },
    }, { components: {
      pathItems: { Items: {
        parameters: [{ $ref: "#/components/parameters/Query" }],
        get: { parameters: [{ ...param("q"), required: true }] },
        post: { parameters: [{ ...param("q"), schema: { $ref: "#/components/schemas/A~1B~0C" } }] },
      } },
      parameters: { Query: param("q", "query", { type: "integer" }) },
      schemas: { "A/B~C": { type: "string", enum: ["yes"] } },
    } }));
    expect(result.warnings).toEqual([]);
    expect(result.actions[0].input?.q).toEqual({ type: "string", required: true });
    expect(result.actions[1].input?.q.enum).toEqual(["yes"]);
  });

  it("resolves request body and schema references", () => {
    const result = importOpenApiActions(spec({ "/items": { post: { requestBody: { $ref: "#/components/requestBodies/Item" } } } }, {
      components: {
        requestBodies: { Item: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Item" } } } } },
        schemas: { Item: { type: "object", properties: { title: scalar } } },
      },
    }));
    expect(result.warnings).toEqual([]);
    expect(result.actions[0].input?.title).toEqual({ type: "string", required: false });
  });

  it("uses operation/path/document servers, defaults, and an explicit override", () => {
    const value = spec({
      "/root": { get: {} },
      "/path": { servers: [{ url: "https://path.test/api" }], get: {} },
      "/operation": { servers: [{ url: "https://path.test" }], get: {
        servers: [{ url: "https://{region}.test/api", variables: { region: { default: "eu" } } }, { url: "https://other.test" }],
      } },
    });
    const result = importOpenApiActions(value);
    expect(result.actions.map((action) => action.url)).toEqual([
      `${BASE}/root`, "https://path.test/api/path", "https://eu.test/api/operation",
    ]);
    expect(result.warnings.join(" ")).toMatch(/first API server/);
    expect(importOpenApiActions(value, { baseUrl: "https://override.test/v2/" }).actions.map((action) => action.url)).toEqual([
      "https://override.test/v2/root", "https://override.test/v2/path", "https://override.test/v2/operation",
    ]);
  });

  it("resolves relative and implicit servers only with a document URL", () => {
    const value = spec({ "/items": { get: {} } }, { servers: [{ url: "../api" }] });
    expect(importOpenApiActions(value, { documentUrl: "https://example.test/spec/openapi.yaml" }).actions[0].url).toBe("https://example.test/api/items");
    const result = importOpenApiActions(value);
    expect(result.actions).toEqual([]);
    expect(result.warnings.join(" ")).toContain("--base-url");
    const implicit = { openapi: "3.0.3", paths: { "/items": { get: {} } } };
    expect(importOpenApiActions(implicit, { documentUrl: "https://example.test/spec/openapi.json" }).actions[0].url).toBe("https://example.test/items");
    expect(importOpenApiActions(value, { baseUrl: BASE }).actions).toHaveLength(1);
  });

  it.each(["ftp://example.test", "https://user:pass@example.test", "https://example.test/?x=1", "https://example.test/#x"])(
    "rejects unsafe or ambiguous API base %s", (baseUrl) => {
      expect(() => importOpenApiActions(spec({ "/items": { get: {} } }), { baseUrl })).toThrow(/API server/);
    },
  );

  it("produces stable, bounded, unique names", () => {
    const operations = ["List Items", "list-items", "1", "x".repeat(90), "x".repeat(91), "!!!"];
    const value = spec(Object.fromEntries(operations.map((operationId, i) => [`/items/${i}`, { get: { operationId } }])));
    const result = importOpenApiActions(value);
    expect(result.actions.slice(0, 3).map((action) => action.name)).toEqual(["list_items", "list_items_2", "submit_1"]);
    expect(new Set(result.actions.map((action) => action.name)).size).toBe(6);
    expect(result.actions.every((action) => /^[a-z][a-z0-9_]{0,47}$/.test(action.name))).toBe(true);
    expect(importOpenApiActions(value)).toEqual(result);
  });

  it("uses environment placeholders for inherited bearer/API-key auth without copying examples", () => {
    const result = importOpenApiActions(spec({
      "/private": { get: {} },
      "/public": { get: { security: [] } },
    }, {
      security: [{ bearer: [], "api-key": [] }],
      components: { securitySchemes: {
        bearer: { type: "http", scheme: "bearer", example: "do-not-copy" },
        "api-key": { type: "apiKey", in: "header", name: "X-API-Key", default: "do-not-copy" },
      } },
    }));
    expect(result.warnings).toEqual([]);
    expect(result.actions[0].headers).toEqual({
      Authorization: "Bearer ${env:SITE2MCP_BEARER}", "X-API-Key": "${env:SITE2MCP_API_KEY}",
    });
    expect(result.actions[1].headers).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("do-not-copy");
    const req = buildActionRequest(result.actions[0], {}, { SITE2MCP_BEARER: "token", SITE2MCP_API_KEY: "key" });
    expect(req.headers.Authorization).toBe("Bearer token");
    expect(() => buildActionRequest(result.actions[0], {}, {})).toThrow(/needs environment variable/);
    expect(() => validateActions(result.actions, "https://website.test")).toThrow(/origin/);
  });

  it("does not copy sensitive input defaults", () => {
    const result = importOpenApiActions(spec({ "/items": { get: {
      parameters: [param("token", "query", { type: "string", default: "do-not-copy" })],
    } } }));
    expect(result.actions[0].input?.token.default).toBeUndefined();
    expect(result.warnings.join(" ")).toContain("sensitive default");
    expect(JSON.stringify(result)).not.toContain("do-not-copy");
  });

  it.each([
    ["nested", { post: { requestBody: body({ item: { type: "object", properties: { name: scalar } } }) } }, /scalar/],
    ["array", { get: { parameters: [param("ids", "query", { type: "array", items: scalar })] } }, /scalar/],
    ["mixed", { post: { parameters: [param("q")], requestBody: body({ name: scalar }) } }, /Mixed/],
    ["header", { get: { parameters: [param("X-Name", "header")] } }, /dynamic header/],
    ["formBoolean", { post: { requestBody: body({ active: { type: "boolean" } }, "application/x-www-form-urlencoded") } }, /Boolean form/],
    ["multipart", { post: { requestBody: body({ file: scalar }, "multipart/form-data") } }, /Only JSON/],
    ["getBody", { get: { requestBody: body({ name: scalar }) } }, /GET request bodies/],
    ["missingPath", { get: {} }, /no declared path parameter/],
    ["reserved", { get: { parameters: [param("confirmed")] } }, /Reserved/],
    ["collision", { get: { parameters: [param("id", "path"), param("id")] } }, /conflicting/],
    ["union", { get: { parameters: [param("q", "query", { oneOf: [scalar] })] } }, /oneOf/],
    ["nullable", { get: { parameters: [param("q", "query", { type: "string", nullable: true })] } }, /Nullable/],
    ["external", { get: { parameters: [{ $ref: "other.yaml#/parameters/Id" }] } }, /bundle external/],
    ["missingRef", { get: { parameters: [{ $ref: "#/missing" }] } }, /Unresolved/],
    ["serialization", { get: { parameters: [{ ...param("q"), style: "deepObject" }] } }, /serialization/],
    ["numericEnum", { get: { parameters: [param("q", "query", { type: "integer", enum: [1, 2] })] } }, /string enums/],
  ])("skips %s with diagnostics instead of an incomplete action", (_name, operation, reason) => {
    const route = ["missingPath", "collision"].includes(_name) ? "/bad/{id}" : "/bad";
    const result = importOpenApiActions(spec({ "/ok": { get: {} }, [route]: operation }));
    expect(result.actions).toHaveLength(1);
    expect(result.warnings.join(" ")).toMatch(reason);
    expect(result.warnings.join(" ")).toContain("Skipped");
  });

  it("stops circular references and does not lose unrelated actions", () => {
    const result = importOpenApiActions(spec({ "/ok": { get: {} }, "/bad": { $ref: "#/components/pathItems/A" } }, {
      components: { pathItems: { A: { $ref: "#/components/pathItems/B" }, B: { $ref: "#/components/pathItems/A" } } },
    }));
    expect(result.actions).toHaveLength(1);
    expect(result.warnings.join(" ")).toMatch(/Circular/);
  });

  it.each([
    { type: "apiKey", in: "query", name: "key" },
    { type: "http", scheme: "basic" },
    { type: "oauth2", flows: {} },
  ])("skips unsupported auth %j", (scheme) => {
    const result = importOpenApiActions(spec({ "/items": { get: {} } }, {
      security: [{ auth: [] }], components: { securitySchemes: { auth: scheme } },
    }));
    expect(result.actions).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/Security scheme/);
  });

  it("prefers anonymous access when authentication is optional", () => {
    const result = importOpenApiActions(spec({ "/items": { get: {} } }, {
      security: [{ auth: [] }, {}],
      components: { securitySchemes: { auth: { type: "http", scheme: "bearer" } } },
    }));
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].headers).toBeUndefined();
    expect(result.warnings.join(" ")).toMatch(/optional.*also accepts auth/);
  });

  it("uses the first supported alternative and reports the others", () => {
    const result = importOpenApiActions(spec({
      "/a": { get: {} },
      "/b": { get: { security: [{ oauth: ["read"] }, { key: [] }] } },
    }, {
      security: [{ userAgent: [] }, { key: [] }],
      components: { securitySchemes: {
        userAgent: { type: "apiKey", in: "header", name: "User-Agent" },
        key: { type: "apiKey", in: "header", name: "API-Key" },
        oauth: { type: "oauth2", flows: {} },
      } },
    }));
    expect(result.actions.map((action) => action.headers)).toEqual([
      { "User-Agent": "${env:SITE2MCP_USERAGENT}" },
      { "API-Key": "${env:SITE2MCP_KEY}" },
    ]);
    expect(result.warnings).toEqual([
      "GET /a: Using userAgent authentication; the API also accepts key.",
      "GET /b: Using key authentication; the API also accepts oauth.",
    ]);
  });

  it("skips operations when no authentication alternative is supported", () => {
    const result = importOpenApiActions(spec({ "/items": { get: {} } }, {
      security: [{ oauth: ["read"] }, { basic: [] }],
      components: { securitySchemes: { oauth: { type: "oauth2", flows: {} }, basic: { type: "http", scheme: "basic" } } },
    }));
    expect(result.actions).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/No supported authentication alternative: Scoped.*Security scheme basic/);
  });

  it.each([
    { security: null },
    { servers: null },
    { parameters: [{ ...param("q"), required: "true" }] },
    { requestBody: { ...body({ message: scalar }), required: "true" } },
  ])("rejects malformed control fields instead of treating them as defaults: %j", (operation) => {
    const result = importOpenApiActions(spec({ "/items": { post: operation } }));
    expect(result.actions).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/Skipped/);
  });

  it("reports conflicting auth headers rather than overwriting either credential", () => {
    const result = importOpenApiActions(spec({ "/items": { get: {} } }, {
      security: [{ bearer: [], key: [] }],
      components: { securitySchemes: {
        bearer: { type: "http", scheme: "bearer" },
        key: { type: "apiKey", in: "header", name: "authorization" },
      } },
    }));
    expect(result.actions).toEqual([]);
    expect(result.warnings.join(" ")).toContain("Conflicting authentication header");
  });

  it("reports constraints left for the backend and optional-body narrowing", () => {
    const requestBody = { ...body({ name: { type: "string", maxLength: 10 } }), required: false };
    const result = importOpenApiActions(spec({ "/items": { post: { requestBody } } }));
    expect(result.actions).toHaveLength(1);
    expect(result.warnings.join(" ")).toMatch(/validation constraints/);
    expect(result.warnings.join(" ")).toMatch(/always sends a body/);
  });

  it.each([null, {}, { swagger: "2.0", paths: {} }, { openapi: "3.2.0", paths: {} }, { openapi: "3.1.0", paths: [] }])(
    "rejects unsupported or invalid root documents %j", (value) => {
      expect(() => importOpenApiActions(value)).toThrow();
    },
  );
});

describe("OpenAPI document loading", () => {
  it("reads JSON/YAML files and rejects duplicate keys or custom YAML tags", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "site2mcp-openapi-"));
    dirs.push(dir);
    const file = path.join(dir, "api.yaml");
    const yaml = "openapi: 3.0.3\nservers:\n  - url: https://api.example.test\npaths:\n  /items:\n    get:\n      summary: List items\n";
    await writeFile(file, yaml);
    const loaded = await loadOpenApiDocument(file);
    expect(loaded.documentUrl).toBeUndefined();
    expect(importOpenApiActions(loaded.document).actions[0].name).toBe("get_items");
    expect(parseOpenApiDocument(JSON.stringify(spec({})))).toEqual(spec({}));
    expect(() => parseOpenApiDocument("openapi: 3.0.3\nopenapi: 3.1.0")).toThrow(/Invalid OpenAPI/);
    expect(() => parseOpenApiDocument("x: !unknown value")).toThrow(/Invalid OpenAPI/);
    expect(() => parseOpenApiDocument("{broken")).toThrow(/Invalid OpenAPI/);
  });

  it("uses the final description URL and checks redirect destinations", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/spec/openapi.yaml" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(spec({ "/items": { get: {} } }, { servers: [{ url: "../api" }] }))));
    const result = await loadOpenApiDocument("https://example.test/start", { fetchImpl, lookupImpl: publicLookup });
    expect(result.documentUrl).toBe("https://example.test/spec/openapi.yaml");
    expect(importOpenApiActions(result.document, result).actions[0].url).toBe("https://example.test/api/items");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });

  it("refuses public redirects to private hosts without fetching them", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }));
    await expect(loadOpenApiDocument("https://example.test/spec", { fetchImpl, lookupImpl: publicLookup })).rejects.toThrow(/non-public/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("allows explicit localhost documents but not redirects to a different private origin", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(spec({}))));
    await expect(loadOpenApiDocument("http://localhost:3000/api", { fetchImpl })).resolves.toHaveProperty("document");
    fetchImpl.mockResolvedValue(new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }));
    await expect(loadOpenApiDocument("http://localhost:3000/api", { fetchImpl })).rejects.toThrow(/non-public/);
  });

  it("rejects oversized declared and streamed responses", async () => {
    const oversized = " ".repeat(5 * 1024 * 1024 + 1);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("small", { headers: { "content-length": String(oversized.length) } }));
    await expect(loadOpenApiDocument("https://example.test/spec", { fetchImpl, lookupImpl: publicLookup })).rejects.toThrow(/5 MiB/);
    fetchImpl.mockResolvedValue(new Response(oversized));
    await expect(loadOpenApiDocument("https://example.test/spec", { fetchImpl, lookupImpl: publicLookup })).rejects.toThrow(/5 MiB/);
    expect(() => parseOpenApiDocument(oversized)).toThrow(/5 MiB/);
  });

  it("reports HTTP failure and redirect loops", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("no", { status: 403 }));
    await expect(loadOpenApiDocument("https://example.test/spec", { fetchImpl, lookupImpl: publicLookup })).rejects.toThrow(/HTTP 403/);
    fetchImpl.mockImplementation(async () => new Response(null, { status: 302, headers: { location: "/loop" } }));
    await expect(loadOpenApiDocument("https://example.test/spec", { fetchImpl, lookupImpl: publicLookup })).rejects.toThrow(/Too many/);
  });
});
