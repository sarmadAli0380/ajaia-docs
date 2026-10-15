import TurndownService from "turndown";
import type { Db } from "../db/index.js";
import { getDocument } from "./documents.js";
import { truncateCodePoints } from "./text.js";

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
  strongDelimiter: "**",
});
// Markdown has no underline; keep the text, drop the mark.
turndown.addRule("underline", { filter: ["u"], replacement: (content) => content });
turndown.addRule("strikethrough", { filter: ["s", "strike"], replacement: (content) => `~~${content}~~` });

export function htmlToMarkdown(html: string): string {
  const md = turndown.turndown(html).trim();
  return md.length > 0 ? `${md}\n` : "";
}

const FALLBACK_BASENAME = "document";

/**
 * Builds a download filename from a title (EC-18). Removes path separators, quotes,
 * control characters and other characters that are unsafe in filenames or headers.
 */
export function exportBaseName(title: string): string {
  const cleaned = title
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, " ")
    .replace(/[\\/:*?"<>|;,]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "");
  const limited = truncateCodePoints(cleaned, 100).trim();
  return limited.length > 0 ? limited : FALLBACK_BASENAME;
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Content-Disposition value with an ASCII fallback and a UTF-8 filename*. */
export function contentDisposition(title: string): { header: string; filename: string } {
  const base = exportBaseName(title);
  const filename = `${base}.md`;
  const asciiBase = base.replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ").trim();
  const asciiName = /[A-Za-z0-9]/.test(asciiBase) ? `${asciiBase}.md` : `${FALLBACK_BASENAME}.md`;
  return {
    filename,
    header: `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeRfc5987(filename)}`,
  };
}

export async function exportMarkdown(
  db: Db,
  userId: string,
  documentId: unknown,
): Promise<{ markdown: string; filename: string; contentDisposition: string }> {
  const doc = await getDocument(db, userId, documentId);
  const { header, filename } = contentDisposition(doc.title);
  return { markdown: htmlToMarkdown(doc.content), filename, contentDisposition: header };
}
