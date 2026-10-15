import type { Editor } from "@tiptap/react";

interface ToolbarButton {
  key: string;
  label: string;
  text: string;
  shortcut?: string;
  isActive?: (e: Editor) => boolean;
  isDisabled?: (e: Editor) => boolean;
  run: (e: Editor) => void;
  className?: string;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl+";

const GROUPS: ToolbarButton[][] = [
  [
    {
      key: "undo",
      label: "Undo",
      text: "↶",
      shortcut: `${MOD}Z`,
      isDisabled: (e) => !e.can().undo(),
      run: (e) => e.chain().focus().undo().run(),
    },
    {
      key: "redo",
      label: "Redo",
      text: "↷",
      shortcut: isMac ? "⌘⇧Z" : "Ctrl+Y",
      isDisabled: (e) => !e.can().redo(),
      run: (e) => e.chain().focus().redo().run(),
    },
  ],
  [
    {
      key: "bold",
      label: "Bold",
      text: "B",
      shortcut: `${MOD}B`,
      className: "tb-bold",
      isActive: (e) => e.isActive("bold"),
      run: (e) => e.chain().focus().toggleBold().run(),
    },
    {
      key: "italic",
      label: "Italic",
      text: "I",
      shortcut: `${MOD}I`,
      className: "tb-italic",
      isActive: (e) => e.isActive("italic"),
      run: (e) => e.chain().focus().toggleItalic().run(),
    },
    {
      key: "underline",
      label: "Underline",
      text: "U",
      shortcut: `${MOD}U`,
      className: "tb-underline",
      isActive: (e) => e.isActive("underline"),
      run: (e) => e.chain().focus().toggleUnderline().run(),
    },
  ],
  ([1, 2, 3] as const).map((level) => ({
    key: `h${level}`,
    label: `Heading ${level}`,
    text: `H${level}`,
    isActive: (e: Editor) => e.isActive("heading", { level }),
    run: (e: Editor) => e.chain().focus().toggleHeading({ level }).run(),
  })),
  [
    {
      key: "bullet",
      label: "Bulleted list",
      text: "• List",
      isActive: (e) => e.isActive("bulletList"),
      run: (e) => e.chain().focus().toggleBulletList().run(),
    },
    {
      key: "ordered",
      label: "Numbered list",
      text: "1. List",
      isActive: (e) => e.isActive("orderedList"),
      run: (e) => e.chain().focus().toggleOrderedList().run(),
    },
  ],
];

/** Formatting toolbar with active-state indication (aria-pressed). Wraps on wide screens, scrolls on phones. */
export function Toolbar({ editor, disabled }: { editor: Editor | null; disabled: boolean }) {
  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting" aria-disabled={disabled}>
      {GROUPS.map((group, gi) => (
        <div className="toolbar-group" key={gi}>
          {group.map((b) => {
            const active = editor && b.isActive ? b.isActive(editor) : undefined;
            const isDisabled = disabled || !editor || (b.isDisabled ? b.isDisabled(editor) : false);
            return (
              <button
                key={b.key}
                type="button"
                className={`toolbar-button ${b.className ?? ""} ${active ? "is-active" : ""}`}
                aria-label={b.label}
                aria-pressed={b.isActive ? Boolean(active) : undefined}
                title={b.shortcut ? `${b.label} (${b.shortcut})` : b.label}
                disabled={isDisabled}
                // Keep the editor selection when clicking a button.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => editor && b.run(editor)}
              >
                {b.text}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
