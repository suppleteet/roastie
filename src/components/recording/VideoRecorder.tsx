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
      // Guard against double-start (React StrictMode fires effects twice in dev)
      if (recorderRef.current?.state === "recording") return;
      chunksRef.current = [];

      const videoTracks = compositorStream.getVideoTracks();
      const audioTracks = audioStream?.getAudioTracks() ?? [];

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

      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(combined, { mimeType, videoBitsPerSecond: 8_000_000 });
      } catch {
        try {
          recorder = new MediaRecorder(combined, { mimeType });
        } catch {
          recorder = new MediaRecorder(combined, { mimeType: "video/webm" });
        }
      }
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onerror = (e) => console.error("[recorder] error:", e);
      recorder.start(100);
      recorderRef.current = recorder;
    },

    stop(): Promise<Blob> {
      return new Promise((resolve) => {
        const recorder = recorderRef.current;
        if (!recorder || recorder.state === "inactive") {
          resolve(new Blob(chunksRef.current, { type: "video/webm" }));
          return;
        }
        recorder.onstop = () => {
          resolve(new Blob(chunksRef.current, { type: "video/webm" }));
        };
        recorder.stop();
      });
    },
  }));

  return null;
});

export default VideoRecorder;
