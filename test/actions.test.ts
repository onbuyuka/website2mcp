import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitRequestSchema, type ElicitRequest, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  actionInputShape,
  buildActionRequest,
  executeAction,
  redactPreview,
  registerActionTools,
  suggestActionsFromHtml,
  validateActions,
  type ActionRunEvent,
} from "../src/actions.js";
import type { ActionDefinition } from "../src/types.js";

const SITE = "https://example.test";
const publicLookup = async () => [{ address: "93.184.215.14", family: 4 }];

const subscribe: ActionDefinition = {
  name: "subscribe",
  description: "Subscribe to the newsletter.",
  method: "POST",
  url: "https://example.test/subscribe",
  input: {
    email: { type: "string", format: "email", required: true, description: "Subscriber email" },
    topic: { type: "string", enum: ["news", "deals"] },
  },
  headers: { "x-api-key": "${env:NEWSLETTER_KEY}" },
};

function fakeFetch(respond: () => Response = () => new Response("ok", { status: 200 })) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

describe("validateActions", () => {
  it("accepts valid definitions and returns them", () => {
    const actions = validateActions([subscribe], SITE);
    expect(actions).toHaveLength(1);
    expect(actions[0].name).toBe("subscribe");
    expect(validateActions(undefined, SITE)).toEqual([]);
  });

  it("rejects non-arrays", () => {
    expect(() => validateActions({ name: "x" }, SITE)).toThrow(/array/);
  });

  it("rejects bad names and includes the action name", () => {
    expect(() => validateActions([{ ...subscribe, name: "Bad-Name" }], SITE)).toThrow(/Action "Bad-Name": name:/);
  });

  it("rejects unknown keys and bad methods", () => {
    expect(() => validateActions([{ ...subscribe, methd: "POST" }], SITE)).toThrow(/Action "subscribe"/);
    expect(() => validateActions([{ ...subscribe, method: "TRACE" }], SITE)).toThrow(/method/);
  });

  it("rejects foreign origins unless allowed", () => {
    const foreign = { ...subscribe, url: "https://forms.other.test/subscribe" };
    expect(() => validateActions([foreign], SITE)).toThrow(/Action "subscribe": url: origin https:\/\/forms\.other\.test/);
    expect(validateActions([foreign], SITE, { allowedOrigins: ["https://forms.other.test/"] })).toHaveLength(1);
  });

  it("rejects non-http urls and env placeholders in the host", () => {
    expect(() => validateActions([{ ...subscribe, url: "ftp://example.test/x" }], SITE)).toThrow(/http/);
    expect(() => validateActions([{ ...subscribe, url: "https://${env:HOST}/x" }], SITE)).toThrow(/scheme or host/);
    expect(() =>
      validateActions(
        [{ ...subscribe, url: "https://{tenant}.example.test/x", input: { tenant: { type: "string" } } }],
        SITE,
      ),
    ).toThrow(/scheme or host/);
    expect(() => validateActions([{ ...subscribe, url: "/relative" }], SITE)).toThrow(/absolute/);
  });

  it("allows env placeholders in the path and query", () => {
    const action = { ...subscribe, url: "https://example.test/hooks/${env:HOOK_ID}?key=${env:KEY}" };
    expect(validateActions([action], SITE)).toHaveLength(1);
  });

  it("rejects placeholders that are not declared input fields", () => {
    const action = { ...subscribe, url: "https://example.test/items/{id}" };
    expect(() => validateActions([action], SITE)).toThrow(/placeholder \{id\} does not match/);
    expect(
      validateActions([{ ...action, input: { id: { type: "string", required: true } } }], SITE),
    ).toHaveLength(1);
  });

  it("rejects duplicate names", () => {
    expect(() => validateActions([subscribe, { ...subscribe }], SITE)).toThrow(/Action "subscribe": duplicate/);
  });

  it("rejects the reserved confirmed field, mismatched defaults and GET bodies", () => {
    expect(() =>
      validateActions([{ ...subscribe, input: { confirmed: { type: "boolean" } } }], SITE),
    ).toThrow(/reserved/);
    expect(() =>
      validateActions([{ ...subscribe, input: { count: { type: "integer", default: 1.5 } } }], SITE),
    ).toThrow(/default/);
    expect(() => validateActions([{ ...subscribe, method: "GET", bodyType: "json" }], SITE)).toThrow(/GET/);
  });

  it("reports problems for several actions at once", () => {
    let message = "";
    try {
      validateActions([{ ...subscribe, name: "1bad" }, { ...subscribe, url: "https://evil.test/" }], SITE);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('Action "1bad"');
    expect(message).toContain('Action "subscribe"');
  });
});

describe("actionInputShape", () => {
  const action: ActionDefinition = {
    name: "book",
    description: "Book a table.",
    method: "POST",
    url: "https://example.test/book",
    input: {
      email: { type: "string", format: "email", required: true, description: "Contact email" },
      size: { type: "string", enum: ["small", "large"] },
      guests: { type: "integer", required: true },
      date: { type: "string", format: "date" },
      website: { type: "string", format: "uri" },
      newsletter: { type: "boolean", default: false },
    },
  };
  const schema = z.object(actionInputShape(action));

  it("validates formats, enums and required fields", () => {
    expect(schema.safeParse({ email: "a@b.test", guests: 2 }).success).toBe(true);
    expect(schema.safeParse({ email: "not-an-email", guests: 2 }).success).toBe(false);
    expect(schema.safeParse({ email: "a@b.test" }).success).toBe(false);
    expect(schema.safeParse({ email: "a@b.test", guests: 2.5 }).success).toBe(false);
    expect(schema.safeParse({ email: "a@b.test", guests: 2, size: "medium" }).success).toBe(false);
    expect(schema.safeParse({ email: "a@b.test", guests: 2, size: "large" }).success).toBe(true);
    expect(schema.safeParse({ email: "a@b.test", guests: 2, date: "2026-13-45" }).success).toBe(false);
    expect(schema.safeParse({ email: "a@b.test", guests: 2, website: "javascript:alert(1)" }).success).toBe(false);
  });

  it("applies defaults and adds the confirmed flag", () => {
    const shape = actionInputShape(action);
    expect(shape.confirmed).toBeDefined();
    expect(shape.confirmed.description).toBe(
      "Set to false for a preview only (no request or approval prompt). Set to true only after the user has approved the preview; approval-capable clients will still ask for confirmation.",
    );
    expect(shape.email.description).toBe("Contact email");
    const parsed = schema.parse({ email: "a@b.test", guests: 2, confirmed: true });
    expect(parsed).toMatchObject({ newsletter: false, confirmed: true });
  });
});

describe("buildActionRequest", () => {
  it("builds query requests and skips undefined values", () => {
    const request = buildActionRequest(
      {
        name: "find",
        description: "Find.",
        method: "GET",
        url: "https://example.test/find?lang=en",
        input: { term: { type: "string" }, page: { type: "integer" }, extra: { type: "string" } },
      },
      { term: "a b", page: 2, extra: undefined, confirmed: true },
      {},
    );
    expect(request.url).toBe("https://example.test/find?lang=en&term=a+b&page=2");
    expect(request.body).toBeUndefined();
    expect(request.headers.accept).toBe("application/json, text/plain;q=0.9, */*;q=0.5");
    expect(request.url).not.toContain("confirmed");
  });

  it("builds JSON requests without the confirmed flag or undeclared fields", () => {
    const request = buildActionRequest(subscribe, { email: "a@b.test", confirmed: true, sneaky: "x" }, {
      NEWSLETTER_KEY: "secret-key",
    });
    expect(request.method).toBe("POST");
    expect(request.body).toBe(JSON.stringify({ email: "a@b.test" }));
    expect(request.headers["content-type"]).toBe("application/json");
    expect(request.headers["x-api-key"]).toBe("secret-key");
  });

  it("builds form requests", () => {
    const request = buildActionRequest(
      {
        name: "contact",
        description: "Contact.",
        method: "POST",
        url: "https://example.test/contact",
        bodyType: "form",
        input: { name: { type: "string" }, consent: { type: "boolean" }, promo: { type: "boolean" } },
        headers: { Accept: "text/html" },
      },
      { name: "Ada & co", consent: true, promo: false },
      {},
    );
    expect(request.body).toBe("name=Ada+%26+co&consent=true");
    expect(request.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(request.headers.Accept).toBe("text/html");
    expect(request.headers.accept).toBeUndefined();
  });

  it("substitutes url placeholders and removes them from the body", () => {
    const request = buildActionRequest(
      {
        name: "book",
        description: "Book.",
        method: "PUT",
        url: "https://example.test/rooms/{room}/bookings",
        input: { room: { type: "string", required: true }, guests: { type: "integer" } },
      },
      { room: "a/b c", guests: 3 },
      {},
    );
    expect(request.url).toBe("https://example.test/rooms/a%2Fb%20c/bookings");
    expect(request.body).toBe(JSON.stringify({ guests: 3 }));
  });

  it("expands env placeholders and reports missing ones", () => {
    const action: ActionDefinition = {
      name: "ping",
      description: "Ping.",
      method: "GET",
      url: "https://example.test/hooks/${env:HOOK}?key=${env:KEY}",
      headers: { authorization: "Bearer ${env:TOKEN}" },
    };
    const request = buildActionRequest(action, {}, { HOOK: "h1", KEY: "k&1", TOKEN: "t0k" });
    expect(request.url).toBe("https://example.test/hooks/h1?key=k%261");
    expect(request.headers.authorization).toBe("Bearer t0k");
    expect(() => buildActionRequest(action, {}, { HOOK: "h1", KEY: "k" })).toThrow(
      'Action "ping" needs environment variable TOKEN.',
    );
  });

  it("requires values for url placeholders", () => {
    const action: ActionDefinition = {
      name: "item",
      description: "Item.",
      method: "GET",
      url: "https://example.test/items/{id}",
      input: { id: { type: "string" } },
    };
    expect(() => buildActionRequest(action, {}, {})).toThrow(/needs a value for "id"/);
  });

  it("redacts sensitive headers and query parameters", () => {
    const redacted = redactPreview({
      method: "POST",
      url: "https://example.test/x?api_key=abc&keyword=shoes",
      headers: {
        Authorization: "Bearer abc",
        Cookie: "a=b",
        "x-api-key": "k",
        "x-auth-token": "t",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(redacted.headers).toEqual({
      Authorization: "[redacted]",
      Cookie: "[redacted]",
      "x-api-key": "[redacted]",
      "x-auth-token": "[redacted]",
      "content-type": "application/json",
    });
    expect(redacted.url).toBe("https://example.test/x?api_key=[redacted]&keyword=shoes");
    expect(redacted.body).toBe("{}");
  });
});

describe("executeAction", () => {
  const env = { NEWSLETTER_KEY: "k" };

  it("sends the request with manual redirects and returns the response", async () => {
    const { fetchImpl, calls } = fakeFetch(
      () => new Response('{"subscribed":true}', { status: 201, headers: { "content-type": "application/json" } }),
    );
    const result = await executeAction(subscribe, { email: "a@b.test" }, { fetchImpl, env, lookupImpl: publicLookup });
    expect(result).toEqual({
      ok: true,
      status: 201,
      contentType: "application/json",
      body: '{"subscribed":true}',
      truncated: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://example.test/subscribe");
    expect(calls[0].init).toMatchObject({ method: "POST", redirect: "manual", body: '{"email":"a@b.test"}' });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports HTTP errors as not ok", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("nope", { status: 422 }));
    const result = await executeAction(subscribe, { email: "a@b.test" }, { fetchImpl, env, lookupImpl: publicLookup });
    expect(result).toMatchObject({ ok: false, status: 422, body: "nope" });
  });

  it("truncates large bodies", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("x".repeat(50_000)));
    const result = await executeAction(subscribe, { email: "a@b.test" }, {
      fetchImpl,
      env,
      lookupImpl: publicLookup,
      maxBytes: 10,
    });
    expect(result.body).toBe("x".repeat(10));
    expect(result.truncated).toBe(true);
  });

  it("uses the action's maxResponseChars limit", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("x".repeat(50_000)));
    const limited = { ...subscribe, maxResponseChars: 40_000 };
    const result = await executeAction(limited, { email: "a@b.test" }, { fetchImpl, env, lookupImpl: publicLookup });
    expect(result.body).toHaveLength(40_000);
    expect(result.truncated).toBe(true);
    expect(() => validateActions([{ ...subscribe, maxResponseChars: 10 }], SITE)).toThrow(/maxResponseChars/);
  });

  it("does not follow redirects", async () => {
    const { fetchImpl, calls } = fakeFetch(
      () => new Response(null, { status: 303, headers: { location: "/thanks" } }),
    );
    const result = await executeAction(subscribe, { email: "a@b.test" }, { fetchImpl, env, lookupImpl: publicLookup });
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({
      ok: true,
      status: 303,
      body: "Redirect (not followed) to https://example.test/thanks",
    });
  });

  it("refuses private hosts unless allowed", async () => {
    const { fetchImpl, calls } = fakeFetch();
    const privateLookup = async () => [{ address: "10.0.0.1", family: 4 }];
    await expect(
      executeAction(subscribe, { email: "a@b.test" }, { fetchImpl, env, lookupImpl: privateLookup }),
    ).rejects.toThrow(/non-public host/);
    expect(calls).toHaveLength(0);

    const result = await executeAction(subscribe, { email: "a@b.test" }, {
      fetchImpl,
      env,
      lookupImpl: privateLookup,
      allowPrivateHosts: true,
    });
    expect(result.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("wraps network errors and timeouts", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND") });
    }) as unknown as typeof fetch;
    await expect(
      executeAction(subscribe, { email: "a@b.test" }, { fetchImpl: failing, env, lookupImpl: publicLookup }),
    ).rejects.toThrow('Action "subscribe" request failed: fetch failed (getaddrinfo ENOTFOUND)');

    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    await expect(
      executeAction(subscribe, { email: "a@b.test" }, { fetchImpl: hanging, env, lookupImpl: publicLookup, timeoutMs: 20 }),
    ).rejects.toThrow('Action "subscribe" timed out after 20 ms.');
  });
});

describe("registerActionTools", () => {
  let client: Client | undefined;
  let server: McpServer | undefined;

  afterEach(async () => {
    await client?.close();
    await server?.close();
    client = undefined;
    server = undefined;
  });

  async function connect(
    actions: ActionDefinition[],
    options: { respond?: () => Response; elicit?: (message: string) => ElicitResult } = {},
  ) {
    const { fetchImpl, calls } = fakeFetch(options.respond);
    const events: ActionRunEvent[] = [];
    server = new McpServer({ name: "website2mcp", version: "0.1.0" });
    registerActionTools(server, actions, {
      siteUrl: SITE,
      fetchImpl,
      env: { NEWSLETTER_KEY: "super-secret" },
      lookupImpl: publicLookup,
      onRun: (event) => events.push(event),
    });
    const elicitMessages: string[] = [];
    const elicitRequests: ElicitRequest[] = [];
    client = new Client(
      { name: "test-client", version: "1.0.0" },
      options.elicit ? { capabilities: { elicitation: {} } } : {},
    );
    if (options.elicit) {
      const elicit = options.elicit;
      client.setRequestHandler(ElicitRequestSchema, async (request) => {
        elicitMessages.push(request.params.message);
        elicitRequests.push(request);
        return elicit(request.params.message);
      });
    }
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, calls, events, elicitMessages, elicitRequests };
  }

  function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
    const content = result.content as Array<{ type: string; text?: string }>;
    return content.map((item) => item.text ?? "").join("\n");
  }

  it("lists action tools with annotations and the approval note", async () => {
    const { client } = await connect([
      subscribe,
      { name: "remove", description: "Remove.", method: "DELETE", url: `${SITE}/x`, destructive: true },
      { name: "status", description: "Status.", method: "GET", url: `${SITE}/status`, confirm: false },
    ]);
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect([...byName.keys()].sort()).toEqual(["action_remove", "action_status", "action_subscribe"]);

    const tool = byName.get("action_subscribe")!;
    expect(tool.description).toBe(
      "Subscribe to the newsletter. (Sends a POST request to https://example.test; requires user approval.)",
    );
    expect(tool.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
      idempotentHint: false,
    });
    expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(["confirmed", "email", "topic"]);
    expect(tool.inputSchema.required).toEqual(["email"]);

    expect(byName.get("action_remove")!.annotations).toMatchObject({ destructiveHint: true, idempotentHint: false });
    expect(byName.get("action_status")!.annotations).toMatchObject({ idempotentHint: true });
    expect(byName.get("action_status")!.description).toBe(
      "Status. (Sends a GET request to https://example.test.)",
    );
  });

  it.each([undefined, false])("previews without elicitation with confirmed=%s and sends only once confirmed", async (confirmed) => {
    const { client, calls, events } = await connect([subscribe], {
      respond: () => new Response('{"ok":1}', { status: 200, headers: { "content-type": "application/json" } }),
    });

    const preview = await client.callTool({ name: "action_subscribe", arguments: { email: "a@b.test", confirmed } });
    expect(preview.isError).toBeFalsy();
    const previewText = textOf(preview);
    expect(previewText).toContain("POST https://example.test/subscribe");
    expect(previewText).toContain('{"email":"a@b.test"}');
    expect(previewText).toContain("x-api-key: [redacted]");
    expect(previewText).not.toContain("super-secret");
    expect(previewText).toContain(
      "Show this to the user. If they approve, call this tool again with the same arguments and confirmed: true.",
    );
    expect(calls).toHaveLength(0);
    expect(events).toHaveLength(0);

    const sent = await client.callTool({
      name: "action_subscribe",
      arguments: { email: "a@b.test", confirmed: true },
    });
    expect(sent.isError).toBeFalsy();
    expect(JSON.parse(textOf(sent))).toEqual({
      ok: true,
      status: 200,
      contentType: "application/json",
      body: '{"ok":1}',
      truncated: false,
    });
    expect(sent.structuredContent).toMatchObject({ ok: true, status: 200 });
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0].init.headers).get("x-api-key")).toBe("super-secret");
    expect(calls[0].init.body).toBe('{"email":"a@b.test"}');
    expect(events).toEqual([
      expect.objectContaining({ action: "subscribe", ok: true, status: 200, confirmedVia: "argument" }),
    ]);
  });

  it("rejects invalid arguments before previewing", async () => {
    const { client, calls } = await connect([subscribe]);
    const result = await client.callTool({ name: "action_subscribe", arguments: { email: "nope", confirmed: true } });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it.each([true, false])("confirmed:false only previews even with elicitation and confirm=%s", async (confirm) => {
    const { client, calls, events, elicitMessages } = await connect([{ ...subscribe, confirm }], {
      elicit: () => ({ action: "accept", content: { approved: true } }),
    });
    const result = await client.callTool({
      name: "action_subscribe",
      arguments: { email: "a@b.test", confirmed: false },
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("not sent yet");
    expect(calls).toHaveLength(0);
    expect(elicitMessages).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it.each([undefined, true])("asks for explicit approval via elicitation with confirmed=%s", async (confirmed) => {
    const { client, calls, events, elicitMessages, elicitRequests } = await connect([subscribe], {
      elicit: () => ({ action: "accept", content: { approved: true } }),
    });
    const result = await client.callTool({ name: "action_subscribe", arguments: { email: "a@b.test", confirmed } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toMatchObject({ ok: true, status: 200 });
    expect(calls).toHaveLength(1);
    expect(elicitMessages).toEqual([
      'Allow website2mcp to send this request?\nPOST https://example.test/subscribe\n{"email":"a@b.test"}',
    ]);
    expect(elicitRequests[0].params).toMatchObject({
      mode: "form",
      requestedSchema: {
        type: "object",
        properties: { approved: { type: "boolean", default: false } },
        required: ["approved"],
      },
    });
    expect(events).toEqual([expect.objectContaining({ ok: true, confirmedVia: "elicitation" })]);
  });

  it.each<ElicitResult>([
    { action: "accept" },
    { action: "accept", content: {} },
    { action: "accept", content: { approved: false } },
    { action: "accept", content: { approved: "true" } },
  ])("rejects acceptance without explicit boolean approval: %j", async (response) => {
    const { client, calls, events } = await connect([subscribe], { elicit: () => response });
    const result = await client.callTool({
      name: "action_subscribe",
      arguments: { email: "a@b.test", confirmed: true },
    });
    expect(textOf(result)).toMatch(/Cancelled|Could not get user approval/);
    expect(calls).toHaveLength(0);
    expect(events).toEqual([expect.objectContaining({ ok: false, confirmedVia: "elicitation" })]);
  });

  it.each(["decline", "cancel"] as const)("does not send on %s, even with confirmed: true", async (action) => {
    const { client, calls, events } = await connect([subscribe], {
      elicit: () => ({ action }),
    });
    const result = await client.callTool({
      name: "action_subscribe",
      arguments: { email: "a@b.test", confirmed: true },
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe("Cancelled: the user did not approve subscribe.");
    expect(calls).toHaveLength(0);
    expect(events).toEqual([
      expect.objectContaining({ action: "subscribe", ok: false, error: "cancelled", confirmedVia: "elicitation" }),
    ]);
  });

  it("does not send or fall back to confirmed:true when elicitation fails", async () => {
    const { client, calls, events } = await connect([subscribe], {
      elicit: () => { throw new Error("Approval UI unavailable"); },
    });
    const result = await client.callTool({
      name: "action_subscribe",
      arguments: { email: "a@b.test", confirmed: true },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Could not get user approval");
    expect(calls).toHaveLength(0);
    expect(events).toEqual([expect.objectContaining({ ok: false, confirmedVia: "elicitation" })]);
  });

  it("sends directly when confirmation is not required and flags HTTP errors", async () => {
    const { client, calls, events } = await connect(
      [{ name: "status", description: "Status.", method: "GET", url: `${SITE}/status`, confirm: false }],
      { respond: () => new Response("down", { status: 503 }) },
    );
    const result = await client.callTool({ name: "action_status", arguments: {} });
    expect(calls).toHaveLength(1);
    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result))).toMatchObject({ ok: false, status: 503, body: "down" });
    expect(events).toEqual([
      expect.objectContaining({ action: "status", ok: false, status: 503, confirmedVia: "not-required" }),
    ]);
    expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns a tool error when the request cannot be built", async () => {
    server = new McpServer({ name: "website2mcp", version: "0.1.0" });
    const events: ActionRunEvent[] = [];
    const { fetchImpl, calls } = fakeFetch();
    registerActionTools(server, [subscribe], { siteUrl: SITE, fetchImpl, env: {}, onRun: (e) => events.push(e) });
    client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({ name: "action_subscribe", arguments: { email: "a@b.test" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Action "subscribe" needs environment variable NEWSLETTER_KEY.');
    expect(calls).toHaveLength(0);
    expect(events).toEqual([expect.objectContaining({ ok: false, confirmedVia: "argument" })]);
  });
});

describe("suggestActionsFromHtml", () => {
  const html = `<!doctype html>
<html><body>
  <h1>Welcome</h1>
  <form action="/search"><input name="q" placeholder="Search"><button>Go</button></form>
  <form role="search" action="/find"><input type="search" name="term"><input type="hidden" name="lang" value="en"></form>
  <h2>Join our newsletter</h2>
  <form method="post" action="/subscribe#top">
    <input type="hidden" name="csrf_token" value="abc">
    <label for="nl-email">Email address *</label>
    <input id="nl-email" type="email" name="email" required>
    <label>Frequency
      <select name="frequency"><option value="">Choose one</option><option value="weekly">Weekly</option><option>Monthly</option></select>
    </label>
    <label><input type="checkbox" name="consent" required> I agree to the terms</label>
    <fieldset><legend>Topic</legend>
      <input type="radio" name="topic" value="news" checked> News
      <input type="radio" name="topic" value="deals"> Deals
    </fieldset>
    <input type="number" name="age">
    <input type="date" name="birthday">
    <input type="url" name="website">
    <textarea name="message" placeholder="Your message"></textarea>
    <input type="password" name="pw">
    <input type="submit" value="Subscribe">
  </form>
  <h2>Contact us</h2>
  <form method="post" action="https://forms.other.test/contact" enctype="multipart/form-data">
    <input name="name" aria-label="Your name"><input type="file" name="cv">
  </form>
  <h2>Contact us</h2>
  <form method="post" action="/contact2"><input name="name" required></form>
  <form method="post" action="mailto:someone@example.test"><input name="body"></form>
</body></html>`;
  const page = new URL("https://example.test/pages/home#section");
  const suggestions = suggestActionsFromHtml(html, page);

  it("skips search forms and non-http actions", () => {
    expect(suggestions.map((suggestion) => suggestion.action.name)).toEqual([
      "join_our_newsletter",
      "contact_us",
      "contact_us_2",
    ]);
    expect(suggestions.every((suggestion) => suggestion.page === "https://example.test/pages/home")).toBe(true);
  });

  it("maps a newsletter form to an action definition", () => {
    const [newsletter] = suggestions;
    expect(newsletter.action).toEqual({
      name: "join_our_newsletter",
      description: "Submit the 'Join our newsletter' form on /pages/home.",
      method: "POST",
      url: "https://example.test/subscribe",
      bodyType: "form",
      confirm: true,
      destructive: false,
      input: {
        email: { type: "string", format: "email", required: true, description: "Email address" },
        frequency: { type: "string", enum: ["weekly", "Monthly"], description: "Frequency" },
        consent: { type: "boolean", required: true, description: "I agree to the terms" },
        topic: { type: "string", enum: ["news", "deals"], default: "news", description: "Topic" },
        age: { type: "number" },
        birthday: { type: "string", format: "date" },
        website: { type: "string", format: "uri" },
        message: { type: "string", description: "Your message" },
      },
    });
    expect(newsletter.notes).toContain(
      "Hidden field 'csrf_token' (may be a CSRF token or tracking value) was not included.",
    );
    expect(newsletter.notes).toContain("Password field 'pw' was not included.");
    expect(newsletter.notes.some((note) => note.includes("CSRF protection"))).toBe(true);
  });

  it("notes multipart encoding, file fields and foreign origins", () => {
    const contact = suggestions[1];
    expect(contact.action).toMatchObject({
      method: "POST",
      url: "https://forms.other.test/contact",
      bodyType: "form",
      input: { name: { type: "string", description: "Your name" } },
    });
    expect(contact.notes.some((note) => note.includes("multipart/form-data"))).toBe(true);
    expect(contact.notes.some((note) => note.includes("File field 'cv'"))).toBe(true);
    expect(contact.notes.some((note) => note.includes("allowedOrigins"))).toBe(true);
  });

  it("produces definitions that pass validation", () => {
    const actions = suggestions.map((suggestion) => suggestion.action);
    expect(validateActions(actions, SITE, { allowedOrigins: ["https://forms.other.test"] })).toHaveLength(3);
  });

  it("derives names from ids, prefixes non-letters and dedupes", () => {
    const result = suggestActionsFromHtml(
      `<form id="mc-embedded-subscribe-form" method="post" action="/a"><input name="email" type="email"></form>
       <form id="mc-embedded-subscribe-form" method="post" action="/b"><input name="email" type="email"></form>
       <form name="2024 signup" method="post" action="/c"><input name="x"></form>
       <form method="post" action="/book-a-table"><input name="when" type="date"></form>
       <form method="get" action="/catalog"><input name="color"><input name="size"></form>`,
      new URL("https://example.test/"),
    );
    expect(result.map((suggestion) => suggestion.action.name)).toEqual([
      "mc_embedded_subscribe_form",
      "mc_embedded_subscribe_form_2",
      "submit_2024_signup",
      "book_a_table",
      "catalog",
    ]);
    expect(result[4].action).toMatchObject({ method: "GET", bodyType: "query", url: "https://example.test/catalog" });
  });
});
