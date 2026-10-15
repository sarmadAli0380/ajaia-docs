import type { ReactNode } from "react";
import { Modal } from "./Modal";

interface ConfirmDialogProps {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  pending?: boolean;
  onConfirm(): void;
  onCancel(): void;
}

/** In-app replacement for window.confirm (EC-17, EC-19, EC-22). */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  danger = false,
  pending = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      busy={pending}
      size="small"
      alert
      footer={
        <>
          <button type="button" className="button" onClick={onCancel} disabled={pending} data-autofocus>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`button ${danger ? "button-danger" : "button-primary"}`}
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? "Working…" : confirmLabel}
          </button>
        </>
      }
    >
      <div className="confirm-text">{children}</div>
    </Modal>
  );
}
