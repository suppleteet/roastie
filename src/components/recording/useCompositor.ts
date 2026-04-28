import { useRef, useEffect } from "react";
import { COMPOSITOR_SIZE, PIP_SIZE } from "@/lib/constants";
import { centerCropSquare } from "@/lib/videoUtils";

export interface CompositorHandle {
  canvas: HTMLCanvasElement | null;
  stream: MediaStream | null;
}

/**
 * Creates an offscreen compositor canvas that composites:
 *  1. Puppet canvas (full square)
 *  2. Webcam video as PiP (bottom-right)
 *  3. Watermark image (bottom-left)
 *
 * Runs its own rAF loop. Returns the canvas and its captureStream.
 */
export function useCompositor(
  puppetCanvasRef: React.RefObject<HTMLCanvasElement | null>,
  webcamVideoRef: React.RefObject<HTMLVideoElement | null>
): React.MutableRefObject<CompositorHandle> {
  const handle = useRef<CompositorHandle>({ canvas: null, stream: null });
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const size = COMPOSITOR_SIZE;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const stream = canvas.captureStream(30);
    handle.current = { canvas, stream };

    // Cache the 2D context — getContext called once, not every frame
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const watermark = new Image();
    watermark.src = "/watermark.png";

    function draw() {
      // 1. Puppet canvas
      const puppetCanvas = puppetCanvasRef.current;
      if (puppetCanvas) {
        try {
          ctx!.drawImage(puppetCanvas, 0, 0, size, size);
        } catch {
          ctx!.fillStyle = "#1a0a00";
          ctx!.fillRect(0, 0, size, size);
        }
      } else {
        ctx!.fillStyle = "#1a0a00";
        ctx!.fillRect(0, 0, size, size);
      }

      // 2. Webcam PiP — center-cropped square, bottom-right
      const video = webcamVideoRef.current;
      if (video && video.readyState >= 2) {
        const { videoWidth: vw, videoHeight: vh } = video;
        if (vw > 0 && vh > 0) {
          const { side, sx, sy } = centerCropSquare(vw, vh);
          const pip = PIP_SIZE;
          const margin = 12;
          const px = size - pip - margin;
          const py = size - pip - margin;
          ctx!.save();
          ctx!.beginPath();
          ctx!.roundRect(px, py, pip, pip, 8);
          ctx!.clip();
          ctx!.drawImage(video, sx, sy, side, side, px, py, pip, pip);
          ctx!.restore();
          ctx!.strokeStyle = "rgba(255,255,255,0.5)";
          ctx!.lineWidth = 2;
          ctx!.beginPath();
          ctx!.roundRect(px, py, pip, pip, 8);
          ctx!.stroke();
        }
      }

      // 3. Watermark — bottom-left
      if (watermark.complete && watermark.naturalWidth > 0) {
        ctx!.globalAlpha = 0.6;
        ctx!.drawImage(watermark, 12, size - 36, 120, 24);
        ctx!.globalAlpha = 1;
      } else {
        ctx!.font = "bold 13px sans-serif";
        ctx!.fillStyle = "rgba(255,255,255,0.5)";
        ctx!.fillText("roastie.app", 14, size - 14);
      }

      rafRef.current = requestAnimationFrame(draw);
    }

    rafRef.current = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(rafRef.current);
      stream.getTracks().forEach((track) => track.stop());
    };
  }, [puppetCanvasRef, webcamVideoRef]);

  return handle;
}
