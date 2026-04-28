import { describe, expect, it } from "vitest";
import {
  chooseRecorderFormat,
  contentTypeForVideoFilename,
  extensionForMimeType,
  isSafeVideoFilename,
  recommendedVideoBitsPerSecond,
} from "@/lib/mediaRecorderSupport";

describe("mediaRecorderSupport", () => {
  it("prefers the first supported format", () => {
    const format = chooseRecorderFormat((mime) => mime === "video/webm;codecs=vp8,opus");
    expect(format.mimeType).toBe("video/webm;codecs=vp8,opus");
    expect(format.extension).toBe("webm");
  });

  it("falls back to basic webm when support probing fails", () => {
    const format = chooseRecorderFormat(() => {
      throw new Error("probe failed");
    });
    expect(format.mimeType).toBe("video/webm");
  });

  it("derives extension from mime type", () => {
    expect(extensionForMimeType("video/mp4;codecs=h264,aac")).toBe("mp4");
    expect(extensionForMimeType("video/webm;codecs=vp9,opus")).toBe("webm");
    expect(extensionForMimeType(null)).toBe("webm");
  });

  it("derives response content type from filename", () => {
    expect(contentTypeForVideoFilename("clip.mp4")).toBe("video/mp4");
    expect(contentTypeForVideoFilename("clip.webm")).toBe("video/webm");
  });

  it("rejects unsafe video filenames", () => {
    expect(isSafeVideoFilename("roast.mp4")).toBe(true);
    expect(isSafeVideoFilename("roast.webm")).toBe(true);
    expect(isSafeVideoFilename("../roast.mp4")).toBe(false);
    expect(isSafeVideoFilename("nested/roast.mp4")).toBe(false);
    expect(isSafeVideoFilename("notes.txt")).toBe(false);
  });

  it("keeps recommended bitrate inside practical bounds", () => {
    expect(recommendedVideoBitsPerSecond(720, 720, 30)).toBeGreaterThanOrEqual(2_500_000);
    expect(recommendedVideoBitsPerSecond(3840, 2160, 60)).toBeLessThanOrEqual(8_000_000);
  });
});
