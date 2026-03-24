"use client";
import { useRef, useState, useEffect } from "react";
import { useSessionStore } from "@/store/useSessionStore";

export default function ShareScreen() {
  const recordedBlob = useSessionStore((s) => s.recordedBlob);
  const reset = useSessionStore((s) => s.reset);
  const [playing, setPlaying] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [savedFolder, setSavedFolder] = useState<string | null>(null);
  const [savedFilename, setSavedFilename] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  // Prevent double-save (React StrictMode fires effects twice in dev)
  const savedBlobRef = useRef<Blob | null>(null);

  // Create and revoke the object URL to avoid blob URL memory leaks
  useEffect(() => {
    if (!recordedBlob) return;
    const url = URL.createObjectURL(recordedBlob);
    setVideoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [recordedBlob]);

  // Auto-save to temp folder whenever a new blob arrives
  useEffect(() => {
    if (!recordedBlob || savedBlobRef.current === recordedBlob) return;
    savedBlobRef.current = recordedBlob;
    fetch("/api/save-video", {
      method: "POST",
      headers: { "Content-Type": "video/webm" },
      body: recordedBlob,
    })
      .then((r) => r.json())
      .then((d: { folder?: string; filename?: string }) => {
        if (d.folder) setSavedFolder(d.folder);
        if (d.filename) setSavedFilename(d.filename);
      })
      .catch((e) => console.warn("[save-video] failed:", e));
  }, [recordedBlob]);

  function handlePlayback() {
    if (!videoRef.current || !videoUrl) return;
    videoRef.current.src = videoUrl;
    videoRef.current.play();
    setPlaying(true);
  }

  async function handleShare() {
    if (!recordedBlob) return;
    const file = new File([recordedBlob], "roast-me.webm", { type: "video/webm" });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: "I got roasted by an AI puppet 🔥" });
    }
  }

  function handleDownload() {
    if (!videoUrl) return;
    // Use the server's clever name (swap extension to .webm — that's what the client blob is)
    const name = savedFilename
      ? savedFilename.replace(/\.\w+$/, ".webm")
      : "roast-me.webm";
    const a = document.createElement("a");
    a.href = videoUrl;
    a.download = name;
    a.click();
  }

  function handleOpenFolder() {
    fetch("/api/open-videos-folder", { method: "POST" }).catch((e) =>
      console.warn("[open-folder] failed:", e)
    );
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-black text-white px-6 text-center">
      <h2 className="text-4xl font-black mb-2">You got roasted. 🔥</h2>
      <p className="text-gray-400 mb-8">Share your suffering with the world.</p>

      {/* Video frame with folder button above top-right */}
      <div className="relative w-full max-w-sm mb-6">
        <button
          onClick={handleOpenFolder}
          title={savedFolder ?? "Open videos folder"}
          className="absolute -top-8 right-0 p-1.5 rounded-lg bg-white/10 hover:bg-white/20 transition-all text-white/60 hover:text-white/90"
        >
          {/* Folder icon */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-5 h-5"
          >
            <path d="M2 6a2 2 0 012-2h4l2 2h6a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
          </svg>
        </button>

        <div className="relative aspect-square bg-gray-900 rounded-2xl overflow-hidden">
          <video
            ref={videoRef}
            className="w-full h-full object-cover"
            onEnded={() => setPlaying(false)}
            playsInline
          />
          {!playing && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/50">
              <button
                onClick={handlePlayback}
                className="w-16 h-16 rounded-full bg-white/20 hover:bg-white/30 flex items-center justify-center text-3xl transition-all"
              >
                ▶
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="flex gap-3 mb-8 flex-wrap justify-center">
        {typeof navigator !== "undefined" && "share" in navigator && (
          <button
            onClick={handleShare}
            className="px-6 py-3 bg-blue-600 hover:bg-blue-500 rounded-xl font-bold transition-all"
          >
            Share Video
          </button>
        )}
        <button
          onClick={handleDownload}
          className="px-6 py-3 bg-gray-700 hover:bg-gray-600 rounded-xl font-bold transition-all"
        >
          Download
        </button>
      </div>

      <button onClick={reset} className="text-gray-500 hover:text-gray-300 text-sm">
        ← Roast me again
      </button>
    </div>
  );
}
