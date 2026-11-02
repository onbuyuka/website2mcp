import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createJsonlAnalytics,
  createMemoryAnalytics,
  formatAnalyticsSummary,
  readAnalytics,
  summarizeAnalytics,
  type AnalyticsEvent,
} from "../src/analytics.js";

const directories: string[] = [];

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "site2mcp-analytics-"));
  directories.push(directory);
  return directory;
}

function event(overrides: Partial<AnalyticsEvent> = {}): AnalyticsEvent {
  return {
    ts: "2026-01-01T10:00:00.000Z",
    tool: "search",
    ok: true,
    durationMs: 5,
    ...overrides,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe("createJsonlAnalytics", () => {
  it("writes events in order across ticks and reads them back", async () => {
    const file = path.join(await tempDir(), "analytics.jsonl");
    const sink = createJsonlAnalytics(file);
    for (let index = 0; index < 250; index += 1) {
      sink.record(event({ tool: "fetch", pageId: `page-${index}`, durationMs: index }));
      if (index % 37 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    for (let index = 250; index < 500; index += 1) {
      sink.record(event({ tool: "fetch", pageId: `page-${index}`, durationMs: index }));
    }
    await sink.flush();

    const raw = await readFile(file, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.trimEnd().split("\n")).toHaveLength(500);

    const { events, invalidLines } = await readAnalytics(file);
    expect(invalidLines).toBe(0);
    expect(events.map((item) => item.pageId)).toEqual(
      Array.from({ length: 500 }, (_, index) => `page-${index}`),
    );
    expect(events[3]).toEqual({
      ts: "2026-01-01T10:00:00.000Z",
      tool: "fetch",
      pageId: "page-3",
      ok: true,
      durationMs: 3,
    });
  });

  it("creates missing parent directories", async () => {
    const file = path.join(await tempDir(), "nested", "deeper", "analytics.jsonl");
    const sink = createJsonlAnalytics(file);
    sink.record(event({ query: "brazil", resultCount: 3 }));
    await sink.close();
    const { events } = await readAnalytics(file);
    expect(events).toHaveLength(1);
    expect(events[0]!.query).toBe("brazil");
  });

  it("redacts queries with a deterministic short hash", async () => {
    const file = path.join(await tempDir(), "analytics.jsonl");
    const sink = createJsonlAnalytics(file, { redactQueries: true });
    sink.record(event({ query: "Brazil squad" }));
    sink.record(event({ query: "  brazil   squad " }));
    sink.record(event({ query: "argentina" }));
    await sink.flush();

    const { events } = await readAnalytics(file);
    const [first, second, third] = events.map((item) => item.query!);
    expect(first).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(second).toBe(first);
    expect(third).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(third).not.toBe(first);
    expect(await readFile(file, "utf8")).not.toContain("squad");
  });

  it("trims and truncates long queries and errors", async () => {
    const file = path.join(await tempDir(), "analytics.jsonl");
    const sink = createJsonlAnalytics(file);
    sink.record(event({ query: `   ${"q".repeat(500)}   `, ok: false, error: "e".repeat(1000) }));
    await sink.flush();
    const { events } = await readAnalytics(file);
    expect(events[0]!.query).toBe("q".repeat(200));
    expect(events[0]!.error).toBe("e".repeat(200));
    expect(events[0]!.ok).toBe(false);
  });

  it("ignores records after close", async () => {
    const file = path.join(await tempDir(), "analytics.jsonl");
    const sink = createJsonlAnalytics(file);
    sink.record(event({ pageId: "kept" }));
    await sink.close();
    sink.record(event({ pageId: "dropped" }));
    await sink.flush();
    await sink.close();
    const { events } = await readAnalytics(file);
    expect(events.map((item) => item.pageId)).toEqual(["kept"]);
  });

  it("reports write failures once to stderr without throwing", async () => {
    const directory = await tempDir();
    const target = path.join(directory, "is-a-directory");
    await mkdir(target);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write");

    const sink = createJsonlAnalytics(target);
    expect(() => sink.record(event())).not.toThrow();
    await expect(sink.flush()).resolves.toBeUndefined();
    sink.record(event());
    sink.record(event());
    await expect(sink.close()).resolves.toBeUndefined();

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]![0])).toMatch(/^site2mcp: analytics write failed: .+\n$/);
    expect(stdout).not.toHaveBeenCalled();
  });
});

describe("createMemoryAnalytics", () => {
  it("collects sanitized events and ignores records after close", async () => {
    const sink = createMemoryAnalytics();
    sink.record(event({ query: `  ${"x".repeat(300)}` }));
    await sink.flush();
    await sink.close();
    sink.record(event());
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]!.query).toBe("x".repeat(200));
  });
});

describe("readAnalytics", () => {
  it("skips blank lines and counts invalid ones", async () => {
    const file = path.join(await tempDir(), "analytics.jsonl");
    const lines = [
      JSON.stringify(event({ tool: "search" })),
      "",
      "not json",
      "   ",
      JSON.stringify({ hello: "world" }),
      "[1,2,3]",
      JSON.stringify(event({ tool: "fetch", pageId: "a" })),
      "{\"ts\":\"2026-01-01T00:00:00Z\",\"tool\":\"sea",
    ];
    await writeFile(file, lines.join("\r\n"), "utf8");
    const { events, invalidLines } = await readAnalytics(file);
    expect(events.map((item) => item.tool)).toEqual(["search", "fetch"]);
    expect(invalidLines).toBe(4);
  });

  it("returns nothing for a missing file", async () => {
    const file = path.join(await tempDir(), "missing.jsonl");
    await expect(readAnalytics(file)).resolves.toEqual({ events: [], invalidLines: 0 });
  });
});

describe("summarizeAnalytics", () => {
  const events: AnalyticsEvent[] = [
    event({ ts: "2026-01-02T09:00:00.000Z", tool: "search", client: "vscode 1.2.3", query: "Brazil ", resultCount: 4, durationMs: 10 }),
    event({ ts: "2026-01-02T09:01:00.000Z", tool: "search", client: "vscode 1.2.3", query: "brazil", resultCount: 2, durationMs: 20 }),
    event({ ts: "2026-01-02T09:02:00.000Z", tool: "search", client: "claude 0.9", query: "  BRAZIL  ", resultCount: 0, durationMs: 30 }),
    event({ ts: "2026-01-01T23:59:00.000Z", tool: "query_items", query: "offside   rule", resultCount: 0, durationMs: 40 }),
    event({ ts: "2026-01-03T00:00:00.000Z", tool: "search", query: "Offside rule", resultCount: 0, durationMs: 50 }),
    event({ ts: "2026-01-03T01:00:00.000Z", tool: "fetch", pageId: "teams/br", durationMs: 60 }),
    event({ ts: "2026-01-03T02:00:00.000Z", tool: "fetch", pageId: "teams/br", durationMs: 70 }),
    event({ ts: "2026-01-03T03:00:00.000Z", tool: "resource", pageId: "teams/ar", durationMs: 80 }),
    event({ ts: "2026-01-03T04:00:00.000Z", tool: "action_subscribe", ok: true, durationMs: 90 }),
    event({ ts: "2026-01-03T05:00:00.000Z", tool: "action_subscribe", ok: false, error: "timeout", durationMs: 100 }),
    event({ ts: "2026-01-03T06:00:00.000Z", tool: "action_contact", ok: false, error: "bad input", durationMs: 1 }),
  ];

  it("aggregates tools, clients, days, queries, pages, and actions", () => {
    const summary = summarizeAnalytics(events);
    expect(summary.totalCalls).toBe(11);
    expect(summary.errorCalls).toBe(2);
    expect(summary.from).toBe("2026-01-01T23:59:00.000Z");
    expect(summary.to).toBe("2026-01-03T06:00:00.000Z");
    expect(summary.byTool).toEqual([
      { tool: "search", calls: 4, errors: 0 },
      { tool: "action_subscribe", calls: 2, errors: 1 },
      { tool: "fetch", calls: 2, errors: 0 },
      { tool: "action_contact", calls: 1, errors: 1 },
      { tool: "query_items", calls: 1, errors: 0 },
      { tool: "resource", calls: 1, errors: 0 },
    ]);
    expect(summary.byClient).toEqual([
      { client: "unknown", calls: 8 },
      { client: "vscode 1.2.3", calls: 2 },
      { client: "claude 0.9", calls: 1 },
    ]);
    expect(summary.byDay).toEqual([
      { day: "2026-01-01", calls: 1 },
      { day: "2026-01-02", calls: 3 },
      { day: "2026-01-03", calls: 7 },
    ]);
    expect(summary.topQueries).toEqual([
      { query: "brazil", count: 3, avgResults: 2 },
      { query: "offside rule", count: 2, avgResults: 0 },
    ]);
    expect(summary.zeroResultQueries).toEqual([
      { query: "offside rule", count: 2 },
      { query: "brazil", count: 1 },
    ]);
    expect(summary.topPages).toEqual([
      { pageId: "teams/br", count: 2 },
      { pageId: "teams/ar", count: 1 },
    ]);
    expect(summary.actions).toEqual([
      { action: "subscribe", runs: 2, failures: 1 },
      { action: "contact", runs: 1, failures: 1 },
    ]);
  });

  it("computes nearest-rank latency percentiles", () => {
    const durations = Array.from({ length: 100 }, (_, index) => event({ durationMs: 100 - index }));
    expect(summarizeAnalytics(durations).latencyMs).toEqual({ p50: 50, p95: 95, max: 100 });
    const small = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((durationMs) => event({ durationMs }));
    expect(summarizeAnalytics(small).latencyMs).toEqual({ p50: 50, p95: 100, max: 100 });
    expect(summarizeAnalytics([]).latencyMs).toEqual({ p50: 0, p95: 0, max: 0 });
  });

  it("applies the since filter and top limit", () => {
    const summary = summarizeAnalytics(events, { since: new Date("2026-01-03T00:00:00.000Z"), top: 1 });
    expect(summary.totalCalls).toBe(7);
    expect(summary.from).toBe("2026-01-03T00:00:00.000Z");
    expect(summary.topQueries).toEqual([{ query: "offside rule", count: 1, avgResults: 0 }]);
    expect(summary.topPages).toEqual([{ pageId: "teams/br", count: 2 }]);
    expect(summary.byDay).toEqual([{ day: "2026-01-03", calls: 7 }]);
  });

  it("returns an empty summary for no events", () => {
    const summary = summarizeAnalytics([]);
    expect(summary).toMatchObject({ totalCalls: 0, errorCalls: 0, byTool: [], topQueries: [] });
    expect(summary.from).toBeUndefined();
  });

  it("formats a readable report with all sections", () => {
    const text = formatAnalyticsSummary(summarizeAnalytics(events));
    expect(text).toContain("2026-01-01 23:59 UTC to 2026-01-03 06:00 UTC");
    expect(text).toContain("11 calls, 2 errors");
    for (const heading of [
      "Tools",
      "Clients",
      "Top searches",
      "Searches with no results (content gaps)",
      "Most fetched pages",
      "Actions",
      "Latency p50/p95/max",
    ]) {
      expect(text.split("\n")).toContain(heading);
    }
    expect(text).toMatch(/^ {2}brazil\s+3\s+2$/m);
    expect(text).toMatch(/^ {2}teams\/br\s+2$/m);
    expect(text).toMatch(/^ {2}subscribe\s+2\s+1$/m);
    expect(text).toContain("50 ms / 100 ms / 100 ms");
    expect(text.endsWith("\n")).toBe(true);
    expect(text).not.toContain("\u001b[");
  });

  it("omits the actions section when there are none", () => {
    const text = formatAnalyticsSummary(summarizeAnalytics([event({ query: "x", resultCount: 1 })]));
    expect(text.split("\n")).not.toContain("Actions");
    expect(text).toContain("Searches with no results (content gaps)\n  (none)\n");
  });

  it("prints the empty message when there are no events", () => {
    expect(formatAnalyticsSummary(summarizeAnalytics([]))).toBe("No analytics events recorded yet.\n");
  });
});
