import { getSchema, type JSONContent } from "@tiptap/core";
import { generateHTML, generateJSON } from "@tiptap/html";
import { describe, expect, it } from "vitest";
import { sanitizeDocumentHtml } from "../../../server/services/sanitize.js";
import { createExtensions } from "./editorExtensions";

/**
 * Parity guard: the TipTap schema (client) and the server sanitizer allowlist must agree.
 * Anything the editor can produce must survive sanitization unchanged, and anything the
 * sanitizer keeps (e.g. links from imports) must survive a trip through the editor.
 */

const EXPECTED_NODES = [
  "blockquote",
  "bulletList",
  "codeBlock",
  "doc",
  "hardBreak",
  "heading",
  "horizontalRule",
  "listItem",
  "orderedList",
  "paragraph",
  "text",
];
const EXPECTED_MARKS = ["bold", "code", "italic", "link", "strike", "underline"];

const WEB = ["https", "://example.test/a?b=1"].join("");
const WEB2 = ["https", "://example.test/x"].join("");
const MAIL = "mailto:someone@example.test";

const text = (t: string, marks: JSONContent["marks"] = []): JSONContent => ({ type: "text", text: t, marks });
const para = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });

/** A document using every node and mark the schema has (keep in sync with EXPECTED_*). */
const EVERYTHING: JSONContent = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 1 }, content: [text("H1")] },
    { type: "heading", attrs: { level: 2 }, content: [text("H2")] },
    { type: "heading", attrs: { level: 3 }, content: [text("H3")] },
    para(
      text("bold", [{ type: "bold" }]),
      text("italic", [{ type: "italic" }]),
      text("underline", [{ type: "underline" }]),
      text("strike", [{ type: "strike" }]),
      text("code", [{ type: "code" }]),
      { type: "hardBreak" },
      text("web", [{ type: "link", attrs: { href: WEB } }]),
      text("mail", [{ type: "link", attrs: { href: MAIL } }]),
      text("all", [{ type: "bold" }, { type: "italic" }, { type: "underline" }, { type: "strike" }]),
    ),
    { type: "bulletList", content: [{ type: "listItem", content: [para(text("bullet"))] }] },
    { type: "orderedList", attrs: { start: 1 }, content: [{ type: "listItem", content: [para(text("one"))] }] },
    { type: "orderedList", attrs: { start: 3 }, content: [{ type: "listItem", content: [para(text("three"))] }] },
    { type: "blockquote", content: [para(text("quote"))] },
    { type: "codeBlock", content: [text("const x = 1;")] },
    { type: "horizontalRule" },
  ],
};

/** Void-element spelling (`<br>` vs `<br />`) is serializer style, not content. */
const voidStyle = (html: string) => html.replace(/<(br|hr)\s*\/?>/g, "<$1>");

function collectTypes(node: JSONContent, nodes: Set<string>, marks: Set<string>) {
  if (node.type) nodes.add(node.type);
  for (const m of node.marks ?? []) marks.add(m.type);
  for (const child of node.content ?? []) collectTypes(child, nodes, marks);
}

describe("editor schema <-> server sanitizer parity", () => {
  const extensions = createExtensions();
  const schema = getSchema(extensions);

  it("the editor schema has exactly the nodes and marks this guard covers", () => {
    expect(Object.keys(schema.nodes).sort()).toEqual(EXPECTED_NODES);
    expect(Object.keys(schema.marks).sort()).toEqual(EXPECTED_MARKS);
    const nodes = new Set<string>();
    const marks = new Set<string>();
    collectTypes(EVERYTHING, nodes, marks);
    expect([...nodes].sort()).toEqual(EXPECTED_NODES);
    expect([...marks].sort()).toEqual(EXPECTED_MARKS);
  });

  it("every tag and attribute the editor emits survives the sanitizer unchanged", () => {
    const html = generateHTML(EVERYTHING, extensions);
    expect(html).toContain("<a ");
    expect(html).not.toContain("target=");
    expect(voidStyle(sanitizeDocumentHtml(html))).toBe(voidStyle(html));
  });

  it("links kept by the sanitizer (e.g. from imports) survive a round-trip through the editor", () => {
    const stored = sanitizeDocumentHtml(`<p>See <a href="${WEB2}" title="t">site</a> or <a href="${MAIL}">mail</a></p>`);
    expect(stored).toContain(`href="${WEB2}"`);
    const reEmitted = generateHTML(generateJSON(stored, extensions), extensions);
    expect(reEmitted).toContain(`href="${WEB2}"`);
    expect(reEmitted).toContain(`href="${MAIL}"`);
    expect(voidStyle(sanitizeDocumentHtml(reEmitted))).toBe(voidStyle(reEmitted));
  });

  it("the editor refuses link schemes the sanitizer would strip", () => {
    const json = generateJSON('<p><a href="javascript:alert(1)">x</a><a href="//evil.test">y</a></p>', extensions);
    const html = generateHTML(json, extensions);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toContain("//evil.test");
  });
});
