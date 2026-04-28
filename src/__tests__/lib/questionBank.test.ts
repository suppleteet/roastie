import { describe, it, expect } from "vitest";
import { QUESTION_BANK, type ComedyQuestion } from "@/lib/questionBank";

describe("QUESTION_BANK", () => {
  it("is non-empty", () => {
    expect(QUESTION_BANK.length).toBeGreaterThan(0);
  });

  it("has unique IDs", () => {
    const ids = QUESTION_BANK.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes the name question", () => {
    expect(QUESTION_BANK.find((q) => q.id === "name")).toBeDefined();
  });

  it("includes roastable setup questions beyond demographics", () => {
    const ids = QUESTION_BANK.map((q) => q.id);
    expect(ids).toEqual(expect.arrayContaining(["look", "bad_habit", "free_time", "delusion"]));
  });

  for (const q of QUESTION_BANK) {
    describe(`question: ${q.id}`, () => {
      it("has a non-empty question string", () => {
        expect(q.question.trim().length).toBeGreaterThan(0);
      });

      it("has a non-empty jokeContext", () => {
        expect(q.jokeContext.trim().length).toBeGreaterThan(0);
      });

      it("has at least 2 prod lines", () => {
        expect(q.prodLines.length).toBeGreaterThanOrEqual(2);
      });

      if (q.excludes) {
        it("excludes only valid question IDs", () => {
          const allIds = QUESTION_BANK.map((qq) => qq.id);
          for (const ex of q.excludes!) {
            expect(allIds).toContain(ex);
          }
        });
      }
    });
  }
});
