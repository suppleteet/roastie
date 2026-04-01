"use client";
import { useState } from "react";
import { useSessionStore } from "@/store/useSessionStore";

interface Props {
  videoFilename?: string | null;
  onSent?: () => void;
}

/** Text feedback box — used inside feedback modal on share screen. */
export default function FeedbackBox({ videoFilename, onSent }: Props) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle");

  async function handleSubmit() {
    const trimmed = text.trim();
    if (!trimmed || status === "sending") return;

    setStatus("sending");

    const store = useSessionStore.getState();
    const sessionLog = {
      transcriptHistory: store.transcriptHistory,
      timingLog: store.timingLog,
      observations: store.observations,
      visionSetting: store.visionSetting,
      brainState: store.brainState,
      activePersona: store.activePersona,
      burnIntensity: store.burnIntensity,
      sessionMode: store.sessionMode,
      timeToFirstSpeechMs: store.timeToFirstSpeechMs,
    };

    try {
      await fetch("/api/save-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "post-session",
          text: trimmed,
          persona: store.activePersona,
          videoFilename: videoFilename ?? null,
          sessionLog,
        }),
      });
      setStatus("sent");
      setText("");
      onSent?.();
    } catch (e) {
      console.error("[FeedbackBox] save failed", e);
      setStatus("idle");
    }
  }

  return (
    <div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What did you think?"
        rows={4}
        autoFocus
        className="w-full bg-gray-800 text-white text-sm rounded-xl px-4 py-3 placeholder-gray-500 resize-none focus:outline-none focus:ring-1 focus:ring-gray-600"
      />
      <button
        onClick={handleSubmit}
        disabled={!text.trim() || status === "sending"}
        className="mt-3 w-full px-4 py-2.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-bold rounded-xl transition-colors"
      >
        {status === "sending" ? "Sending…" : "Send Feedback"}
      </button>
    </div>
  );
}
