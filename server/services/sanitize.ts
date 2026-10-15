import sanitizeHtml from "sanitize-html";
import { toStorableText } from "./text.js";

/**
 * The single allowlist used for every write path (save, import, restore). It mirrors
 * what the TipTap editor (StarterKit + Underline) can produce; everything else is
 * dropped. Script-like containers are discarded together with their contents.
 */
const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "p",
    "br",
    "strong",
    "b",
    "em",
    "i",
    "u",
    "s",
    "strike",
    "h1",
    "h2",
    "h3",
    "ul",
    "ol",
    "li",
    "blockquote",
    "pre",
    "code",
    "hr",
    "a",
  ],
  allowedAttributes: {
    a: ["href", "title", "rel"],
    ol: ["start"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: {},
  allowedSchemesAppliedToAttributes: ["href"],
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
  nonTextTags: [
    "script",
    "style",
    "textarea",
    "option",
    "noscript",
    "iframe",
    "object",
    "embed",
    "svg",
    "math",
    "template",
    "title",
    "head",
  ],
  transformTags: {
    // The editor only supports three heading levels.
    h4: "h3",
    h5: "h3",
    h6: "h3",
    a: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, rel: "noopener noreferrer nofollow" },
    }),
  },
};

/** Sanitizes document HTML for storage. Pure function; safe to call repeatedly. */
export function sanitizeDocumentHtml(html: string): string {
  return sanitizeHtml(toStorableText(html), OPTIONS).trim();
}
