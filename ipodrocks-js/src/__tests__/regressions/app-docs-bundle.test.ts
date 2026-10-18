/**
 * @vitest-environment node
 *
 * Rocksy's full-documentation tool, `app_docs_search`.
 *
 * The bundle it searches is generated from docs/ and checked in, so the first
 * test is the one that matters most: an edited page that nobody re-bundled
 * would leave Rocksy answering from the old text with nothing to say so.
 * Fix a failure here with `node scripts/bundle-docs.js`.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

import { DOCS_PAGES } from "../../main/assistant/docsCorpus.generated";
import {
  listDocsPages,
  readDocsPage,
  searchDocs,
} from "../../main/assistant/appDocsSearch";
import { getToolByName } from "../../main/assistant/tools";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const bundler = require("../../../scripts/bundle-docs.js") as {
  render(): string;
  pageContent(raw: string): string;
  OUT: string;
};

describe("app docs bundle", () => {
  it("matches docs/ exactly — re-run scripts/bundle-docs.js if this fails", () => {
    // A Windows checkout may give the generated file CRLF line endings; the
    // bundle's content is what matters, not how git wrote it to disk.
    expect(fs.readFileSync(bundler.OUT, "utf8").replace(/\r\n/g, "\n")).toBe(bundler.render());
  });

  it("holds every page of the docs site", () => {
    const paths = DOCS_PAGES.map((p) => p.path);
    expect(paths).toContain("index.md");
    expect(paths).toContain("app-reference/sync.md");
    expect(paths).toContain("guide/server-deployment.md");
    expect(paths.every((p) => !p.startsWith(".vitepress"))).toBe(true);
    expect(path.basename(bundler.OUT)).toBe("docsCorpus.generated.ts");
  });

  it("strips CRLF frontmatter too — what a Windows checkout gives the build", () => {
    const lf = "---\nlayout: home\n---\n# Title\n\nBody\n";
    expect(bundler.pageContent(lf)).toBe("# Title\n\nBody\n");
    expect(bundler.pageContent(lf.replace(/\n/g, "\r\n"))).toBe("# Title\n\nBody\n");
  });
});

describe("searchDocs", () => {
  it("finds the section that answers a feature question", () => {
    const [top] = searchDocs("how do I build the rockbox database during sync");
    expect(top.page).toBe("app-reference/sync.md");
    expect(top.heading).toBe("Building the Rockbox database");
    expect(top.text).toContain("Off by default");
  });

  it("finds deployment and troubleshooting answers too", () => {
    expect(searchDocs("cloudflare tunnel").map((r) => r.page)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^guide\/server-/)])
    );
    expect(searchDocs("mpcenc not found")[0].page).toBe("guide/troubleshooting.md");
  });

  it("returns nothing for a question of only stop words", () => {
    expect(searchDocs("how do I")).toEqual([]);
  });

  it("reads a page by path, forgiving the extension and a docs/ prefix", () => {
    expect(readDocsPage("docs/app-reference/ratings")?.title).toBe("Ratings");
    expect(readDocsPage("nope.md")).toBeNull();
    expect(listDocsPages().length).toBe(DOCS_PAGES.length);
  });
});

describe("app_docs_search tool", () => {
  const tool = getToolByName("app_docs_search")!;

  it("is a read-tier tool open to everyone", () => {
    expect(tool).toBeDefined();
    expect(tool.kind).toBe("read");
  });

  it("answers a query, reads a page, and lists pages", async () => {
    const ctx = {} as Parameters<typeof tool.run>[1];
    const q = (await tool.run({ query: "rating waiting for the device's database" }, ctx)) as {
      results: Array<{ page: string }>;
    };
    expect(q.results.map((r) => r.page)).toContain("app-reference/ratings.md");

    const page = (await tool.run({ page: "app-reference/sync.md" }, ctx)) as { content: string };
    expect(page.content).toContain("Build Rockbox database");

    const missing = (await tool.run({ page: "missing.md" }, ctx)) as { error: string };
    expect(missing.error).toMatch(/No docs page/);

    const list = (await tool.run({}, ctx)) as { pages: unknown[] };
    expect(list.pages.length).toBe(DOCS_PAGES.length);
  });
});
