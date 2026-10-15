import Link from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import StarterKit from "@tiptap/starter-kit";

/**
 * Editor schema: StarterKit (headings limited to H1-H3) + Underline + Link.
 * Mirrors the server sanitizer allowlist (guarded by editorSanitizerParity.test.ts):
 * links keep only http/https/mailto, carry the same rel the server enforces, and no
 * target attribute (the sanitizer does not allow one).
 */
export function createExtensions() {
  return [
    StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
    Underline,
    Link.configure({
      openOnClick: false,
      autolink: false,
      linkOnPaste: false,
      protocols: ["http", "https", "mailto"],
      // Same rule as the server sanitizer: http/https/mailto or a relative URL; no other
      // scheme and no protocol-relative "//host" URLs.
      isAllowedUri: (url) => {
        const u = url.trim();
        if (u.startsWith("//")) return false;
        return !/^[a-z][a-z0-9+.-]*:/i.test(u) || /^(https?|mailto):/i.test(u);
      },
      HTMLAttributes: { rel: "noopener noreferrer nofollow", target: null, class: null },
    }),
  ];
}
