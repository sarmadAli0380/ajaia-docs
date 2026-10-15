import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { trapTabTarget } from "../lib/focusTrap";

interface ModalProps {
  title: string;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  /** While busy the dialog cannot be dismissed (pending request). */
  busy?: boolean;
  size?: "small" | "medium" | "large";
  /** Rendered with role="alertdialog" (confirmations). */
  alert?: boolean;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Open dialogs, innermost last; only the topmost one reacts to keys and focus. */
const openDialogs: HTMLElement[] = [];

/**
 * Accessible in-app dialog: focus moves in and is trapped (document-level, so it
 * survives focus falling to <body>), Escape/backdrop close it,
 * focus returns to the opener. Full-screen on phones via CSS.
 */
export function Modal({ title, onClose, children, footer, busy = false, size = "medium", alert = false }: ModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    // Register before focusing so an outer dialog's focus guard doesn't pull focus back.
    if (dialog) openDialogs.push(dialog);
    const preferred = dialog?.querySelector<HTMLElement>("[data-autofocus]");
    const first = preferred ?? dialog?.querySelector<HTMLElement>(FOCUSABLE) ?? dialog;
    first?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Document-level so Escape/Tab still work when focus has fallen out of the dialog
    // (e.g. the focused control became disabled and the browser moved focus to <body>).
    const onKeyDown = (e: KeyboardEvent) => {
      if (!dialog || openDialogs[openDialogs.length - 1] !== dialog) return; // only the topmost dialog
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (!busyRef.current) onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      const target = trapTabTarget<HTMLElement>(dialog, items, document.activeElement as HTMLElement | null, e.shiftKey);
      if (target) {
        e.preventDefault();
        target.focus();
      }
    };
    // Focus moving to something outside the topmost dialog is pulled back in.
    const onFocusIn = (e: FocusEvent) => {
      if (!dialog || openDialogs[openDialogs.length - 1] !== dialog) return;
      if (e.target instanceof Node && !dialog.contains(e.target)) dialog.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      const index = dialog ? openDialogs.lastIndexOf(dialog) : -1;
      if (index >= 0) openDialogs.splice(index, 1);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, []);

  // When a busy phase starts or ends, controls may have been disabled under the focus;
  // keep focus inside the dialog rather than letting it drop to <body>.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) dialog.focus();
  }, [busy]);

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busyRef.current) onCloseRef.current();
      }}
    >
      <div
        ref={dialogRef}
        className={`modal modal-${size}`}
        role={alert ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="modal-header">
          <h2 id={titleId} className="modal-title">
            {title}
          </h2>
          <button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose} disabled={busy}>
            ×
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-footer">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}
