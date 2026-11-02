import type { Browser, BrowserContext } from "playwright-core";
import { startStaticServer } from "./static-server.js";
import type { CrawlOptions } from "./types.js";
import { assertPublicHost } from "./url.js";

export interface RenderedPage {
  url: string;
  html: string;
  links: string[];
  status?: number;
  missingFiles?: string[];
}

export interface PageRenderer {
  render(url: string): Promise<RenderedPage>;
  close(): Promise<void>;
}

export interface BrowserRendererOptions {
  timeoutMs?: number;
  idleTimeoutMs?: number;
}

export interface LiveRendererOptions extends BrowserRendererOptions {
  origin: string;
  headers?: Record<string, string>;
  userAgent?: string;
  lookupImpl?: CrawlOptions["lookupImpl"];
  allowPrivateHosts?: boolean;
}

// Renders public URLs by loading the matching path from a local copy of the build folder.
export async function createBrowserRenderer(
  root: string,
  baseUrl: URL,
  options: BrowserRendererOptions = {},
): Promise<PageRenderer> {
  const server = await startStaticServer(root, baseUrl.pathname);
  let browser: Browser;
  try {
    browser = await launchBrowser();
  } catch (error) {
    await server.close();
    throw error;
  }
  const context = await browser.newContext({ serviceWorkers: "block" });
  const rebase = (href: string, origin: string) => {
    const url = new URL(href);
    return new URL(`${url.pathname}${url.search}${url.hash}`, origin).href;
  };

  return pageRenderer(context, {
    ...options,
    toBrowser: (url) => rebase(url, server.origin),
    toPublic: (href) => (new URL(href).origin === server.origin ? rebase(href, baseUrl.origin) : undefined),
    isMissingFile: (url, status) => status === 404 && new URL(url).origin === server.origin,
    close: async () => {
      await browser.close().catch(() => {});
      await server.close();
    },
  });
}

// Renders a live site; every browser request is checked so pages can't reach private networks.
export async function createLiveRenderer(options: LiveRendererOptions): Promise<PageRenderer> {
  const browser = await launchBrowser();
  const context = await browser.newContext({
    serviceWorkers: "block",
    ...(options.userAgent ? { userAgent: options.userAgent } : {}),
  });
  const hostChecks = new Map<string, Promise<boolean>>();
  const isAllowedHost = (hostname: string) => {
    let check = hostChecks.get(hostname);
    if (!check) {
      check = options.allowPrivateHosts
        ? Promise.resolve(true)
        : assertPublicHost(hostname, options.lookupImpl).then(() => true, () => false);
      hostChecks.set(hostname, check);
    }
    return check;
  };

  await context.route("**/*", async (route) => {
    const request = route.request();
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      return route.abort();
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return route.abort();
    const isTopLevel = request.isNavigationRequest() && request.frame().parentFrame() === null;
    if (isTopLevel && url.origin !== options.origin) return route.abort();
    if (!(await isAllowedHost(url.hostname))) return route.abort();
    if (options.headers && url.origin === options.origin) {
      return route.continue({ headers: { ...request.headers(), ...lowerCaseKeys(options.headers) } });
    }
    return route.continue();
  });
  await context.routeWebSocket(/.*/, async (socket) => {
    const url = new URL(socket.url());
    if (await isAllowedHost(url.hostname)) socket.connectToServer();
    else await socket.close();
  });

  return pageRenderer(context, {
    ...options,
    toBrowser: (url) => url,
    toPublic: (href) => (new URL(href).origin === options.origin ? href : undefined),
    checkStatus: true,
    close: async () => {
      await browser.close().catch(() => {});
    },
  });
}

interface RendererHooks extends BrowserRendererOptions {
  toBrowser(url: string): string;
  toPublic(href: string): string | undefined;
  isMissingFile?(url: string, status: number): boolean;
  checkStatus?: boolean;
  close(): Promise<void>;
}

function pageRenderer(context: BrowserContext, hooks: RendererHooks): PageRenderer {
  const timeout = hooks.timeoutMs ?? 30_000;
  const idleTimeout = hooks.idleTimeoutMs ?? 5_000;
  return {
    async render(url) {
      const page = await context.newPage();
      const missingFiles: string[] = [];
      if (hooks.isMissingFile) {
        page.on("response", (response) => {
          if (hooks.isMissingFile?.(response.url(), response.status())) {
            missingFiles.push(new URL(response.url()).pathname);
          }
        });
      }
      try {
        const response = await page.goto(hooks.toBrowser(url), { waitUntil: "load", timeout });
        const status = response?.status();
        if (hooks.checkStatus && status !== undefined && status >= 400) {
          throw new Error(`HTTP ${status}`);
        }
        await page.waitForLoadState("networkidle", { timeout: idleTimeout }).catch(() => {});
        const links = await page.$$eval("a[href]", (anchors) =>
          anchors.map((anchor) => (anchor as HTMLAnchorElement).href),
        );
        return {
          url: hooks.toPublic(page.url()) ?? url,
          html: await page.content(),
          links: links.map((link) => {
            try {
              return hooks.toPublic(link);
            } catch {
              return undefined;
            }
          }).filter((link): link is string => link !== undefined),
          ...(status !== undefined ? { status } : {}),
          missingFiles,
        };
      } finally {
        await page.close();
      }
    },
    close: hooks.close,
  };
}

function lowerCaseKeys(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

export async function launchBrowser(): Promise<Browser> {
  const { chromium } = await import("playwright-core");
  const errors: string[] = [];
  for (const channel of ["msedge", "chrome", undefined]) {
    try {
      return await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
    } catch (error) {
      const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
      errors.push(`${channel ?? "playwright chromium"}: ${message}`);
    }
  }
  throw new Error(
    `JavaScript rendering needs Microsoft Edge, Google Chrome, or Playwright Chromium (npx playwright install chromium).\n${errors.join("\n")}`,
  );
}
