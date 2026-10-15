import { EditorContent, useEditor } from "@tiptap/react";
import { createExtensions } from "../lib/editorExtensions";

/**
 * Renders stored HTML through the editor schema (never via innerHTML), so anything
 * outside the schema is dropped even if it somehow reached the database.
 */
export function ReadOnlyContent({ html, label }: { html: string; label: string }) {
  const editor = useEditor({
    extensions: createExtensions(),
    content: html,
    editable: false,
    editorProps: { attributes: { class: "prose", "aria-label": label, role: "document" } },
  });
  return <EditorContent editor={editor} className="readonly-content" />;
}
