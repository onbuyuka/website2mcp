import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectProject, hasHtmlIndex } from "../src/project.js";

const roots: string[] = [];

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "site2mcp-project-"));
  roots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return root;
}

function gitConfig(url: string): string {
  return `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n`;
}

function pkg(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("detectProject", () => {
  it("detects a Vite app deployed to GitHub Pages under a repo base path", async () => {
    const root = await makeProject({
      "package.json": pkg({ scripts: { build: "vite build" }, devDependencies: { vite: "^7.0.0" } }),
      "vite.config.ts": "import { defineConfig } from 'vite';\nexport default defineConfig({\n  base: '/world-cup-2026/',\n  plugins: [],\n});\n",
      ".git/config": gitConfig("https://github.com/onbuyuka/world-cup-2026.git"),
      "index.html": "<html>source shell</html>",
      "dist/index.html": "<html>built</html>",
    });

    const info = await detectProject(root);

    expect(info.root).toBe(root);
    expect(info.framework).toBe("vite");
    expect(info.outputDir).toBe(path.join(root, "dist"));
    expect(info.outputCandidates[0]).toBe(path.join(root, "dist"));
    expect(info.outputCandidates).not.toContain(path.join(root, "public"));
    expect(info.baseUrl).toBe("https://onbuyuka.github.io/world-cup-2026/");
    expect(info.baseUrlSource).toBe("vite.config.ts base + git remote (GitHub Pages)");
    expect(info.buildCommand).toEqual({ command: "npm", args: ["run", "build"] });
  });

  it("uses the vite build.outDir and a conditional base path", async () => {
    const root = await makeProject({
      "package.json": pkg({ scripts: { build: "vite build" }, devDependencies: { vite: "^7.0.0" } }),
      "vite.config.js": "export default {\n  base: process.env.NODE_ENV === 'production' ? '/stats/' : '/',\n  build: { outDir: 'site-out' },\n};\n",
      ".git/config": gitConfig("git@github.com:Acme/stats.git"),
      "site-out/index.html": "<html></html>",
    });

    const info = await detectProject(root);

    expect(info.outputCandidates.slice(0, 2)).toEqual([path.join(root, "site-out"), path.join(root, "dist")]);
    expect(info.outputDir).toBe(path.join(root, "site-out"));
    expect(info.baseUrl).toBe("https://acme.github.io/stats/");
  });

  it("maps a <owner>.github.io repo to the user site root", async () => {
    const root = await makeProject({
      "index.html": "<html></html>",
      ".git/config": gitConfig("git@github.com:Owner/Owner.github.io.git"),
    });

    const info = await detectProject(root);

    expect(info.framework).toBe("static");
    expect(info.baseUrl).toBe("https://owner.github.io/");
    expect(info.baseUrlSource).toBe("git remote (GitHub Pages)");
  });

  it("maps a project repo without a bundler base to /<repo>/", async () => {
    const root = await makeProject({
      "index.html": "<html></html>",
      ".git/config": gitConfig("https://github.com/Owner/Docs-Site"),
    });

    const info = await detectProject(root);

    expect(info.baseUrl).toBe("https://owner.github.io/Docs-Site/");
  });

  it("prefers a CNAME file over the git remote", async () => {
    const root = await makeProject({
      "package.json": pkg({ scripts: { build: "vite build" }, devDependencies: { vite: "^7.0.0" } }),
      "public/CNAME": "docs.example.com\n",
      ".git/config": gitConfig("https://github.com/owner/repo.git"),
    });

    const info = await detectProject(root);

    expect(info.baseUrl).toBe("https://docs.example.com/");
    expect(info.baseUrlSource).toBe("CNAME");
  });

  it("uses an absolute package.json homepage and ignores the CRA public template", async () => {
    const root = await makeProject({
      "package.json": pkg({
        homepage: "https://example.com/app",
        scripts: { build: "react-scripts build" },
        dependencies: { "react-scripts": "5.0.1" },
      }),
      "public/index.html": "<html>template</html>",
    });

    const info = await detectProject(root);

    expect(info.framework).toBe("create-react-app");
    expect(info.baseUrl).toBe("https://example.com/app/");
    expect(info.baseUrlSource).toBe("package.json homepage");
    expect(info.outputDir).toBeUndefined();
    expect(info.outputCandidates[0]).toBe(path.join(root, "build"));
  });

  it("ignores a relative package.json homepage", async () => {
    const root = await makeProject({
      "package.json": pkg({ homepage: ".", dependencies: { "react-scripts": "5.0.1" } }),
    });

    const info = await detectProject(root);

    expect(info.baseUrl).toBeUndefined();
    expect(info.notes.some((note) => note.includes("--base-url"))).toBe(true);
  });

  it("reads Astro site and base", async () => {
    const root = await makeProject({
      "package.json": pkg({ dependencies: { astro: "^5.0.0" }, scripts: { build: "astro build" } }),
      "astro.config.mjs": "import { defineConfig } from 'astro/config';\n// site: 'https://old.example.com',\nexport default defineConfig({\n  site: 'https://example.com',\n  base: '/docs',\n});\n",
      "dist/index.html": "<html></html>",
    });

    const info = await detectProject(root);

    expect(info.framework).toBe("astro");
    expect(info.outputDir).toBe(path.join(root, "dist"));
    expect(info.baseUrl).toBe("https://example.com/docs/");
    expect(info.baseUrlSource).toBe("astro.config.mjs site");
  });

  it("reads Docusaurus url and baseUrl", async () => {
    const root = await makeProject({
      "package.json": pkg({ dependencies: { "@docusaurus/core": "^3.0.0" }, scripts: { build: "docusaurus build" } }),
      "docusaurus.config.ts": "const config = {\n  title: 'Docs',\n  url: 'https://facebook.github.io',\n  baseUrl: '/docusaurus/',\n  presets: [['classic', { docs: { editUrl: 'https://github.com/x/y' } }]],\n};\nexport default config;\n",
      "build/index.html": "<html></html>",
    });

    const info = await detectProject(root);

    expect(info.framework).toBe("docusaurus");
    expect(info.outputDir).toBe(path.join(root, "build"));
    expect(info.baseUrl).toBe("https://facebook.github.io/docusaurus/");
    expect(info.baseUrlSource).toBe("docusaurus.config.ts url");
  });

  it("reads Gatsby siteUrl and pathPrefix", async () => {
    const root = await makeProject({
      "package.json": pkg({ dependencies: { gatsby: "^5.0.0" } }),
      "gatsby-config.js": "module.exports = {\n  pathPrefix: '/blog',\n  siteMetadata: { siteUrl: 'https://www.example.org' },\n};\n",
      "public/index.html": "<html></html>",
    });

    const info = await detectProject(root);

    expect(info.framework).toBe("gatsby");
    expect(info.outputDir).toBe(path.join(root, "public"));
    expect(info.baseUrl).toBe("https://www.example.org/blog/");
  });
});
describe("detectProject (non-JS generators)", () => {
  it("reads Hugo baseURL", async () => {
    const root = await makeProject({
      "hugo.toml": 'baseURL = "https://gohugo.example.org/"\ntitle = "Site"\n',
      "public/index.html": "<html></html>",
    });

    const info = await detectProject(root);

    expect(info.framework).toBe("hugo");
    expect(info.outputDir).toBe(path.join(root, "public"));
    expect(info.baseUrl).toBe("https://gohugo.example.org/");
    expect(info.baseUrlSource).toBe("hugo.toml baseURL");
    expect(info.buildCommand).toEqual({ command: "hugo", args: [] });
  });

  it("detects legacy Hugo config.yaml with baseURL", async () => {
    const root = await makeProject({ "config.yaml": "baseURL: https://legacy.example.org/blog\n" });

    const info = await detectProject(root);

    expect(info.framework).toBe("hugo");
    expect(info.baseUrl).toBe("https://legacy.example.org/blog/");
  });

  it("reads Jekyll url and baseurl", async () => {
    const root = await makeProject({
      "_config.yml": 'title: Blog\nurl: "https://user.github.io"\nbaseurl: /blog # project path\n',
    });

    const info = await detectProject(root);

    expect(info.framework).toBe("jekyll");
    expect(info.baseUrl).toBe("https://user.github.io/blog/");
    expect(info.baseUrlSource).toBe("_config.yml url");
    expect(info.buildCommand).toEqual({ command: "bundle", args: ["exec", "jekyll", "build"] });
    expect(info.outputCandidates[0]).toBe(path.join(root, "_site"));
  });

  it("reads MkDocs site_url", async () => {
    const root = await makeProject({
      "mkdocs.yml": "site_name: Guide\nsite_url: https://docs.example.com/guide\n",
      "site/index.html": "<html></html>",
    });

    const info = await detectProject(root);

    expect(info.framework).toBe("mkdocs");
    expect(info.outputDir).toBe(path.join(root, "site"));
    expect(info.baseUrl).toBe("https://docs.example.com/guide/");
    expect(info.buildCommand).toEqual({ command: "mkdocs", args: ["build"] });
  });

  it("reads VitePress sitemap hostname and base", async () => {
    const root = await makeProject({
      "package.json": pkg({ devDependencies: { vitepress: "^1.0.0" }, scripts: { build: "vitepress build docs" } }),
      "docs/.vitepress/config.mts": "export default {\n  base: '/guide/',\n  sitemap: { hostname: 'https://example.com' },\n};\n",
      "docs/.vitepress/dist/index.html": "<html></html>",
      "docs/index.md": "# Home",
    });

    const info = await detectProject(root);

    expect(info.framework).toBe("vitepress");
    expect(info.outputDir).toBe(path.join(root, "docs", ".vitepress", "dist"));
    expect(info.baseUrl).toBe("https://example.com/guide/");
    expect(info.contentDirs).toEqual([path.join(root, "docs")]);
  });

  it("combines a Next basePath with a CNAME host and finds out/", async () => {
    const root = await makeProject({
      "package.json": pkg({ dependencies: { next: "^15.0.0" }, scripts: { build: "next build" } }),
      "next.config.mjs": "const nextConfig = {\n  output: 'export',\n  basePath: '/my-app',\n};\nexport default nextConfig;\n",
      CNAME: "www.example.com",
      "out/index.html": "<html></html>",
      "public/index.html": "<html>asset</html>",
    });

    const info = await detectProject(root);

    expect(info.framework).toBe("next");
    expect(info.outputDir).toBe(path.join(root, "out"));
    expect(info.baseUrl).toBe("https://www.example.com/my-app/");
    expect(info.baseUrlSource).toBe("next.config.mjs basePath + CNAME");
  });

  it("treats a plain folder with index.html as a static site", async () => {
    const root = await makeProject({ "index.html": "<html></html>", "about.html": "<html></html>" });

    const info = await detectProject(root);

    expect(info.framework).toBe("static");
    expect(info.outputDir).toBe(root);
    expect(info.outputCandidates[0]).toBe(root);
    expect(info.buildCommand).toBeUndefined();
    expect(info.baseUrl).toBeUndefined();
    expect(info.notes).toContain(
      "Could not infer the site's public URL. Pass --base-url <url> or set baseUrl in site2mcp.config.json.",
    );
  });

  it("returns unknown for an empty folder", async () => {
    const root = await makeProject({});

    const info = await detectProject(root);

    expect(info.framework).toBe("unknown");
    expect(info.outputDir).toBeUndefined();
    expect(info.contentDirs).toEqual([]);
    expect(info.notes.length).toBeGreaterThan(0);
  });
});

describe("detectProject (build, content, errors)", () => {
  it.each([
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
  ])("picks the package manager from %s", async (lockfile, manager) => {
    const root = await makeProject({
      "package.json": pkg({ scripts: { build: "astro build" }, dependencies: { astro: "^5.0.0" } }),
      [lockfile]: "",
    });

    const info = await detectProject(root);

    expect(info.buildCommand).toEqual({ command: manager, args: ["run", "build"] });
  });

  it("detects content dirs and skips node_modules and dot-directories", async () => {
    const root = await makeProject({
      "docs/guide/intro.md": "# Intro",
      "blog/node_modules/pkg/readme.md": "# pkg",
      "blog/.cache/post.md": "# cached",
      "blog/index.html": "<html></html>",
      "content/notes.txt": "plain",
      "src/content/posts/2026/hello.mdx": "# Hello",
      "src/pages/index.tsx": "export default null;",
      "README.md": "# Readme",
    });

    const info = await detectProject(root);

    expect(info.contentDirs).toEqual([path.join(root, "docs"), path.join(root, "src", "content")]);
  });

  it("adds a build note when the output folder is missing", async () => {
    const root = await makeProject({
      "package.json": pkg({ scripts: { build: "vite build" }, devDependencies: { vite: "^7.0.0" } }),
    });

    const info = await detectProject(root);

    expect(info.outputDir).toBeUndefined();
    expect(info.notes).toContain("No build output found in dist. Run `npm run build` first, or pass --build.");
  });

  it("does not throw on an invalid package.json and ignores templated values", async () => {
    const root = await makeProject({
      "package.json": "{ not json",
      "astro.config.ts": "export default { site: `${process.env.SITE_URL}`, base: '{{ base }}' };\n",
    });

    const info = await detectProject(root);

    expect(info.framework).toBe("astro");
    expect(info.baseUrl).toBeUndefined();
    expect(info.notes).toContain("package.json could not be parsed; ignoring it.");
  });

  it("throws for a missing directory or a file path", async () => {
    const root = await makeProject({ "file.txt": "x" });

    await expect(detectProject(path.join(root, "missing"))).rejects.toThrow(/does not exist/);
    await expect(detectProject(path.join(root, "file.txt"))).rejects.toThrow(/not a directory/);
  });
});

describe("hasHtmlIndex", () => {
  it("checks for index.html or index.htm", async () => {
    const root = await makeProject({ "a/index.html": "", "b/index.htm": "", "c/page.html": "" });

    await expect(hasHtmlIndex(path.join(root, "a"))).resolves.toBe(true);
    await expect(hasHtmlIndex(path.join(root, "b"))).resolves.toBe(true);
    await expect(hasHtmlIndex(path.join(root, "c"))).resolves.toBe(false);
    await expect(hasHtmlIndex(path.join(root, "missing"))).resolves.toBe(false);
  });
});
