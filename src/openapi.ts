import { readFile, stat } from "node:fs/promises";
import { parseDocument } from "yaml";
import { suggestActionName, validateActions } from "./actions.js";
import { DEFAULT_USER_AGENT } from "./crawl.js";
import { isPrivateTarget } from "./source.js";
import type { ActionDefinition, ActionField, CrawlOptions } from "./types.js";
import { assertPublicHost, normalizeUrl } from "./url.js";

const MAX_SPEC_BYTES = 5 * 1024 * 1024;
const METHODS = new Map<string, ActionDefinition["method"]>([
  ["get", "GET"], ["post", "POST"], ["put", "PUT"], ["patch", "PATCH"], ["delete", "DELETE"],
]);
const SENSITIVE_FIELD = /password|secret|token|api[-_]?key|authorization/i;
type ObjectValue = Record<string, unknown>;

export interface OpenApiImportOptions {
  baseUrl?: string;
  documentUrl?: string;
}

export interface OpenApiImportResult {
  actions: ActionDefinition[];
  warnings: string[];
}

class ImportProblem extends Error {}

function object(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ImportProblem(`${label} must be an object.`);
  }
  return value as ObjectValue;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new ImportProblem(`${label} must be an array.`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ImportProblem(`${label} must be a nonempty string.`);
  return value;
}

function resolve(value: unknown, root: ObjectValue): ObjectValue {
  let current = object(value, "Referenced value");
  const seen = new Set<string>();
  const annotations: ObjectValue = {};
  while (Object.hasOwn(current, "$ref")) {
    const ref = text(current.$ref, "$ref");
    if (!ref.startsWith("#/")) throw new ImportProblem("Only local #/ references are supported; bundle external references first.");
    if (seen.has(ref) || seen.size >= 32) throw new ImportProblem("Circular or excessively deep reference.");
    if (Object.keys(current).some((key) => !["$ref", "description", "summary"].includes(key))) {
      throw new ImportProblem("$ref siblings other than description/summary are not supported.");
    }
    for (const key of ["description", "summary"]) {
      if (current[key] !== undefined && annotations[key] === undefined) annotations[key] = current[key];
    }
    seen.add(ref);
    let target: unknown = root;
    let pointer: string;
    try { pointer = decodeURIComponent(ref.slice(2)); }
    catch { throw new ImportProblem("Invalid percent encoding in local reference."); }
    for (const part of pointer.split("/")) {
      const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
      const container = object(target, "Reference target");
      if (!Object.hasOwn(container, key)) throw new ImportProblem(`Unresolved local reference: ${ref}`);
      target = container[key];
    }
    current = object(target, "Reference target");
  }
  return { ...current, ...annotations };
}

export function parseOpenApiDocument(contents: string): unknown {
  if (Buffer.byteLength(contents) > MAX_SPEC_BYTES) throw new Error("OpenAPI document exceeds 5 MiB.");
  const doc = parseDocument(contents, { uniqueKeys: true });
  if (doc.errors.length || doc.warnings.length) {
    throw new Error(`Invalid OpenAPI JSON/YAML: ${[...doc.errors, ...doc.warnings].map((issue) => issue.message).join("; ")}`);
  }
  return doc.toJS({ maxAliasCount: 50 }) as unknown;
}

export async function loadOpenApiDocument(
  source: string,
  options: { userAgent?: string; fetchImpl?: typeof fetch; lookupImpl?: CrawlOptions["lookupImpl"] } = {},
): Promise<{ document: unknown; documentUrl?: string }> {
  if (!/^https?:\/\//i.test(source)) {
    if ((await stat(source)).size > MAX_SPEC_BYTES) throw new Error("OpenAPI document exceeds 5 MiB.");
    return { document: parseOpenApiDocument(await readFile(source, "utf8")) };
  }
  const initial = normalizeUrl(source);
  if (!initial) throw new Error("OpenAPI source must be an HTTP(S) URL without credentials.");
  let url = initial;
  const signal = AbortSignal.timeout(20_000);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (!(isPrivateTarget(initial.hostname) && url.origin === initial.origin)) {
      await assertPublicHost(url.hostname, options.lookupImpl);
    }
    const response = await (options.fetchImpl ?? fetch)(url, {
      headers: { accept: "application/json, application/yaml, text/yaml", "user-agent": options.userAgent ?? DEFAULT_USER_AGENT },
      redirect: "manual",
      signal,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      const next = location ? normalizeUrl(location, url) : undefined;
      if (!next) throw new Error("Invalid OpenAPI redirect.");
      url = next;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Could not load OpenAPI document: HTTP ${response.status}`);
    }
    if (Number(response.headers.get("content-length")) > MAX_SPEC_BYTES) {
      await response.body?.cancel();
      throw new Error("OpenAPI document exceeds 5 MiB.");
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = response.body?.getReader();
    if (reader) {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_SPEC_BYTES) {
            await reader.cancel();
            throw new Error("OpenAPI document exceeds 5 MiB.");
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
    }
    return { document: parseOpenApiDocument(Buffer.concat(chunks).toString("utf8")), documentUrl: url.href };
  }
  throw new Error("Too many OpenAPI redirects (maximum 5).");
}

export function importOpenApiActions(value: unknown, options: OpenApiImportOptions = {}): OpenApiImportResult {
  const root = object(value, "OpenAPI document");
  if (typeof root.openapi !== "string" || !/^3\.(0|1)\.\d+(?:[-+].*)?$/.test(root.openapi)) {
    throw new Error("Expected an OpenAPI 3.0 or 3.1 document (Swagger 2 is not supported).");
  }
  const paths = object(root.paths, "OpenAPI paths");
  if (options.baseUrl) apiBase(options.baseUrl);
  const actions: ActionDefinition[] = [];
  const warnings: string[] = [];
  const names = new Set<string>();
  const envNames = new Map<string, string>();
  const usedEnvNames = new Set<string>();
  const reference = (entry: unknown) => resolve(entry, root);

  for (const [route, rawPath] of Object.entries(paths)) {
    if (route.startsWith("x-")) continue;
    let pathItem: ObjectValue;
    try { pathItem = reference(rawPath); }
    catch (error) {
      if (!(error instanceof ImportProblem)) throw error;
      warnings.push(`Skipped ${route}: ${error.message}`);
      continue;
    }
    for (const [method, rawOperation] of Object.entries(pathItem)) {
      const verb = METHODS.get(method);
      if (!verb) {
        if (["head", "options", "trace"].includes(method)) warnings.push(`Skipped ${method.toUpperCase()} ${route}: method is not supported by actions.`);
        continue;
      }
      const label = `${method.toUpperCase()} ${route}`;
      const notes: string[] = [];
      try {
        if (!route.startsWith("/") || /[?#]|\$\{/.test(route)) throw new ImportProblem("API path must start with / and contain no query, fragment or environment templates.");
        const operation = object(rawOperation, label);
        const servers = operation.servers !== undefined ? operation.servers :
          pathItem.servers !== undefined ? pathItem.servers : root.servers;
        const base = selectServer(servers, options, notes);
        const input: Record<string, ActionField> = {};
        const params = new Map<string, ObjectValue>();
        for (const list of [pathItem.parameters, operation.parameters]) {
          const local = new Set<string>();
          for (const raw of list === undefined ? [] : array(list, "parameters")) {
            const param = reference(raw);
            const name = text(param.name, "Parameter name");
            const key = `${text(param.in, "Parameter location")}:${name}`;
            if (local.has(key)) throw new ImportProblem(`Duplicate parameter: ${key}`);
            local.add(key);
            params.set(key, param);
          }
        }
        const pathFields = new Set<string>();
        let queryCount = 0;
        const addField = (name: string, schema: unknown, required: boolean) => {
          if (["confirmed", "__proto__", "constructor", "prototype"].includes(name) || Object.hasOwn(input, name)) {
            throw new ImportProblem(`Reserved or conflicting input name: ${name}`);
          }
          input[name] = convertField(reference(schema), name, required, notes);
        };
        for (const param of params.values()) {
          const name = text(param.name, "Parameter name");
          if (param.required !== undefined && typeof param.required !== "boolean") {
            throw new ImportProblem(`Parameter ${name}: required must be a boolean.`);
          }
          if (param.in !== "path" && param.in !== "query") throw new ImportProblem(`Parameter ${name}: dynamic ${String(param.in)} parameters are not supported.`);
          const style = param.in === "path" ? "simple" : "form";
          if ((param.style !== undefined && param.style !== style) || param.allowReserved === true || param.content !== undefined) {
            throw new ImportProblem(`Parameter ${name}: unsupported serialization.`);
          }
          if (param.in === "path") {
            if (param.required !== true || !route.includes(`{${name}}`)) throw new ImportProblem(`Path parameter ${name} must be required and match the path.`);
            pathFields.add(name);
          } else queryCount++;
          addField(name, param.schema, param.required === true);
          if (typeof param.description === "string") input[name].description = param.description.slice(0, 1000);
        }
        for (const [, name] of route.matchAll(/\{([^{}]+)\}/g)) {
          if (!pathFields.has(name)) throw new ImportProblem(`Path placeholder ${name} has no declared path parameter.`);
        }
        const headers = authHeaders(operation.security !== undefined ? operation.security : root.security, root, envNames, usedEnvNames, notes);
        let bodyType: ActionDefinition["bodyType"] = "query";
        if (operation.requestBody !== undefined) {
          if (method === "get") throw new ImportProblem("GET request bodies are not supported.");
          if (queryCount) throw new ImportProblem("Mixed query parameters and request bodies are not supported.");
          const body = reference(operation.requestBody);
          if (body.required !== undefined && typeof body.required !== "boolean") {
            throw new ImportProblem("Request body required must be a boolean.");
          }
          const content = object(body.content, "Request body content");
          const mediaType = ["application/json", "application/x-www-form-urlencoded"].find((type) => Object.hasOwn(content, type));
          if (!mediaType) throw new ImportProblem("Only JSON and URL-encoded request bodies are supported.");
          if (Object.keys(content).length > 1) notes.push(`Selected ${mediaType}; other body encodings were not imported.`);
          const media = object(content[mediaType], "Media type");
          if (media.encoding !== undefined && Object.keys(object(media.encoding, "encoding")).length) throw new ImportProblem("Custom body encoding is not supported.");
          const schema = reference(media.schema);
          checkSchema(schema);
          if (schema.type !== "object") throw new ImportProblem("Request body must be a flat object.");
          if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) throw new ImportProblem("Dynamic request body properties are not supported.");
          const properties = object(schema.properties, "Body properties");
          const required = new Set(schema.required === undefined ? [] : array(schema.required, "required").map((key) => text(key, "Required field")));
          for (const key of required) if (!Object.hasOwn(properties, key)) throw new ImportProblem(`Required body field ${key} is not defined.`);
          for (const [name, rawSchema] of Object.entries(properties)) {
            const field = reference(rawSchema);
            if (field.readOnly === true) continue;
            addField(name, field, required.has(name));
            if (mediaType !== "application/json" && input[name].type === "boolean") {
              throw new ImportProblem("Boolean form fields cannot be represented faithfully; use a JSON endpoint.");
            }
          }
          bodyType = mediaType === "application/json" ? "json" : "form";
          if (Object.keys(headers).some((name) => name.toLowerCase() === "content-type")) throw new ImportProblem("Authentication conflicts with Content-Type.");
          headers["content-type"] = mediaType;
          if (body.required !== true) notes.push("The action always sends a body and requires its required properties, even though this API makes the whole body optional.");
        }
        const action: ActionDefinition = {
          name: suggestActionName(typeof operation.operationId === "string" ? operation.operationId : `${method}_${route}`, names),
          description: (typeof operation.summary === "string" && operation.summary.trim() ? operation.summary :
            typeof operation.description === "string" && operation.description.trim() ? operation.description : label).slice(0, 1000),
          method: verb,
          url: `${base.replace(/\/$/, "")}${route}`,
          ...(Object.keys(input).length ? { input } : {}),
          bodyType,
          ...(Object.keys(headers).length ? { headers } : {}),
          confirm: true,
          destructive: method !== "get",
        };
        try { validateActions([action], base); }
        catch (error) { throw new ImportProblem(error instanceof Error ? error.message : String(error)); }
        actions.push(action);
        for (const note of notes) warnings.push(`${label}: ${note}`);
      } catch (error) {
        if (!(error instanceof ImportProblem)) throw error;
        warnings.push(`Skipped ${label}: ${error.message}`);
      }
    }
  }
  if (!actions.length) warnings.push("No importable actions found.");
  return { actions, warnings };
}

function apiBase(value: string, documentUrl?: string): string {
  const url = normalizeUrl(value, documentUrl);
  if (!url || url.search || new URL(value, documentUrl).hash || /[{}]/.test(value)) {
    throw new ImportProblem("API server must be an HTTP(S) URL without credentials, query, fragment or unresolved variables; supply --base-url.");
  }
  return url.href;
}

function selectServer(servers: unknown, options: OpenApiImportOptions, notes: string[]): string {
  if (options.baseUrl) return apiBase(options.baseUrl);
  const choices = servers === undefined ? [] : array(servers, "servers");
  if (!choices.length) return apiBase("/", options.documentUrl);
  if (choices.length > 1) notes.push("Selected the first API server; use --base-url to choose another.");
  const server = object(choices[0], "Server");
  const template = text(server.url, "Server URL");
  const url = template.replace(/\{([^{}]+)\}/g, (_match, name: string) => {
    const variables = object(server.variables, "Server variables");
    if (!Object.hasOwn(variables, name)) throw new ImportProblem(`Missing server variable ${name}; supply --base-url.`);
    const variable = object(variables[name], "Server variable");
    return text(variable.default, `Default for server variable ${name}`);
  });
  return apiBase(url, options.documentUrl);
}

function checkSchema(schema: ObjectValue): void {
  for (const key of ["allOf", "anyOf", "oneOf", "not", "if", "then", "else", "const", "patternProperties", "dependentRequired", "dependentSchemas", "unevaluatedProperties"]) {
    if (schema[key] !== undefined) throw new ImportProblem(`Schema keyword ${key} is not supported.`);
  }
  if (schema.nullable === true) throw new ImportProblem("Nullable fields are not supported.");
}

function convertField(schema: ObjectValue, name: string, required: boolean, notes: string[]): ActionField {
  checkSchema(schema);
  const type = schema.type;
  if (type !== "string" && type !== "number" && type !== "integer" && type !== "boolean") {
    throw new ImportProblem(`Field ${name}: only scalar string/number/integer/boolean schemas are supported.`);
  }
  const field: ActionField = { type, required };
  if (typeof schema.description === "string") field.description = schema.description.slice(0, 1000);
  if (schema.enum !== undefined) {
    const values = array(schema.enum, "enum");
    if (type !== "string" || !values.every((value): value is string => typeof value === "string")) {
      throw new ImportProblem(`Field ${name}: only string enums are supported.`);
    }
    field.enum = values;
  }
  if (schema.format !== undefined) {
    const format = text(schema.format, "format");
    if (["binary", "byte"].includes(format)) throw new ImportProblem(`Field ${name}: binary inputs are not supported.`);
    if (type === "string" && (format === "email" || format === "uri" || format === "date")) field.format = format;
    else notes.push(`Field ${name}: format ${format} must be enforced by the API.`);
  }
  if (["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern"].some((key) => schema[key] !== undefined)) {
    notes.push(`Field ${name}: additional validation constraints must be enforced by the API.`);
  }
  if (schema.default !== undefined) {
    if (SENSITIVE_FIELD.test(name) || schema.format === "password") notes.push(`Field ${name}: sensitive default was not copied.`);
    else if (typeof schema.default === "string" || typeof schema.default === "number" || typeof schema.default === "boolean") field.default = schema.default;
    else throw new ImportProblem(`Field ${name}: non-scalar defaults are not supported.`);
  }
  return field;
}

function authHeaders(
  security: unknown, root: ObjectValue, envNames: Map<string, string>, usedNames: Set<string>, notes: string[],
): Record<string, string> {
  if (security === undefined) return {};
  const alternatives = array(security, "security").map((entry) => object(entry, "Security requirement"));
  if (!alternatives.length) return {};
  const label = (entry: ObjectValue) => Object.keys(entry).join(" + ");
  if (alternatives.length > 1 && alternatives.some((entry) => !Object.keys(entry).length)) {
    notes.push(`Authentication is optional; no credentials were configured (also accepts ${alternatives.filter((entry) => Object.keys(entry).length).map(label).join(", ")}).`);
    return {};
  }
  // Any one listed alternative satisfies the API, so use the first one we can represent.
  const problems: string[] = [];
  for (const alternative of alternatives) {
    let selected: Array<{ name: string; header: string; prefix: string }>;
    try { selected = authAlternative(alternative, root); }
    catch (error) {
      if (!(error instanceof ImportProblem)) throw error;
      problems.push(error.message);
      continue;
    }
    if (alternatives.length > 1) {
      notes.push(`Using ${label(alternative)} authentication; the API also accepts ${alternatives.filter((entry) => entry !== alternative).map(label).join(", ")}.`);
    }
    const headers: Record<string, string> = {};
    for (const { name, header, prefix } of selected) {
      let env = envNames.get(name);
      if (!env) {
        env = `SITE2MCP_${suggestActionName(name, usedNames).toUpperCase()}`;
        envNames.set(name, env);
      }
      headers[header] = `${prefix}\${env:${env}}`;
    }
    return headers;
  }
  if (problems.length === 1) throw new ImportProblem(problems[0]);
  throw new ImportProblem(`No supported authentication alternative: ${[...new Set(problems)].join(" ")}`);
}

function authAlternative(requirement: ObjectValue, root: ObjectValue): Array<{ name: string; header: string; prefix: string }> {
  const selected: Array<{ name: string; header: string; prefix: string }> = [];
  for (const [name, scopes] of Object.entries(requirement)) {
    if (array(scopes, "Security scopes").length) throw new ImportProblem("Scoped authentication requires manual configuration.");
    const schemes = object(object(root.components, "components").securitySchemes, "securitySchemes");
    if (!Object.hasOwn(schemes, name)) throw new ImportProblem(`Unknown security scheme ${name}.`);
    const scheme = resolve(schemes[name], root);
    let header: string;
    let prefix = "";
    if (scheme.type === "http" && typeof scheme.scheme === "string" && scheme.scheme.toLowerCase() === "bearer") {
      header = "Authorization";
      prefix = "Bearer ";
    } else if (scheme.type === "apiKey" && scheme.in === "header") {
      header = text(scheme.name, "API key header");
    } else {
      throw new ImportProblem(`Security scheme ${name}: only HTTP bearer and header API keys can be imported.`);
    }
    if (selected.some((entry) => entry.header.toLowerCase() === header.toLowerCase())) {
      throw new ImportProblem(`Conflicting authentication header ${header}.`);
    }
    selected.push({ name, header, prefix });
  }
  return selected;
}
