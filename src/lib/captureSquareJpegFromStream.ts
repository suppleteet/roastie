import { VISION_FRAME_SIZE } from "@/lib/constants";
import { centerCropSquare } from "@/lib/videoUtils";

const CAPTURE_TIMEOUT_MS = 5000;

/**
 * Grab one center-cropped JPEG frame from a MediaStream (same geometry as WebcamCapture).
 * Used to start greeting/vision API work before the WebcamCapture ref is ready.
 */
export function captureSquareJpegFromStream(stream: MediaStream): Promise<string | undefined> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;

    const timeoutId = window.setTimeout(() => {
      cleanup();
      resolve(undefined);
    }, CAPTURE_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeoutId);
      video.pause();
      video.srcObject = null;
      video.onloadedmetadata = null;
      video.onerror = null;
    };

    const finish = (base64: string | undefined) => {
      cleanup();
      resolve(base64);
    };

    video.onerror = () => finish(undefined);

    video.onloadedmetadata = () => {
      video
        .play()
        .then(() => {
          const tryGrab = () => {
            const vw = video.videoWidth || 0;
            const vh = video.videoHeight || 0;
            if (vw < 2 || vh < 2) {
              requestAnimationFrame(tryGrab);
              return;
            }
            const canvas = document.createElement("canvas");
            const size = VISION_FRAME_SIZE;
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext("2d");
            if (!ctx) {
              finish(undefined);
              return;
            }
            const { side, sx, sy } = centerCropSquare(vw, vh);
            ctx.drawImage(video, sx, sy, side, side, 0, 0, size, size);
            const dataUrl = canvas.toDataURL("image/jpeg", 0.8).split(",")[1];
            finish(dataUrl || undefined);
          };
          tryGrab();
        })
        .catch(() => finish(undefined));
    };
  });
}
