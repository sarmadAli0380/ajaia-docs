import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentDisposition, exportBaseName, htmlToMarkdown } from "../services/exporter.js";
import { createDoc, createTestContext, share, signIn, type ApiClient, type TestContext } from "./helpers.js";

let ctx: TestContext;
let alice: ApiClient;
let carol: ApiClient;

beforeAll(async () => {
  ctx = await createTestContext();
  alice = await signIn(ctx, "alice");
  carol = await signIn(ctx, "carol");
});
afterAll(async () => {
  await ctx.close();
});

describe("Markdown export (AC-EXPORT)", () => {
  it("downloads Markdown reflecting headings, lists and emphasis", async () => {
    const html =
      "<h1>Plan</h1><h2>Goals</h2><h3>Detail</h3><p><strong>Bold</strong> and <em>italic</em> and <u>under</u></p>" +
      "<ul><li><p>one</p></li><li><p>two</p></li></ul><ol><li><p>first</p></li></ol>";
    const { id } = await createDoc(alice, "Quarterly Plan", html);
    const res = await alice.get(`/api/documents/${id}/export`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/markdown; charset=utf-8/);
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename="Quarterly Plan.md"; filename*=UTF-8''Quarterly%20Plan.md`,
    );
    const md = res.text;
    expect(md).toContain("# Plan");
    expect(md).toContain("## Goals");
    expect(md).toContain("### Detail");
    expect(md).toContain("**Bold**");
    expect(md).toContain("*italic*");
    expect(md).toContain("under"); // underline degrades to plain text
    expect(md).not.toContain("<u>");
    expect(md).toMatch(/^-\s+one$/m);
    expect(md).toMatch(/^1\.\s+first$/m);
  });

  it("exports an empty document as an empty file", async () => {
    const { id } = await createDoc(alice);
    const res = await alice.get(`/api/documents/${id}/export`);
    expect(res.status).toBe(200);
    expect(res.text).toBe("");
    expect(res.headers["content-disposition"]).toContain('filename="Untitled document.md"');
  });

  it("viewer can export; users without access get 404", async () => {
    const { id } = await createDoc(alice, "Shared export", "<p>x</p>");
    expect((await carol.get(`/api/documents/${id}/export`)).status).toBe(404);
    await share(alice, id, "carol", "viewer");
    expect((await carol.get(`/api/documents/${id}/export`)).status).toBe(200);
  });

  it("filename is sanitized from the title and cannot inject headers (EC-18)", async () => {
    const { id } = await createDoc(alice, 'evil"; name=x\\..\\/etc/passwd');
    const res = await alice.get(`/api/documents/${id}/export`);
    const header = res.headers["content-disposition"] as string;
    expect(header).toMatch(/^attachment; filename="[^"\\/]+\.md"; filename\*=UTF-8''[A-Za-z0-9%._~-]+$/);
    expect(header).not.toMatch(/[\r\n]/);
  });
});

describe("export filename rules (EC-18)", () => {
  it.each([
    ["Quarterly Plan", "Quarterly Plan"],
    ["a/b\\c:d*e?f\"g<h>i|j", "a b c d e f g h i j"],
    ["..hidden..", "hidden"],
    ["   ", "document"],
    ["///", "document"],
    ["Line break\ttab", "Line break tab"],
    ["x".repeat(150), "x".repeat(100)],
  ])("%j -> %j", (title, expected) => {
    expect(exportBaseName(title)).toBe(expected);
  });

  it("falls back to document.md for the ASCII filename when the title has no ASCII letters", () => {
    const { header, filename } = contentDisposition("日本語 📝");
    expect(filename).toBe("日本語 📝.md");
    expect(header).toContain('filename="document.md"');
    expect(header).toContain(`filename*=UTF-8''${encodeURIComponent("日本語 📝.md")}`);
  });

  it("keeps accented titles in filename* and strips them from the ASCII fallback", () => {
    const { header } = contentDisposition("Résumé (final)");
    expect(header).toContain('filename="Rsum (final).md"');
    expect(header).toContain("filename*=UTF-8''R%C3%A9sum%C3%A9%20%28final%29.md");
  });
});

describe("htmlToMarkdown", () => {
  it("handles nested lists, code and strikethrough without throwing", () => {
    const md = htmlToMarkdown(
      "<ul><li><p>a</p><ul><li><p>nested</p></li></ul></li></ul><pre><code>x = 1</code></pre><p><s>gone</s> <code>inline</code></p>",
    );
    expect(md).toContain("nested");
    expect(md).toContain("```");
    expect(md).toContain("~~gone~~");
    expect(md).toContain("`inline`");
  });
});
