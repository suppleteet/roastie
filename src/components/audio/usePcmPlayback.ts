"use client";
import { useRef, useEffect, useCallback } from "react";
import { useSessionStore } from "@/store/useSessionStore";
import { OUTPUT_SAMPLE_RATE } from "@/lib/liveConstants";
import { base64Pcm16ToFloat32 } from "@/lib/audioUtils";

const AMPLITUDE_THRESHOLD = 0.01;

/** Linear-interpolate Float32 PCM from one sample rate to another. */
function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIdx = i * ratio;
    const lo = Math.floor(srcIdx);
    const hi = Math.min(lo + 1, input.length - 1);
    const frac = srcIdx - lo;
    out[i] = input[lo] * (1 - frac) + input[hi] * frac;
  }
  return out;
}

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
  /** Call synchronously from a user gesture (tap/click) to create and warm the
   *  AudioContext. On iOS Safari this is required for hardware volume buttons
   *  to control Web Audio output. */
  warmUp(): void;
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

  // Hidden <audio> element routes output through the media channel on Android.
  // Without this, Chrome Android sends Web Audio through the earpiece when
  // getUserMedia is active, ignoring the media volume slider.
  const audioElRef = useRef<HTMLAudioElement | null>(null);

  function getOrCreateContext(): AudioContext {
    let ctx = ctxRef.current;
    if (!ctx || ctx.state === "closed") {
      // Use device native sample rate (don't request 24kHz). iOS Safari sometimes
      // honors the request, sometimes coerces silently to 48kHz, and on the latter
      // path its built-in AudioBufferSourceNode resampler glitches the first ~500ms
      // of audio (chipmunk effect). Resampling ourselves in enqueueChunk gives a
      // single deterministic code path on every device.
      ctx = new AudioContext();
      ctxRef.current = ctx;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.3;
      analyserRef.current = analyser;

      const dest = ctx.createMediaStreamDestination();
      destRef.current = dest;

      // Route through a MediaStream → <audio> element so Android Chrome uses
      // the media volume channel instead of the earpiece/communication channel.
      // Without this, Chrome Android sends Web Audio through the call/earpiece
      // channel when getUserMedia is active, and the media volume slider has no effect.
      const speakerDest = ctx.createMediaStreamDestination();
      analyser.connect(speakerDest);
      analyser.connect(dest);

      // Append to DOM and configure for inline media playback. Without DOM
      // attachment + playsInline + autoplay, Android Chrome takes one extra
      // session start to lock onto the media channel — first roast plays
      // through the earpiece (volume slider does nothing) and the audio also
      // sounds chipmunked while routing settles. Subsequent roasts work
      // because the element from the first attempt is still alive.
      const audioEl = document.createElement("audio");
      audioEl.autoplay = true;
      audioEl.setAttribute("playsinline", "");
      audioEl.muted = false;
      audioEl.controls = false;
      audioEl.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px;";
      audioEl.setAttribute("aria-hidden", "true");
      document.body.appendChild(audioEl);
      audioEl.srcObject = speakerDest.stream;
      audioEl.play().catch((e) => console.warn("[playback] audioEl.play failed:", e));
      audioElRef.current = audioEl;
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

    const raw = base64Pcm16ToFloat32(base64Pcm);
    if (raw.length === 0) return;

    // Manual resample to ctx.sampleRate. iOS Safari sometimes silently coerces a
    // 24kHz AudioContext to the device default (48kHz) AND has a startup glitch
    // where AudioBufferSourceNode plays the first ~500ms at the wrong rate
    // (chipmunk effect). Resampling here means the buffer always matches the
    // context rate exactly — no implicit resampler involved.
    const samples =
      ctx.sampleRate === OUTPUT_SAMPLE_RATE
        ? raw
        : resampleLinear(raw, OUTPUT_SAMPLE_RATE, ctx.sampleRate);

    const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    buffer.getChannelData(0).set(samples);
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
      if (audioElRef.current) {
        audioElRef.current.pause();
        audioElRef.current.srcObject = null;
        audioElRef.current.remove();
        audioElRef.current = null;
      }
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

  const warmUp = useCallback(() => {
    const ctx = getOrCreateContext();
    if (ctx.state === "suspended") ctx.resume();
    // 250ms of silence at OUTPUT_SAMPLE_RATE: marks the context as user-initiated
    // media (so iOS hardware volume buttons control it) AND warms the resampler
    // before real audio arrives. Without the latter, iOS Safari plays the first
    // ~500ms of real chunks at the context's native rate (chipmunk effect) before
    // the 24kHz→48kHz resampler stabilizes.
    const samples = Math.round(OUTPUT_SAMPLE_RATE * 0.25);
    const buf = ctx.createBuffer(1, samples, OUTPUT_SAMPLE_RATE);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(analyserRef.current ?? ctx.destination);
    src.start();
    // Also ensure the <audio> element is playing (Android requires user gesture)
    audioElRef.current?.play().catch(() => {});
  }, []);

  return {
    enqueueChunk,
    decodeAndEnqueue,
    flush,
    warmUp,
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
