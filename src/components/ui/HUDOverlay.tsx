"use client";
import { useSessionStore } from "@/store/useSessionStore";

interface Props {
  onStartSession: () => void;
  onStartMock: () => void;
  isMock?: boolean;
}

export default function HUDOverlay({ onStartSession, onStartMock, isMock = false }: Props) {
  const phase = useSessionStore((s) => s.phase);
  const setPhase = useSessionStore((s) => s.setPhase);
  const burnIntensity = useSessionStore((s) => s.burnIntensity);
  const sessionMode = useSessionStore((s) => s.sessionMode);
  const isSpeaking = useSessionStore((s) => s.isSpeaking);
  const isListening = useSessionStore((s) => s.isListening);
  const isUserSpeaking = useSessionStore((s) => s.isUserSpeaking);
  const brainState = useSessionStore((s) => s.brainState);
  const currentQuestion = useSessionStore((s) => s.currentQuestion);

  const isConversation = sessionMode === "conversation";
  const isRoasting = phase === "roasting";
  const isStopped = phase === "stopped";
  const isDev = process.env.NODE_ENV !== "production";

  return (
    <div
      className="absolute inset-0 pointer-events-none z-10"
      data-testid="hud-overlay"
      data-brain-state={brainState ?? ""}
    >
      {/* Top bar */}
      <div className="absolute top-4 left-4 flex items-center gap-2 pointer-events-none">
        <span className={`w-2 h-2 rounded-full ${isRoasting ? "bg-red-500 animate-pulse" : "bg-gray-500"}`} />
        <span className="text-xs font-bold text-white/70 uppercase tracking-wider">
          {isRoasting ? "Live" : "Stopped"} · Burn {burnIntensity}/5
          {isConversation && " · Conversation"}
          {isMock && <span className="text-yellow-400"> · MOCK</span>}
        </span>
        {isDev && isRoasting && isSpeaking && (
          <span className="text-xs text-orange-400 font-bold uppercase tracking-wider animate-pulse ml-2">
            Speaking…
          </span>
        )}
        {isDev && isRoasting && isConversation && isListening && !isSpeaking && (
          <span className="text-xs text-green-400 font-bold uppercase tracking-wider ml-2">
            Listening…
          </span>
        )}
        {isDev && isRoasting && isConversation && isUserSpeaking && (
          <span className="text-xs text-cyan-400 font-bold uppercase tracking-wider animate-pulse ml-2">
            You're talking…
          </span>
        )}
        {isDev && isRoasting && isConversation && brainState && (
          <span className="text-xs text-white/30 font-mono ml-2">{brainState}</span>
        )}
      </div>

      {/* Current question (conversation mode) */}
      {isDev && isRoasting && isConversation && currentQuestion && (
        <div className="absolute top-10 right-4 max-w-[240px] pointer-events-none">
          <div className="bg-black/60 rounded px-2 py-1 font-mono text-[10px] text-cyan-300/60 leading-tight">
            Q: {currentQuestion}
          </div>
        </div>
      )}

      {/* Transcript moved to DebugTranscript panel (right side, collapsed by default) */}

      {/* Bottom buttons */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex gap-3 pointer-events-auto">
        {isRoasting && (
          <button
            onClick={() => setPhase("stopped")}
            className="px-8 py-3 bg-white/10 hover:bg-white/20 backdrop-blur border border-white/20 rounded-full text-white font-bold transition-all"
          >
            Stop Session
          </button>
        )}
        {isStopped && (
          <>
            <button
              onClick={onStartSession}
              className="px-8 py-3 bg-green-600/80 hover:bg-green-500/80 backdrop-blur border border-green-400/30 rounded-full text-white font-bold transition-all"
            >
              Start Session
            </button>
            <button
              onClick={onStartMock}
              className="px-5 py-3 bg-yellow-500/20 hover:bg-yellow-500/30 backdrop-blur border border-yellow-400/40 rounded-full text-yellow-300 font-bold transition-all"
            >
              Mock
            </button>
            <button
              onClick={() => setPhase("sharing")}
              className="px-6 py-3 bg-white/10 hover:bg-white/20 backdrop-blur border border-white/20 rounded-full text-white font-bold transition-all"
            >
              Share
            </button>
          </>
        )}
      </div>
    </div>
  );
}
