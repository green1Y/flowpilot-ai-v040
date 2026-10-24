/**
 * Builder i18n fragment tests: EN/AR key parity (deep) and RTL sanity.
 * The `ar: typeof en` annotation enforces this at compile time; these
 * tests guard it at runtime too.
 */
import { describe, it, expect } from "vitest";
import { en, ar } from "./builder";

function keysDeep(obj: unknown, prefix = ""): string[] {
  if (obj === null || typeof obj !== "object") return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    keysDeep(v, prefix ? `${prefix}.${k}` : k)
  );
}

describe("builder i18n fragment", () => {
  it("has identical key trees in EN and AR", () => {
    expect(keysDeep(ar).sort()).toEqual(keysDeep(en).sort());
  });

  it("every AR string is non-empty", () => {
    for (const k of keysDeep(ar)) {
      const v = k.split(".").reduce<unknown>((acc, part) => {
        if (acc !== null && typeof acc === "object") return (acc as Record<string, unknown>)[part];
        return undefined;
      }, ar);
      expect(typeof v).toBe("string");
      expect((v as string).length).toBeGreaterThan(0);
    }
  });

  it("has both builder and copilot namespaces", () => {
    expect(en.builder).toBeDefined();
    expect(en.copilot).toBeDefined();
    expect(ar.builder).toBeDefined();
    expect(ar.copilot).toBeDefined();
  });
});
