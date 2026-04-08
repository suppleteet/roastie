import { describe, it, expect } from "vitest";
import { transcriptConfidence } from "@/lib/transcriptConfidence";

describe("transcriptConfidence", () => {
  // ─── Garbage inputs (should score < 0.3) ──────────────────────────────────

  it("returns 0 for empty string", () => {
    expect(transcriptConfidence("", "name")).toBe(0);
  });

  it("returns 0 for whitespace only", () => {
    expect(transcriptConfidence("   ", "name")).toBe(0);
  });

  it("returns 0 for punctuation only", () => {
    expect(transcriptConfidence("...", "name")).toBe(0);
    expect(transcriptConfidence("?!", "name")).toBe(0);
    expect(transcriptConfidence(", .", "name")).toBe(0);
  });

  it("returns 0.1 for single character", () => {
    expect(transcriptConfidence("M", "name")).toBe(0.1);
  });

  it("scores low for all-filler words", () => {
    expect(transcriptConfidence("um", "name")).toBeLessThan(0.3);
    expect(transcriptConfidence("uh yeah", "name")).toBeLessThan(0.3);
    expect(transcriptConfidence("hmm", "name")).toBeLessThan(0.3);
  });

  it("scores low for repeated syllables", () => {
    expect(transcriptConfidence("ba ba ba", "name")).toBeLessThan(0.5);
    expect(transcriptConfidence("the the the", "name")).toBeLessThan(0.5);
  });

  // ─── Valid name inputs (should score >= 0.7) ─────────────────────────────

  it("scores high for a clean capitalized name", () => {
    expect(transcriptConfidence("Tyler", "name")).toBeGreaterThanOrEqual(0.7);
  });

  it("scores high for a two-word name", () => {
    expect(transcriptConfidence("Tyler Hurd", "name")).toBeGreaterThanOrEqual(0.7);
  });

  it("scores high for a three-word name", () => {
    expect(transcriptConfidence("Mary Jane Watson", "name")).toBeGreaterThanOrEqual(0.7);
  });

  // ─── Edge cases ───────────────────────────────────────────────────────────

  it("penalizes suspiciously long name answers", () => {
    const long = transcriptConfidence("I think my name might be John", "name");
    const short = transcriptConfidence("John", "name");
    expect(long).toBeLessThan(short);
  });

  it("treats filler as name with low score", () => {
    // "um" for a name question should be very low
    expect(transcriptConfidence("um", "name")).toBeLessThan(0.3);
  });

  it("gives reasonable score to non-name questions", () => {
    expect(transcriptConfidence("software engineer", "job")).toBeGreaterThanOrEqual(0.7);
    expect(transcriptConfidence("25", "age")).toBeGreaterThanOrEqual(0.5);
    expect(transcriptConfidence("yes", "single")).toBeGreaterThanOrEqual(0.3);
  });

  it("clamps score between 0 and 1", () => {
    // Even with all bonuses, should not exceed 1
    expect(transcriptConfidence("Tyler", "name")).toBeLessThanOrEqual(1);
    // Even with all penalties, should not go below 0
    expect(transcriptConfidence("um um um", "name")).toBeGreaterThanOrEqual(0);
  });
});
