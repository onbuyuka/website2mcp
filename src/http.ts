import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

export interface NodeHttpOptions {
  port?: number;
  host?: string;
  maxBodyBytes?: number;
}

export interface RunningHttpServer {
  url: string;
  close(): Promise<void>;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export async function startHttpServer(
  handler: (request: Request) => Promise<Response>,
  options: NodeHttpOptions = {},
): Promise<RunningHttpServer> {
  const host = options.host ?? "127.0.0.1";
  const loopback = LOOPBACK_HOSTS.has(host);
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;

  const server = createServer(async (incoming, outgoing) => {
    try {
      // Blocks DNS-rebinding attacks against servers bound to localhost.
      const requestHost = (incoming.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
      if (loopback && !LOOPBACK_HOSTS.has(requestHost)) {
        outgoing.writeHead(403, { "content-type": "text/plain" }).end("Forbidden host");
        return;
      }
      const request = await toRequest(incoming, maxBodyBytes);
      if (!request) {
        outgoing.writeHead(413, { "content-type": "text/plain" }).end("Request body too large");
        return;
      }
      await sendResponse(outgoing, await handler(request));
    } catch (error) {
      if (!outgoing.headersSent) outgoing.writeHead(500, { "content-type": "text/plain" });
      outgoing.end(error instanceof Error ? error.message : "Internal error");
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 3000, host, () => resolve());
  });
  const address = server.address() as AddressInfo;
  const displayHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return {
    url: `http://${displayHost === "0.0.0.0" ? "localhost" : displayHost}:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function toRequest(incoming: IncomingMessage, maxBodyBytes: number): Promise<Request | undefined> {
  const url = new URL(incoming.url ?? "/", `http://${incoming.headers.host ?? "localhost"}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else if (value !== undefined) headers.set(key, value);
  }
  const method = incoming.method ?? "GET";
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return new Request(url, { method, headers });
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of incoming) {
    total += (chunk as Buffer).length;
    if (total > maxBodyBytes) return undefined;
    chunks.push(chunk as Buffer);
  }
  return new Request(url, { method, headers, body: Buffer.concat(chunks) });
}

async function sendResponse(outgoing: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  outgoing.writeHead(response.status, headers);
  if (!response.body) {
    outgoing.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream)
      .on("error", reject)
      .pipe(outgoing)
      .on("finish", resolve)
      .on("error", reject);
  });
}
