"use client";
import { useRef, useEffect, useState, useCallback } from "react";
import { useSessionStore } from "@/store/useSessionStore";
import LandingScreen from "@/components/ui/LandingScreen";
import ConsentScreen from "@/components/ui/ConsentScreen";
import HUDOverlay from "@/components/ui/HUDOverlay";
import ShareScreen from "@/components/ui/ShareScreen";
import DebugTimeline from "@/components/ui/DebugTimeline";
import DebugTranscript from "@/components/ui/DebugTranscript";
import PuppetScene from "@/components/puppet/PuppetScene";
import WebcamCapture, { type WebcamCaptureHandle } from "@/components/session/WebcamCapture";
import AudioPlayer, { type AudioPlayerHandle } from "@/components/audio/AudioPlayer";
import VideoRecorder, { type VideoRecorderHandle } from "@/components/recording/VideoRecorder";
import SessionController from "@/components/session/SessionController";
import LiveSessionController from "@/components/session/LiveSessionController";
import { useCompositor } from "@/components/recording/useCompositor";
import { PERSONA_IDS, PERSONAS } from "@/lib/personas";
import { kickTownFlavorFetch } from "@/lib/kickTownFlavorFetch";
import { prefetchParallelVisionAndGreeting } from "@/lib/greetingPrefetch";
import { captureSquareJpegFromStream } from "@/lib/captureSquareJpegFromStream";
import type { JokeResponse } from "@/app/api/generate-joke/route";
import RigEditMode from "@/engine/ui/RigEditMode";
import { useRigEditStore } from "@/engine/store/RigEditStore";

interface DebugUsageSnapshot {
  llm: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
  };
  tts: {
    calls: number;
    characters: number;
    estimatedCostUsd: number;
  };
  totalEstimatedCostUsd: number;
}

function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatDebugCost(value: number): string {
  if (value <= 0) return "$0.0000";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/**
 * Top-level router — decides between edit mode and the main app.
 * Must be a separate component from MainApp so hooks are always called
 * in the same order regardless of which branch renders.
 */
export default function Home() {
  const isRigEditMode = useRigEditStore((s) => s.isEditMode);
  if (isRigEditMode) return <RigEditMode />;
  return <MainApp />;
}

function MainApp() {
  const phase = useSessionStore((s) => s.phase);
  const sessionMode = useSessionStore((s) => s.sessionMode);
  const setPhase = useSessionStore((s) => s.setPhase);
  const setError = useSessionStore((s) => s.setError);
  const logTiming = useSessionStore((s) => s.logTiming);
  const timingLog = useSessionStore((s) => s.timingLog);
  const setSessionStartTs = useSessionStore((s) => s.setSessionStartTs);
  const timeToFirstSpeechMs = useSessionStore((s) => s.timeToFirstSpeechMs);
  const activePersona = useSessionStore((s) => s.activePersona);
  const setActivePersona = useSessionStore((s) => s.setActivePersona);
  const hasSpokenThisSession = useSessionStore((s) => s.hasSpokenThisSession);
  const puppetRevealed = useSessionStore((s) => s.puppetRevealed);
  const isEnding = useSessionStore((s) => s.isEnding);
  const brainState = useSessionStore((s) => s.brainState);
  const IS_DEV = process.env.NODE_ENV !== "production";
  const [debugMode, setDebugMode] = useState(IS_DEV);
  const [mockMode, setMockMode] = useState(false);
  const [llmUsage, setLlmUsage] = useState<DebugUsageSnapshot | null>(null);
  const lastNonZeroUsageRef = useRef<DebugUsageSnapshot | null>(null);
  const ambientRequestInFlightRef = useRef(false);
  const mockModeRef = useRef(false); // ref so the requesting-permissions effect reads current value
  const pendingMockRestartRef = useRef(false); // set by handleMockToggle to bounce session

  const [webcamStream, setWebcamStream] = useState<MediaStream | null>(null);
  // Pre-fetched Live API token — may start on idle (conversation) so connect is faster after permission
  const tokenPromiseRef = useRef<Promise<string> | null>(null);
  /** Vision analyze + greeting joke — starts as soon as we have a MediaStream, before phase is roasting */
  const warmupGreetingPromiseRef = useRef<Promise<JokeResponse | null> | null>(null);

  const webcamRef = useRef<WebcamCaptureHandle>(null);
  const audioPlayerRef = useRef<AudioPlayerHandle>(null);
  const videoRecorderRef = useRef<VideoRecorderHandle>(null);
  const puppetCanvasRef = useRef<HTMLCanvasElement>(null);
  const webcamVideoRef = useRef<HTMLVideoElement | null>(null);
  const pipVideoRef = useRef<HTMLVideoElement>(null);

  const compositorHandle = useCompositor(puppetCanvasRef, webcamVideoRef);

  // Keep mockModeRef in sync for stale-closure-safe reads in effects
  useEffect(() => { mockModeRef.current = mockMode; }, [mockMode]);

  /** Gemini Live ephemeral token (~5 min TTL); safe to prefetch on idle before the user taps Roast. */
  function ensureLiveTokenPrefetch(): void {
    if (sessionMode !== "conversation" || mockModeRef.current) return;
    if (tokenPromiseRef.current) return;
    const { burnIntensity: bi, activePersona: ap } = useSessionStore.getState();
    tokenPromiseRef.current = fetch("/api/live-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ burnIntensity: bi, persona: ap }),
    })
      .then((r) => r.json())
      .then((d: { token?: string }) => {
        if (!d.token) throw new Error("No token in response");
        logTiming("prefetch: token ready");
        return d.token;
      })
      .catch((e) => {
        console.warn("[token-prefetch] failed:", e);
        tokenPromiseRef.current = null;
        throw e;
      });
  }

  /** Fire parallel /api/analyze + /api/generate-joke (greeting) before we leave the permission screen */
  function startPreRoastGreetingWarmup(stream: MediaStream): void {
    if (sessionMode !== "conversation" || mockModeRef.current) {
      warmupGreetingPromiseRef.current = null;
      return;
    }
    warmupGreetingPromiseRef.current = (async () => {
      const frame = await captureSquareJpegFromStream(stream);
      const s = useSessionStore.getState();
      return prefetchParallelVisionAndGreeting(frame, {
        activePersona: s.activePersona,
        burnIntensity: s.burnIntensity,
        contentMode: s.contentMode,
      });
    })().catch(() => null);
  }

  const handleStartSession = async () => {
    if (process.env.NEXT_PUBLIC_ROASTIE_PAYMENTS_ENABLED === "true") {
      const resp = await fetch("/api/monetization/redeem", { method: "POST" });
      if (!resp.ok) {
        const data = (await resp.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "No Roast Pass available.");
        setPhase("sharing", "SHARE_CLICKED");
        return;
      }
    }
    setPhase("requesting-permissions", "START_CLICKED");
  };

  // Capture first frame from a MediaStream and send to vision API immediately
  function preAnalyzeFirstFrame(stream: MediaStream) {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    video.play().then(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 512;
      canvas.height = 512;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      // Center-crop to square before sending to vision
      const vw = video.videoWidth || 640;
      const vh = video.videoHeight || 480;
      const side = Math.min(vw, vh);
      const sx = (vw - side) / 2;
      const sy = (vh - side) / 2;
      ctx.drawImage(video, sx, sy, side, side, 0, 0, 512, 512);
      const imageBase64 = canvas.toDataURL("image/jpeg", 0.8).split(",")[1];
      video.pause();
      video.srcObject = null;
      if (!imageBase64) return;
      const { burnIntensity: bi, activePersona: ap } = useSessionStore.getState();
      logTiming("pre-scan: frame captured, sending to vision");
      fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64, burnIntensity: bi, mode: "vision", persona: ap }),
        signal: AbortSignal.timeout(8000),
      })
        .then((r) => r.json())
        .then((d: { observations?: string[] }) => {
          if (d.observations?.length) {
            useSessionStore.getState().setObservations(d.observations);
            logTiming("pre-scan: observations ready");
          }
        })
        .catch(() => {});
    }).catch(() => {});
  }

  // Eagerly request camera as soon as the consent screen appears — this way permission
  // dialog fires while the user is reading, and the first frame is pre-analyzed.
  useEffect(() => {
    if (phase !== "consent") return;
    navigator.mediaDevices
      .getUserMedia({
        video: { width: { ideal: 720 }, height: { ideal: 720 }, facingMode: { ideal: "user" } },
        audio: false, // microphone is requested together with camera at start
      })
      .then((stream) => {
        setWebcamStream(stream);
        preAnalyzeFirstFrame(stream);
      })
      .catch(() => {
        // Silently fail — requesting-permissions will retry with proper error display
      });
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const prevPhaseRef = useRef<typeof phase | null>(null);

  // Idle: clear stale prefetch handles when returning from a session, then warm the Live token for the next run
  useEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = phase;

    if (phase !== "idle") return;

    const enteredIdleFromSession = prev !== null && prev !== "idle";
    if (enteredIdleFromSession) {
      tokenPromiseRef.current = null;
      warmupGreetingPromiseRef.current = null;
    }
    if (sessionMode === "conversation" && !mockMode) {
      ensureLiveTokenPrefetch();
    }
  }, [phase, sessionMode, mockMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Request camera when phase enters requesting-permissions
  useEffect(() => {
    if (phase !== "requesting-permissions") return;

    ensureLiveTokenPrefetch();

    const liveVideoTracks = webcamStream
      ?.getVideoTracks()
      .filter((track) => track.readyState === "live") ?? [];
    const liveAudioTracks = webcamStream
      ?.getAudioTracks()
      .filter((track) => track.readyState === "live") ?? [];

    // If camera + mic were already granted, go straight to warmup.
    if (webcamStream?.getAudioTracks().some((track) => track.readyState === "live")) {
      startPreRoastGreetingWarmup(webcamStream);
      setPhase("roasting", "PERMISSIONS_GRANTED");
      return;
    }

    if (webcamStream && liveVideoTracks.length > 0) {
      navigator.mediaDevices
        .getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
        })
        .then((audioStream) => {
          const stream = new MediaStream([
            ...liveVideoTracks,
            ...audioStream.getAudioTracks(),
          ]);
          setWebcamStream(stream);
          startPreRoastGreetingWarmup(stream);
          setPhase("roasting", "PERMISSIONS_GRANTED");
        })
        .catch((err) => {
          console.error("Microphone denied:", err.name, err.message);
          setError(`Microphone error: ${err.name} — ${err.message}. Please allow microphone access and try again.`);
          setPhase("idle", "PERMISSIONS_DENIED");
        });
      return;
    }

    // Request camera and microphone together before the session starts. Splitting
    // this into a later background mic request can leave the live session deaf.
    navigator.mediaDevices
      .getUserMedia({
        video: { width: { ideal: 720 }, height: { ideal: 720 }, facingMode: { ideal: "user" } },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      })
      .then((stream) => {
        liveAudioTracks.forEach((track) => track.stop());
        setWebcamStream(stream);
        startPreRoastGreetingWarmup(stream);
        setPhase("roasting", "PERMISSIONS_GRANTED");
      })
      .catch((err) => {
        console.error("Camera/microphone denied:", err.name, err.message);
        setError(`Camera/microphone error: ${err.name} — ${err.message}. Please allow both camera and microphone access and try again.`);
        setPhase("idle", "PERMISSIONS_DENIED");
      });
  }, [phase, sessionMode, webcamStream, setPhase, setError]); // eslint-disable-line react-hooks/exhaustive-deps

  const locationConsent = useSessionStore((s) => s.locationConsent);

  // Geolocation + ambient context as soon as the user opts in (landing / consent) — before the roast begins
  useEffect(() => {
    if (phase !== "idle" && phase !== "consent" && phase !== "requesting-permissions" && phase !== "roasting")
      return;
    const { locationConsent: locOk, ambientContext } = useSessionStore.getState();
    if (!locOk) return;
    if (!navigator.geolocation) return;
    if (ambientContext?.city && ambientContext.city !== "unknown") return;
    if (ambientRequestInFlightRef.current) return;
    ambientRequestInFlightRef.current = true;

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lon } = pos.coords;
        logTiming(`geo: got location (${lat.toFixed(2)}, ${lon.toFixed(2)})`);
        fetch("/api/ambient-context", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lat, lon }),
          signal: AbortSignal.timeout(8000),
        })
          .then((r) => r.json())
          .then((ctx) => {
            if (ctx.city) {
              useSessionStore.getState().setAmbientContext(ctx);
              logTiming(`geo: ambient context ready — ${ctx.city}, ${ctx.timeOfDay}, ${ctx.weather ?? "no weather"}`);
              kickTownFlavorFetch();
            }
          })
          .catch(() => logTiming("geo: ambient-context fetch failed"))
          .finally(() => { ambientRequestInFlightRef.current = false; });
      },
      () => {
        ambientRequestInFlightRef.current = false;
        logTiming("geo: permission denied or unavailable");
      },
      { timeout: 10000, maximumAge: 300000 },
    );
  }, [phase, locationConsent]); // eslint-disable-line react-hooks/exhaustive-deps

  // Wire webcam video element ref once stream is ready
  useEffect(() => {
    webcamVideoRef.current = webcamRef.current?.getVideoElement() ?? null;
  }, [webcamStream]);

  // Wire PIP video element to webcam stream.
  // useCallback ref so it re-fires when the element mounts/unmounts (showPuppet toggles DOM).
  const pipRefCallback = useCallback((el: HTMLVideoElement | null) => {
    pipVideoRef.current = el;
    if (!el) return;
    el.srcObject = webcamStream;
    if (webcamStream) el.play().catch(() => {});
  }, [webcamStream]); // eslint-disable-line react-hooks/exhaustive-deps

  // Also sync stream to already-mounted element when webcamStream changes
  useEffect(() => {
    if (!pipVideoRef.current) return;
    pipVideoRef.current.srcObject = webcamStream;
    if (webcamStream) pipVideoRef.current.play().catch(() => {});
  }, [webcamStream]);

  // Start session timer + clear stale logs when roasting begins;
  // save log to disk when session stops.
  useEffect(() => {
    if (phase === "roasting") {
      const now = Date.now();
      setSessionStartTs(now);
      // NOTE: Do NOT clearTimingLog() here — startLiveSession() already logged
      // prefetch entries before this effect runs. Clearing would wipe them.
      logTiming("session: roasting started");
    }
    if (phase === "stopped" || phase === "sharing") {
      const s = useSessionStore.getState();
      fetch("/api/save-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trigger: phase,
          sessionStartTs: s.sessionStartTs,
          timingLog: s.timingLog,
          transcriptHistory: s.transcriptHistory,
          laughCount: s.laughCount,
          smileFrames: s.smileFrames,
          totalVisionFrames: s.totalVisionFrames,
          timeToFirstSpeechMs: s.timeToFirstSpeechMs,
          activePersona: s.activePersona,
          burnIntensity: s.burnIntensity,
        }),
      }).catch(() => {});
    }
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stop webcam tracks when session ends
  useEffect(() => {
    if ((phase === "sharing" || phase === "idle" || phase === "stopped") && webcamStream) {
      webcamStream.getTracks().forEach((t) => t.stop());
      setWebcamStream(null);
    }
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!IS_DEV || !debugMode) return;
    let cancelled = false;

    async function refreshUsage() {
      const resp = await fetch("/api/debug-usage", { cache: "no-store" }).catch(() => null);
      if (!resp?.ok) return;
      const data = (await resp.json()) as DebugUsageSnapshot;
      const hasUsage = data.totalEstimatedCostUsd > 0 || data.llm.calls > 0 || data.tts.calls > 0;
      if (hasUsage) lastNonZeroUsageRef.current = data;
      if (!cancelled) setLlmUsage(hasUsage ? data : lastNonZeroUsageRef.current ?? data);
    }

    void refreshUsage();
    const id = window.setInterval(refreshUsage, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [IS_DEV, debugMode]);

  const showPuppet =
    phase === "roasting" || phase === "stopped" || phase === "requesting-permissions";

  function handleDebugToggle(checked: boolean) {
    setDebugMode(checked);
    if (!checked) { setMockMode(false); mockModeRef.current = false; setPhase("idle", "DEBUG_TOGGLE"); }
  }

  function handleMockToggle(checked: boolean) {
    setMockMode(checked);
    mockModeRef.current = checked;
    // If a session is running, bounce through stopped → requesting-permissions.
    // Child effects (LiveSessionController stopLiveSession) fire before parent
    // effects, so by the time the phase==="stopped" effect below runs, the
    // session is already torn down.
    if (phase === "roasting" || phase === "stopped") {
      pendingMockRestartRef.current = true;
      setPhase("stopped", "STOP_CLICKED");
    }
  }

  // Restart after mock toggle tears down the current session
  useEffect(() => {
    if (phase === "stopped" && pendingMockRestartRef.current) {
      pendingMockRestartRef.current = false;
      setPhase("requesting-permissions", "SESSION_RESTART");
    }
  }, [phase]);

  return (
    <main className="relative h-dvh bg-black flex items-center justify-center overflow-hidden">
      {/* Debug / mock toggles — dev only */}
      {IS_DEV && (
        <div className="absolute top-3 right-3 z-50 flex items-center gap-3 text-white/50 text-xs select-none">
          {debugMode && (
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={mockMode}
                onChange={(e) => handleMockToggle(e.target.checked)}
                className="accent-orange-400"
              />
              mock
            </label>
          )}
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={debugMode}
              onChange={(e) => handleDebugToggle(e.target.checked)}
              className="accent-yellow-400"
            />
            debug
          </label>
          <button
            onClick={() => useRigEditStore.getState().enterEditMode()}
            className="text-white/50 hover:text-white/80 border border-white/20 rounded px-2 py-0.5 text-xs transition-colors"
          >
            Edit Rig
          </button>
        </div>
      )}
      <AudioPlayer ref={audioPlayerRef} />
      <VideoRecorder ref={videoRecorderRef} />
      <WebcamCapture ref={webcamRef} stream={webcamStream} />

      {phase === "roasting" && sessionMode === "monologue" && (
        <SessionController
          webcamRef={webcamRef}
          audioPlayerRef={audioPlayerRef}
          videoRecorderRef={videoRecorderRef}
          compositorStream={compositorHandle.current.stream}
        />
      )}

      {(phase === "roasting" || phase === "stopped") && sessionMode === "conversation" && (
        <LiveSessionController
          webcamRef={webcamRef}
          videoRecorderRef={videoRecorderRef}
          compositorStream={compositorHandle.current.stream}
          mediaStream={webcamStream}
          prefetchedTokenPromise={tokenPromiseRef.current}
          warmupGreetingPrefetch={warmupGreetingPromiseRef.current}
          mockMode={mockMode}
        />
      )}

      {phase === "idle" && <LandingScreen />}
      {phase === "consent" && <ConsentScreen />}

      {showPuppet && (
        <div className="relative w-full max-w-[560px] aspect-square">
          {/* Loading overlay — fades out only when the first TTS audio chunk starts. */}
          <div className={`absolute inset-0 bg-black z-10 pointer-events-none transition-opacity ${isEnding ? "duration-[600ms]" : "duration-[500ms]"} ${puppetRevealed ? "opacity-0" : "opacity-100"}`}>
            {phase === "roasting" && !puppetRevealed && (
              <div className="flex items-center justify-center h-full">
                <div className="flex flex-col items-center gap-3">
                  <div className="w-6 h-6 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  <p className="text-white/50 text-sm font-medium animate-pulse">Sizing you up…</p>
                </div>
              </div>
            )}
          </div>
          <PuppetScene canvasRef={puppetCanvasRef} />
          {/* Webcam PIP — bottom-right, mirrored; hidden once stream stops */}
          <video
            ref={pipRefCallback}
            muted
            playsInline
            className={`absolute bottom-4 right-4 w-36 h-36 object-cover rounded-lg border border-white/20 z-20 ${webcamStream ? "" : "hidden"}`}
            style={{ transform: "scaleX(-1)" }}
          />
          {(phase === "roasting" || phase === "stopped") && (
            <HUDOverlay
              onStartSession={handleStartSession}
              isMock={mockMode}
            />
          )}
          {phase === "requesting-permissions" && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/70">
              <p className="text-white text-lg font-bold animate-pulse">Requesting camera…</p>
            </div>
          )}
        </div>
      )}

      {/* End Session — outside puppet view */}
      {phase === "roasting" && (
        <button
          onClick={() => setPhase("stopped", "STOP_CLICKED")}
          className="absolute bottom-6 left-1/2 -translate-x-1/2 z-30 px-8 py-3 bg-white/10 hover:bg-white/20 backdrop-blur border border-white/20 rounded-full text-white font-bold transition-all"
        >
          End Session
        </button>
      )}

      {phase === "sharing" && <ShareScreen />}

      {/* Debug panels — dev only */}
      {IS_DEV && debugMode && <DebugTranscript />}
      {IS_DEV && debugMode && <DebugTimeline />}
      {IS_DEV && debugMode && (
        <div className="fixed top-3 left-3 z-50 flex flex-col gap-2 max-w-xs">
          {/* Persona selector */}
          <div className="bg-black/80 border border-purple-400/40 rounded p-2 font-mono text-[10px] text-purple-300 leading-tight pointer-events-auto">
            <div className="text-purple-500 mb-1">persona</div>
            <select
              value={activePersona}
              onChange={(e) => setActivePersona(e.target.value as typeof activePersona)}
              className="bg-black/60 border border-purple-400/30 rounded text-purple-200 text-[10px] w-full px-1 py-0.5 cursor-pointer"
            >
              {PERSONA_IDS.map((id) => (
                <option key={id} value={id}>{PERSONAS[id].name} ({id})</option>
              ))}
            </select>
          </div>
          {/* Time to first speech */}
          <div className="bg-black/80 border border-orange-400/40 rounded p-2 font-mono text-[10px] leading-tight pointer-events-auto">
            <span className="text-orange-500">TTFS </span>
            {timeToFirstSpeechMs !== null ? (
              <span className={`font-bold ${timeToFirstSpeechMs < 1500 ? "text-green-400" : timeToFirstSpeechMs < 3000 ? "text-yellow-400" : "text-red-400"}`}>
                {timeToFirstSpeechMs}ms
              </span>
            ) : (
              <span className="text-white/30">{phase === "roasting" ? "waiting…" : "—"}</span>
            )}
          </div>
          {llmUsage && (
            <div className="bg-black/80 border border-emerald-400/40 rounded p-2 font-mono text-[10px] leading-tight pointer-events-auto">
              <div className="text-[11px]">
                <span className="text-emerald-400">COST </span>
                <span className="font-bold text-emerald-100">{formatDebugCost(llmUsage.totalEstimatedCostUsd)}</span>
                <span className="text-white/35"> est</span>
              </div>
              <div className="text-white/35">
                {llmUsage.llm.calls + llmUsage.tts.calls} calls · {formatCompactNumber(llmUsage.llm.totalTokens)} tok · {formatCompactNumber(llmUsage.tts.characters)} chars
              </div>
              <div className="text-white/25">
                LLM {formatDebugCost(llmUsage.llm.estimatedCostUsd)} · TTS {formatDebugCost(llmUsage.tts.estimatedCostUsd)}
              </div>
            </div>
          )}
          {timingLog.length > 0 && (
            <div className="max-h-52 overflow-y-auto bg-black/80 border border-yellow-400/40 rounded p-2 font-mono text-[10px] text-yellow-300 leading-tight pointer-events-auto">
              {timingLog.map((line, i) => (
                <div key={i} className={line.startsWith("──") ? "text-yellow-500 mt-1" : "pl-2"}>
                  {line}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {process.env.NODE_ENV === "production" && process.env.NEXT_PUBLIC_BUILD_TIME && (
        <div className="fixed bottom-2 right-3 text-white/40 text-[10px] sm:text-xs select-none pointer-events-none z-50">
          {new Date(process.env.NEXT_PUBLIC_BUILD_TIME).toLocaleString()}
        </div>
      )}
    </main>
  );
}
