import { describe, it, expect } from "vitest";
import { diffObservations } from "@/lib/visionDiff";

describe("diffObservations", () => {
  it("returns no changes when sets are identical", () => {
    const obs = ["person sitting", "blue shirt", "messy desk"];
    const result = diffObservations(obs, obs);
    expect(result.changes).toHaveLength(0);
    expect(result.isInteresting).toBe(false);
  });

  it("detects new observations", () => {
    const prev = ["person sitting", "blue shirt"];
    const current = ["person sitting", "blue shirt", "now wearing sunglasses"];
    const result = diffObservations(prev, current);
    expect(result.changes).toContain("now wearing sunglasses");
  });

  it("marks high-interest keyword as interesting", () => {
    const prev = ["person sitting"];
    const current = ["person sitting", "a dog appeared on camera"];
    const result = diffObservations(prev, current);
    expect(result.isInteresting).toBe(true);
  });

  it("marks laughter as high-interest", () => {
    const result = diffObservations([], ["person laughing"]);
    expect(result.isInteresting).toBe(true);
  });

  it("marks crying as high-interest", () => {
    const result = diffObservations([], ["person crying"]);
    expect(result.isInteresting).toBe(true);
  });

  it("marks phone usage as high-interest", () => {
    const result = diffObservations([], ["looking at their phone"]);
    expect(result.isInteresting).toBe(true);
  });

  it("is interesting with 4+ new observations even without keywords", () => {
    const prev = ["person sitting"];
    const current = ["person sitting", "new item 1", "new item 2", "new item 3", "new item 4"];
    const result = diffObservations(prev, current);
    expect(result.isInteresting).toBe(true);
    expect(result.changes).toHaveLength(4);
  });

  it("is NOT interesting with 2 new non-keyword observations", () => {
    const prev = ["person sitting"];
    const current = ["person sitting", "adjusted collar", "leaned back"];
    const result = diffObservations(prev, current);
    expect(result.isInteresting).toBe(false);
    expect(result.changes).toHaveLength(2);
  });

  it("handles empty prev set — everything is new", () => {
    const current = ["person sitting", "blue shirt"];
    const result = diffObservations([], current);
    expect(result.changes).toHaveLength(2);
  });

  it("returns not interesting when current is empty", () => {
    const result = diffObservations(["anything"], []);
    expect(result.isInteresting).toBe(false);
    expect(result.changes).toHaveLength(0);
  });

  it("uses fuzzy substring match — similar observations not flagged as new", () => {
    const prev = ["person wearing blue shirt"];
    const current = ["blue shirt"];
    const result = diffObservations(prev, current);
    expect(result.changes).toHaveLength(0);
  });
});
