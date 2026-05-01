"use client";
import { useState, useRef, useEffect, useMemo } from "react";
import { useSessionStore, DEFAULT_VOICE_SETTINGS } from "@/store/useSessionStore";
import type { VoiceSettings } from "@/store/useSessionStore";

type TranscriptEntry = ReturnType<typeof useSessionStore.getState>["transcriptHistory"][number];

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
  const [tab, setTab] = useState<"transcript" | "log">("transcript");
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
  const jokeRatings = useSessionStore((s) => s.jokeRatings);
  const rateJoke = useSessionStore((s) => s.rateJoke);
  const voiceSettings = useSessionStore((s) => s.voiceSettings);
  const setVoiceSettings = useSessionStore((s) => s.setVoiceSettings);
  const burnIntensity = useSessionStore((s) => s.burnIntensity);
  const setBurnIntensity = useSessionStore((s) => s.setBurnIntensity);

  // Group consecutive same-role same-groupId entries — one paragraph per delivery batch.
  const groupedTranscript = useMemo(() => {
    const groups: TranscriptEntry[][] = [];
    for (const entry of transcriptHistory) {
      const last = groups[groups.length - 1];
      if (last && last[0].role === entry.role && last[0].groupId === entry.groupId) {
        last.push(entry);
      } else {
        groups.push([entry]);
      }
    }
    return groups;
  }, [transcriptHistory]);

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
            {(["transcript", "log"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex-1 py-0.5 font-mono text-[10px] transition-colors ${
                  tab === t ? "text-emerald-300 bg-emerald-900/30" : "text-white/30 hover:text-white/50"
                }`}
              >
                {t === "log" ? `log (${timingLog.length})` : `transcript (${transcriptHistory.length})`}
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
                {groupedTranscript.length === 0 ? (
                  <div className="text-white/20 italic">No transcript yet</div>
                ) : (
                  groupedTranscript.map((group) => {
                    const head = group[0];
                    const isUser = head.role === "user";
                    const paragraph = group.map((e) => e.text).join(" ");
                    return (
                      <div
                        key={head.groupId}
                        className={`mb-0.5 flex items-start gap-1 ${isUser ? "text-cyan-300/80" : "text-orange-300/80"}`}
                        data-testid="transcript-group"
                        data-group-id={head.groupId}
                      >
                        <div className="flex-1 min-w-0">
                          <span className="text-white/20">{relTime(head.ts, sessionStartTs)}</span>{" "}
                          <span className={`font-bold ${isUser ? "text-cyan-400" : "text-orange-400"}`}>
                            {isUser ? "YOU" : "🎭"}
                          </span>{" "}
                          {paragraph}
                        </div>
                        {!isUser && (
                          <span className="flex-shrink-0 flex flex-col gap-px mt-px">
                            {group.map((entry, i) => {
                              const rating = jokeRatings[entry.ts];
                              const titleHint = group.length > 1 ? ` (joke ${i + 1})` : "";
                              return (
                                <span key={entry.ts} className="flex gap-px">
                                  <button
                                    onClick={() => rateJoke(entry.ts, "up")}
                                    className={`px-0.5 rounded text-[9px] leading-none transition-colors ${
                                      rating === "up"
                                        ? "text-green-400 bg-green-400/20"
                                        : "text-white/20 hover:text-green-400/70"
                                    }`}
                                    title={`Good joke${titleHint}`}
                                  >▲</button>
                                  <button
                                    onClick={() => rateJoke(entry.ts, "down")}
                                    className={`px-0.5 rounded text-[9px] leading-none transition-colors ${
                                      rating === "down"
                                        ? "text-red-400 bg-red-400/20"
                                        : "text-white/20 hover:text-red-400/70"
                                    }`}
                                    title={`Bad joke${titleHint}`}
                                  >▼</button>
                                </span>
                              );
                            })}
                          </span>
                        )}
                      </div>
                    );
                  })
                )}
                <div ref={transcriptBottomRef} />
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
      {/* Voice settings — collapsible below transcript */}
      {expanded && (
        <VoiceSliders
          voiceSettings={voiceSettings}
          setVoiceSettings={setVoiceSettings}
          burnIntensity={burnIntensity}
          setBurnIntensity={setBurnIntensity}
        />
      )}
    </div>
  );
}

const VOICE_SLIDERS: { key: keyof VoiceSettings; label: string; min: number; max: number; step: number }[] = [
  { key: "stability", label: "Stability", min: 0, max: 1, step: 0.05 },
  { key: "similarity_boost", label: "Similarity", min: 0, max: 1, step: 0.05 },
  { key: "style", label: "Style", min: 0, max: 1, step: 0.05 },
  { key: "speed", label: "Speed", min: 0.7, max: 1.2, step: 0.05 },
];

function VoiceSliders({ voiceSettings, setVoiceSettings, burnIntensity, setBurnIntensity }: {
  voiceSettings: VoiceSettings;
  setVoiceSettings: (s: Partial<VoiceSettings>) => void;
  burnIntensity: number;
  setBurnIntensity: (n: 1 | 2 | 3 | 4 | 5) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="w-72 bg-black/90 border border-purple-400/30 rounded overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full px-2 py-0.5 font-mono text-[10px] text-purple-300 hover:bg-purple-900/20 transition-colors text-left"
      >
        voice {open ? "▾" : "▸"}
      </button>
      {open && (
        <div className="px-2 pb-2 space-y-1.5">
          <label className="block">
            <div className="flex justify-between font-mono text-[10px] text-orange-300/80">
              <span>Burn</span>
              <span className="text-white/40">{burnIntensity}/5</span>
            </div>
            <input
              type="range"
              min={1}
              max={5}
              step={1}
              value={burnIntensity}
              onChange={(e) => setBurnIntensity(parseInt(e.target.value) as 1 | 2 | 3 | 4 | 5)}
              className="w-full h-1 accent-orange-400 cursor-pointer"
            />
          </label>
          <div className="border-t border-white/10 my-1" />
          {VOICE_SLIDERS.map(({ key, label, min, max, step }) => (
            <label key={key} className="block">
              <div className="flex justify-between font-mono text-[10px] text-purple-300/80">
                <span>{label}</span>
                <span className="text-white/40">{(voiceSettings[key] as number).toFixed(2)}</span>
              </div>
              <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={voiceSettings[key] as number}
                onChange={(e) => setVoiceSettings({ [key]: parseFloat(e.target.value) })}
                className="w-full h-1 accent-purple-400 cursor-pointer"
              />
            </label>
          ))}
          <label className="flex items-center gap-2 font-mono text-[10px] text-purple-300/80 cursor-pointer">
            <input
              type="checkbox"
              checked={voiceSettings.use_speaker_boost}
              onChange={(e) => setVoiceSettings({ use_speaker_boost: e.target.checked })}
              className="w-3 h-3 accent-purple-400 cursor-pointer"
            />
            Speaker Boost
          </label>
          <button
            onClick={() => setVoiceSettings(DEFAULT_VOICE_SETTINGS)}
            className="w-full py-0.5 font-mono text-[9px] text-white/30 hover:text-white/60 border border-white/10 hover:border-white/20 rounded transition-colors"
          >
            Reset defaults
          </button>
        </div>
      )}
    </div>
  );
}
