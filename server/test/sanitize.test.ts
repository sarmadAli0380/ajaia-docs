import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sanitizeDocumentHtml } from "../services/sanitize.js";
import { createDoc, createTestContext, signIn, type ApiClient, type TestContext } from "./helpers.js";

const SITE = ["https", "://example.test/page"].join("");

/** Payloads that must never survive storage (AC-SANITIZE, REG-12). */
const XSS_CORPUS = [
  "<script>alert(1)</script>",
  "<SCRIPT SRC=//evil.test/x.js></SCRIPT>",
  '<img src=x onerror="alert(1)">',
  '<p onclick="alert(1)">click</p>',
  '<a href="javascript:alert(1)">js</a>',
  '<a href="JaVaScRiPt:alert(1)">mixed case</a>',
  '<a href="&#106;avascript:alert(1)">entity</a>',
  '<a href="  javascript:alert(1)">leading space</a>',
  '<a href="vbscript:msgbox(1)">vb</a>',
  '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">data</a>',
  "<iframe src=\"//evil.test\"></iframe>",
  '<svg><script>alert(1)</script></svg>',
  '<svg onload="alert(1)"></svg>',
  '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
  "<style>body{display:none}</style>",
  '<p style="background:url(javascript:alert(1))">styled</p>',
  '<object data="evil.swf"></object>',
  '<embed src="evil.swf">',
  '<form action="//evil.test"><input name=x></form>',
  '<meta http-equiv="refresh" content="0;url=//evil.test">',
  '<base href="//evil.test/">',
  '<details open ontoggle="alert(1)">x</details>',
  '<p><a href="#" onmouseover="alert(1)">hover</a></p>',
];

const FORBIDDEN = [
  "<script",
  "onerror",
  "onclick",
  "onload",
  "ontoggle",
  "onmouseover",
  "javascript:",
  "vbscript:",
  "data:",
  "<iframe",
  "<svg",
  "<math",
  "<style",
  "style=",
  "<object",
  "<embed",
  "<form",
  "<input",
  "<meta",
  "<base",
  "<img",
];

describe("sanitizeDocumentHtml", () => {
  it.each(XSS_CORPUS)("neutralizes %s", (payload) => {
    const out = sanitizeDocumentHtml(payload).toLowerCase();
    for (const bad of FORBIDDEN) expect(out, bad).not.toContain(bad);
  });

  it("round-trips everything the editor produces unchanged", () => {
    const html =
      "<h1>H1</h1><h2>H2</h2><h3>H3</h3><p><strong>b</strong><em>i</em><u>u</u><s>s</s><code>c</code><br />x</p>" +
      "<ul><li><p>a</p></li></ul><ol><li><p>b</p></li></ol><blockquote><p>q</p></blockquote><pre><code>x</code></pre><hr />";
    expect(sanitizeDocumentHtml(html)).toBe(html);
  });

  it("keeps safe links and forces rel", () => {
    expect(sanitizeDocumentHtml(`<a href="${SITE}">ok</a>`)).toBe(
      `<a href="${SITE}" rel="noopener noreferrer nofollow">ok</a>`,
    );
    expect(sanitizeDocumentHtml('<a href="mailto:a@b.test">m</a>')).toContain('href="mailto:a@b.test"');
  });

  it("unwraps unknown tags but keeps their text", () => {
    expect(sanitizeDocumentHtml("<div><span>text</span></div>")).toBe("text");
  });

  it("removes NUL characters and repairs lone surrogates", () => {
    expect(sanitizeDocumentHtml("<p>a\u0000b\uD800c</p>")).toBe("<p>ab�c</p>");
  });
});

describe("sanitization on the save path", () => {
  let ctx: TestContext;
  let alice: ApiClient;
  beforeAll(async () => {
    ctx = await createTestContext();
    alice = await signIn(ctx, "alice");
  });
  afterAll(async () => {
    await ctx.close();
  });

  it("stores sanitized content for every payload", async () => {
    const { id } = await createDoc(alice, "XSS");
    let revision = 1;
    for (const payload of XSS_CORPUS) {
      const res = await alice.put(`/api/documents/${id}/content`, {
        content: `<p>keep</p>${payload}`,
        baseRevision: revision,
      });
      expect(res.status).toBe(200);
      revision = res.body.revision;
      const stored = (await alice.get(`/api/documents/${id}`)).body.document.content.toLowerCase();
      expect(stored).toContain("<p>keep</p>");
      for (const bad of FORBIDDEN) expect(stored, `${payload} -> ${bad}`).not.toContain(bad);
    }
    const versions = (await alice.get(`/api/documents/${id}/versions`)).body.versions;
    for (const v of versions) {
      const preview = (await alice.get(`/api/documents/${id}/versions/${v.id}`)).body.version.content.toLowerCase();
      for (const bad of FORBIDDEN) expect(preview).not.toContain(bad);
    }
  });

  it("a NUL character or lone surrogate in content does not cause a 500", async () => {
    const { id } = await createDoc(alice, "Odd chars");
    const res = await alice.put(`/api/documents/${id}/content`, { content: "<p>a\u0000b\uD800</p>", baseRevision: 1 });
    expect(res.status).toBe(200);
    const title = await alice.patch(`/api/documents/${id}`, { title: "t\uDC00" });
    expect(title.status).toBe(200);
  });
});
