"use client";
import { useState, useRef, useEffect } from "react";
import { useSessionStore } from "@/store/useSessionStore";

/**
 * Collapsible debug panel showing full transcript history.
 * Fixed to the right side of the screen.
 */
export default function DebugTranscript() {
  const [expanded, setExpanded] = useState(false);
  const transcriptHistory = useSessionStore((s) => s.transcriptHistory);
  const brainState = useSessionStore((s) => s.brainState);
  const userAnswer = useSessionStore((s) => s.userAnswer);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    if (expanded) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcriptHistory.length, expanded]);

  return (
    <div className="fixed top-3 right-28 z-50 pointer-events-auto">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="bg-black/80 border border-emerald-400/40 rounded px-2 py-0.5 font-mono text-[10px] text-emerald-300 hover:bg-black/90 transition-colors"
      >
        transcript {expanded ? "▾" : "▸"} ({transcriptHistory.length})
      </button>

      {expanded && (
        <div className="mt-1 w-72 max-h-[60vh] overflow-y-auto bg-black/90 border border-emerald-400/30 rounded p-2 font-mono text-[10px] leading-relaxed">
          {/* Current brain state + answer buffer */}
          <div className="text-emerald-500 mb-1 border-b border-emerald-400/20 pb-1">
            state: <span className="text-white/60">{brainState ?? "—"}</span>
            {userAnswer && (
              <>
                {" · "}answer: <span className="text-cyan-300/70">{userAnswer}</span>
              </>
            )}
          </div>

          {/* Transcript history */}
          {transcriptHistory.length === 0 ? (
            <div className="text-white/20 italic">No transcript yet</div>
          ) : (
            transcriptHistory.map((entry, i) => {
              const time = new Date(entry.ts).toLocaleTimeString("en-US", {
                hour12: false,
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              });
              const isUser = entry.role === "user";
              return (
                <div key={i} className={`mb-0.5 ${isUser ? "text-cyan-300/80" : "text-orange-300/80"}`}>
                  <span className="text-white/20">{time}</span>{" "}
                  <span className={`font-bold ${isUser ? "text-cyan-400" : "text-orange-400"}`}>
                    {isUser ? "YOU" : "🎭"}
                  </span>{" "}
                  {entry.text}
                </div>
              );
            })
          )}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
