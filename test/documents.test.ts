import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractMarkdown,
  extractPdf,
  indexMarkdownSource,
} from "../src/documents.js";

function buildPdf(info?: string): Uint8Array {
  const content = "BT /F1 24 Tf 72 720 Td (Hello PDF world) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  if (info) objects.push(info);
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  const infoRef = info ? ` /Info ${objects.length} 0 R` : "";
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${infoRef} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, "latin1"));
}

describe("extractPdf", () => {
  it("reads text and metadata from a PDF", async () => {
    const bytes = buildPdf(
      "<< /Title (Annual Report) /Subject (Summary) /ModDate (D:20240115103000Z) >>",
    );
    const length = bytes.byteLength;
    const page = await extractPdf(
      bytes,
      new URL("https://example.test/files/report.pdf?v=2"),
    );

    expect(page.kind).toBe("pdf");
    expect(page.title).toBe("Annual Report");
    expect(page.text).toContain("Hello PDF world");
    expect(page.description).toBe("Summary");
    expect(page.lastModified).toBe("2024-01-15T10:30:00.000Z");
    expect(page.id).toBe("/files/report.pdf?v=2");
    expect(page.url).toBe("https://example.test/files/report.pdf?v=2");
    expect(page.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(bytes.byteLength).toBe(length);
  }, 30_000);

  it("derives the title from the file name when metadata has none", async () => {
    const page = await extractPdf(
      buildPdf(),
      new URL("https://example.test/files/annual-report_2024.pdf"),
    );
    expect(page.title).toBe("annual report 2024");
    expect(page.description).toBeUndefined();
    expect(page.lastModified).toBeUndefined();
  }, 30_000);

  it("cleans authoring-tool titles and converts offset dates", async () => {
    const page = await extractPdf(
      buildPdf(
        "<< /Title (Microsoft Word - Budget Plan.docx) /ModDate (D:20240115103000+01'00') >>",
      ),
      new URL("https://example.test/budget.pdf"),
    );
    expect(page.title).toBe("Budget Plan");
    expect(page.lastModified).toBe("2024-01-15T09:30:00.000Z");

    const untitled = await extractPdf(
      buildPdf("<< /Title (Untitled) >>"),
      new URL("https://example.test/my%20file.pdf"),
    );
    expect(untitled.title).toBe("my file");
  }, 30_000);

  it("rejects corrupt input with a clear error", async () => {
    await expect(
      extractPdf(
        new TextEncoder().encode("this is not a pdf"),
        new URL("https://example.test/broken.pdf"),
      ),
    ).rejects.toThrow(/Could not read PDF/);
    await expect(
      extractPdf(new Uint8Array(), new URL("https://example.test/empty.pdf")),
    ).rejects.toThrow(/Could not read PDF/);
    const truncated = await extractPdf(
      buildPdf().slice(0, 200),
      new URL("https://example.test/truncated.pdf"),
    ).then(
      (page) => page.kind,
      (error: Error) => error.message,
    );
    expect(truncated).toMatch(/^pdf$|Could not read PDF/);
  }, 30_000);
});

describe("extractMarkdown", () => {
  const url = new URL("https://example.test/docs/guide/");

  it("parses YAML front matter", () => {
    const source = [
      "---",
      'title: "Getting: Started"',
      "summary: A short guide # trailing comment",
      "date: 2023-05-01",
      "lastmod: 2024-01-15 10:30:00 +0100",
      "sidebar_label: Ignored",
      "tags:",
      "  - one",
      "draft: false",
      "---",
      "# Heading",
      "",
      "Body text.",
    ].join("\n");
    const result = extractMarkdown(source, url, "guide.md");

    expect(result.page.title).toBe("Getting: Started");
    expect(result.page.description).toBe("A short guide");
    expect(result.page.lastModified).toBe("2024-01-15T09:30:00.000Z");
    expect(result.page.kind).toBe("markdown");
    expect(result.page.id).toBe("/docs/guide/");
    expect(result.page.text).toBe("# Heading\n\nBody text.");
    expect(result.draft).toBe(false);
    expect(result.permalink).toBeUndefined();
    expect(result.page.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("parses TOML front matter", () => {
    const source = [
      "+++",
      'title = "TOML Page"',
      "description = 'Literal description'",
      "date = 2024-02-03T04:05:06Z",
      "draft = true",
      'slug = "custom-slug"',
      "[params]",
      'title = "Nested"',
      "+++",
      "Content here.",
    ].join("\r\n");
    const result = extractMarkdown(source, url, "page.md");

    expect(result.page.title).toBe("TOML Page");
    expect(result.page.description).toBe("Literal description");
    expect(result.page.lastModified).toBe("2024-02-03T04:05:06.000Z");
    expect(result.draft).toBe(true);
    expect(result.permalink).toBe("custom-slug");
    expect(result.page.text).toBe("Content here.");
  });

  it("falls back to the first heading and then the file name", () => {
    expect(
      extractMarkdown("Intro\n\n# Real Title {#anchor}\n\nText", url, "x.md")
        .page.title,
    ).toBe("Real Title");
    expect(
      extractMarkdown("```\n# not a title\n```\n\nText", url, "02-my_page.md")
        .page.title,
    ).toBe("my page");
    expect(
      extractMarkdown(
        "Text only",
        new URL("https://example.test/docs/setup-guide/"),
        "README.md",
      ).page.title,
    ).toBe("setup guide");
  });

  it("strips MDX imports, exports and self-closing components", () => {
    const source = [
      "---",
      "title: MDX",
      "---",
      'import Tabs from "@theme/Tabs";',
      "import {",
      "  Alpha,",
      "  Beta,",
      '} from "./components";',
      "export const meta = {",
      '  author: "me",',
      "};",
      "",
      "Intro text.",
      "",
      '<Callout type="info" />',
      "",
      "```js",
      'import keep from "keep";',
      "<Keep />",
      "```",
      "",
      "<Tabs>Inline stays</Tabs>",
    ].join("\n");
    const { page } = extractMarkdown(source, url, "page.mdx");

    expect(page.text).not.toContain("@theme/Tabs");
    expect(page.text).not.toContain("Alpha");
    expect(page.text).not.toContain("author");
    expect(page.text).not.toContain("Callout");
    expect(page.text).toContain("Intro text.");
    expect(page.text).toContain('import keep from "keep";');
    expect(page.text).toContain("<Keep />");
    expect(page.text).toContain("<Tabs>Inline stays</Tabs>");
    expect(page.text.startsWith("Intro text.")).toBe(true);
  });

  it("never throws on odd front matter", () => {
    const odd = [
      "---",
      "title: [unclosed",
      ': "no key"',
      'description: "unterminated',
      "date: not a date",
      "permalink:",
      "---",
      "Body",
    ].join("\n");
    const result = extractMarkdown(odd, url, "odd.md");
    expect(result.page.text).toBe("Body");
    expect(result.page.lastModified).toBeUndefined();

    const unclosed = extractMarkdown("---\ntitle: x\nBody", url, "u.md");
    expect(unclosed.page.text).toContain("Body");
  });
});

describe("indexMarkdownSource", () => {
  let root: string;
  let docs: string;
  const base = new URL("https://example.test/docs/");

  async function write(relative: string, content: string): Promise<void> {
    const file = path.join(docs, ...relative.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "site2mcp-docs-"));
    docs = path.join(root, "docs");
    await write("index.md", "# Home\n\nWelcome home.");
    await write("guide/README.md", "# Guide\n\nGuide overview.");
    await write("guide/01-intro.md", "# Intro\n\nIntro text.");
    await write("guide/slugged.md", "---\nslug: renamed\n---\nSlug body.");
    await write("02_advanced/1_setup.mdx", "Setup body.");
    await write("_posts/2024-01-15-hello-world.md", "Post body.");
    await write("custom.md", "---\npermalink: /custom/path/\n---\nCustom.");
    await write("draft.md", "---\ndraft: true\n---\nDraft body.");
    await write("empty.md", "---\ntitle: Empty\n---\n");
    await write("zz-dup.md", "---\npermalink: /guide/\n---\nDuplicate.");
    await write("CHANGELOG.md", "# Changes");
    await write("license.md", "# License");
    await write("node_modules/pkg/readme.md", "# Package");
    await write(".hidden/secret.md", "# Secret");
    await write("notes.txt", "Not markdown");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("maps files to doc-site URLs", async () => {
    const { pages, warnings } = await indexMarkdownSource([docs], base);
    const byFile = Object.fromEntries(
      pages.map((page) => [page.sourceFile, page.id]),
    );

    expect(byFile).toEqual({
      "docs/02_advanced/1_setup.mdx": "/docs/advanced/setup/",
      "docs/_posts/2024-01-15-hello-world.md": "/docs/2024/01/15/hello-world/",
      "docs/custom.md": "/docs/custom/path/",
      "docs/guide/01-intro.md": "/docs/guide/intro/",
      "docs/guide/README.md": "/docs/guide/",
      "docs/guide/slugged.md": "/docs/guide/renamed/",
      "docs/index.md": "/docs/",
    });
    expect(pages.map((page) => page.sourceFile)).toEqual([
      "docs/02_advanced/1_setup.mdx",
      "docs/_posts/2024-01-15-hello-world.md",
      "docs/custom.md",
      "docs/guide/01-intro.md",
      "docs/guide/README.md",
      "docs/guide/slugged.md",
      "docs/index.md",
    ]);
    const setup = pages.find((page) => page.id === "/docs/advanced/setup/");
    expect(setup?.title).toBe("setup");
    expect(setup?.url).toBe("https://example.test/docs/advanced/setup/");
    expect(setup?.visibility).toBeUndefined();
    expect(
      pages.find((page) => page.id === "/docs/2024/01/15/hello-world/")?.title,
    ).toBe("hello world");

    expect(warnings).toContainEqual(
      expect.stringMatching(/Duplicate page id \/docs\/guide\/.*zz-dup\.md/),
    );
    expect(warnings).toContain("Skipped 1 Markdown file with no content.");
  });

  it("includes drafts when requested", async () => {
    const { pages } = await indexMarkdownSource([docs], base, {
      includeDrafts: true,
    });
    expect(pages.map((page) => page.id)).toContain("/docs/draft/");
  });

  it("respects maxPages", async () => {
    const { pages, warnings } = await indexMarkdownSource([docs], base, {
      maxPages: 2,
    });
    expect(pages).toHaveLength(2);
    expect(warnings).toContainEqual(expect.stringMatching(/maxPages limit \(2\)/));
  });

  it("warns instead of throwing for missing directories", async () => {
    const { pages, warnings } = await indexMarkdownSource(
      [path.join(root, "missing"), docs],
      new URL("https://example.test/docs"),
    );
    expect(pages.length).toBeGreaterThan(0);
    expect(pages[0].url.startsWith("https://example.test/docs/")).toBe(true);
    expect(warnings[0]).toMatch(/Could not read directory/);
  });
});
