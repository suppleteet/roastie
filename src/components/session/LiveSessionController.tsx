"use client";
import { useEffect, useRef, useCallback } from "react";
import { GoogleGenAI, Modality } from "@google/genai";
import type { Session, LiveServerMessage } from "@google/genai";
import { useSessionStore } from "@/store/useSessionStore";
import type { WebcamCaptureHandle } from "./WebcamCapture";
import type { VideoRecorderHandle } from "@/components/recording/VideoRecorder";
import { useMicCapture } from "@/components/audio/useMicCapture";
import { useVad } from "@/components/audio/useVad";
import { usePcmPlayback } from "@/components/audio/usePcmPlayback";
import { float32ToBase64Pcm16 } from "@/lib/audioUtils";
import { inferMotionFromTranscript } from "@/lib/motionInference";
import {
  LIVE_MODEL,
  LIVE_VOICE_NAME,
  WEBCAM_SEND_INTERVAL_MS,
  SESSION_ROTATE_MS,
  MIC_MIME_TYPE,
  MOCK_LINES,
} from "@/lib/liveConstants";
import { getLiveTranscriptionPrompt } from "@/lib/livePrompts";
import { ComedianBrain } from "@/lib/comedianBrain";
import type { MotionState } from "@/lib/motionStates";
import { COMEDIAN_CONFIG } from "@/lib/comedianConfig";
import { kickTownFlavorFetch } from "@/lib/kickTownFlavorFetch";
import type { JokeResponse } from "@/app/api/generate-joke/route";
import { prefetchParallelVisionAndGreeting } from "@/lib/greetingPrefetch";


interface Props {
  webcamRef: React.RefObject<WebcamCaptureHandle | null>;
  videoRecorderRef: React.RefObject<VideoRecorderHandle | null>;
  compositorStream: MediaStream | null;
  prefetchedTokenPromise?: Promise<string> | null;
  /** Parallel vision + greeting jokes started in page.tsx as soon as the camera stream exists (before roasting). */
  warmupGreetingPrefetch?: Promise<JokeResponse | null> | null;
  mockMode?: boolean;
}

export default function LiveSessionController({
  webcamRef,
  videoRecorderRef,
  compositorStream,
  prefetchedTokenPromise,
  warmupGreetingPrefetch,
  mockMode = false,
}: Props) {
  // Only subscribe to phase + pendingDebugTranscription for lifecycle/debug.
  // All other store access uses getState() to avoid stale closures.
  const phase = useSessionStore((s) => s.phase);
  const pendingDebugTranscription = useSessionStore((s) => s.pendingDebugTranscription);
  const pendingDevNoteResume = useSessionStore((s) => s.pendingDevNoteResume);

  const sessionRef = useRef<Session | null>(null);
  const isRunningRef = useRef(false);
  const webcamIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const visionIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const rotateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userSpeakingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const laughDecayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const smileDecayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const kickoffTimeRef = useRef<number | null>(null);
  const firstSpeechRecordedRef = useRef(false);

  // Gemini multi-turn chat session ID (comedian persona loaded once)
  const comedianSessionIdRef = useRef<string | null>(null);

  // TTS pipeline — brain-driven, sequential ElevenLabs requests
  const ttsChainRef = useRef<Promise<void>>(Promise.resolve());
  const ttsGenerationRef = useRef(0);

  // rAF for TTS drain detection
  const drainRafRef = useRef<number>(0);
  const wasDrainedRef = useRef(true); // track edge: false → true
  const earlyListenFiredRef = useRef(false); // true once early-listen has fired for current question

  // Mic → recording mix (disconnect function returned by addInputToRecording)
  const micRecordingDisconnectRef = useRef<(() => void) | null>(null);

  // Timeline span IDs
  const userSpeakingSpanRef = useRef<string | null>(null);
  const geminiWaitingSpanRef = useRef<string | null>(null);

  // Vocal continuity: last text spoken by puppet — passed as previous_text to ElevenLabs so
  // each TTS request inherits the intonation/prosody of what came before.
  const lastSpokenTextRef = useRef<string>("");

  // Audio pipeline hooks
  const playback = usePcmPlayback();
  const mic = useMicCapture(
    useCallback((pcm: Float32Array) => {
      const session = sessionRef.current;
      if (!session || !isRunningRef.current) return;
      // Gate mic: send audio when brain is listening OR in passive warm-up (keeps Gemini VAD hot)
      const brain = brainRef.current;
      if (brain && !brain.isAudioActive()) return;
      const base64 = float32ToBase64Pcm16(pcm);
      try {
        session.sendRealtimeInput({
          audio: { data: base64, mimeType: MIC_MIME_TYPE },
        });
      } catch {
        // Session WebSocket may be in CLOSING state during rotation — safe to discard chunk
      }
    }, []),
  );

  // Silero VAD — fast end-of-speech detection (~200ms vs 300ms silence timer fallback)
  const vad = useVad({
    onSpeechEnd: () => {
      if (isRunningRef.current) {
        useSessionStore.getState().setIsUserSpeaking(false);
      }
      brainRef.current?.onVadSpeechEnd();
    },
    onSpeechStart: () => {
      if (isRunningRef.current) {
        useSessionStore.getState().setIsUserSpeaking(true);
      }
    },
  });

  // ComedianBrain — instantiated when session starts
  const brainRef = useRef<ComedianBrain | null>(null);

  // Debug: consume typed transcription and forward to brain (same as mic input)
  useEffect(() => {
    if (!pendingDebugTranscription || !brainRef.current) return;
    const text = pendingDebugTranscription;
    useSessionStore.getState().clearPendingDebugTranscription();
    useSessionStore.getState().pushTranscriptEntry("user", text);
    useSessionStore.getState().logTiming(`debug-input: "${text}"`);
    brainRef.current.onInputTranscription(text);
  }, [pendingDebugTranscription]);

  // Dev voice notes: consume resume signal and forward to brain
  useEffect(() => {
    if (!pendingDevNoteResume || !brainRef.current) return;
    useSessionStore.getState().clearPendingDevNoteResume();
    brainRef.current.resumeFromDevNote();
  }, [pendingDevNoteResume]);

  // ─── Brain helpers ────────────────────────────────────────────────────────────

  function queueSpeak(text: string, motion?: MotionState, intensity?: number, appendToPrev?: boolean): void {
    if (!text.trim() || !isRunningRef.current) return;
    // Reveal puppet on first queued speech — TTS latency ≈ fade duration
    if (!useSessionStore.getState().puppetRevealed) {
      useSessionStore.getState().setPuppetRevealed(true);
    }
    useSessionStore.getState().pushTranscriptEntry("puppet", text.trim(), { append: appendToPrev });
    wasDrainedRef.current = false; // reset edge so drain detection fires when this plays through
    const gen = ttsGenerationRef.current;

    // Snapshot previousText NOW (at queue time) for vocal continuity,
    // then update lastSpokenTextRef immediately so the NEXT queueSpeak gets the right context.
    const previousText = lastSpokenTextRef.current;
    lastSpokenTextRef.current = text.trim();

    // Fire TTS fetch NOW — starts generating audio while previous joke is still playing.
    // Chunks are buffered; playback waits for our turn in the chain.
    const audioPromise = prefetchTts(text.trim(), gen, previousText);

    ttsChainRef.current = ttsChainRef.current.then(async () => {
      if (ttsGenerationRef.current !== gen || !isRunningRef.current) return;
      if (motion) useSessionStore.getState().setActiveMotionState(motion, intensity ?? 0.7);
      const prevTail = previousText.length > 60 ? `…${previousText.slice(-60)}` : previousText;
      useSessionStore.getState().logTiming(
        `tts: "${text.trim().slice(0, 60)}" prev="${prevTail}"`,
      );
      await scheduleFromPrefetch(audioPromise, gen);
    });
  }

  function cancelSpeech(): void {
    ttsGenerationRef.current++;
    ttsChainRef.current = Promise.resolve();
    playback.flush();
    useSessionStore.getState().setIsSpeaking(false);
  }

  // ─── TTS pipeline ─────────────────────────────────────────────────────────────

  /**
   * Start TTS stream immediately — buffer audio chunks.
   * Fires outside the chain so multiple prefetches overlap (no dead air between jokes).
   */
  async function prefetchTts(text: string, gen: number, previousText?: string): Promise<string[] | null> {
    if (!isRunningRef.current) return null;
    const ttsSpanId = useSessionStore.getState().beginSpan("tts", text.slice(0, 22));

    try {
      const resp = await fetch("/api/tts-ws", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          ...(previousText ? { previousText } : {}),
          voiceSettings: useSessionStore.getState().voiceSettings,
        }),
      });

      if (!resp.ok || !resp.body || ttsGenerationRef.current !== gen) {
        useSessionStore.getState().endSpan(ttsSpanId);
        return null;
      }

      const chunks: string[] = [];
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (ttsGenerationRef.current !== gen || !isRunningRef.current) {
          reader.cancel();
          useSessionStore.getState().endSpan(ttsSpanId);
          return null;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6)) as { type: string; chunk?: string };
            if (event.type === "audio" && event.chunk) {
              chunks.push(event.chunk);
            }
          } catch { /* malformed SSE line */ }
        }
      }

      useSessionStore.getState().endSpan(ttsSpanId);
      return chunks;
    } catch (e) {
      useSessionStore.getState().endSpan(ttsSpanId);
      if ((e as Error).name !== "AbortError") {
        console.error("[live] TTS prefetch error:", e);
      }
      return null;
    }
  }

  /**
   * Wait for prefetch to complete, then enqueue all buffered chunks for playback.
   * Runs inside the ttsChain so playback order is preserved.
   */
  async function scheduleFromPrefetch(
    audioPromise: Promise<string[] | null>,
    gen: number,
  ): Promise<void> {
    const chunks = await audioPromise;
    if (!chunks || !isRunningRef.current || ttsGenerationRef.current !== gen) return;

    for (const chunk of chunks) {
      playback.enqueueChunk(chunk);
    }

    if (ttsGenerationRef.current !== gen) {
      playback.flush();
      return;
    }

    recordTtfs();
    useSessionStore.getState().setIsSpeaking(true);
  }

  /** Record time-to-first-speech metric (recording already started at kickoff). */
  function recordTtfs(): void {
    if (!firstSpeechRecordedRef.current && kickoffTimeRef.current !== null) {
      firstSpeechRecordedRef.current = true;
      const ttfs = Date.now() - kickoffTimeRef.current;
      useSessionStore.getState().setTimeToFirstSpeechMs(ttfs);
      useSessionStore.getState().logTiming(`brain: TTFS ${ttfs}ms`);
      useSessionStore.getState().setHasSpokenThisSession(true);
    }
  }

  // ─── TTS drain detection via rAF ─────────────────────────────────────────────

  function startDrainPolling(): void {
    stopDrainPolling();
    // Initialize "drained" so the first poll doesn't fire onTtsQueueDrained
    // before any audio has been queued. The first real drain edge fires after
    // queueSpeak resets this to false and audio actually plays through.
    wasDrainedRef.current = true;
    earlyListenFiredRef.current = false;

    function poll() {
      if (!isRunningRef.current) return;

      // Wait for ttsChain to settle before checking audio queue
      ttsChainRef.current.then(() => {
        if (!isRunningRef.current) return;
        const isEmpty = playback.isQueueEmpty();
        const store = useSessionStore.getState();

        if (isEmpty && !wasDrainedRef.current) {
          // Transition: playing → drained
          wasDrainedRef.current = true;
          earlyListenFiredRef.current = false;
          store.setIsSpeaking(false);
          store.setActiveMotionState("idle", 0.3);
          brainRef.current?.onTtsQueueDrained();
        } else if (!isEmpty) {
          wasDrainedRef.current = false;

          // Activate mic early when question is nearly done
          if (
            !earlyListenFiredRef.current &&
            store.brainState === "ask_question" &&
            playback.getPlaybackRemainingMs() <= COMEDIAN_CONFIG.earlyListenMs
          ) {
            earlyListenFiredRef.current = true;
            brainRef.current?.activateEarlyListen();
            store.setIsListening(true);
          }
        }

        drainRafRef.current = requestAnimationFrame(poll);
      });
    }

    drainRafRef.current = requestAnimationFrame(poll);
  }

  function stopDrainPolling(): void {
    if (drainRafRef.current) {
      cancelAnimationFrame(drainRafRef.current);
      drainRafRef.current = 0;
    }
  }

  // ─── Token + Session ──────────────────────────────────────────────────────────

  async function fetchToken(): Promise<string> {
    const { burnIntensity: bi, activePersona: ap } = useSessionStore.getState();
    const resp = await fetch("/api/live-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ burnIntensity: bi, persona: ap }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(`Token fetch failed: ${(err as { detail?: string }).detail ?? resp.status}`);
    }
    const { token } = await resp.json();
    return token;
  }

  async function openSession(tokenPromise?: Promise<string> | null): Promise<Session> {
    const token = tokenPromise ? await tokenPromise.catch(() => fetchToken()) : await fetchToken();
    const ai = new GoogleGenAI({
      apiKey: token,
      httpOptions: { apiVersion: "v1alpha" },
    });

    const session = await ai.live.connect({
      model: LIVE_MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: LIVE_VOICE_NAME } },
        },
        systemInstruction: getLiveTranscriptionPrompt(),
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
      callbacks: {
        onopen: () => {
          useSessionStore.getState().logTiming("live: session opened");
          useSessionStore.getState().setIsListening(true);
        },
        onmessage: handleMessage,
        onerror: (e) => {
          const msg = e instanceof ErrorEvent ? e.message : String(e);
          console.error("[live] WebSocket error:", msg);
          useSessionStore.getState().logTiming(`live: error — ${msg}`);
        },
        onclose: () => {
          useSessionStore.getState().logTiming("live: session closed");
          useSessionStore.getState().setIsListening(false);
        },
      },
    });

    return session;
  }

  // ─── Message handler ──────────────────────────────────────────────────────────

  function handleMessage(msg: LiveServerMessage) {
    if (!isRunningRef.current) return;
    const store = useSessionStore.getState();

    // GoAway — session is about to end
    if (msg.goAway) {
      store.logTiming(`live: goAway — ${JSON.stringify(msg.goAway.timeLeft ?? "")} left`);
      rotateSession();
      return;
    }

    const sc = msg.serverContent;
    if (!sc) return;

    // Gemini audio output — discard PCM, log transcription only
    if (sc.modelTurn?.parts) {
      for (const part of sc.modelTurn.parts) {
        if ((part as { thought?: boolean }).thought) continue;
        const partText = (part as { text?: string }).text;
        if (partText) {
          // Log only — ComedianBrain controls all speech
          store.logTiming(`live: gemini-text (discarded) — ${partText.slice(0, 40)}`);
        }
      }
    }

    // Output transcription (what Gemini is saying) — discarded in brain mode
    if (sc.outputTranscription?.text) {
      store.logTiming(`live: gemini-output (discarded) — ${sc.outputTranscription.text.slice(0, 40)}`);
    }

    // Interrupted — user barged in
    if (sc.interrupted) {
      store.setIsSpeaking(false);
      store.addConversationEvent("interrupted");
      store.logTiming("live: interrupted (barge-in)");
      brainRef.current?.onInterrupted();
    }

    // Turn complete — Gemini finished its (discarded) turn
    if (sc.turnComplete) {
      store.addConversationEvent("ai-done");
    }

    // Input transcription — user is speaking
    if (sc.inputTranscription?.text) {
      const text = sc.inputTranscription.text;
      store.setIsUserSpeaking(true);
      store.addConversationEvent("user-start", text.slice(0, 40));
      store.setTranscript(text.slice(-200));
      store.pushTranscriptEntry("user", text);

      // Infer puppet listening animation
      const [motion, intensity] = inferMotionFromTranscript(text, store.audioAmplitude);
      store.setActiveMotionState(motion, intensity);

      // Route to brain (pass finished flag so brain can use authoritative final text)
      brainRef.current?.onInputTranscription(text, sc.inputTranscription.finished ?? false);

      // Start user speaking span
      if (!userSpeakingSpanRef.current) {
        userSpeakingSpanRef.current = store.beginSpan("user", "speaking");
      }
      if (userSpeakingTimerRef.current) clearTimeout(userSpeakingTimerRef.current);
      userSpeakingTimerRef.current = setTimeout(() => {
        if (isRunningRef.current) {
          useSessionStore.getState().setIsUserSpeaking(false);
          if (userSpeakingSpanRef.current) {
            useSessionStore.getState().endSpan(userSpeakingSpanRef.current);
            userSpeakingSpanRef.current = null;
          }
          geminiWaitingSpanRef.current = useSessionStore.getState().beginSpan("gemini", "processing", "#92400e");
        }
      }, 500);
    }

    if (sc.waitingForInput) {
      store.setActiveMotionState("listening", 0.4);
    }
  }

  // ─── Laugh + smile detection (vision-based) ────────────────────────────────────

  const LAUGH_KEYWORDS = ["laugh", "cracking up", "giggl", "chuckl", "grin", "smirk", "hysterical"];
  const SMILE_KEYWORDS = ["smile", "smiling", "grinning", "beaming", "happy", "amused", "cheerful"];
  const LAUGH_DECAY_MS = 4000;
  const SMILE_DECAY_MS = 4000;

  function detectExpression(observations: string[]) {
    const store = useSessionStore.getState();
    const lowerObs = observations.map((o) => o.toLowerCase());

    // Laugh detection
    const isLaughing = lowerObs.some((obs) =>
      LAUGH_KEYWORDS.some((kw) => obs.includes(kw)),
    );

    if (isLaughing) {
      if (!store.isUserLaughing) {
        store.incrementLaughCount();
      }
      store.setIsUserLaughing(true);
      store.addConversationEvent("user-laugh");
      if (laughDecayTimerRef.current) clearTimeout(laughDecayTimerRef.current);
      laughDecayTimerRef.current = setTimeout(clearLaughter, LAUGH_DECAY_MS);
    } else {
      clearLaughter();
    }

    // Smile detection
    const isSmiling = lowerObs.some((obs) =>
      SMILE_KEYWORDS.some((kw) => obs.includes(kw)),
    );

    if (isSmiling) {
      store.setIsUserSmiling(true);
      if (smileDecayTimerRef.current) clearTimeout(smileDecayTimerRef.current);
      smileDecayTimerRef.current = setTimeout(clearSmile, SMILE_DECAY_MS);
    } else {
      clearSmile();
    }

    // Record this vision frame for smile percentage
    store.recordVisionFrame(isSmiling || isLaughing);
  }

  function clearLaughter() {
    if (useSessionStore.getState().isUserLaughing) {
      useSessionStore.getState().setIsUserLaughing(false);
    }
    if (laughDecayTimerRef.current) {
      clearTimeout(laughDecayTimerRef.current);
      laughDecayTimerRef.current = null;
    }
  }

  function clearSmile() {
    if (useSessionStore.getState().isUserSmiling) {
      useSessionStore.getState().setIsUserSmiling(false);
    }
    if (smileDecayTimerRef.current) {
      clearTimeout(smileDecayTimerRef.current);
      smileDecayTimerRef.current = null;
    }
  }

  // ─── Webcam + Vision ──────────────────────────────────────────────────────────

  function startWebcamSend() {
    stopWebcamSend();
    webcamIntervalRef.current = setInterval(() => {
      if (!isRunningRef.current || !sessionRef.current) return;
      const frame = webcamRef.current?.captureFrame();
      if (frame) {
        sessionRef.current.sendRealtimeInput({
          video: { data: frame, mimeType: "image/jpeg" },
        });
      }
    }, WEBCAM_SEND_INTERVAL_MS);
  }

  function stopWebcamSend() {
    if (webcamIntervalRef.current) {
      clearInterval(webcamIntervalRef.current);
      webcamIntervalRef.current = null;
    }
  }

  function runVisionAnalyze() {
    const frame = webcamRef.current?.captureFrame();
    if (!frame) {
      brainRef.current?.setCameraAvailable(false);
      useSessionStore.getState().logTiming("vision: no frame (camera not ready)");
      scheduleNextVision();
      return;
    }
    const { burnIntensity: bi, activePersona: ap } = useSessionStore.getState();
    useSessionStore.getState().setLastVisionCallTs(Date.now());
    const visionSpanId = useSessionStore.getState().beginSpan("vision", "analyze");
    fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64: frame, burnIntensity: bi, mode: "vision", persona: ap }),
      signal: AbortSignal.timeout(10_000),
    })
      .then((r) => r.json())
      .then((d) => {
        useSessionStore.getState().endSpan(visionSpanId);
        const obs: string[] = d.observations ?? [];
        const setting: string | null = d.setting ?? null;
        useSessionStore.getState().logTiming(`vision: ${obs.length} obs — ${obs.join("; ").slice(0, 100)}${setting ? ` [${setting}]` : ""}`);
        if (obs.length) {
          useSessionStore.getState().setObservations(obs);
          brainRef.current?.onVisionUpdate(obs);
          detectExpression(obs);
        } else {
          clearLaughter();
        }
        if (setting) {
          useSessionStore.getState().setVisionSetting(setting);
        }
      })
      .catch((e) => {
        useSessionStore.getState().endSpan(visionSpanId);
        useSessionStore.getState().logTiming(`vision: ERROR — ${(e as Error).message}`);
      })
      .finally(() => {
        scheduleNextVision();
      });
  }

  /** Schedule next vision call after the configured interval. */
  function scheduleNextVision() {
    if (!isRunningRef.current) return;
    visionIntervalRef.current = setTimeout(runVisionAnalyze, COMEDIAN_CONFIG.visionIntervalMs);
  }

  function startVisionSend() {
    stopVisionSend();
    runVisionAnalyze();
  }

  function stopVisionSend() {
    if (visionIntervalRef.current) {
      clearTimeout(visionIntervalRef.current);
      visionIntervalRef.current = null;
    }
  }

  // ─── Session rotation ─────────────────────────────────────────────────────────

  async function rotateSession() {
    if (!isRunningRef.current) return;
    useSessionStore.getState().logTiming("live: rotating session");
    useSessionStore.getState().addConversationEvent("rotate");
    const rotateSpanId = useSessionStore.getState().beginSpan("session", "rotate");

    try {
      const oldSession = sessionRef.current;
      const newSession = await openSession();
      sessionRef.current = newSession;
      useSessionStore.getState().endSpan(rotateSpanId);
      try { oldSession?.close(); } catch { /* may be closed */ }
      scheduleRotation();
      const frame = webcamRef.current?.captureFrame();
      if (frame) {
        newSession.sendRealtimeInput({ video: { data: frame, mimeType: "image/jpeg" } });
      }
    } catch (err) {
      console.error("[live] Rotation failed:", err);
      useSessionStore.getState().logTiming(`live: rotation error — ${(err as Error).message}`);
      useSessionStore.getState().endSpan(rotateSpanId);
    }
  }

  function scheduleRotation() {
    if (rotateTimerRef.current) clearTimeout(rotateTimerRef.current);
    // Allow tests to inject a longer rotation timeout via window.__SESSION_ROTATE_MS__
    const rotateMsOverride = typeof window !== "undefined"
      ? (window as unknown as Record<string, unknown>).__SESSION_ROTATE_MS__
      : undefined;
    const rotateMs = typeof rotateMsOverride === "number" ? rotateMsOverride : SESSION_ROTATE_MS;

    // Skip rotation if the wrapup window is imminent — opening a new WebSocket only to
    // tear it down moments later wastes a connect and risks racing the wrapup TTS drain.
    if (kickoffTimeRef.current !== null) {
      const elapsed = Date.now() - kickoffTimeRef.current;
      if (elapsed + rotateMs >= COMEDIAN_CONFIG.wrapupGuardMs) {
        useSessionStore.getState().logTiming(
          `live: skipping rotation — wrapup imminent (elapsed=${(elapsed / 1000).toFixed(1)}s)`,
        );
        return;
      }
    }
    rotateTimerRef.current = setTimeout(rotateSession, rotateMs);
  }

  function scheduleWrapup() {
    if (wrapupTimerRef.current) clearTimeout(wrapupTimerRef.current);
    const ms = COMEDIAN_CONFIG.wrapupAfterMs;
    if (ms <= 0) return;
    wrapupTimerRef.current = setTimeout(() => {
      wrapupTimerRef.current = null;
      if (!isRunningRef.current) return;
      useSessionStore.getState().logTiming(
        `live: wrapup timer fired (${(ms / 1000).toFixed(0)}s elapsed) — requesting brain wrapup`,
      );
      brainRef.current?.requestWrapup();
    }, ms);
  }

  // ─── Audio stream for recording ────────────────────────────────────────────────

  function getRecordingAudioStream(): MediaStream | null {
    // Mix mic audio into the recording destination (TTS playback context).
    // Routes mic → dest node only (NOT speakers) to avoid feedback.
    const micStream = mic.getStream();
    if (micStream) {
      micRecordingDisconnectRef.current = playback.addInputToRecording(micStream);
    }
    return playback.getDestinationStream();
  }

  // ─── Mock session ──────────────────────────────────────────────────────────────

  async function startMockSession() {
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    isRunningRef.current = true;
    ttsChainRef.current = Promise.resolve();
    ttsGenerationRef.current++;


    userSpeakingSpanRef.current = null;
    geminiWaitingSpanRef.current = null;
    useSessionStore.getState().clearConversationEvents();
    useSessionStore.getState().clearTimelineSpans();
    useSessionStore.getState().clearTranscriptHistory();

    // Start immediately — puppet looks up and talks with no gaps
    useSessionStore.getState().setActiveMotionState("smug", 0.8);

    // AI-generated joke queue — refilled in the background as it empties
    const jokeQueue: string[] = [];
    let fetchInFlight = false;

    async function refillJokeQueue(): Promise<void> {
      if (fetchInFlight || !isRunningRef.current) return;
      fetchInFlight = true;
      try {
        const resp = await fetch("/api/generate-joke", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ context: "hopper", persona: "kvetch", burnIntensity: 3 }),
        });
        if (resp.ok) {
          const data = (await resp.json()) as { jokes?: { text: string }[] };
          const texts = (data.jokes ?? []).map((j) => j.text).filter(Boolean);
          jokeQueue.push(...texts);
        }
      } catch {
        // API unavailable — fall back to MOCK_LINES below
      } finally {
        fetchInFlight = false;
      }
    }

    // Pre-fetch before the loop starts so the first line is AI-generated
    await refillJokeQueue();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (!isRunningRef.current) break;

      // Refill in the background when queue is getting low
      if (jokeQueue.length <= 1) void refillJokeQueue();

      // Use AI joke if available, otherwise fall back to hardcoded lines
      const line = jokeQueue.shift() ?? MOCK_LINES[Math.floor(Math.random() * MOCK_LINES.length)];

      const store = useSessionStore.getState();
      store.setIsSpeaking(true);
      store.setTranscript(line);

      const sentences = line.match(/[^.!?]+[.!?]+\s*/g) ?? [line];
      for (const s of sentences) queueSpeak(s);

      // Wait for TTS to finish decoding AND finish playing
      await ttsChainRef.current;
      while (!playback.isQueueEmpty() && isRunningRef.current) await sleep(50);
      if (!isRunningRef.current) break;

      store.setIsSpeaking(false);
      useSessionStore.getState().setActiveMotionState("smug", 0.8);
    }
  }

  // ─── Start / Stop ─────────────────────────────────────────────────────────────

  async function startLiveSession() {
    if (isRunningRef.current) return; // guard against React StrictMode double-invoke
    isRunningRef.current = true;

    // Warm up AudioContext immediately — on iOS Safari, creating the context close
    // to the user gesture ensures hardware volume buttons control Web Audio output.
    playback.warmUp();

    ttsChainRef.current = Promise.resolve();
    ttsGenerationRef.current++; // increment (not reset) — invalidates any in-flight TTS from prior session
    lastSpokenTextRef.current = ""; // reset vocal continuity context for new session

    userSpeakingSpanRef.current = null;
    geminiWaitingSpanRef.current = null;
    firstSpeechRecordedRef.current = false;
    useSessionStore.getState().setError(null); // clear any prior quota/session error
    useSessionStore.getState().clearTimingLog();
    useSessionStore.getState().clearConversationEvents();
    useSessionStore.getState().clearTimelineSpans();
    useSessionStore.getState().clearTranscriptHistory();
    useSessionStore.getState().setTownFlavorBlurb(null);
    useSessionStore.getState().setTownFlavorRequested(false);
    useSessionStore.getState().logTiming("live: starting session");

    // Prefetch greeting: vision analyze first → then joke generation with observations.
    // This lets the greeting reference what the model actually sees ("nice beard", "that shirt").
    // Webcam startup can lag by a few hundred ms, so retry briefly before giving up.
    const captureGreetingFrame = async (): Promise<string | undefined> => {
      let frame = webcamRef.current?.captureFrame();
      if (frame) return frame;
      for (let i = 0; i < 3; i++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 120));
        frame = webcamRef.current?.captureFrame();
        if (frame) {
          useSessionStore.getState().logTiming(`live: greeting frame became ready after retry ${i + 1}`);
          return frame;
        }
      }
      return undefined;
    };
    let greetingPrefetch: Promise<JokeResponse | null>;

    if (warmupGreetingPrefetch) {
      greetingPrefetch = warmupGreetingPrefetch.catch(() => null);
      useSessionStore.getState().logTiming("live: using pre-roast greeting warmup");
    } else {
      const greetingFrame = await captureGreetingFrame();
      const greetingStore = useSessionStore.getState();
      useSessionStore.getState().logTiming(`live: greeting prefetch — frame=${greetingFrame ? "yes" : "no"}`);

      greetingPrefetch = prefetchParallelVisionAndGreeting(greetingFrame, {
        activePersona: greetingStore.activePersona,
        burnIntensity: greetingStore.burnIntensity,
        contentMode: greetingStore.contentMode,
      }).catch(() => null);
      useSessionStore.getState().logTiming("live: greeting prefetch fired (parallel vision + joke)");
    }

    // Build ComedianBrain
    brainRef.current = new ComedianBrain({
      queueSpeak,
      cancelSpeech,
      isQueueEmpty: () => playback.isQueueEmpty(),
      setMotion: (state, intensity) =>
        useSessionStore.getState().setActiveMotionState(state, intensity),
      captureFrame: () => webcamRef.current?.captureFrame() ?? undefined,
      getPersona: () => useSessionStore.getState().activePersona,
      getBurnIntensity: () => useSessionStore.getState().burnIntensity,
      getContentMode: () => useSessionStore.getState().contentMode,
      getRoastModel: () => useSessionStore.getState().roastModel,
      getInputAmplitude: () => mic.getInputAmplitude(),
      getObservations: () => useSessionStore.getState().observations,
      getVisionSetting: () => useSessionStore.getState().visionSetting,
      getAmbientContext: () => useSessionStore.getState().ambientContext,
      getTownFlavor: () => useSessionStore.getState().townFlavorBlurb,
      getSessionId: () => comedianSessionIdRef.current,
      setBrainState: (s) => useSessionStore.getState().setBrainState(s),
      setCurrentQuestion: (q) => useSessionStore.getState().setCurrentQuestion(q),
      setUserAnswer: (a) => useSessionStore.getState().setUserAnswer(a),
      logTiming: (e) => useSessionStore.getState().logTiming(e),
      setError: (e) => useSessionStore.getState().setError(e),
      revealSession: () => useSessionStore.getState().setHasSpokenThisSession(true),
      prefetchedGreeting: greetingPrefetch,
      saveCritique: (text, ctx) => {
        fetch("/api/save-feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "critique",
            text,
            persona: ctx.persona,
            lastJokeText: ctx.lastJokeText,
          }),
        }).catch(() => {});
      },
      onSessionEnd: () => {
        if (!isRunningRef.current) return;
        const store = useSessionStore.getState();
        const pauseMs = COMEDIAN_CONFIG.wrapupPostLinePauseMs;
        const fadeMs = 600;
        store.logTiming(
          `live: wrapup complete — holding ${pauseMs}ms before fade, then stopping`,
        );

        // Beat of silence: hold the puppet on stage for a few seconds after the goodbye,
        // then quick fade to black, then phase transition.
        setTimeout(() => {
          if (!isRunningRef.current) return;
          useSessionStore.getState().setIsEnding(true);
          useSessionStore.getState().setPuppetRevealed(false);
          setTimeout(() => {
            if (useSessionStore.getState().phase === "roasting") {
              useSessionStore.getState().setPhase("stopped", "SESSION_TIMEOUT");
            }
          }, fadeMs + 50);
        }, pauseMs);
      },
    });

    const connectSpanId = useSessionStore.getState().beginSpan("session", "connect");
    try {
      const sessionPromise = openSession(prefetchedTokenPromise);
      const micPromise = mic.start().catch((e) => {
        console.warn("[live] mic start failed:", e);
        brainRef.current?.setMicAvailable(false);
      });

      // Create comedian chat session in parallel (non-blocking — falls back to stateless if it fails)
      const store = useSessionStore.getState();
      fetch("/api/comedian-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          persona: store.activePersona,
          burnIntensity: store.burnIntensity,
          contentMode: store.contentMode,
          model: store.roastModel,
        }),
      })
        .then((r) => r.json())
        .then((data: { sessionId?: string }) => {
          if (data.sessionId && isRunningRef.current) {
            comedianSessionIdRef.current = data.sessionId;
            useSessionStore.getState().logTiming(`live: comedian chat session ready (${data.sessionId}) model=${store.roastModel}`);
          }
        })
        .catch(() => { /* stateless fallback — no action needed */ });

      const session = await sessionPromise;

      // Guard: stopLiveSession() may have run while we were awaiting (e.g. user
      // clicked Stop, then immediately Start Session before the old stop finished).
      if (!isRunningRef.current || !brainRef.current) {
        try { session.close(); } catch { /* noop */ }
        useSessionStore.getState().endSpan(connectSpanId);
        return;
      }

      sessionRef.current = session;
      useSessionStore.getState().endSpan(connectSpanId);
      useSessionStore.getState().logTiming("live: session ready (mic init in background)");

      kickoffTimeRef.current = Date.now();
      useSessionStore.getState().setTimeToFirstSpeechMs(null);
      useSessionStore.getState().setHasSpokenThisSession(false);
      // puppetRevealed is set by page.tsx when phase becomes "roasting" — don't reset
      // here or the puppet would flash off mid-mount. Stop/restart paths reset elsewhere.
      useSessionStore.getState().setIsEnding(false);

      // Check camera availability
      const frame = webcamRef.current?.captureFrame();
      if (!frame) brainRef.current.setCameraAvailable(false);

      // Start recording with TTS-audio destination only — mic is added when ready.
      // playback.getDestinationStream() returns the shared destination; later
      // addInputToRecording() routes mic into the same node, so the recording
      // captures it without re-starting.
      if (!mockMode && videoRecorderRef.current && compositorStream && isRunningRef.current) {
        videoRecorderRef.current.start(compositorStream, playback.getDestinationStream());
        useSessionStore.getState().logTiming("live: recording started (TTS-only, mic to follow)");
      }

      // Start the comedy show NOW — don't wait for mic to finish initializing.
      // Greeting + first question are TTS-only; mic isn't needed until wait_answer
      // (~10s later). Pulls TTFS down by the mic init time (~3s).
      startDrainPolling();
      brainRef.current.start();
      kickTownFlavorFetch(); // overlaps first-joke TTS when geo already resolved
      useSessionStore.getState().logTiming("live: brain started");

      // Mic + VAD setup in background — won't block first speech.
      micPromise.then(() => {
        if (!isRunningRef.current || !brainRef.current) return;
        useSessionStore.getState().logTiming("live: mic ready");
        const micStream = mic.getStream();
        if (micStream) {
          micRecordingDisconnectRef.current = playback.addInputToRecording(micStream);
          vad.start(micStream)
            .then(() => brainRef.current?.setVadAvailable(true))
            .catch((e) => {
              brainRef.current?.setVadAvailable(false);
              console.warn("[live] VAD start failed (falling back to silence timer):", e);
            });
        } else {
          brainRef.current?.setVadAvailable(false);
        }
      });

      // Send first webcam frame to Gemini for VAD context
      if (frame) {
        session.sendRealtimeInput({ video: { data: frame, mimeType: "image/jpeg" } });
        useSessionStore.getState().logTiming("live: initial frame sent");
      }

      startWebcamSend();
      scheduleRotation();
      scheduleWrapup();
      startVisionSend();
    } catch (err) {
      console.error("[live] Failed to start:", err);
      useSessionStore.getState().logTiming(`live: start error — ${(err as Error).message}`);
      useSessionStore.getState().endSpan(connectSpanId);
      useSessionStore.getState().setError(
        `Live session failed: ${(err as Error).message}. Try monologue mode.`,
      );
      useSessionStore.getState().setPhase("idle", "ERROR");
    }
  }

  async function stopLiveSession() {
    isRunningRef.current = false;

    // Stop brain
    brainRef.current?.stop();
    brainRef.current = null;

    stopDrainPolling();

    // Close timeline spans
    const store = useSessionStore.getState();
    if (userSpeakingSpanRef.current) { store.endSpan(userSpeakingSpanRef.current); userSpeakingSpanRef.current = null; }
    if (geminiWaitingSpanRef.current) { store.endSpan(geminiWaitingSpanRef.current); geminiWaitingSpanRef.current = null; }

    store.setHasSpokenThisSession(false);
    store.setPuppetRevealed(false);

    stopWebcamSend();
    stopVisionSend();
    if (rotateTimerRef.current) clearTimeout(rotateTimerRef.current);
    if (wrapupTimerRef.current) { clearTimeout(wrapupTimerRef.current); wrapupTimerRef.current = null; }

    cancelSpeech();
    micRecordingDisconnectRef.current?.();
    micRecordingDisconnectRef.current = null;
    vad.stop();
    mic.stop();
    playback.flush();

    try { sessionRef.current?.close(); } catch { /* may be closed */ }
    sessionRef.current = null;

    // Clean up comedian chat session (fire-and-forget)
    if (comedianSessionIdRef.current) {
      fetch("/api/comedian-session", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: comedianSessionIdRef.current }),
      }).catch(() => {});
      comedianSessionIdRef.current = null;
    }

    store.setIsSpeaking(false);
    store.setIsListening(false);
    store.setIsUserSpeaking(false);
    store.setActiveMotionState("idle", 0.3);

    if (videoRecorderRef.current) {
      try {
        const blob = await videoRecorderRef.current.stop();
        store.setRecordedBlob(blob);
      } catch (err) {
        console.error("[live] Recording stop error:", err);
      }
    }

    // Only navigate to sharing if the user hasn't already moved on (e.g. clicked
    // "Start Session" again before this async stop finished).
    if (useSessionStore.getState().phase === "stopped") {
      store.setPhase("sharing", "SHARE_CLICKED");
    }

    // Auto-save transcript for debugging
    saveTranscript(store);
  }

  function saveTranscript(store: ReturnType<typeof useSessionStore.getState>): void {
    const payload = {
      savedAt: new Date().toISOString(),
      transcriptHistory: store.transcriptHistory,
      timingLog: store.timingLog,
      observations: store.observations,
      timeToFirstSpeechMs: store.timeToFirstSpeechMs,
      activePersona: store.activePersona,
      burnIntensity: store.burnIntensity,
      sessionMode: store.sessionMode,
    };
    fetch("/api/save-transcript", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch((e) => console.warn("[save-transcript] failed:", e));
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (phase === "roasting") {
      mockMode ? startMockSession() : startLiveSession();
    } else if (phase === "stopped") {
      stopLiveSession();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // Cleanup on real unmount (navigation away, etc.) — does NOT reset isRunningRef
  // because React StrictMode simulates unmount/remount and would break the start guard.
  // isRunningRef is only set false by stopLiveSession (explicit stop).
  useEffect(() => {
    return () => {
      stopDrainPolling();
      stopWebcamSend();
      stopVisionSend();
      if (rotateTimerRef.current) clearTimeout(rotateTimerRef.current);
      if (wrapupTimerRef.current) clearTimeout(wrapupTimerRef.current);
      if (userSpeakingTimerRef.current) clearTimeout(userSpeakingTimerRef.current);
      brainRef.current?.stop();
      vad.stop();
      mic.stop();
      playback.flush();
      try { sessionRef.current?.close(); } catch { /* noop */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
