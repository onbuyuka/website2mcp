import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface AnalyticsEvent {
  ts: string;
  tool: string;
  client?: string;
  transport?: "stdio" | "http";
  auth?: "anonymous" | "token";
  query?: string;
  pageId?: string;
  pathPrefix?: string;
  itemType?: string;
  resultCount?: number;
  ok: boolean;
  error?: string;
  durationMs: number;
}

export interface AnalyticsSink {
  record(event: AnalyticsEvent): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface AnalyticsSummary {
  from?: string;
  to?: string;
  totalCalls: number;
  errorCalls: number;
  byTool: Array<{ tool: string; calls: number; errors: number }>;
  byClient: Array<{ client: string; calls: number }>;
  byDay: Array<{ day: string; calls: number }>;
  topQueries: Array<{ query: string; count: number; avgResults: number }>;
  zeroResultQueries: Array<{ query: string; count: number }>;
  topPages: Array<{ pageId: string; count: number }>;
  actions: Array<{ action: string; runs: number; failures: number }>;
  latencyMs: { p50: number; p95: number; max: number };
}

const MAX_TEXT_LENGTH = 200;
const MAX_CELL_LENGTH = 60;
const ACTION_PREFIX = "action_";
const QUERY_TOOLS = new Set(["search", "query_items"]);
const PAGE_TOOLS = new Set(["fetch", "resource"]);

export function createJsonlAnalytics(
  filePath: string,
  options: { redactQueries?: boolean } = {},
): AnalyticsSink {
  const target = path.resolve(filePath);
  const redact = options.redactQueries === true;
  let pending: string[] = [];
  let chain: Promise<void> = Promise.resolve();
  let scheduled = false;
  let closed = false;
  let directoryReady = false;
  let reported = false;

  const report = (error: unknown): void => {
    if (reported) return;
    reported = true;
    const message = error instanceof Error ? error.message : String(error);
    try {
      process.stderr.write(`site2mcp: analytics write failed: ${message}\n`);
    } catch {
      // stderr unavailable; nothing else we can do
    }
  };

  const writeBatch = async (): Promise<void> => {
    scheduled = false;
    const lines = pending;
    pending = [];
    if (lines.length === 0) return;
    try {
      if (!directoryReady) {
        await mkdir(path.dirname(target), { recursive: true });
        directoryReady = true;
      }
      await appendFile(target, lines.join(""), "utf8");
    } catch (error) {
      report(error);
    }
  };

  const flush = async (): Promise<void> => {
    let current: Promise<void>;
    do {
      current = chain;
      await current;
    } while (current !== chain);
  };

  return {
    record(event: AnalyticsEvent): void {
      if (closed) return;
      try {
        pending.push(`${JSON.stringify(sanitizeEvent(event, redact))}\n`);
      } catch (error) {
        report(error);
        return;
      }
      if (!scheduled) {
        scheduled = true;
        chain = chain.then(writeBatch);
      }
    },
    flush,
    async close(): Promise<void> {
      closed = true;
      await flush();
    },
  };
}

export function createMemoryAnalytics(): AnalyticsSink & { events: AnalyticsEvent[] } {
  const events: AnalyticsEvent[] = [];
  let closed = false;
  return {
    events,
    record(event: AnalyticsEvent): void {
      if (closed) return;
      try {
        events.push(sanitizeEvent(event, false));
      } catch {
        // never throw into callers
      }
    },
    async flush(): Promise<void> {},
    async close(): Promise<void> {
      closed = true;
    },
  };
}

export async function readAnalytics(
  filePath: string,
): Promise<{ events: AnalyticsEvent[]; invalidLines: number }> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { events: [], invalidLines: 0 };
    throw error;
  }
  const events: AnalyticsEvent[] = [];
  let invalidLines = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const event = parseEventLine(line);
    if (event) events.push(event);
    else invalidLines += 1;
  }
  return { events, invalidLines };
}

export function summarizeAnalytics(
  events: AnalyticsEvent[],
  options: { top?: number; since?: Date } = {},
): AnalyticsSummary {
  const top = Math.max(0, Math.floor(options.top ?? 10));
  const sinceTime = options.since?.getTime();
  const selected = sinceTime === undefined
    ? events
    : events.filter((event) => {
      const time = Date.parse(event.ts);
      return !Number.isNaN(time) && time >= sinceTime;
    });

  let errorCalls = 0;
  let earliest: { time: number; ts: string } | undefined;
  let latest: { time: number; ts: string } | undefined;
  const tools = new Map<string, { calls: number; errors: number }>();
  const clients = new Map<string, number>();
  const days = new Map<string, number>();
  const queries = new Map<string, { count: number; resultTotal: number; resultSamples: number }>();
  const zeroResults = new Map<string, number>();
  const pages = new Map<string, number>();
  const actions = new Map<string, { runs: number; failures: number }>();
  const durations: number[] = [];

  for (const event of selected) {
    if (!event.ok) errorCalls += 1;

    const time = Date.parse(event.ts);
    if (!Number.isNaN(time)) {
      if (!earliest || time < earliest.time) earliest = { time, ts: event.ts };
      if (!latest || time > latest.time) latest = { time, ts: event.ts };
      increment(days, new Date(time).toISOString().slice(0, 10));
    }

    const tool = tools.get(event.tool) ?? { calls: 0, errors: 0 };
    tool.calls += 1;
    if (!event.ok) tool.errors += 1;
    tools.set(event.tool, tool);

    increment(clients, event.client?.trim() || "unknown");

    if (QUERY_TOOLS.has(event.tool) && typeof event.query === "string") {
      const query = normalizeQuery(event.query);
      if (query) {
        const stats = queries.get(query) ?? { count: 0, resultTotal: 0, resultSamples: 0 };
        stats.count += 1;
        if (typeof event.resultCount === "number" && Number.isFinite(event.resultCount)) {
          stats.resultTotal += event.resultCount;
          stats.resultSamples += 1;
        }
        queries.set(query, stats);
        if (event.resultCount === 0) increment(zeroResults, query);
      }
    }

    if (PAGE_TOOLS.has(event.tool) && event.pageId) increment(pages, event.pageId);

    if (event.tool.startsWith(ACTION_PREFIX)) {
      const name = event.tool.slice(ACTION_PREFIX.length);
      const stats = actions.get(name) ?? { runs: 0, failures: 0 };
      stats.runs += 1;
      if (!event.ok) stats.failures += 1;
      actions.set(name, stats);
    }

    if (Number.isFinite(event.durationMs)) durations.push(event.durationMs);
  }

  durations.sort((a, b) => a - b);

  return {
    from: earliest?.ts,
    to: latest?.ts,
    totalCalls: selected.length,
    errorCalls,
    byTool: [...tools]
      .map(([tool, stats]) => ({ tool, calls: stats.calls, errors: stats.errors }))
      .sort((a, b) => b.calls - a.calls || compareText(a.tool, b.tool)),
    byClient: [...clients]
      .map(([client, calls]) => ({ client, calls }))
      .sort((a, b) => b.calls - a.calls || compareText(a.client, b.client)),
    byDay: [...days]
      .map(([day, calls]) => ({ day, calls }))
      .sort((a, b) => compareText(a.day, b.day)),
    topQueries: [...queries]
      .map(([query, stats]) => ({
        query,
        count: stats.count,
        avgResults: stats.resultSamples === 0 ? 0 : round1(stats.resultTotal / stats.resultSamples),
      }))
      .sort((a, b) => b.count - a.count || compareText(a.query, b.query))
      .slice(0, top),
    zeroResultQueries: [...zeroResults]
      .map(([query, count]) => ({ query, count }))
      .sort((a, b) => b.count - a.count || compareText(a.query, b.query))
      .slice(0, top),
    topPages: [...pages]
      .map(([pageId, count]) => ({ pageId, count }))
      .sort((a, b) => b.count - a.count || compareText(a.pageId, b.pageId))
      .slice(0, top),
    actions: [...actions]
      .map(([action, stats]) => ({ action, runs: stats.runs, failures: stats.failures }))
      .sort((a, b) => b.runs - a.runs || compareText(a.action, b.action)),
    latencyMs: {
      p50: percentile(durations, 50),
      p95: percentile(durations, 95),
      max: durations.length === 0 ? 0 : durations[durations.length - 1]!,
    },
  };
}

export function formatAnalyticsSummary(summary: AnalyticsSummary): string {
  if (summary.totalCalls === 0) return "No analytics events recorded yet.\n";

  const errorRate = round1((summary.errorCalls / summary.totalCalls) * 100);
  const lines: string[] = [
    `site2mcp analytics (${formatTime(summary.from)} to ${formatTime(summary.to)}): `
      + `${summary.totalCalls} ${plural(summary.totalCalls, "call")}, `
      + `${summary.errorCalls} ${plural(summary.errorCalls, "error")} (${errorRate}%)`,
  ];

  const section = (title: string, body: string[]): void => {
    lines.push("", title, ...body);
  };

  section("Tools", table(
    ["tool", "calls", "errors"],
    summary.byTool.map((row) => [row.tool, row.calls, row.errors]),
  ));
  section("Clients", table(
    ["client", "calls"],
    summary.byClient.map((row) => [row.client, row.calls]),
  ));
  section("Top searches", table(
    ["query", "count", "avg results"],
    summary.topQueries.map((row) => [row.query, row.count, row.avgResults]),
  ));
  section("Searches with no results (content gaps)", table(
    ["query", "count"],
    summary.zeroResultQueries.map((row) => [row.query, row.count]),
  ));
  section("Most fetched pages", table(
    ["page", "count"],
    summary.topPages.map((row) => [row.pageId, row.count]),
  ));
  if (summary.actions.length > 0) {
    section("Actions", table(
      ["action", "runs", "failures"],
      summary.actions.map((row) => [row.action, row.runs, row.failures]),
    ));
  }
  const { p50, p95, max } = summary.latencyMs;
  section("Latency p50/p95/max", [`  ${formatNumber(p50)} ms / ${formatNumber(p95)} ms / ${formatNumber(max)} ms`]);

  return `${lines.join("\n")}\n`;
}

function sanitizeEvent(event: AnalyticsEvent, redact: boolean): AnalyticsEvent {
  const result: Partial<AnalyticsEvent> = {
    ts: typeof event.ts === "string" && event.ts ? event.ts : new Date().toISOString(),
    tool: String(event.tool),
  };
  if (event.client !== undefined) result.client = event.client;
  if (event.transport !== undefined) result.transport = event.transport;
  if (event.auth !== undefined) result.auth = event.auth;
  if (typeof event.query === "string") {
    const query = event.query.trim();
    if (query) result.query = redact ? hashQuery(query) : clip(query);
  }
  if (event.pageId !== undefined) result.pageId = event.pageId;
  if (event.pathPrefix !== undefined) result.pathPrefix = event.pathPrefix;
  if (event.itemType !== undefined) result.itemType = event.itemType;
  if (event.resultCount !== undefined) result.resultCount = event.resultCount;
  result.ok = event.ok === true;
  if (event.error !== undefined) result.error = clip(String(event.error));
  result.durationMs = Number.isFinite(event.durationMs) ? Math.max(0, Math.round(event.durationMs)) : 0;
  return result as AnalyticsEvent;
}

function parseEventLine(line: string): AnalyticsEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const event = value as Partial<AnalyticsEvent>;
  if (typeof event.ts !== "string" || Number.isNaN(Date.parse(event.ts))) return undefined;
  if (typeof event.tool !== "string" || event.tool === "") return undefined;
  if (typeof event.ok !== "boolean") return undefined;
  if (typeof event.durationMs !== "number" || !Number.isFinite(event.durationMs)) return undefined;
  return event as AnalyticsEvent;
}

function hashQuery(query: string): string {
  return `sha256:${createHash("sha256").update(normalizeQuery(query)).digest("hex").slice(0, 12)}`;
}

function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

function clip(value: string, max = MAX_TEXT_LENGTH): string {
  if (value.length <= max) return value;
  return Array.from(value).slice(0, max).join("");
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

function formatTime(value: string | undefined): string {
  if (!value) return "?";
  const time = Date.parse(value);
  if (Number.isNaN(time)) return value;
  return `${new Date(time).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function table(headers: string[], rows: Array<Array<string | number>>): string[] {
  if (rows.length === 0) return ["  (none)"];
  const numeric = headers.map((_, index) => rows.every((row) => typeof row[index] === "number"));
  const cells = [
    headers,
    ...rows.map((row) => row.map((cell) =>
      typeof cell === "number" ? formatNumber(cell) : truncateCell(cell))),
  ];
  const widths = headers.map((_, index) => Math.max(...cells.map((row) => row[index]!.length)));
  return cells.map((row) => {
    const padded = row.map((cell, index) =>
      numeric[index] ? cell.padStart(widths[index]!) : cell.padEnd(widths[index]!));
    return `  ${padded.join("  ")}`.trimEnd();
  });
}

function truncateCell(value: string): string {
  const flat = value.replace(/\s+/g, " ");
  return flat.length <= MAX_CELL_LENGTH ? flat : `${clip(flat, MAX_CELL_LENGTH - 3)}...`;
}
