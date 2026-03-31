"use client";
import { useEffect, useRef, useState } from "react";
import { useSessionStore } from "@/store/useSessionStore";

interface Props {
  onStartSession: () => void;
  isMock?: boolean;
}

export default function HUDOverlay({ onStartSession, isMock = false }: Props) {
  const phase = useSessionStore((s) => s.phase);
  const setPhase = useSessionStore((s) => s.setPhase);
  const sessionMode = useSessionStore((s) => s.sessionMode);
  const isSpeaking = useSessionStore((s) => s.isSpeaking);
  const isListening = useSessionStore((s) => s.isListening);
  const isUserSpeaking = useSessionStore((s) => s.isUserSpeaking);
  const isUserLaughing = useSessionStore((s) => s.isUserLaughing);
  const brainState = useSessionStore((s) => s.brainState);
  const currentQuestion = useSessionStore((s) => s.currentQuestion);
  const userAnswer = useSessionStore((s) => s.userAnswer);
  const submitDebugTranscription = useSessionStore((s) => s.submitDebugTranscription);

  const isConversation = sessionMode === "conversation";
  const isRoasting = phase === "roasting";
  const isStopped = phase === "stopped";
  const isDev = process.env.NODE_ENV !== "production";

  return (
    <div
      className="absolute inset-0 pointer-events-none z-10 overflow-hidden"
      data-testid="hud-overlay"
      data-brain-state={brainState ?? ""}
    >
      {/* Top bar */}
      <div className="absolute top-4 left-4 flex items-center gap-2 pointer-events-none">
        <span className={`w-2 h-2 rounded-full ${isRoasting ? "bg-red-500 animate-pulse" : "bg-gray-500"}`} />
        <span className="text-xs font-bold text-white/70 uppercase tracking-wider">
          {isRoasting ? "Live" : "Stopped"}
          {isConversation && " · Conversation"}
          {isMock && <span className="text-yellow-400"> · MOCK</span>}
        </span>
        {isDev && isRoasting && isSpeaking && (
          <span className="text-xs text-orange-400 font-bold uppercase tracking-wider animate-pulse ml-2">
            Speaking…
          </span>
        )}
        {isDev && isRoasting && isConversation && isListening && !isSpeaking &&
          (brainState === "wait_answer" || brainState === "prodding" || brainState === "pre_generate") && (
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

      {/* Answer correction bar — shows what was heard, lets user type a correction */}
      {isRoasting && isConversation && (
        <AnswerCorrectionBar
          brainState={brainState}
          userAnswer={userAnswer}
          isListening={isListening}
          onSubmit={submitDebugTranscription}
        />
      )}

      {/* Debug left-side panels */}
      {isDev && isRoasting && isConversation && isUserLaughing && (
        <div className="absolute bottom-52 left-4 pointer-events-none">
          <span className="text-xs text-yellow-300 font-bold uppercase tracking-wider animate-pulse">
            LAUGH DETECTED
          </span>
        </div>
      )}
      {isDev && isRoasting && <DebugAmplitudeBars />}

      {/* Bottom buttons */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex gap-3 pointer-events-auto">
        {isRoasting && (
          <button
            onClick={() => setPhase("stopped", "STOP_CLICKED")}
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
              onClick={() => setPhase("sharing", "SHARE_CLICKED")}
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

/** Compact correction bar — shows heard text, lets user type a correction via keyboard. */
function AnswerCorrectionBar({
  brainState,
  userAnswer,
  isListening,
  onSubmit,
}: {
  brainState: string | null;
  userAnswer: string;
  isListening: boolean;
  onSubmit: (text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [correctionText, setCorrectionText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const isAnswerPhase = isListening && (
    brainState === "wait_answer" || brainState === "prodding" || brainState === "pre_generate"
  );
  // Also show briefly during generating so user can correct before joke plays
  const showBar = isAnswerPhase || brainState === "generating";

  // Auto-focus when editing starts
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  // Reset editing state when leaving answer phase
  useEffect(() => {
    if (!showBar) {
      setEditing(false);
      setCorrectionText("");
    }
  }, [showBar]);

  if (!showBar) return null;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = correctionText.trim();
    if (!text) return;
    onSubmit(text);
    setEditing(false);
    setCorrectionText("");
  }

  return (
    <div className="absolute top-16 left-1/2 -translate-x-1/2 pointer-events-auto max-w-md w-full px-4">
      {editing ? (
        <form onSubmit={handleSubmit} className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={correctionText}
            onChange={(e) => setCorrectionText(e.target.value)}
            placeholder="Type your actual answer…"
            className="flex-1 bg-black/80 border border-cyan-400/50 rounded-full px-4 py-2 text-sm text-white placeholder:text-white/30 outline-none focus:border-cyan-400 backdrop-blur"
            autoComplete="off"
          />
          <button
            type="submit"
            className="bg-cyan-600/60 hover:bg-cyan-600/80 border border-cyan-400/40 rounded-full px-4 py-2 text-sm text-white font-medium backdrop-blur"
          >
            Send
          </button>
          <button
            type="button"
            onClick={() => { setEditing(false); setCorrectionText(""); }}
            className="text-white/40 hover:text-white/70 text-sm px-2"
          >
            ✕
          </button>
        </form>
      ) : (
        userAnswer && (
          <button
            onClick={() => { setEditing(true); setCorrectionText(userAnswer); }}
            className="w-full bg-black/50 hover:bg-black/70 border border-white/10 hover:border-cyan-400/30 rounded-full px-4 py-2 text-sm text-white/60 backdrop-blur transition-all text-left truncate"
            title="Click to correct what was heard"
          >
            <span className="text-white/30 mr-2">Heard:</span>
            {userAnswer}
            <span className="text-cyan-400/50 ml-2 text-xs">(click to correct)</span>
          </button>
        )
      )}
    </div>
  );
}

/** Two vertical bars showing raw amplitude vs mouth output — rAF driven, no re-renders. */
function DebugAmplitudeBars() {
  const ampRef = useRef<HTMLDivElement>(null);
  const mouthRef = useRef<HTMLDivElement>(null);
  const ampLabelRef = useRef<HTMLSpanElement>(null);
  const mouthLabelRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let raf = 0;
    function tick() {
      const w = window as unknown as Record<string, number>;
      const amp = w.__DEBUG_AMP__ ?? 0;
      const mouth = w.__DEBUG_MOUTH__ ?? 0;
      if (ampRef.current) ampRef.current.style.height = `${amp * 100}%`;
      if (mouthRef.current) mouthRef.current.style.height = `${mouth * 100}%`;
      if (ampLabelRef.current) ampLabelRef.current.textContent = amp.toFixed(2);
      if (mouthLabelRef.current) mouthLabelRef.current.textContent = mouth.toFixed(2);
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const barContainer = "w-4 h-24 bg-white/10 rounded-sm relative overflow-hidden";
  const barFill = "absolute bottom-0 left-0 right-0 rounded-sm transition-none";

  return (
    <div className="absolute bottom-24 left-4 flex gap-2 items-end pointer-events-none">
      <div className="flex flex-col items-center gap-1">
        <div className={barContainer}>
          <div ref={ampRef} className={`${barFill} bg-green-400/80`} />
        </div>
        <span ref={ampLabelRef} className="text-[9px] font-mono text-green-400/70">0</span>
        <span className="text-[8px] font-mono text-white/30">AMP</span>
      </div>
      <div className="flex flex-col items-center gap-1">
        <div className={barContainer}>
          <div ref={mouthRef} className={`${barFill} bg-orange-400/80`} />
        </div>
        <span ref={mouthLabelRef} className="text-[9px] font-mono text-orange-400/70">0</span>
        <span className="text-[8px] font-mono text-white/30">JAW</span>
      </div>
    </div>
  );
}
