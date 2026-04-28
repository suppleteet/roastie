import { describe, expect, it } from "vitest";
import { parseRangeHeader } from "@/lib/httpRange";

describe("parseRangeHeader", () => {
  it("parses closed byte ranges", () => {
    expect(parseRangeHeader("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
  });

  it("parses open-ended byte ranges", () => {
    expect(parseRangeHeader("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
  });

  it("parses suffix byte ranges", () => {
    expect(parseRangeHeader("bytes=-25", 100)).toEqual({ start: 75, end: 99 });
  });

  it("clamps end to file size", () => {
    expect(parseRangeHeader("bytes=90-200", 100)).toEqual({ start: 90, end: 99 });
  });

  it("rejects invalid ranges", () => {
    expect(parseRangeHeader("bytes=20-10", 100)).toBeNull();
    expect(parseRangeHeader("bytes=100-101", 100)).toBeNull();
    expect(parseRangeHeader("bytes=-0", 100)).toBeNull();
    expect(parseRangeHeader("items=0-10", 100)).toBeNull();
    expect(parseRangeHeader("bytes=0-1,4-5", 100)).toBeNull();
  });
});
