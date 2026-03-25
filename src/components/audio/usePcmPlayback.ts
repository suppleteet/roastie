"use client";
import { useRef, useEffect, useCallback } from "react";
import { useSessionStore } from "@/store/useSessionStore";
import { OUTPUT_SAMPLE_RATE } from "@/lib/liveConstants";
import { base64Pcm16ToFloat32 } from "@/lib/audioUtils";

const AMPLITUDE_THRESHOLD = 0.01;

export interface PcmPlaybackHandle {
  enqueueChunk(base64Pcm: string): void;
  /** Decode a raw MP3/AAC ArrayBuffer and schedule it for playback. */
  decodeAndEnqueue(arrayBuffer: ArrayBuffer): Promise<void>;
  flush(): void;
  getDestinationStream(): MediaStream | null;
  getAudioContext(): AudioContext | null;
  /** Returns true when all queued audio has finished playing. */
  isQueueEmpty(): boolean;
  /** Returns milliseconds of audio remaining in the queue (0 when empty). */
  getPlaybackRemainingMs(): number;
  /** Route an external stream (e.g. mic) to the recording destination only
   *  (NOT speakers — avoids feedback). Returns a disconnect function. */
  addInputToRecording(stream: MediaStream): () => void;
}

/**
 * Hook that plays incoming base64-encoded PCM audio chunks from Gemini Live API.
 *
 * Schedules AudioBufferSourceNodes in sequence for gapless playback.
 * Polls amplitude via AnalyserNode for mouth sync (same pattern as AudioPlayer).
 */
export function usePcmPlayback(): PcmPlaybackHandle {
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const destRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const queueEndRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const rafRef = useRef<number>(0);
  const lastAmplitudeRef = useRef<number>(0);

  function getOrCreateContext(): AudioContext {
    let ctx = ctxRef.current;
    if (!ctx || ctx.state === "closed") {
      ctx = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
      ctxRef.current = ctx;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyserRef.current = analyser;

      const dest = ctx.createMediaStreamDestination();
      destRef.current = dest;

      analyser.connect(ctx.destination);
      analyser.connect(dest);
    }
    return ctx;
  }

  // Amplitude polling — drives puppet mouth sync via store
  const pollAmplitude = useCallback(() => {
    const analyser = analyserRef.current;
    if (analyser) {
      const data = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(data);
      let sumSq = 0;
      for (let i = 0; i < data.length; i++) sumSq += data[i] * data[i];
      const rms = Math.min(Math.sqrt(sumSq / data.length) * 6, 1);
      if (Math.abs(rms - lastAmplitudeRef.current) >= AMPLITUDE_THRESHOLD) {
        lastAmplitudeRef.current = rms;
        useSessionStore.getState().setAudioAmplitude(rms);
      }
    }
    rafRef.current = requestAnimationFrame(pollAmplitude);
  }, []);

  useEffect(() => {
    rafRef.current = requestAnimationFrame(pollAmplitude);
    return () => cancelAnimationFrame(rafRef.current);
  }, [pollAmplitude]);

  /** Schedule an already-decoded AudioBuffer for gapless playback. */
  const scheduleBuffer = useCallback((buffer: AudioBuffer) => {
    const ctx = getOrCreateContext();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(analyserRef.current!);
    const startTime = Math.max(ctx.currentTime, queueEndRef.current);
    src.start(startTime);
    queueEndRef.current = startTime + buffer.duration;
    sourcesRef.current.add(src);
    src.onended = () => sourcesRef.current.delete(src);
  }, []);

  const enqueueChunk = useCallback((base64Pcm: string) => {
    const ctx = getOrCreateContext();
    if (ctx.state === "suspended") ctx.resume();

    const float32 = base64Pcm16ToFloat32(base64Pcm);
    if (float32.length === 0) return;

    const buffer = ctx.createBuffer(1, float32.length, OUTPUT_SAMPLE_RATE);
    buffer.getChannelData(0).set(float32);
    scheduleBuffer(buffer);
  }, [scheduleBuffer]);

  const decodeAndEnqueue = useCallback(async (arrayBuffer: ArrayBuffer): Promise<void> => {
    const ctx = getOrCreateContext();
    if (ctx.state === "suspended") await ctx.resume();
    const buffer = await ctx.decodeAudioData(arrayBuffer);
    scheduleBuffer(buffer);
  }, [scheduleBuffer]);

  /** Flush all queued/playing audio — called on barge-in interrupt. */
  const flush = useCallback(() => {
    for (const src of sourcesRef.current) {
      try {
        src.stop();
        src.disconnect();
      } catch {
        // Already stopped
      }
    }
    sourcesRef.current.clear();
    queueEndRef.current = 0;
    lastAmplitudeRef.current = 0;
    useSessionStore.getState().setAudioAmplitude(0);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      flush();
      if (ctxRef.current?.state !== "closed") {
        ctxRef.current?.close();
      }
    };
  }, [flush]);

  const isQueueEmpty = useCallback((): boolean => {
    const ctx = ctxRef.current;
    if (!ctx || ctx.state === "closed") return true;
    return sourcesRef.current.size === 0 && queueEndRef.current <= ctx.currentTime;
  }, []);

  const getPlaybackRemainingMs = useCallback((): number => {
    const ctx = ctxRef.current;
    if (!ctx || ctx.state === "closed") return 0;
    return Math.max(0, (queueEndRef.current - ctx.currentTime) * 1000);
  }, []);

  return {
    enqueueChunk,
    decodeAndEnqueue,
    flush,
    // Eagerly initialize the AudioContext so the destination stream exists
    // before recording starts — otherwise the MediaRecorder captures video-only.
    getDestinationStream: () => {
      getOrCreateContext();
      return destRef.current?.stream ?? null;
    },
    getAudioContext: () => ctxRef.current,
    isQueueEmpty,
    getPlaybackRemainingMs,
    addInputToRecording: (stream: MediaStream): (() => void) => {
      const ctx = getOrCreateContext();
      const source = ctx.createMediaStreamSource(stream);
      // Route to recording destination ONLY — not speakers — to avoid feedback
      source.connect(destRef.current!);
      return () => { source.disconnect(); };
    },
  };
}
