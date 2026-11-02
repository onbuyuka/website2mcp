import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

export interface StaticServer {
  origin: string;
  close(): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
};

// Serves a build folder on loopback under the site's base path, with SPA fallback.
export async function startStaticServer(root: string, basePath: string): Promise<StaticServer> {
  const rootDir = path.resolve(root);
  const server = createServer(async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end();
      return;
    }
    try {
      const file = await resolveStaticFile(rootDir, basePath, request.url ?? "/");
      if (!file) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "content-type": CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      createReadStream(file).pipe(response);
    } catch {
      response.writeHead(500).end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export async function resolveStaticFile(
  root: string,
  basePath: string,
  requestUrl: string,
): Promise<string | undefined> {
  const { pathname } = new URL(requestUrl, "http://localhost");
  if (!pathname.startsWith(basePath) && `${pathname}/` !== basePath) return undefined;

  let relative: string;
  try {
    relative = decodeURIComponent(pathname.slice(basePath.length));
  } catch {
    return undefined;
  }

  const candidate = path.join(root, relative);
  const inside = path.relative(root, candidate);
  if (inside.startsWith("..") || path.isAbsolute(inside)) return undefined;

  const info = await stat(candidate).catch(() => undefined);
  if (info?.isFile()) return candidate;
  if (info?.isDirectory()) {
    const index = path.join(candidate, "index.html");
    if (await isFile(index)) return index;
  }

  if (!path.extname(candidate)) {
    const fallback = path.join(root, "index.html");
    if (await isFile(fallback)) return fallback;
  }
  return undefined;
}

async function isFile(file: string): Promise<boolean> {
  return (await stat(file).catch(() => undefined))?.isFile() ?? false;
}
