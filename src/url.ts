import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export function normalizeUrl(input: string | URL, base?: string | URL): URL | undefined {
  try {
    const url = new URL(input, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password) return undefined;
    url.hash = "";
    return url;
  } catch {
    return undefined;
  }
}

export function isPublicIp(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, "");

  if (isIP(ip) === 4) {
    const octets = ip.split(".").map(Number);
    const [a, b, c] = octets;

    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }

  if (isIP(ip) !== 6) return false;
  const groups = ipv6Groups(ip);
  if (!groups) return false;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const mapped = [
      groups[6] >> 8,
      groups[6] & 0xff,
      groups[7] >> 8,
      groups[7] & 0xff,
    ].join(".");
    return isPublicIp(mapped);
  }

  const firstGroup = groups[0] ?? 0;
  return !(
    ip === "::" ||
    ip === "::1" ||
    (firstGroup & 0xfe00) === 0xfc00 ||
    (firstGroup & 0xffc0) === 0xfe80 ||
    (firstGroup & 0xff00) === 0xff00 ||
    ip.startsWith("2001:db8:")
  );
}

function ipv6Groups(ip: string): number[] | undefined {
  const halves = ip.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return undefined;
  const groups = [
    ...left.map((group) => Number.parseInt(group, 16)),
    ...Array.from({ length: missing }, () => 0),
    ...right.map((group) => Number.parseInt(group, 16)),
  ];
  return groups.length === 8 && groups.every(Number.isInteger) ? groups : undefined;
}

export async function assertPublicHost(
  hostname: string,
  lookupImpl: CrawlLookup = (host) => lookup(host, { all: true, verbatim: true }),
): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(host);
  const addresses = literalFamily
    ? [{ address: host, family: literalFamily }]
    : await lookupImpl(host);

  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicIp(address))) {
    throw new Error(`Refusing to fetch a non-public host: ${hostname}`);
  }
}

type CrawlLookup = NonNullable<import("./types.js").CrawlOptions["lookupImpl"]>;
