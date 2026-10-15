/** Minimal shape needed to decide focus moves (lets the logic be unit-tested without a DOM). */
export interface FocusContainer<T> {
  contains(node: T | null): boolean;
}

/**
 * Decides where Tab/Shift+Tab should move focus inside a modal dialog.
 * Returns the element to focus (caller prevents the default), or null to let the
 * browser move focus normally. Focus outside the dialog - including <body> after the
 * focused control was disabled - is always pulled back in.
 */
export function trapTabTarget<T>(
  dialog: FocusContainer<T> & T,
  items: readonly T[],
  active: T | null,
  shiftKey: boolean,
): T | null {
  if (items.length === 0) return dialog;
  const first = items[0]!;
  const last = items[items.length - 1]!;
  if (active === null || !dialog.contains(active)) return shiftKey ? last : first;
  if (shiftKey && (active === first || active === dialog)) return last;
  if (!shiftKey && active === last) return first;
  return null;
}
