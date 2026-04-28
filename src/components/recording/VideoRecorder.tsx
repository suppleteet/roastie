"use client";
import { useRef, useImperativeHandle, forwardRef } from "react";
import { COMPOSITOR_SIZE } from "@/lib/constants";
import {
  chooseRecorderFormat,
  recommendedVideoBitsPerSecond,
} from "@/lib/mediaRecorderSupport";

export interface VideoRecorderHandle {
  start(compositorStream: MediaStream, audioStream: MediaStream | null): void;
  stop(): Promise<Blob>;
}

const VideoRecorder = forwardRef<VideoRecorderHandle>(function VideoRecorder(_props, ref) {
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeTypeRef = useRef("video/webm");

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
      const format = chooseRecorderFormat();
      const videoBitsPerSecond = recommendedVideoBitsPerSecond(COMPOSITOR_SIZE, COMPOSITOR_SIZE);

      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(combined, {
          mimeType: format.mimeType,
          videoBitsPerSecond,
          audioBitsPerSecond: 128_000,
        });
      } catch {
        try {
          recorder = new MediaRecorder(combined, { mimeType: format.mimeType });
        } catch {
          recorder = new MediaRecorder(combined, { mimeType: "video/webm" });
        }
      }
      mimeTypeRef.current = recorder.mimeType || format.mimeType || "video/webm";
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onerror = (e) => console.error("[recorder] error:", e);
      recorder.start(1000);
      recorderRef.current = recorder;
    },

    stop(): Promise<Blob> {
      return new Promise((resolve) => {
        const recorder = recorderRef.current;
        if (!recorder || recorder.state === "inactive") {
          resolve(new Blob(chunksRef.current, { type: mimeTypeRef.current }));
          return;
        }
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          recorderRef.current = null;
          resolve(new Blob(chunksRef.current, { type: mimeTypeRef.current }));
        };
        recorder.onstop = () => {
          finish();
        };
        recorder.onerror = (e) => {
          console.error("[recorder] stop error:", e);
          finish();
        };
        try {
          recorder.requestData();
        } catch {
          // Some browsers throw if requestData races with stop; onstop still resolves.
        }
        try {
          recorder.stop();
        } catch {
          finish();
        }
        window.setTimeout(finish, 3000);
      });
    },
  }));

  return null;
});

export default VideoRecorder;
