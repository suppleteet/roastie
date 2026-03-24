"use client";
import { useRef, useImperativeHandle, forwardRef } from "react";

export interface VideoRecorderHandle {
  start(compositorStream: MediaStream, audioStream: MediaStream | null): void;
  stop(): Promise<Blob>;
}

const VideoRecorder = forwardRef<VideoRecorderHandle>(function VideoRecorder(_props, ref) {
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useImperativeHandle(ref, () => ({
    start(compositorStream: MediaStream, audioStream: MediaStream | null) {
      // Guard against double-start (React StrictMode fires effects twice in dev,
      // causing sessionStart.then() to schedule two recorder starts)
      if (recorderRef.current?.state === "recording") {
        console.warn("[recorder] already recording — ignoring duplicate start");
        return;
      }
      chunksRef.current = [];

      const videoTracks = compositorStream.getVideoTracks();
      const audioTracks = audioStream?.getAudioTracks() ?? [];
      console.log("[recorder] video tracks:", videoTracks.length, videoTracks.map(t => `${t.label} (${t.readyState})`));
      console.log("[recorder] audio tracks:", audioTracks.length, audioTracks.map(t => `${t.label} (${t.readyState})`));

      const tracks = [...videoTracks, ...audioTracks];
      if (tracks.length === 0) {
        console.error("[recorder] no tracks — recording aborted");
        return;
      }
      const combined = new MediaStream(tracks);

      const mimeType =
        MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
          ? "video/webm;codecs=vp9"
          : MediaRecorder.isTypeSupported("video/webm;codecs=vp8")
          ? "video/webm;codecs=vp8"
          : "video/webm";
      console.log("[recorder] mimeType:", mimeType);

      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(combined, { mimeType, videoBitsPerSecond: 8_000_000 });
      } catch (e) {
        console.error("[recorder] MediaRecorder constructor failed:", e, "— retrying without bitrate");
        try {
          recorder = new MediaRecorder(combined, { mimeType });
        } catch (e2) {
          console.error("[recorder] MediaRecorder constructor failed again:", e2, "— falling back to video/webm");
          recorder = new MediaRecorder(combined, { mimeType: "video/webm" });
        }
      }
      recorder.ondataavailable = (e) => {
        console.log("[recorder] chunk:", e.data.size, "bytes, total chunks:", chunksRef.current.length + 1);
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onerror = (e) => console.error("[recorder] error:", e);
      recorder.start(100);
      recorderRef.current = recorder;
      console.log("[recorder] started, state:", recorder.state);
    },

    stop(): Promise<Blob> {
      return new Promise((resolve) => {
        const recorder = recorderRef.current;
        if (!recorder || recorder.state === "inactive") {
          const blob = new Blob(chunksRef.current, { type: "video/webm" });
          console.log("[recorder] stop (inactive) — blob size:", blob.size, "chunks:", chunksRef.current.length);
          resolve(blob);
          return;
        }
        recorder.onstop = () => {
          const blob = new Blob(chunksRef.current, { type: "video/webm" });
          console.log("[recorder] stop — blob size:", blob.size, "chunks:", chunksRef.current.length);
          resolve(blob);
        };
        recorder.stop();
      });
    },
  }));

  return null;
});

export default VideoRecorder;
