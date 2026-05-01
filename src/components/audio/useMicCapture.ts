"use client";
import { useRef, useCallback } from "react";
import { MIC_SAMPLE_RATE } from "@/lib/liveConstants";

export interface MicCaptureHandle {
  start(sourceStream?: MediaStream | null): Promise<void>;
  stop(): void;
  isCapturing(): boolean;
  getStream(): MediaStream | null;
  /** Current mic input RMS (0-1). Updated every ~100ms from AnalyserNode. */
  getInputAmplitude(): number;
}

/**
 * Captures microphone audio as 16kHz PCM chunks.
 *
 * Prefer AudioWorklet. Fall back to ScriptProcessor for mobile Safari / fake-device
 * environments where worklet setup can fail even after microphone permission succeeds.
 */
export function useMicCapture(onChunk: (pcm: Float32Array) => void): MicCaptureHandle {
  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const pullGainRef = useRef<GainNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const analyserBuf = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const inputAmplitudeRef = useRef(0);
  const peakAmplitudeRef = useRef(0);
  const peakTsRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const ownsStreamRef = useRef(false);
  const capturingRef = useRef(false);
  const onChunkRef = useRef(onChunk);
  onChunkRef.current = onChunk;

  const stop = useCallback(() => {
    capturingRef.current = false;
    inputAmplitudeRef.current = 0;
    peakAmplitudeRef.current = 0;

    workletRef.current?.disconnect();
    workletRef.current = null;

    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.onaudioprocess = null;
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current = null;
    }

    sourceRef.current?.disconnect();
    sourceRef.current = null;
    pullGainRef.current?.disconnect();
    pullGainRef.current = null;

    analyserRef.current?.disconnect();
    analyserRef.current = null;

    if (ctxRef.current?.state !== "closed") {
      ctxRef.current?.close();
    }
    ctxRef.current = null;

    if (ownsStreamRef.current) {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    }
    ownsStreamRef.current = false;
    streamRef.current = null;
  }, []);

  const start = useCallback(async (sourceStream?: MediaStream | null) => {
    if (capturingRef.current) return;

    const existingAudioTracks = sourceStream
      ?.getAudioTracks()
      .filter((track) => track.readyState === "live");
    const clonedAudioTracks = (existingAudioTracks ?? []).map((track) => {
      const clone = track.clone();
      clone.enabled = true;
      return clone;
    });
    const stream = existingAudioTracks?.length
      ? new MediaStream(clonedAudioTracks)
      : await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: { ideal: MIC_SAMPLE_RATE },
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
    streamRef.current = stream;
    ownsStreamRef.current = true;

    try {
      let ctx: AudioContext;
      try {
        ctx = new AudioContext({ sampleRate: MIC_SAMPLE_RATE, latencyHint: "interactive" });
      } catch {
        ctx = new AudioContext({ latencyHint: "interactive" });
      }
      ctxRef.current = ctx;

      if (ctx.state === "suspended") {
        await ctx.resume();
      }

      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;
      const pullGain = ctx.createGain();
      pullGain.gain.value = 0;
      pullGain.connect(ctx.destination);
      pullGainRef.current = pullGain;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.3;
      source.connect(analyser);
      analyserRef.current = analyser;
      analyserBuf.current = new Uint8Array(new ArrayBuffer(analyser.fftSize));

      const updateAmplitude = () => {
        if (!analyserRef.current || !analyserBuf.current) return;
        analyserRef.current.getByteTimeDomainData(analyserBuf.current);
        let sum = 0;
        for (let i = 0; i < analyserBuf.current.length; i++) {
          const v = (analyserBuf.current[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / analyserBuf.current.length);
        inputAmplitudeRef.current = rms;

        const now = performance.now();
        if (rms >= peakAmplitudeRef.current) {
          peakAmplitudeRef.current = rms;
          peakTsRef.current = now;
        } else if (now - peakTsRef.current > 800) {
          peakAmplitudeRef.current = rms;
        }
      };

      const handlePcmChunk = (pcm: Float32Array) => {
        onChunkRef.current(pcm);
        updateAmplitude();
      };

      const startScriptProcessor = () => {
        const ratio = ctx.sampleRate / MIC_SAMPLE_RATE;
        const nativeChunkSize = Math.round(MIC_SAMPLE_RATE * 0.1 * ratio);
        const targetChunkSize = Math.round(MIC_SAMPLE_RATE * 0.1);
        let pending: number[] = [];
        const processor = ctx.createScriptProcessor(4096, 1, 1);
        scriptProcessorRef.current = processor;
        processor.onaudioprocess = (event) => {
          const input = event.inputBuffer.getChannelData(0);
          event.outputBuffer.getChannelData(0).fill(0);
          for (let i = 0; i < input.length; i++) pending.push(input[i]);
          while (pending.length >= nativeChunkSize) {
            const native = pending.splice(0, nativeChunkSize);
            const chunk = new Float32Array(targetChunkSize);
            for (let i = 0; i < targetChunkSize; i++) {
              const srcIdx = i * ratio;
              const lo = Math.floor(srcIdx);
              const hi = Math.min(lo + 1, native.length - 1);
              const frac = srcIdx - lo;
              chunk[i] = native[lo] * (1 - frac) + native[hi] * frac;
            }
            handlePcmChunk(chunk);
          }
        };
        source.connect(processor);
        processor.connect(ctx.destination);
      };

      try {
        if (!ctx.audioWorklet) throw new Error("AudioWorklet unavailable");
        await ctx.audioWorklet.addModule("/worklets/mic-capture-processor.js");
        const worklet = new AudioWorkletNode(ctx, "mic-capture-processor");
        workletRef.current = worklet;
        worklet.port.onmessage = (e: MessageEvent<{ pcm: Float32Array }>) => {
          handlePcmChunk(e.data.pcm);
        };
        source.connect(worklet);
        worklet.connect(pullGain);
      } catch {
        startScriptProcessor();
      }

      capturingRef.current = true;
    } catch (e) {
      stop();
      throw e;
    }
  }, [stop]);

  return {
    start,
    stop,
    isCapturing: () => capturingRef.current,
    getStream: () => streamRef.current,
    getInputAmplitude: () => peakAmplitudeRef.current,
  };
}
