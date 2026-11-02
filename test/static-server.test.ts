import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveStaticFile, startStaticServer } from "../src/static-server.js";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "site2mcp-static-"));
  await mkdir(path.join(root, "assets"));
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, "index.html"), "<html>app shell</html>");
  await writeFile(path.join(root, "assets", "app.js"), "console.log('app')");
  await writeFile(path.join(root, "docs", "index.html"), "<html>docs</html>");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolveStaticFile", () => {
  it("serves files and directory indexes under the base path", async () => {
    await expect(resolveStaticFile(root, "/app/", "/app/assets/app.js")).resolves.toBe(
      path.join(root, "assets", "app.js"),
    );
    await expect(resolveStaticFile(root, "/app/", "/app/docs/")).resolves.toBe(
      path.join(root, "docs", "index.html"),
    );
    await expect(resolveStaticFile(root, "/app/", "/app")).resolves.toBe(
      path.join(root, "index.html"),
    );
  });

  it("falls back to index.html for extensionless routes only", async () => {
    await expect(resolveStaticFile(root, "/app/", "/app/teams/42")).resolves.toBe(
      path.join(root, "index.html"),
    );
    await expect(resolveStaticFile(root, "/app/", "/app/missing.js")).resolves.toBeUndefined();
  });

  it.each(["/other/index.html", "/app/..%2f..%2fsecret", "/app/..%5c..%5csecret", "/app/%E0%A4%A"])(
    "refuses %s",
    async (requestUrl) => {
      await expect(resolveStaticFile(root, "/app/", requestUrl)).resolves.toBeUndefined();
    },
  );
});

describe("startStaticServer", () => {
  it("serves over loopback with content types", async () => {
    const server = await startStaticServer(root, "/");
    try {
      expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const script = await fetch(`${server.origin}/assets/app.js`);
      expect(script.headers.get("content-type")).toContain("text/javascript");
      const missing = await fetch(`${server.origin}/nope.css`);
      expect(missing.status).toBe(404);
      const post = await fetch(`${server.origin}/`, { method: "POST" });
      expect(post.status).toBe(405);
    } finally {
      await server.close();
    }
  });
});
