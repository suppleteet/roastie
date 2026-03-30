"use client";
import { useRef, useCallback } from "react";

/**
 * Lightweight wrapper around @ricky0123/vad-web (Silero VAD).
 *
 * Provides fast (~100-200ms) end-of-speech detection running entirely in the
 * browser. Does NOT do speech-to-text — Gemini Live handles that. This hook's
 * only job is to fire `onSpeechEnd` as fast as possible so the brain can stop
 * waiting on the answerSilenceMs fallback timer.
 */

// Lazy-import the heavy ONNX-backed module so it doesn't block initial bundle.
type MicVADType = import("@ricky0123/vad-web").MicVAD;

export interface VadHandle {
  /** Start VAD on the given mic stream. Call after mic.start(). */
  start(stream: MediaStream): Promise<void>;
  /** Stop and destroy the VAD instance. */
  stop(): void;
  /** Whether the VAD is currently active. */
  isActive(): boolean;
}

interface VadOptions {
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
}

export function useVad({ onSpeechStart, onSpeechEnd }: VadOptions): VadHandle {
  const vadRef = useRef<MicVADType | null>(null);
  const activeRef = useRef(false);

  // Keep callbacks fresh without re-creating the VAD instance
  const onSpeechStartRef = useRef(onSpeechStart);
  onSpeechStartRef.current = onSpeechStart;
  const onSpeechEndRef = useRef(onSpeechEnd);
  onSpeechEndRef.current = onSpeechEnd;

  const start = useCallback(async (stream: MediaStream) => {
    if (activeRef.current) return;
    activeRef.current = true; // optimistic lock — prevents concurrent start() races

    let vad: MicVADType;
    try {
      const { MicVAD } = await import("@ricky0123/vad-web");

      vad = await MicVAD.new({
      // Use the caller's mic stream — don't request permission again
      getStream: async () => stream,
      // No-op stream control — we manage the mic stream externally
      pauseStream: async () => {},
      resumeStream: async (s) => s,

      // Silero V5 is the latest/fastest model
      model: "v5",
      // Serve ONNX model + WASM runtime from public/ to avoid webpack chunking issues
      baseAssetPath: "/",
      onnxWASMBasePath: "/",

      // Sensitivity tuning — biased toward fast detection
      positiveSpeechThreshold: 0.5,
      negativeSpeechThreshold: 0.35,
      redemptionMs: 200,    // grace period before confirming silence (default 300)
      minSpeechMs: 150,     // ignore very short bursts (coughs, clicks)
      preSpeechPadMs: 0,    // we don't need captured audio, just the signal

      startOnLoad: false,

      onSpeechStart: () => {
        onSpeechStartRef.current?.();
      },
      onSpeechEnd: () => {
        onSpeechEndRef.current?.();
      },
    });

    } catch (e) {
      activeRef.current = false;
      throw e;
    }

    vadRef.current = vad;
    await vad.start();
  }, []);

  const stop = useCallback(() => {
    if (!vadRef.current) return;
    activeRef.current = false;
    vadRef.current.destroy().catch((e) => console.warn("[vad] destroy error:", e));
    vadRef.current = null;
  }, []);

  return {
    start,
    stop,
    isActive: () => activeRef.current,
  };
}
