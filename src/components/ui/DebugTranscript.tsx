"use client";
import { useState, useRef, useEffect } from "react";
import { useSessionStore } from "@/store/useSessionStore";

function relTime(ts: number, startTs: number | null): string {
  if (startTs === null) return "--";
  const s = (ts - startTs) / 1000;
  return `+${s.toFixed(2)}s`;
}

/**
 * Collapsible debug panel — transcript history + timing log + debug text input.
 * Fixed to the right side of the screen.
 */
export default function DebugTranscript() {
  const [expanded, setExpanded] = useState(true);
  const [tab, setTab] = useState<"transcript" | "vision" | "log">("transcript");
  const [debugInput, setDebugInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const transcriptBottomRef = useRef<HTMLDivElement>(null);
  const logBottomRef = useRef<HTMLDivElement>(null);

  const transcriptHistory = useSessionStore((s) => s.transcriptHistory);
  const timingLog = useSessionStore((s) => s.timingLog);
  const brainState = useSessionStore((s) => s.brainState);
  const userAnswer = useSessionStore((s) => s.userAnswer);
  const isListening = useSessionStore((s) => s.isListening);
  const sessionStartTs = useSessionStore((s) => s.sessionStartTs);
  const submitDebugTranscription = useSessionStore((s) => s.submitDebugTranscription);
  const observations = useSessionStore((s) => s.observations);
  const visionSetting = useSessionStore((s) => s.visionSetting);
  const isUserLaughing = useSessionStore((s) => s.isUserLaughing);

  // Auto-scroll to bottom on new entries
  useEffect(() => {
    if (expanded && tab === "transcript") transcriptBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcriptHistory.length, expanded, tab]);
  useEffect(() => {
    if (expanded && tab === "log") logBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [timingLog.length, expanded, tab]);

  // Auto-focus input when listening starts
  useEffect(() => {
    if (isListening) inputRef.current?.focus();
  }, [isListening]);

  function handleDebugSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = debugInput.trim();
    if (!text) return;
    submitDebugTranscription(text);
    setDebugInput("");
    inputRef.current?.focus();
  }

  const IS_LISTENING = isListening && (
    brainState === "wait_answer" || brainState === "prodding" || brainState === "pre_generate"
  );

  return (
    <div className="fixed top-8 right-3 z-50 pointer-events-auto flex flex-col items-end gap-1">
      {/* Debug text input — always visible when listening */}
      {IS_LISTENING && (
        <form onSubmit={handleDebugSubmit} className="flex gap-1 w-72">
          <input
            ref={inputRef}
            type="text"
            value={debugInput}
            onChange={(e) => setDebugInput(e.target.value)}
            placeholder="type answer (enter to submit)…"
            className="flex-1 bg-black/90 border border-cyan-400/50 rounded px-2 py-1 font-mono text-[11px] text-cyan-200 placeholder:text-cyan-400/30 outline-none focus:border-cyan-400"
            autoComplete="off"
          />
          <button
            type="submit"
            className="bg-cyan-600/40 hover:bg-cyan-600/60 border border-cyan-400/40 rounded px-2 py-1 font-mono text-[11px] text-cyan-200"
          >
            ↵
          </button>
        </form>
      )}

      {/* Panel toggle button */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="bg-black/80 border border-emerald-400/40 rounded px-2 py-0.5 font-mono text-[10px] text-emerald-300 hover:bg-black/90 transition-colors"
      >
        transcript {expanded ? "▾" : "▸"} ({transcriptHistory.length})
      </button>

      {expanded && (
        <div className="w-72 bg-black/90 border border-emerald-400/30 rounded overflow-hidden">
          {/* Tab bar */}
          <div className="flex border-b border-emerald-400/20">
            {(["transcript", "vision", "log"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex-1 py-0.5 font-mono text-[10px] transition-colors ${
                  tab === t ? "text-emerald-300 bg-emerald-900/30" : "text-white/30 hover:text-white/50"
                }`}
              >
                {t === "log" ? `log (${timingLog.length})`
                  : t === "vision" ? `vision (${observations.length})`
                  : `transcript (${transcriptHistory.length})`}
              </button>
            ))}
          </div>

          {/* State + answer buffer header */}
          <div className="px-2 py-1 font-mono text-[10px] text-emerald-500 border-b border-emerald-400/20">
            state: <span className="text-white/60">{brainState ?? "—"}</span>
            {userAnswer && (
              <> · answer: <span className="text-cyan-300/70">{userAnswer}</span></>
            )}
          </div>

          {/* Tab content */}
          <div className="max-h-[50vh] overflow-y-auto p-2 font-mono text-[10px] leading-relaxed">
            {tab === "transcript" && (
              <>
                {transcriptHistory.length === 0 ? (
                  <div className="text-white/20 italic">No transcript yet</div>
                ) : (
                  transcriptHistory.map((entry, i) => {
                    const isUser = entry.role === "user";
                    return (
                      <div key={i} className={`mb-0.5 ${isUser ? "text-cyan-300/80" : "text-orange-300/80"}`}>
                        <span className="text-white/20">{relTime(entry.ts, sessionStartTs)}</span>{" "}
                        <span className={`font-bold ${isUser ? "text-cyan-400" : "text-orange-400"}`}>
                          {isUser ? "YOU" : "🎭"}
                        </span>{" "}
                        {entry.text}
                      </div>
                    );
                  })
                )}
                <div ref={transcriptBottomRef} />
              </>
            )}
            {tab === "vision" && (
              <>
                {visionSetting && (
                  <div className="mb-1.5 px-1.5 py-1 rounded bg-purple-400/10 border border-purple-400/30 text-purple-300">
                    Setting: <span className="font-bold">{visionSetting}</span>
                  </div>
                )}
                {isUserLaughing && (
                  <div className="mb-1.5 px-1.5 py-1 rounded bg-yellow-400/10 border border-yellow-400/30 text-yellow-300 font-bold animate-pulse">
                    LAUGH DETECTED
                  </div>
                )}
                {observations.length === 0 ? (
                  <div className="text-white/20 italic">No observations yet</div>
                ) : (
                  observations.map((obs, i) => (
                    <div key={i} className="mb-0.5 text-blue-300/80">
                      <span className="text-white/20">•</span> {obs}
                    </div>
                  ))
                )}
              </>
            )}
            {tab === "log" && (
              <>
                {timingLog.length === 0 ? (
                  <div className="text-white/20 italic">No log entries yet</div>
                ) : (
                  timingLog.map((line, i) => (
                    <div
                      key={i}
                      className={
                        line.includes("brain: →")
                          ? "text-purple-300/80 font-bold mb-0.5"
                          : line.includes("ERROR") || line.includes("error")
                          ? "text-red-400/90 mb-0.5"
                          : line.includes("joke[")
                          ? "text-orange-300/70 mb-0.5"
                          : line.includes("heard")
                          ? "text-cyan-300/70 mb-0.5"
                          : "text-white/40 mb-0.5"
                      }
                    >
                      {line}
                    </div>
                  ))
                )}
                <div ref={logBottomRef} />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
