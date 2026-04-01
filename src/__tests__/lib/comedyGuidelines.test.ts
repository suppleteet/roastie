import { describe, it, expect } from "vitest";
import { GLOBAL_COMEDY_GUIDELINES, PERSONA_COMEDY_GUIDELINES, getComedyGuidelinesBlock } from "@/lib/comedyGuidelines";

describe("GLOBAL_COMEDY_GUIDELINES", () => {
  it("is an array", () => {
    expect(Array.isArray(GLOBAL_COMEDY_GUIDELINES)).toBe(true);
  });
});

describe("PERSONA_COMEDY_GUIDELINES", () => {
  it("is an object", () => {
    expect(typeof PERSONA_COMEDY_GUIDELINES).toBe("object");
  });
});

describe("getComedyGuidelinesBlock", () => {
  it("returns empty string when no guidelines exist", () => {
    expect(getComedyGuidelinesBlock()).toBe("");
    expect(getComedyGuidelinesBlock("kvetch")).toBe("");
  });

  it("returns empty string for unknown persona with no global guidelines", () => {
    expect(getComedyGuidelinesBlock("nonexistent")).toBe("");
  });
});
