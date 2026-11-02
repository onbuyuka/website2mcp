import type { PathRules } from "./types.js";

const cache = new Map<string, RegExp>();

export function compileGlob(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached) return cached;
  let source = pattern.trim();
  if (!source.startsWith("/")) source = `/${source}`;
  if (source.endsWith("/")) source += "**";
  let regex = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "*" && source[index + 1] === "*") {
      const atEnd = index + 2 === source.length;
      if (regex.endsWith("/") && atEnd) {
        regex = `${regex.slice(0, -1)}(?:/.*)?`;
      } else if (regex.endsWith("/") && source[index + 2] === "/") {
        regex += "(?:.*/)?";
        index += 1;
      } else {
        regex += ".*";
      }
      index += 1;
    } else if (char === "*") {
      regex += "[^/]*";
    } else if (char === "?") {
      regex += "[^/]";
    } else {
      regex += char.replace(/[.+^${}()|[\]\\#]/g, "\\$&");
    }
  }
  const compiled = new RegExp(`^${regex}$`, "i");
  cache.set(pattern, compiled);
  return compiled;
}

// Patterns match either the full path or the path relative to the site's base path.
export function pathCandidates(url: URL, baseUrl: URL): string[] {
  const hashRoute = /^#!?\/./.test(url.hash) ? url.hash : "";
  const full = `${url.pathname}${hashRoute}`;
  const candidates = [full];
  if (baseUrl.pathname !== "/" && url.pathname.startsWith(baseUrl.pathname)) {
    candidates.push(`/${url.pathname.slice(baseUrl.pathname.length)}${hashRoute}`);
  }
  return candidates;
}

export function matchesAny(url: URL, baseUrl: URL, patterns: string[] | undefined): boolean {
  if (!patterns?.length) return false;
  const candidates = pathCandidates(url, baseUrl);
  return patterns.some((pattern) => {
    const regex = compileGlob(pattern);
    return candidates.some((candidate) => regex.test(candidate));
  });
}

export interface PathDecision {
  excluded: boolean;
  reason?: string;
  private: boolean;
}

export function applyPathRules(url: URL, baseUrl: URL, rules: PathRules): PathDecision {
  if (matchesAny(url, baseUrl, rules.exclude)) {
    return { excluded: true, reason: "matched an exclude rule", private: false };
  }
  if (rules.include?.length && !matchesAny(url, baseUrl, rules.include)) {
    return { excluded: true, reason: "did not match any include rule", private: false };
  }
  return { excluded: false, private: matchesAny(url, baseUrl, rules.private) };
}
