"use client";
import { useState } from "react";
import { useSessionStore } from "@/store/useSessionStore";

interface Props {
  /** Filename of the saved video (mp4 or webm), if available. */
  videoFilename?: string | null;
}

/** Simple text feedback box shown on the share screen. */
export default function FeedbackBox({ videoFilename }: Props) {
  const [open, setOpen] = useState(false);
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
          text: trimmed,
          videoFilename: videoFilename ?? null,
          sessionLog,
        }),
      });
      setStatus("sent");
      setText("");
    } catch (e) {
      console.error("[FeedbackBox] save failed", e);
      setStatus("idle");
    }
  }

  if (status === "sent") {
    return (
      <p className="text-gray-500 text-sm my-3">Thanks for the feedback!</p>
    );
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-gray-500 hover:text-gray-300 text-sm my-3 transition-colors"
      >
        Leave Feedback
      </button>
    );
  }

  return (
    <div className="w-full max-w-sm my-3">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What did you think?"
        rows={3}
        autoFocus
        className="w-full bg-gray-800 text-white text-sm rounded-xl px-4 py-3 placeholder-gray-500 resize-none focus:outline-none focus:ring-1 focus:ring-gray-600"
      />
      {text.trim() && (
        <button
          onClick={handleSubmit}
          disabled={status === "sending"}
          className="mt-2 w-full px-4 py-2.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white text-sm font-bold rounded-xl transition-colors"
        >
          {status === "sending" ? "Sending…" : "Send Feedback"}
        </button>
      )}
    </div>
  );
}
