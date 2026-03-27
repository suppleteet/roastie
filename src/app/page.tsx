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
import RigEditMode from "@/engine/ui/RigEditMode";
import { useRigEditStore } from "@/engine/store/RigEditStore";

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
  const observations = useSessionStore((s) => s.observations);
  const timeToFirstSpeechMs = useSessionStore((s) => s.timeToFirstSpeechMs);
  const activePersona = useSessionStore((s) => s.activePersona);
  const setActivePersona = useSessionStore((s) => s.setActivePersona);
  const brainState = useSessionStore((s) => s.brainState);
  const isThinking = phase === "roasting" && (brainState === "generating" || brainState === "pre_generate");
  const lastVisionCallTs = useSessionStore((s) => s.lastVisionCallTs);
  const IS_DEV = process.env.NODE_ENV !== "production";
  const [debugMode, setDebugMode] = useState(IS_DEV);
  const [mockMode, setMockMode] = useState(false);
  const mockModeRef = useRef(false); // ref so the requesting-permissions effect reads current value
  const pendingMockRestartRef = useRef(false); // set by handleMockToggle to bounce session
  const [visionElapsedSecs, setVisionElapsedSecs] = useState<number | null>(null);

  const [webcamStream, setWebcamStream] = useState<MediaStream | null>(null);
  // Pre-fetched Live API token — started in parallel with camera permissions to cut TTFS
  const tokenPromiseRef = useRef<Promise<string> | null>(null);

  const webcamRef = useRef<WebcamCaptureHandle>(null);
  const audioPlayerRef = useRef<AudioPlayerHandle>(null);
  const videoRecorderRef = useRef<VideoRecorderHandle>(null);
  const puppetCanvasRef = useRef<HTMLCanvasElement>(null);
  const webcamVideoRef = useRef<HTMLVideoElement | null>(null);
  const pipVideoRef = useRef<HTMLVideoElement>(null);

  const compositorHandle = useCompositor(puppetCanvasRef, webcamVideoRef);

  // Keep mockModeRef in sync for stale-closure-safe reads in effects
  useEffect(() => { mockModeRef.current = mockMode; }, [mockMode]);

  const handleStartSession = () => { setPhase("requesting-permissions"); };

  // Capture first frame from a MediaStream and send to vision API immediately
  function preAnalyzeFirstFrame(stream: MediaStream) {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    video.play().then(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 240;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, 320, 240);
      const imageBase64 = canvas.toDataURL("image/jpeg", 0.7).split(",")[1];
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
        audio: false, // audio requested at requesting-permissions (after consent is given)
      })
      .then((stream) => {
        setWebcamStream(stream);
        preAnalyzeFirstFrame(stream);
      })
      .catch(() => {
        // Silently fail — requesting-permissions will retry with proper error display
      });
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // Request camera when phase enters requesting-permissions
  useEffect(() => {
    if (phase !== "requesting-permissions") return;

    // Pre-fetch Live API token in parallel with camera permission dialog — cuts TTFS
    // Skip in mock mode — no Gemini session will be opened
    if (sessionMode === "conversation" && !mockModeRef.current) {
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
        .catch((e) => { console.warn("[token-prefetch] failed:", e); throw e; });
    }

    // If camera was already granted during consent screen, just add audio and go
    if (webcamStream) {
      if (sessionMode === "conversation" && !mockModeRef.current) {
        navigator.mediaDevices.getUserMedia({ audio: true })
          .then((audioStream) => {
            audioStream.getAudioTracks().forEach((t) => webcamStream.addTrack(t));
            setPhase("roasting");
          })
          .catch(() => setPhase("roasting")); // proceed without mic if audio denied
      } else {
        setPhase("roasting");
      }
      return;
    }

    // Fallback: camera not yet granted — request everything now
    navigator.mediaDevices
      .getUserMedia({
        video: { width: { ideal: 720 }, height: { ideal: 720 }, facingMode: { ideal: "user" } },
        audio: sessionMode === "conversation" && !mockModeRef.current,
      })
      .then((stream) => {
        setWebcamStream(stream);
        setPhase("roasting");
      })
      .catch((err) => {
        console.error("Camera denied:", err.name, err.message);
        setError(`Camera error: ${err.name} — ${err.message}. Please allow camera access and try again.`);
        setPhase("idle");
      });
  }, [phase, sessionMode, webcamStream, setPhase, setError]); // eslint-disable-line react-hooks/exhaustive-deps

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
      useSessionStore.getState().clearTimingLog();
      useSessionStore.getState().clearTranscriptHistory();
      useSessionStore.getState().clearConversationEvents();
      useSessionStore.getState().clearTimelineSpans();
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

  // Live elapsed-seconds ticker for vision call age
  useEffect(() => {
    if (lastVisionCallTs === null) { setVisionElapsedSecs(null); return; }
    const tick = () => setVisionElapsedSecs(Math.floor((Date.now() - lastVisionCallTs) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [lastVisionCallTs]);

  const showPuppet =
    phase === "roasting" || phase === "stopped" || phase === "requesting-permissions";

  function handleDebugToggle(checked: boolean) {
    setDebugMode(checked);
    if (!checked) { setMockMode(false); mockModeRef.current = false; setPhase("idle"); }
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
      setPhase("stopped");
    }
  }

  // Restart after mock toggle tears down the current session
  useEffect(() => {
    if (phase === "stopped" && pendingMockRestartRef.current) {
      pendingMockRestartRef.current = false;
      setPhase("requesting-permissions");
    }
  }, [phase]);

  return (
    <main className="relative min-h-dvh bg-black flex items-center justify-center">
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
          prefetchedTokenPromise={tokenPromiseRef.current}
          mockMode={mockMode}
        />
      )}

      {phase === "idle" && <LandingScreen />}
      {phase === "consent" && <ConsentScreen />}

      {showPuppet && (
        <div className="relative w-full max-w-[560px] aspect-square">
          {/* Dark overlay while brain is generating — fades to black */}
          <div className={`absolute inset-0 bg-black z-10 pointer-events-none transition-opacity duration-700 ${isThinking ? "opacity-60" : "opacity-0"}`} />
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
          {observations.length > 0 && (
            <div className="bg-black/80 border border-cyan-400/40 rounded p-2 font-mono text-[10px] text-cyan-300 leading-tight pointer-events-auto overflow-y-auto max-h-36">
              <div className="text-cyan-500 mb-1">👁 vision{visionElapsedSecs !== null ? ` · ${visionElapsedSecs}s ago` : ""}</div>
              {observations.map((obs, i) => (
                <div key={i}>· {obs}</div>
              ))}
            </div>
          )}
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
    </main>
  );
}
