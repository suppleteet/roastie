import { describe, it, expect } from "vitest";
import { getJokePrompt } from "@/lib/prompts";

describe("getJokePrompt", () => {
  describe("context-specific instructions", () => {
    it("contains greeting task heading for greeting context", () => {
      const prompt = getJokePrompt("greeting", "kvetch", 3, "clean");
      expect(prompt).toContain("Task: Quick Opening");
      expect(prompt).toContain("HARD LENGTH CAP: 24 words total");
    });

    it("contains vision_opening task heading", () => {
      const prompt = getJokePrompt("vision_opening", "kvetch", 3, "clean");
      expect(prompt).toContain("Task: First Vision Joke");
    });

    it("contains answer_roast task heading", () => {
      const prompt = getJokePrompt("answer_roast", "kvetch", 3, "clean");
      expect(prompt).toContain("Task: Roast Response");
    });

    it("contains vision_react task heading", () => {
      const prompt = getJokePrompt("vision_react", "kvetch", 3, "clean");
      expect(prompt).toContain("Task: React to Visual Change");
    });

    it("contains hopper task heading", () => {
      const prompt = getJokePrompt("hopper", "kvetch", 3, "clean");
      expect(prompt).toContain("Task: Background Joke Generation");
    });
  });

  describe("intensity flavor", () => {
    it("intensity 1 includes gentle/playful description", () => {
      const prompt = getJokePrompt("answer_roast", "kvetch", 1, "clean");
      expect(prompt).toContain("gentle and playful");
    });

    it("intensity 5 includes MAXIMUM BURN", () => {
      const prompt = getJokePrompt("answer_roast", "kvetch", 5, "clean");
      expect(prompt).toContain("MAXIMUM BURN");
    });

    it("intensity rating appears in prompt", () => {
      const prompt = getJokePrompt("answer_roast", "kvetch", 3, "clean");
      expect(prompt).toContain("3/5");
    });
  });

  describe("content mode", () => {
    it("clean mode includes profanity restriction", () => {
      const prompt = getJokePrompt("answer_roast", "kvetch", 3, "clean");
      expect(prompt).toContain("CLEAN MODE: ZERO profanity");
    });

    it("vulgar mode enables profanity", () => {
      const prompt = getJokePrompt("answer_roast", "kvetch", 5, "vulgar");
      expect(prompt).toContain("VULGAR MODE IS ON");
    });
  });

  describe("answer_roast rules", () => {
    it("includes FILLER RULE", () => {
      const prompt = getJokePrompt("answer_roast", "kvetch", 3, "clean");
      expect(prompt).toContain("FILLER RULE");
      expect(prompt).toContain("FILLER_ALREADY_SAID");
    });

    it("includes PIPELINE RULE", () => {
      const prompt = getJokePrompt("answer_roast", "kvetch", 3, "clean");
      expect(prompt).toContain("PIPELINE RULE");
      expect(prompt).toContain("JOKES ALREADY DELIVERED THIS CYCLE");
    });

    it("includes quality and topper guidance", () => {
      const prompt = getJokePrompt("answer_roast", "kvetch", 3, "clean");
      expect(prompt).toContain("Joke Quality Bar");
      expect(prompt).toContain("shorter topper");
    });

    it("includes BACKGROUND RULE", () => {
      const prompt = getJokePrompt("answer_roast", "kvetch", 3, "clean");
      expect(prompt).toContain("BACKGROUND RULE");
    });

    it("instructs to use QUESTION ASKED and USER'S ANSWER", () => {
      const prompt = getJokePrompt("answer_roast", "kvetch", 3, "clean");
      expect(prompt).toContain("QUESTION ASKED");
      expect(prompt).toContain("USER'S ANSWER");
    });
  });

  describe("response schema", () => {
    it("includes JSON schema with required fields", () => {
      const prompt = getJokePrompt("greeting", "kvetch", 3, "clean");
      expect(prompt).toContain('"relevant"');
      expect(prompt).toContain('"jokes"');
      expect(prompt).toContain('"followUp"');
    });

    it("lists valid motion states", () => {
      const prompt = getJokePrompt("hopper", "kvetch", 3, "clean");
      expect(prompt).toContain("idle");
      expect(prompt).toContain("laugh");
      expect(prompt).toContain("smug");
    });
  });

  describe("persona-specific content", () => {
    it("includes persona name in character description", () => {
      const prompt = getJokePrompt("greeting", "kvetch", 3, "clean");
      // Should contain some persona name (not testing exact name to avoid coupling)
      expect(prompt).toMatch(/You are ".*"/);
    });

    it("uses default persona (kvetch) when none specified", () => {
      const withDefault = getJokePrompt("greeting");
      const withKvetch = getJokePrompt("greeting", "kvetch", 3, "clean");
      expect(withDefault).toBe(withKvetch);
    });
  });
});
