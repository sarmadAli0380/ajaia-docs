import mammoth from "mammoth";
import { marked } from "marked";
import {
  DEFAULT_TITLE,
  MAX_TITLE_LENGTH,
  MAX_UPLOAD_BYTES,
  SUPPORTED_IMPORT_EXTENSIONS,
  formatBytes,
  type ImportExtension,
} from "../../shared/limits.js";
import type { Db } from "../db/index.js";
import { createImportedDocument, type DocumentDetail } from "./documents.js";
import { tooLarge, unsupportedType, validationError } from "./errors.js";
import { normalizeTitleText, truncateCodePoints } from "./text.js";
import { ZipBudgetError, ZipFormatError, assertInflatedSizeWithin, inspectZip } from "./zip.js";

/** Upper bounds for what a 2 MB .docx may expand to before we refuse to parse it. */
const MAX_DOCX_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_DOCX_ENTRIES = 2000;

export interface UploadedFile {
  originalName: string;
  buffer: Buffer;
}

const COULD_NOT_READ = "Could not read file: it does not look like a valid document of that type";

function splitName(rawName: string): { stem: string; extension: string } {
  // Strip any client-supplied path (POSIX or Windows) - only the last segment counts.
  const base = rawName.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot < 0) return { stem: base, extension: "" };
  return { stem: base.slice(0, dot), extension: base.slice(dot).toLowerCase() };
}

function isSupported(ext: string): ext is ImportExtension {
  return (SUPPORTED_IMPORT_EXTENSIONS as readonly string[]).includes(ext);
}

/** Safe, trimmed document title from an upload filename (EC-15). */
export function titleFromFilename(rawName: string): string {
  const { stem } = splitName(rawName);
  const title = truncateCodePoints(normalizeTitleText(stem), MAX_TITLE_LENGTH).trim();
  return title.length > 0 ? title : DEFAULT_TITLE;
}

/** Decodes text that may carry a BOM or not be UTF-8 at all (EC-13). */
export function decodeText(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(buf.subarray(3));
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(buf.subarray(2));
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(buf.subarray(2));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    // Most common non-UTF-8 text on desktops; every byte maps to something.
    return decodeWindows1252(buf);
  }
}

/** Windows-1252 code points for bytes 0x80-0x9F (undefined: same as Latin-1, per WHATWG). */
const CP1252_HIGH: ReadonlyArray<number | undefined> = [
  0x20ac, undefined, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152,
  undefined, 0x017d, undefined, undefined, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc,
  0x2122, 0x0161, 0x203a, 0x0153, undefined, 0x017e, 0x0178,
];

/**
 * Explicit table instead of TextDecoder("windows-1252"): some Node versions decode
 * that label as plain Latin-1, turning curly quotes into C1 control characters.
 */
export function decodeWindows1252(buf: Buffer): string {
  let out = "";
  for (const byte of buf) {
    const mapped = byte >= 0x80 && byte <= 0x9f ? CP1252_HIGH[byte - 0x80] : undefined;
    out += String.fromCharCode(mapped ?? byte);
  }
  return out;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Plain text -> paragraphs on blank lines, <br> on single line breaks. */
export function textToHtml(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n");
  return normalized
    .split(/\n[ \t]*\n+/)
    .map((block) => block.replace(/^\n+|\n+$/g, ""))
    .filter((block) => block.trim().length > 0)
    .map((block) => `<p>${block.split("\n").map(escapeHtml).join("<br>")}</p>`)
    .join("");
}

export function markdownToHtml(markdown: string): string {
  return marked.parse(markdown, { async: false, gfm: true, breaks: false });
}

export async function docxToHtml(buf: Buffer): Promise<string> {
  let info;
  try {
    info = inspectZip(buf);
  } catch (err) {
    if (err instanceof ZipFormatError) throw validationError(COULD_NOT_READ);
    throw err;
  }
  if (info.entryCount > MAX_DOCX_ENTRIES || info.uncompressedBytes > MAX_DOCX_UNCOMPRESSED_BYTES) {
    throw tooLarge("This .docx expands to too much data to import");
  }
  // Declared sizes are uploader-controlled; enforce the real decompressed size too.
  try {
    assertInflatedSizeWithin(buf, MAX_DOCX_UNCOMPRESSED_BYTES);
  } catch (err) {
    if (err instanceof ZipBudgetError) throw tooLarge("This .docx expands to too much data to import");
    if (err instanceof ZipFormatError) throw validationError(COULD_NOT_READ);
    throw err;
  }
  try {
    const result = await mammoth.convertToHtml(
      { buffer: buf },
      {
        // Keep underline (mammoth ignores it by default); images are dropped.
        styleMap: ["u => u"],
        convertImage: mammoth.images.imgElement(async () => ({ src: "" })),
        externalFileAccess: false,
      },
    );
    return result.value;
  } catch {
    throw validationError(COULD_NOT_READ);
  }
}

/** Converts an uploaded file into a new document owned by the uploader (AC-IMPORT). */
export async function importDocument(
  db: Db,
  userId: string,
  file: UploadedFile | undefined,
): Promise<DocumentDetail> {
  if (!file) throw validationError("No file uploaded. Send the file in a form field named 'file'.");
  const { extension } = splitName(file.originalName);
  if (!isSupported(extension)) {
    throw unsupportedType(`Unsupported file type. Supported types: ${SUPPORTED_IMPORT_EXTENSIONS.join(", ")}`);
  }
  if (file.buffer.length === 0) throw validationError("The file is empty");
  if (file.buffer.length > MAX_UPLOAD_BYTES) {
    throw tooLarge(`File is too large (maximum ${formatBytes(MAX_UPLOAD_BYTES)})`);
  }

  let html: string;
  switch (extension) {
    case ".txt":
      html = textToHtml(decodeText(file.buffer));
      break;
    case ".md":
      html = markdownToHtml(decodeText(file.buffer));
      break;
    case ".docx":
      html = await docxToHtml(file.buffer);
      break;
  }
  return createImportedDocument(db, userId, titleFromFilename(file.originalName), html);
}
