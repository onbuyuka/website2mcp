import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseHTML } from "linkedom";
import { z } from "zod";
import type { ActionDefinition, ActionField } from "./types.js";
import { assertPublicHost } from "./url.js";

const ACTION_NAME_RE = /^[a-z][a-z0-9_]{0,47}$/;
const FIELD_PLACEHOLDER_RE = /(?<!\$)\{([^{}]+)\}/g;
const ENV_PLACEHOLDER_RE = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const SENSITIVE_HEADER_RE = /authorization|cookie|token|key|secret/i;
const SENSITIVE_PARAM_RE = /token|secret|password|passwd|signature|api[-_]?key|^key$|^sig$|^auth(orization)?$/i;
const CSRF_NAME_RE = /csrf|xsrf|authenticity|_token$|^token$|nonce/i;
const SEARCH_NAME_RE = /^(q|s|query|search)$/i;
const DEFAULT_ACCEPT = "application/json, text/plain;q=0.9, */*;q=0.5";
const REDACTED = "[redacted]";
const RESERVED_FIELD = "confirmed";
const CONFIRMED_DESCRIPTION =
  "Set to false for a preview only (no request or approval prompt). Set to true only after the user has approved the preview; approval-capable clients will still ask for confirmation.";
const APPROVAL_TIMEOUT_MS = 10 * 60_000;
const MAX_FIELD_NAME = 128;
const MAX_ENUM_VALUES = 1000;

export interface ActionRequestPreview {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface ActionResult {
  ok: boolean;
  status: number;
  contentType?: string;
  body: string;
  truncated: boolean;
}

export type ActionLookup = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

export interface ExecuteActionOptions {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  maxBytes?: number;
  lookupImpl?: ActionLookup;
  allowPrivateHosts?: boolean;
}

export interface ActionRunEvent {
  action: string;
  ok: boolean;
  status?: number;
  confirmedVia: "elicitation" | "argument" | "not-required";
  error?: string;
  durationMs: number;
}

export interface RegisterActionOptions {
  siteUrl: string;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  lookupImpl?: ActionLookup;
  allowPrivateHosts?: boolean;
  onRun?: (event: ActionRunEvent) => void;
}

export interface FormSuggestion {
  page: string;
  action: ActionDefinition;
  notes: string[];
}

const actionFieldSchema = z
  .strictObject({
    type: z.enum(["string", "number", "integer", "boolean"]),
    description: z.string().max(1000).optional(),
    enum: z.array(z.string().max(1000)).min(1).max(MAX_ENUM_VALUES).optional(),
    format: z.enum(["email", "uri", "date"]).optional(),
    required: z.boolean().optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  })
  .superRefine((field, ctx) => {
    if (field.enum && field.type !== "string") {
      ctx.addIssue({ code: "custom", path: ["enum"], message: "enum is only supported for string fields" });
    }
    if (field.format && field.type !== "string") {
      ctx.addIssue({ code: "custom", path: ["format"], message: "format is only supported for string fields" });
    }
    if (field.default !== undefined && !defaultMatchesField(field, field.default)) {
      ctx.addIssue({ code: "custom", path: ["default"], message: `default must be a valid ${field.type} value` });
    }
  });

export const actionDefinitionSchema: z.ZodType<ActionDefinition> = z
  .strictObject({
    name: z
      .string()
      .regex(ACTION_NAME_RE, "name must start with a lowercase letter and contain only a-z, 0-9 and _ (max 48 chars)"),
    description: z.string().regex(/\S/, "description must not be empty").max(1000),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    url: z.string().min(1).max(2048),
    input: z.record(z.string().min(1).max(MAX_FIELD_NAME), actionFieldSchema).optional(),
    bodyType: z.enum(["json", "form", "query"]).optional(),
    headers: z.record(z.string().regex(HEADER_NAME_RE, "invalid header name"), z.string().max(4096)).optional(),
    confirm: z.boolean().optional(),
    destructive: z.boolean().optional(),
    maxResponseChars: z.number().int().min(1000).max(200_000).optional(),
  })
  .superRefine((action, ctx) => {
    const input = action.input ?? {};
    if (Object.hasOwn(input, RESERVED_FIELD)) {
      ctx.addIssue({
        code: "custom",
        path: ["input", RESERVED_FIELD],
        message: `"${RESERVED_FIELD}" is reserved for the approval flag`,
      });
    }
    for (const [, field] of action.url.matchAll(FIELD_PLACEHOLDER_RE)) {
      if (!Object.hasOwn(input, field)) {
        ctx.addIssue({
          code: "custom",
          path: ["url"],
          message: `placeholder {${field}} does not match a declared input field`,
        });
      }
    }
    if (hasUnsupportedTemplate(action.url)) {
      ctx.addIssue({ code: "custom", path: ["url"], message: "only ${env:NAME} placeholders are supported after $" });
    }
    for (const [name, value] of Object.entries(action.headers ?? {})) {
      if (hasUnsupportedTemplate(value)) {
        ctx.addIssue({
          code: "custom",
          path: ["headers", name],
          message: "only ${env:NAME} placeholders are supported in header values",
        });
      }
      if (/[\r\n]/.test(value)) {
        ctx.addIssue({ code: "custom", path: ["headers", name], message: "header values must not contain line breaks" });
      }
    }
    if (action.method === "GET" && action.bodyType && action.bodyType !== "query") {
      ctx.addIssue({ code: "custom", path: ["bodyType"], message: 'GET requests cannot have a body; use bodyType "query"' });
    }
  });

export function validateActions(
  actions: unknown,
  siteUrl: string,
  options: { allowedOrigins?: string[] } = {},
): ActionDefinition[] {
  if (actions === undefined || actions === null) return [];
  if (!Array.isArray(actions)) throw new Error("Invalid actions: expected an array of action definitions.");

  const siteOrigin = httpOrigin(siteUrl);
  if (!siteOrigin) throw new Error(`Invalid site URL for actions: ${siteUrl}`);
  const allowed = new Set([siteOrigin]);
  for (const origin of options.allowedOrigins ?? []) {
    const parsed = httpOrigin(origin);
    if (!parsed) throw new Error(`Invalid allowed origin: ${origin}`);
    allowed.add(parsed);
  }

  const problems: string[] = [];
  const valid: ActionDefinition[] = [];
  const seen = new Set<string>();
  actions.forEach((raw, index) => {
    const label = actionLabel(raw, index);
    const parsed = actionDefinitionSchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = issue.path.length ? `${issue.path.map(String).join(".")}: ` : "";
        problems.push(`${label}: ${path}${issue.message}`);
      }
      return;
    }
    const action = parsed.data;
    if (seen.has(action.name)) problems.push(`${label}: duplicate action name`);
    seen.add(action.name);
    const urlProblem = checkActionUrl(action.url, allowed);
    if (urlProblem) problems.push(`${label}: url: ${urlProblem}`);
    valid.push(action);
  });

  if (problems.length > 0) throw new Error(`Invalid actions:\n- ${problems.join("\n- ")}`);
  return valid;
}

export function actionInputShape(action: ActionDefinition): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, field] of Object.entries(action.input ?? {})) shape[name] = fieldSchema(field);
  shape[RESERVED_FIELD] = z.boolean().optional().describe(CONFIRMED_DESCRIPTION);
  return shape;
}

export function buildActionRequest(
  action: ActionDefinition,
  input: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
): ActionRequestPreview {
  const values = new Map<string, unknown>();
  for (const [name, field] of Object.entries(action.input ?? {})) {
    const value = Object.hasOwn(input, name) ? input[name] : undefined;
    if (value !== undefined && value !== null) values.set(name, value);
    else if (field.default !== undefined) values.set(name, field.default);
  }

  const substituted = new Set<string>();
  const withFields = action.url.replace(FIELD_PLACEHOLDER_RE, (_match, name: string) => {
    const value = values.get(name);
    if (value === undefined || value === "") {
      throw new Error(`Action "${action.name}" needs a value for "${name}".`);
    }
    substituted.add(name);
    return encodeURIComponent(String(value));
  });
  for (const name of substituted) values.delete(name);
  const url = new URL(expandEnv(withFields, action.name, env, encodeURIComponent));

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(action.headers ?? {})) {
    headers[name] = expandEnv(value, action.name, env);
  }

  const bodyType = action.bodyType ?? (action.method === "GET" || action.method === "DELETE" ? "query" : "json");
  let body: string | undefined;
  if (bodyType === "query") {
    for (const [name, value] of values) url.searchParams.append(name, String(value));
  } else if (bodyType === "json") {
    body = JSON.stringify(Object.fromEntries(values));
    setDefaultHeader(headers, "content-type", "application/json");
  } else {
    const form = new URLSearchParams();
    for (const [name, value] of values) {
      // Mirror HTML form semantics: unchecked checkboxes are not submitted.
      if (value === false) continue;
      form.append(name, String(value));
    }
    body = form.toString();
    setDefaultHeader(headers, "content-type", "application/x-www-form-urlencoded");
  }
  setDefaultHeader(headers, "accept", DEFAULT_ACCEPT);

  return { method: action.method, url: url.toString(), headers, ...(body !== undefined ? { body } : {}) };
}

export function redactPreview(preview: ActionRequestPreview): ActionRequestPreview {
  const headers = Object.fromEntries(
    Object.entries(preview.headers).map(([name, value]) => [name, SENSITIVE_HEADER_RE.test(name) ? REDACTED : value]),
  );
  return { ...preview, url: redactUrl(preview.url), headers };
}

export async function executeAction(
  action: ActionDefinition,
  input: Record<string, unknown>,
  options: ExecuteActionOptions = {},
): Promise<ActionResult> {
  const request = buildActionRequest(action, input, options.env);
  const target = new URL(request.url);
  if (!options.allowPrivateHosts) {
    try {
      await assertPublicHost(target.hostname, options.lookupImpl);
    } catch (error) {
      throw new Error(`Action "${action.name}" cannot be sent: ${errorMessage(error)}`);
    }
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxBytes ?? action.maxResponseChars ?? 20_000;
  let response: Response;
  try {
    response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body !== undefined ? { body: request.body } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw requestError(action.name, error, timeoutMs);
  }

  let body: string;
  let truncated: boolean;
  try {
    ({ text: body, truncated } = await readLimited(response, maxBytes));
  } catch (error) {
    throw requestError(action.name, error, timeoutMs);
  }

  const location = response.headers.get("location");
  if (response.status >= 300 && response.status < 400 && location && !body.trim()) {
    body = `Redirect (not followed) to ${resolveLocation(location, request.url)}`;
  }
  const contentType = response.headers.get("content-type") ?? undefined;
  return {
    ok: response.status >= 200 && response.status < 400,
    status: response.status,
    ...(contentType ? { contentType } : {}),
    body,
    truncated,
  };
}

export function registerActionTools(
  server: McpServer,
  actions: ActionDefinition[],
  options: RegisterActionOptions,
): void {
  for (const raw of actions) {
    const parsed = actionDefinitionSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`);
      throw new Error(`Invalid action "${actionLabel(raw, 0)}": ${issues.join("; ")}`);
    }
    registerActionTool(server, parsed.data, options);
  }
}

function registerActionTool(server: McpServer, action: ActionDefinition, options: RegisterActionOptions): void {
  const needsConfirmation = action.confirm !== false;
  const origin = actionOrigin(action.url) ?? httpOrigin(options.siteUrl) ?? options.siteUrl;
  const suffix = needsConfirmation
    ? ` (Sends a ${action.method} request to ${origin}; requires user approval.)`
    : ` (Sends a ${action.method} request to ${origin}.)`;

  server.registerTool(
    `action_${action.name}`,
    {
      description: `${action.description}${suffix}`,
      inputSchema: actionInputShape(action),
      annotations: {
        readOnlyHint: false,
        destructiveHint: action.destructive ?? false,
        openWorldHint: true,
        idempotentHint: action.method === "GET",
      },
    },
    async (args, extra) => {
      const started = Date.now();
      const input = args as Record<string, unknown>;
      const useElicitation = needsConfirmation && supportsFormElicitation(server);
      const confirmedVia: ActionRunEvent["confirmedVia"] = !needsConfirmation
        ? "not-required"
        : useElicitation
          ? "elicitation"
          : "argument";
      const report = (event: Pick<ActionRunEvent, "ok" | "status" | "error">) => {
        try {
          options.onRun?.({ action: action.name, confirmedVia, durationMs: Date.now() - started, ...event });
        } catch {
          // Logging must never break the tool call.
        }
      };

      let preview: ActionRequestPreview;
      try {
        preview = redactPreview(buildActionRequest(action, input, options.env));
      } catch (error) {
        const message = errorMessage(error);
        report({ ok: false, error: message });
        return toolError(message);
      }

      if (input[RESERVED_FIELD] === false) return textResult(previewText(action, preview));

      if (useElicitation) {
        let approved: boolean;
        try {
          const result = await server.server.elicitInput(
            {
              mode: "form",
              message: approvalMessage(preview),
              requestedSchema: {
                type: "object",
                properties: {
                  approved: {
                    type: "boolean",
                    title: "Send this request?",
                    description: "Choose yes only if you approve the request shown above.",
                    default: false,
                  },
                },
                required: ["approved"],
              },
            },
            { relatedRequestId: extra.requestId, signal: extra.signal, timeout: APPROVAL_TIMEOUT_MS },
          );
          approved = result.action === "accept" && result.content?.approved === true;
        } catch (error) {
          const message = `Could not get user approval for ${action.name}: ${errorMessage(error)}`;
          report({ ok: false, error: message });
          return toolError(message);
        }
        if (!approved) {
          report({ ok: false, error: "cancelled" });
          return textResult(`Cancelled: the user did not approve ${action.name}.`);
        }
      } else if (needsConfirmation && input[RESERVED_FIELD] !== true) {
        return textResult(previewText(action, preview));
      }

      try {
        const result = await executeAction(action, input, {
          fetchImpl: options.fetchImpl,
          env: options.env,
          lookupImpl: options.lookupImpl,
          allowPrivateHosts: options.allowPrivateHosts,
        });
        const failed = result.status >= 400;
        report({ ok: result.ok, status: result.status, ...(failed ? { error: `HTTP ${result.status}` } : {}) });
        const payload: Record<string, unknown> = { ...result };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload) }],
          structuredContent: payload,
          ...(failed ? { isError: true } : {}),
        };
      } catch (error) {
        const message = errorMessage(error);
        report({ ok: false, error: message });
        return toolError(message);
      }
    },
  );
}

export function suggestActionsFromHtml(html: string, pageUrl: URL): FormSuggestion[] {
  const { document } = parseHTML(html);
  const page = new URL(pageUrl.href);
  page.hash = "";
  const suggestions: FormSuggestion[] = [];
  const usedNames = new Set<string>();
  let precedingHeading: string | undefined;

  for (const element of Array.from(document.querySelectorAll("form, h1, h2, h3, h4, h5, h6")) as Element[]) {
    if (element.tagName.toLowerCase() !== "form") {
      if (!element.closest("form")) precedingHeading = cleanText(element.textContent) || precedingHeading;
      continue;
    }
    const suggestion = suggestForm(element, document as unknown as Document, page, precedingHeading, usedNames);
    if (suggestion) suggestions.push(suggestion);
  }
  return suggestions;
}

interface CollectedFields {
  input: Record<string, ActionField>;
  userControls: Array<{ name: string; type: string }>;
}

function suggestForm(
  form: Element,
  document: Document,
  page: URL,
  precedingHeading: string | undefined,
  usedNames: Set<string>,
): FormSuggestion | undefined {
  const rawMethod = (form.getAttribute("method") ?? "get").trim().toLowerCase();
  if (rawMethod === "dialog") return undefined;
  const method = rawMethod === "post" ? "POST" : "GET";

  let target: URL;
  try {
    target = new URL(form.getAttribute("action")?.trim() || page.href, page);
  } catch {
    return undefined;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return undefined;
  target.hash = "";
  target.username = "";
  target.password = "";
  if (method === "GET") target.search = "";

  const notes: string[] = [];
  const { input, userControls } = collectFields(form, document, notes);
  if (method === "GET" && looksLikeSearch(form, userControls)) return undefined;
  if (method === "GET" && Object.keys(input).length === 0) return undefined;

  const innerHeading = cleanText(form.querySelector("h1, h2, h3, h4, h5, h6")?.textContent);
  const heading = innerHeading || precedingHeading;
  const ariaLabel = cleanText(form.getAttribute("aria-label"));
  const candidates = [
    form.getAttribute("id"),
    form.getAttribute("name"),
    ariaLabel,
    heading,
    lastPathSegment(target),
    "form",
  ];
  const base = candidates.map((candidate) => slugify(candidate ?? "")).find(Boolean) ?? "form";
  const name = suggestActionName(base, usedNames);
  const title = truncate(heading || ariaLabel || name, 100);

  let bodyType: ActionDefinition["bodyType"] = "query";
  if (method === "POST") {
    bodyType = "form";
    if ((form.getAttribute("enctype") ?? "").toLowerCase().includes("multipart/form-data")) {
      notes.push(
        "This form uses multipart/form-data, which website2mcp doesn't support; fields will be sent as application/x-www-form-urlencoded instead.",
      );
    }
  }
  if (target.origin !== page.origin) {
    notes.push(`The form submits to ${target.origin}; add it to allowedOrigins if you trust it.`);
  }

  const action: ActionDefinition = {
    name,
    description: `Submit the '${title}' form on ${page.pathname}.`,
    method,
    url: target.href.replace(/\{/g, "%7B").replace(/\}/g, "%7D"),
    ...(Object.keys(input).length > 0 ? { input } : {}),
    bodyType,
    confirm: true,
    destructive: false,
  };
  return { page: page.href, action, notes };
}

function collectFields(form: Element, document: Document, notes: string[]): CollectedFields {
  const input: Record<string, ActionField> = {};
  const userControls: Array<{ name: string; type: string }> = [];
  const noted = new Set<string>();
  const note = (message: string) => {
    if (!noted.has(message)) {
      noted.add(message);
      notes.push(message);
    }
  };

  const controls = Array.from(form.querySelectorAll("input, select, textarea, button")) as Element[];
  const formId = form.getAttribute("id");
  if (formId) {
    for (const element of Array.from(document.querySelectorAll("input, select, textarea, button")) as Element[]) {
      if (element.getAttribute("form") === formId && !controls.includes(element)) controls.push(element);
    }
  }

  const checkboxCounts = new Map<string, number>();
  for (const control of controls) {
    if (controlType(control) === "checkbox") {
      const name = control.getAttribute("name") ?? "";
      checkboxCounts.set(name, (checkboxCounts.get(name) ?? 0) + 1);
    }
  }

  let csrfDetected = false;
  for (const control of controls) {
    const name = control.getAttribute("name") ?? "";
    if (!name.trim() || control.hasAttribute("disabled")) continue;
    const type = controlType(control);

    if (type === "submit" || type === "button" || type === "image" || type === "reset") {
      const value = control.getAttribute("value");
      if (type === "submit" && value) {
        note(`Submit button '${name}' sends the value '${value}', which the site may expect; it was not included.`);
      }
      continue;
    }
    if (type === "hidden") {
      note(`Hidden field '${name}' (may be a CSRF token or tracking value) was not included.`);
      if (CSRF_NAME_RE.test(name)) csrfDetected = true;
      continue;
    }
    if (type === "file") {
      note(`File field '${name}' was not included; file uploads aren't supported.`);
      continue;
    }
    if (type === "password") {
      note(`Password field '${name}' was not included.`);
      continue;
    }
    if (name === RESERVED_FIELD) {
      note(`Field '${name}' was not included because the name is reserved by website2mcp.`);
      continue;
    }
    if (name.length > MAX_FIELD_NAME) {
      note(`Field '${truncate(name, 40)}' was not included because its name is too long.`);
      continue;
    }

    if (type === "radio") {
      const value = control.getAttribute("value") ?? "on";
      const existing = input[name];
      if (existing) {
        if (existing.enum && !existing.enum.includes(value)) existing.enum.push(value);
        if (control.hasAttribute("required")) existing.required = true;
        if (control.hasAttribute("checked") && existing.default === undefined) existing.default = value;
        continue;
      }
      const description = groupDescription(control);
      input[name] = {
        type: "string",
        enum: [value],
        ...(description ? { description } : {}),
        ...(control.hasAttribute("required") ? { required: true } : {}),
        ...(control.hasAttribute("checked") ? { default: value } : {}),
      };
      userControls.push({ name, type });
      continue;
    }

    if (type === "checkbox" && (checkboxCounts.get(name) ?? 0) > 1) {
      const value = control.getAttribute("value") ?? "on";
      const existing = input[name];
      if (existing) {
        if (existing.enum && !existing.enum.includes(value)) existing.enum.push(value);
        continue;
      }
      const description = groupDescription(control);
      note(`Checkbox group '${name}' allows multiple values; only one value can be sent.`);
      input[name] = { type: "string", enum: [value], ...(description ? { description } : {}) };
      userControls.push({ name, type });
      continue;
    }

    if (Object.hasOwn(input, name)) continue;
    const field = describeControl(control, type, name, note);
    if (!field) continue;
    const description = fieldDescription(control, document);
    input[name] = {
      ...field,
      ...(description ? { description } : {}),
      ...(control.hasAttribute("required") ? { required: true } : {}),
    };
    userControls.push({ name, type });
  }

  if (csrfDetected) {
    note("This form appears to use CSRF protection; requests without a valid token will likely be rejected.");
  }
  return { input, userControls };
}

function describeControl(
  control: Element,
  type: string,
  name: string,
  note: (message: string) => void,
): ActionField | undefined {
  const value = control.getAttribute("value");
  if (type === "select") {
    const values: string[] = [];
    let selected: string | undefined;
    for (const option of Array.from(control.querySelectorAll("option")) as Element[]) {
      const optionValue = option.getAttribute("value") ?? cleanText(option.textContent);
      if (!optionValue || values.includes(optionValue)) continue;
      values.push(optionValue);
      if (option.hasAttribute("selected") && selected === undefined) selected = optionValue;
    }
    if (control.hasAttribute("multiple")) {
      note(`Select '${name}' allows multiple values; only one value can be sent.`);
    }
    if (values.length === 0 || values.length > MAX_ENUM_VALUES) return { type: "string" };
    return { type: "string", enum: values, ...(selected !== undefined ? { default: selected } : {}) };
  }
  if (type === "textarea") return { type: "string" };
  if (type === "checkbox") {
    if (value && !["on", "true", "1"].includes(value.toLowerCase())) {
      note(`Checkbox '${name}' is sent as "true" when checked; the original form sends "${value}".`);
    }
    return { type: "boolean", ...(control.hasAttribute("checked") ? { default: true } : {}) };
  }
  if (type === "number" || type === "range") {
    const initial = value !== null && value.trim() !== "" ? Number(value) : Number.NaN;
    return { type: "number", ...(Number.isFinite(initial) ? { default: initial } : {}) };
  }

  const initial = value ? { default: value } : {};
  if (type === "email") return { type: "string", format: "email", ...initial };
  if (type === "url") return { type: "string", format: "uri", ...initial };
  if (type === "date") return { type: "string", format: "date", ...initial };
  return { type: "string", ...initial };
}

function controlType(control: Element): string {
  const tag = control.tagName.toLowerCase();
  if (tag === "select" || tag === "textarea") return tag;
  if (tag === "button") return (control.getAttribute("type") ?? "submit").trim().toLowerCase() || "submit";
  return (control.getAttribute("type") ?? "text").trim().toLowerCase() || "text";
}

function looksLikeSearch(form: Element, userControls: Array<{ name: string; type: string }>): boolean {
  if (form.getAttribute("role") === "search" || form.closest("[role=search], search")) return true;
  if (userControls.length !== 1) return false;
  const [control] = userControls;
  return control.type === "search" || SEARCH_NAME_RE.test(control.name);
}

function fieldDescription(control: Element, document: Document): string | undefined {
  const id = control.getAttribute("id");
  if (id) {
    for (const label of Array.from(document.querySelectorAll("label")) as Element[]) {
      if (label.getAttribute("for") === id) {
        const text = labelText(label);
        if (text) return text;
      }
    }
  }
  const wrapping = control.closest("label");
  const wrappingText = wrapping ? labelText(wrapping) : "";
  if (wrappingText) return wrappingText;
  return (
    cleanText(control.getAttribute("placeholder")) ||
    cleanText(control.getAttribute("aria-label")) ||
    cleanText(control.getAttribute("title")) ||
    undefined
  );
}

function groupDescription(control: Element): string | undefined {
  const legend = control.closest("fieldset")?.querySelector("legend");
  const group = control.closest("[role=radiogroup], [role=group]");
  return cleanText(legend?.textContent) || cleanText(group?.getAttribute("aria-label")) || undefined;
}

function labelText(label: Element): string {
  const clone = label.cloneNode(true) as Element;
  for (const nested of Array.from(clone.querySelectorAll("input, select, textarea, button")) as Element[]) {
    nested.remove();
  }
  return cleanText(clone.textContent);
}

function cleanText(text: string | null | undefined): string {
  if (!text) return "";
  return truncate(text.replace(/\s+/g, " ").trim().replace(/[\s:*]+$/, ""), 200);
}

function slugify(text: string): string {
  let slug = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!slug) return "";
  if (!/^[a-z]/.test(slug)) slug = `submit_${slug}`;
  return slug.slice(0, 48).replace(/_+$/, "");
}

export function suggestActionName(value: string, used: Set<string>): string {
  const base = slugify(value) || "action";
  let name = base;
  for (let counter = 2; used.has(name); counter += 1) {
    const suffix = `_${counter}`;
    name = `${base.slice(0, 48 - suffix.length).replace(/_+$/, "")}${suffix}`;
  }
  used.add(name);
  return name;
}

function lastPathSegment(url: URL): string {
  const segment = url.pathname.split("/").filter(Boolean).pop() ?? "";
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function fieldSchema(field: ActionField): z.ZodTypeAny {
  let schema: z.ZodTypeAny;
  switch (field.type) {
    case "string":
      schema = stringSchema(field);
      break;
    case "number":
      schema = z.number();
      break;
    case "integer":
      schema = z.number().int();
      break;
    case "boolean":
      schema = z.boolean();
      break;
  }
  if (field.default !== undefined) schema = schema.default(field.default);
  else if (!field.required) schema = schema.optional();
  return field.description ? schema.describe(field.description) : schema;
}

function stringSchema(field: ActionField): z.ZodTypeAny {
  if (field.enum?.length) return z.enum(field.enum as [string, ...string[]]);
  switch (field.format) {
    case "email":
      return z.email();
    case "uri":
      return z.url({ protocol: /^https?$/ });
    case "date":
      return z.iso.date();
    default:
      return z.string().max(10_000);
  }
}

function defaultMatchesField(field: ActionField, value: string | number | boolean): boolean {
  switch (field.type) {
    case "string":
      return typeof value === "string" && (!field.enum || field.enum.includes(value));
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
  }
}

function hasUnsupportedTemplate(text: string): boolean {
  return text.replace(ENV_PLACEHOLDER_RE, "").includes("${");
}

function checkActionUrl(url: string, allowed: Set<string>): string | undefined {
  const prefix = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(url)?.[0];
  if (!prefix) return "must be an absolute http(s) URL";
  if (/[{}$]/.test(prefix)) return "placeholders are not allowed in the scheme or host";
  let parsed: URL;
  try {
    parsed = new URL(url.replace(FIELD_PLACEHOLDER_RE, "x"));
  } catch {
    return "is not a valid URL";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "must use http or https";
  if (parsed.username || parsed.password) return "must not contain credentials; use headers instead";
  if (!allowed.has(parsed.origin)) {
    return `origin ${parsed.origin} is not the site origin; add it to allowedOrigins to permit it`;
  }
  return undefined;
}

function httpOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function actionOrigin(url: string): string | undefined {
  return httpOrigin(url.replace(FIELD_PLACEHOLDER_RE, "x"));
}

function actionLabel(raw: unknown, index: number): string {
  const name = raw && typeof raw === "object" ? (raw as { name?: unknown }).name : undefined;
  return typeof name === "string" && name ? `Action "${name}"` : `Action #${index + 1}`;
}

function expandEnv(
  text: string,
  actionName: string,
  env: Record<string, string | undefined>,
  encode: (value: string) => string = (value) => value,
): string {
  return text.replace(ENV_PLACEHOLDER_RE, (_match, name: string) => {
    const value = env[name];
    if (value === undefined || value === "") {
      throw new Error(`Action "${actionName}" needs environment variable ${name}.`);
    }
    return encode(value);
  });
}

function setDefaultHeader(headers: Record<string, string>, name: string, value: string): void {
  if (!Object.keys(headers).some((key) => key.toLowerCase() === name)) headers[name] = value;
}

function redactUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  const sensitive = [...new Set(url.searchParams.keys())].filter((name) => SENSITIVE_PARAM_RE.test(name));
  if (sensitive.length === 0) return value;
  const marker = "__website2mcp_redacted__";
  for (const name of sensitive) url.searchParams.set(name, marker);
  return url.toString().replaceAll(marker, REDACTED);
}

async function readLimited(response: Response, maxChars: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) {
    const text = typeof response.text === "function" ? await response.text() : "";
    return text.length > maxChars ? { text: text.slice(0, maxChars), truncated: true } : { text, truncated: false };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > maxChars) {
        truncated = true;
        break;
      }
    }
    if (!truncated) text += decoder.decode();
  } finally {
    if (truncated) await reader.cancel().catch(() => undefined);
    else reader.releaseLock();
  }
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }
  return { text, truncated };
}

function resolveLocation(location: string, base: string): string {
  try {
    return new URL(location, base).href;
  } catch {
    return location;
  }
}

function requestError(actionName: string, error: unknown, timeoutMs: number): Error {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new Error(`Action "${actionName}" timed out after ${timeoutMs} ms.`);
  }
  const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : "";
  return new Error(`Action "${actionName}" request failed: ${errorMessage(error)}${cause}`);
}

function supportsFormElicitation(server: McpServer): boolean {
  const elicitation = server.server.getClientCapabilities()?.elicitation;
  if (!elicitation) return false;
  return elicitation.form !== undefined || Object.keys(elicitation).length === 0;
}

function approvalMessage(preview: ActionRequestPreview): string {
  const lines = ["Allow website2mcp to send this request?", `${preview.method} ${preview.url}`];
  if (preview.body) lines.push(truncate(preview.body, 1000));
  return lines.join("\n");
}

function previewText(action: ActionDefinition, preview: ActionRequestPreview): string {
  const lines = [
    `Preview of action "${action.name}" (not sent yet):`,
    `${preview.method} ${preview.url}`,
    ...Object.entries(preview.headers).map(([name, value]) => `${name}: ${value}`),
  ];
  if (preview.body) lines.push("", truncate(preview.body, 4000));
  lines.push(
    "",
    "Show this to the user. If they approve, call this tool again with the same arguments and confirmed: true.",
  );
  return lines.join("\n");
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function toolError(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}
