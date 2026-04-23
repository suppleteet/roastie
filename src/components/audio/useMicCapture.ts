"use client";
import { useRef, useCallback } from "react";
import { MIC_SAMPLE_RATE } from "@/lib/liveConstants";

export interface MicCaptureHandle {
  start(): Promise<void>;
  stop(): void;
  isCapturing(): boolean;
  getStream(): MediaStream | null;
  /** Current mic input RMS (0-1). Updated every ~100ms from AnalyserNode. */
  getInputAmplitude(): number;
}

/**
 * Hook that captures microphone audio as PCM Float32 chunks via AudioWorklet.
 *
 * @param onChunk — called on the main thread with each 100ms PCM chunk (Float32Array).
 */
export function useMicCapture(onChunk: (pcm: Float32Array) => void): MicCaptureHandle {
  const ctxRef = useRef<AudioContext | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const analyserBuf = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const inputAmplitudeRef = useRef(0);
  const peakAmplitudeRef = useRef(0);
  const peakTsRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const capturingRef = useRef(false);
  const onChunkRef = useRef(onChunk);
  onChunkRef.current = onChunk;

  const start = useCallback(async () => {
    if (capturingRef.current) return;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: { ideal: MIC_SAMPLE_RATE },
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    streamRef.current = stream;

    // Hint 16kHz; browsers that ignore this (iOS Safari) will be resampled by the worklet.
    const ctx = new AudioContext({ sampleRate: MIC_SAMPLE_RATE, latencyHint: "interactive" });
    ctxRef.current = ctx;

    // iOS Safari starts AudioContext in "suspended" state — must explicitly resume.
    if (ctx.state === "suspended") {
      await ctx.resume();
    }

    await ctx.audioWorklet.addModule("/worklets/mic-capture-processor.js");

    const source = ctx.createMediaStreamSource(stream);

    // AnalyserNode for mic input amplitude — used by brain for background noise gating
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.3;
    source.connect(analyser);
    analyserRef.current = analyser;
    // Typed array for getByteTimeDomainData — cast needed for strict TS ArrayBuffer vs ArrayBufferLike
    analyserBuf.current = new Uint8Array(new ArrayBuffer(analyser.fftSize));

    // Worklet is self-configuring: reads sampleRate from AudioWorkletGlobalScope
    // and downsamples to 16kHz internally.
    const worklet = new AudioWorkletNode(ctx, "mic-capture-processor");
    workletRef.current = worklet;

    worklet.port.onmessage = (e: MessageEvent<{ pcm: Float32Array }>) => {
      onChunkRef.current(e.data.pcm);
      // Update amplitude from analyser on each chunk (~100ms)
      // Uses getByteTimeDomainData (0-255, 128=silence) to avoid Float32Array type issues
      if (analyserRef.current && analyserBuf.current) {
        analyserRef.current.getByteTimeDomainData(analyserBuf.current);
        let sum = 0;
        for (let i = 0; i < analyserBuf.current.length; i++) {
          const v = (analyserBuf.current[i] - 128) / 128; // normalize to -1..1
          sum += v * v;
        }
        const rms = Math.sqrt(sum / analyserBuf.current.length);
        inputAmplitudeRef.current = rms;
        // Track peak amplitude with 800ms decay — transcriptions arrive delayed,
        // so the peak from when the user was actually speaking must still be available.
        const now = performance.now();
        if (rms >= peakAmplitudeRef.current) {
          peakAmplitudeRef.current = rms;
          peakTsRef.current = now;
        } else if (now - peakTsRef.current > 800) {
          peakAmplitudeRef.current = rms; // decay to current level
        }
      }
    };

    source.connect(worklet);
    // Worklet doesn't produce output — no need to connect to destination
    capturingRef.current = true;
  }, []);

  const stop = useCallback(() => {
    capturingRef.current = false;
    inputAmplitudeRef.current = 0;
    peakAmplitudeRef.current = 0;
    workletRef.current?.disconnect();
    workletRef.current = null;
    analyserRef.current?.disconnect();
    analyserRef.current = null;

    if (ctxRef.current?.state !== "closed") {
      ctxRef.current?.close();
    }
    ctxRef.current = null;

    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  return {
    start,
    stop,
    isCapturing: () => capturingRef.current,
    getStream: () => streamRef.current,
    getInputAmplitude: () => peakAmplitudeRef.current,
  };
}
