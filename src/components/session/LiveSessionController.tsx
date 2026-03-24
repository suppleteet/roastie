"use client";
import { useEffect, useRef, useCallback } from "react";
import { GoogleGenAI, Modality } from "@google/genai";
import type { Session, LiveServerMessage } from "@google/genai";
import { useSessionStore } from "@/store/useSessionStore";
import type { WebcamCaptureHandle } from "./WebcamCapture";
import type { VideoRecorderHandle } from "@/components/recording/VideoRecorder";
import { useMicCapture } from "@/components/audio/useMicCapture";
import { usePcmPlayback } from "@/components/audio/usePcmPlayback";
import { float32ToBase64Pcm16 } from "@/lib/audioUtils";
import { inferMotionFromTranscript } from "@/lib/motionInference";
import {
  LIVE_MODEL,
  LIVE_VOICE_NAME,
  WEBCAM_SEND_INTERVAL_MS,
  VISION_INTERVAL_MS,
  SESSION_ROTATE_MS,
  MIC_MIME_TYPE,
  MOCK_LINES,
} from "@/lib/liveConstants";
import { getLiveTranscriptionPrompt } from "@/lib/livePrompts";
import { ComedianBrain } from "@/lib/comedianBrain";
import type { MotionState } from "@/lib/motionStates";


interface Props {
  webcamRef: React.RefObject<WebcamCaptureHandle | null>;
  videoRecorderRef: React.RefObject<VideoRecorderHandle | null>;
  compositorStream: MediaStream | null;
  prefetchedTokenPromise?: Promise<string> | null;
  mockMode?: boolean;
}

export default function LiveSessionController({
  webcamRef,
  videoRecorderRef,
  compositorStream,
  prefetchedTokenPromise,
  mockMode = false,
}: Props) {
  // Only subscribe to phase for lifecycle — all other store access uses getState()
  // to avoid stale closures in long-lived WebSocket callbacks.
  const phase = useSessionStore((s) => s.phase);

  const sessionRef = useRef<Session | null>(null);
  const isRunningRef = useRef(false);
  const webcamIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const visionIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const rotateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userSpeakingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const kickoffTimeRef = useRef<number | null>(null);
  const firstSpeechRecordedRef = useRef(false);

  // TTS pipeline — brain-driven, sequential ElevenLabs requests
  const ttsChainRef = useRef<Promise<void>>(Promise.resolve());
  const ttsGenerationRef = useRef(0);

  // rAF for TTS drain detection
  const drainRafRef = useRef<number>(0);
  const wasDrainedRef = useRef(true); // track edge: false → true

  // Timeline span IDs
  const userSpeakingSpanRef = useRef<string | null>(null);
  const geminiWaitingSpanRef = useRef<string | null>(null);

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

  // ComedianBrain — instantiated when session starts
  const brainRef = useRef<ComedianBrain | null>(null);

  // ─── Brain helpers ────────────────────────────────────────────────────────────

  function queueSpeak(text: string, motion?: MotionState, intensity?: number): void {
    if (!text.trim() || !isRunningRef.current) return;
    useSessionStore.getState().pushTranscriptEntry("puppet", text.trim());
    wasDrainedRef.current = false; // reset edge so drain detection fires when this plays through
    const gen = ttsGenerationRef.current;

    // Fire TTS fetch NOW — doesn't wait for previous joke to finish fetching
    const audioPromise = prefetchTts(text.trim(), gen);

    ttsChainRef.current = ttsChainRef.current.then(async () => {
      // Motion fires when THIS joke is about to play (not at queue time)
      if (motion) useSessionStore.getState().setActiveMotionState(motion, intensity ?? 0.7);
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

  async function prefetchTts(text: string, gen: number): Promise<ArrayBuffer | null> {
    if (!isRunningRef.current) return null;
    try {
      const ttsSpanId = useSessionStore.getState().beginSpan("tts", text.slice(0, 22));
      const resp = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      useSessionStore.getState().endSpan(ttsSpanId);
      if (!resp.ok || ttsGenerationRef.current !== gen) return null;
      return resp.arrayBuffer();
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        console.error("[live] TTS prefetch error:", e);
      }
      return null;
    }
  }

  async function scheduleFromPrefetch(
    audioPromise: Promise<ArrayBuffer | null>,
    gen: number,
  ): Promise<void> {
    const ab = await audioPromise;
    if (!ab || !isRunningRef.current || ttsGenerationRef.current !== gen) return;

    await playback.decodeAndEnqueue(ab);

    if (ttsGenerationRef.current !== gen) {
      playback.flush();
      return;
    }

    // TTFS — first audio scheduled
    if (!firstSpeechRecordedRef.current && kickoffTimeRef.current !== null) {
      firstSpeechRecordedRef.current = true;
      const ttfs = Date.now() - kickoffTimeRef.current;
      useSessionStore.getState().setTimeToFirstSpeechMs(ttfs);
      useSessionStore.getState().logTiming(`brain: TTFS ${ttfs}ms`);
      useSessionStore.getState().setHasSpokenThisSession(true);
    }
    useSessionStore.getState().setIsSpeaking(true);
  }

  // ─── TTS drain detection via rAF ─────────────────────────────────────────────

  function startDrainPolling(): void {
    stopDrainPolling();
    wasDrainedRef.current = false;

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
          store.setIsSpeaking(false);
          store.setActiveMotionState("idle", 0.3);
          brainRef.current?.onTtsQueueDrained();
        } else if (!isEmpty) {
          wasDrainedRef.current = false;
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

      // Route to brain
      brainRef.current?.onInputTranscription(text);

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
        if (d.observations?.length) {
          useSessionStore.getState().setObservations(d.observations);
          brainRef.current?.onVisionUpdate(d.observations as string[]);
        }
      })
      .catch((e) => {
        useSessionStore.getState().endSpan(visionSpanId);
        console.warn("[vision] analyze fetch failed:", e);
      });
  }

  function startVisionSend() {
    stopVisionSend();
    runVisionAnalyze();
    visionIntervalRef.current = setInterval(() => {
      if (!isRunningRef.current) return;
      runVisionAnalyze();
    }, VISION_INTERVAL_MS);
  }

  function stopVisionSend() {
    if (visionIntervalRef.current) {
      clearInterval(visionIntervalRef.current);
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
    rotateTimerRef.current = setTimeout(rotateSession, SESSION_ROTATE_MS);
  }

  // ─── Audio stream for recording ────────────────────────────────────────────────

  function getRecordingAudioStream(): MediaStream | null {
    // Use the TTS playback destination stream directly — it's already on the right
    // AudioContext (OUTPUT_SAMPLE_RATE). Routing through a second AudioContext causes
    // cross-rate resampling artifacts in the recorded WebM.
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
    useSessionStore.getState().logTiming("mock: starting");

    const connectSpanId = useSessionStore.getState().beginSpan("session", "mock-connect");
    await sleep(280);
    if (!isRunningRef.current) return;
    useSessionStore.getState().endSpan(connectSpanId);
    useSessionStore.getState().setIsListening(true);
    useSessionStore.getState().logTiming("mock: ready");

    geminiWaitingSpanRef.current = useSessionStore.getState().beginSpan("gemini", "processing", "#92400e");
    await sleep(180 + Math.random() * 120);
    if (!isRunningRef.current) return;

    let lineIdx = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (!isRunningRef.current) break;

      const store = useSessionStore.getState();
      if (geminiWaitingSpanRef.current) {
        store.endSpan(geminiWaitingSpanRef.current);
        geminiWaitingSpanRef.current = null;
      }
      store.setIsSpeaking(true);

      const line = MOCK_LINES[lineIdx % MOCK_LINES.length];
      lineIdx++;
      store.setTranscript(line);
      const [motion, intensity] = inferMotionFromTranscript(line, 0.5);
      store.setActiveMotionState(motion, intensity);

      const sentences = line.match(/[^.!?]+[.!?]+\s*/g) ?? [line];
      for (const s of sentences) queueSpeak(s);
      await ttsChainRef.current;
      if (!isRunningRef.current) break;

      useSessionStore.getState().setIsSpeaking(false);
      useSessionStore.getState().setActiveMotionState("idle", 0.3);

      await sleep(600 + Math.random() * 400);
      if (!isRunningRef.current) break;

      userSpeakingSpanRef.current = useSessionStore.getState().beginSpan("user", "speaking");
      useSessionStore.getState().setIsUserSpeaking(true);
      await sleep(700 + Math.random() * 600);
      if (!isRunningRef.current) break;

      useSessionStore.getState().endSpan(userSpeakingSpanRef.current!);
      userSpeakingSpanRef.current = null;
      useSessionStore.getState().setIsUserSpeaking(false);

      geminiWaitingSpanRef.current = useSessionStore.getState().beginSpan("gemini", "processing", "#92400e");
      await sleep(300 + Math.random() * 400);
    }
  }

  // ─── Start / Stop ─────────────────────────────────────────────────────────────

  async function startLiveSession() {
    if (isRunningRef.current) return; // guard against React StrictMode double-invoke
    isRunningRef.current = true;
    ttsChainRef.current = Promise.resolve();
    ttsGenerationRef.current++; // increment (not reset) — invalidates any in-flight TTS from prior session
    userSpeakingSpanRef.current = null;
    geminiWaitingSpanRef.current = null;
    firstSpeechRecordedRef.current = false;
    useSessionStore.getState().clearConversationEvents();
    useSessionStore.getState().clearTimelineSpans();
    useSessionStore.getState().clearTranscriptHistory();
    useSessionStore.getState().logTiming("live: starting session");

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
      getObservations: () => useSessionStore.getState().observations,
      setBrainState: (s) => useSessionStore.getState().setBrainState(s),
      setCurrentQuestion: (q) => useSessionStore.getState().setCurrentQuestion(q),
      setUserAnswer: (a) => useSessionStore.getState().setUserAnswer(a),
      logTiming: (e) => useSessionStore.getState().logTiming(e),
    });

    const connectSpanId = useSessionStore.getState().beginSpan("session", "connect");
    try {
      const sessionPromise = openSession(prefetchedTokenPromise);
      const micPromise = mic.start().catch((e) => {
        console.warn("[live] mic start failed:", e);
        brainRef.current?.setMicAvailable(false);
      });
      const session = await sessionPromise;
      await micPromise;
      sessionRef.current = session;
      useSessionStore.getState().endSpan(connectSpanId);
      useSessionStore.getState().logTiming("live: session + mic ready");

      kickoffTimeRef.current = Date.now();
      useSessionStore.getState().setTimeToFirstSpeechMs(null);
      useSessionStore.getState().setHasSpokenThisSession(false);

      // Check camera availability
      const frame = webcamRef.current?.captureFrame();
      if (!frame) brainRef.current.setCameraAvailable(false);

      // Start the comedy show
      startDrainPolling();
      brainRef.current.start();
      useSessionStore.getState().logTiming("live: brain started");

      // Send first webcam frame to Gemini for VAD context
      if (frame) {
        session.sendRealtimeInput({ video: { data: frame, mimeType: "image/jpeg" } });
        useSessionStore.getState().logTiming("live: initial frame sent");
      }

      startWebcamSend();
      scheduleRotation();
      startVisionSend();
    } catch (err) {
      console.error("[live] Failed to start:", err);
      useSessionStore.getState().logTiming(`live: start error — ${(err as Error).message}`);
      useSessionStore.getState().endSpan(connectSpanId);
      useSessionStore.getState().setError(
        `Live session failed: ${(err as Error).message}. Try monologue mode.`,
      );
      useSessionStore.getState().setPhase("idle");
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

    stopWebcamSend();
    stopVisionSend();
    if (rotateTimerRef.current) clearTimeout(rotateTimerRef.current);

    cancelSpeech();
    mic.stop();
    playback.flush();

    try { sessionRef.current?.close(); } catch { /* may be closed */ }
    sessionRef.current = null;

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

    store.setPhase("sharing");

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
      const sessionStart = mockMode ? startMockSession() : startLiveSession();
      sessionStart.then(() => {
        if (!mockMode && videoRecorderRef.current && compositorStream && isRunningRef.current) {
          // Brief delay so captureStream(30) has at least one valid frame buffered
          // before MediaRecorder starts — prevents empty/malformed EBML header.
          setTimeout(() => {
            if (videoRecorderRef.current && isRunningRef.current) {
              videoRecorderRef.current.start(compositorStream, getRecordingAudioStream());
            }
          }, 500);
        }
      });
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
      if (userSpeakingTimerRef.current) clearTimeout(userSpeakingTimerRef.current);
      brainRef.current?.stop();
      mic.stop();
      playback.flush();
      try { sessionRef.current?.close(); } catch { /* noop */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
