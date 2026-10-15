import { describe, expect, it } from "vitest";
import { trapTabTarget } from "./focusTrap";

interface FakeNode {
  name: string;
  contains(node: FakeNode | null): boolean;
}

function setup() {
  const inside = new Set<FakeNode>();
  const dialog: FakeNode = { name: "dialog", contains: (n) => n !== null && (n === dialog || inside.has(n)) };
  const make = (name: string): FakeNode => ({ name, contains: (n) => n === null ? false : n.name === name });
  const a = make("a");
  const b = make("b");
  const c = make("c");
  [a, b, c].forEach((n) => inside.add(n));
  const body = make("body");
  return { dialog, items: [a, b, c], a, b, c, body };
}

describe("modal Tab trap", () => {
  it("wraps from last to first and first to last", () => {
    const { dialog, items, a, c } = setup();
    expect(trapTabTarget(dialog, items, c, false)).toBe(a);
    expect(trapTabTarget(dialog, items, a, true)).toBe(c);
  });

  it("lets the browser move focus between inner items", () => {
    const { dialog, items, a, b } = setup();
    expect(trapTabTarget(dialog, items, a, false)).toBeNull();
    expect(trapTabTarget(dialog, items, b, true)).toBeNull();
  });

  it("pulls focus back in when it fell to <body> (focused control was disabled)", () => {
    const { dialog, items, a, c, body } = setup();
    expect(trapTabTarget(dialog, items, body, false)).toBe(a);
    expect(trapTabTarget(dialog, items, body, true)).toBe(c);
    expect(trapTabTarget(dialog, items, null, false)).toBe(a);
  });

  it("Shift+Tab from the dialog container goes to the last item", () => {
    const { dialog, items, c } = setup();
    expect(trapTabTarget(dialog, items, dialog, true)).toBe(c);
  });

  it("keeps focus on the dialog when nothing inside is focusable", () => {
    const { dialog, body } = setup();
    expect(trapTabTarget(dialog, [], body, false)).toBe(dialog);
  });
});
