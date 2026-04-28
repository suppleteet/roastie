export type VideoExtension = "mp4" | "webm";

export interface RecorderFormat {
  mimeType: string;
  extension: VideoExtension;
  label: string;
}

export const RECORDER_FORMAT_CANDIDATES: readonly RecorderFormat[] = [
  {
    mimeType: "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    extension: "mp4",
    label: "MP4/H.264",
  },
  {
    mimeType: "video/mp4;codecs=h264,aac",
    extension: "mp4",
    label: "MP4/H.264",
  },
  {
    mimeType: "video/mp4",
    extension: "mp4",
    label: "MP4",
  },
  {
    mimeType: "video/webm;codecs=vp9,opus",
    extension: "webm",
    label: "WebM/VP9",
  },
  {
    mimeType: "video/webm;codecs=vp8,opus",
    extension: "webm",
    label: "WebM/VP8",
  },
  {
    mimeType: "video/webm",
    extension: "webm",
    label: "WebM",
  },
];

export function extensionForMimeType(mimeType: string | null | undefined): VideoExtension {
  const normalized = (mimeType ?? "").toLowerCase();
  if (normalized.includes("mp4") || normalized.includes("h264") || normalized.includes("avc1")) {
    return "mp4";
  }
  return "webm";
}

export function contentTypeForVideoFilename(filename: string): string {
  return filename.toLowerCase().endsWith(".mp4") ? "video/mp4" : "video/webm";
}

export function isSafeVideoFilename(filename: string | null | undefined): filename is string {
  if (!filename) return false;
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) return false;
  return /\.(mp4|webm)$/i.test(filename);
}

export function chooseRecorderFormat(
  isTypeSupported?: (mimeType: string) => boolean,
): RecorderFormat {
  const supports =
    isTypeSupported ??
    ((mimeType: string) =>
      typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mimeType));

  return (
    RECORDER_FORMAT_CANDIDATES.find((format) => {
      try {
        return supports(format.mimeType);
      } catch {
        return false;
      }
    }) ?? RECORDER_FORMAT_CANDIDATES[RECORDER_FORMAT_CANDIDATES.length - 1]
  );
}

export function recommendedVideoBitsPerSecond(
  width: number,
  height: number,
  fps = 30,
): number {
  const pixelsPerSecond = Math.max(1, width) * Math.max(1, height) * Math.max(1, fps);
  // 0.28 bits/pixel/frame is enough for the stylized puppet + PiP without wasting CPU/bandwidth.
  return Math.round(Math.min(8_000_000, Math.max(2_500_000, pixelsPerSecond * 0.28)));
}
