"use client";
import { useRef, useState, useEffect } from "react";
import { useSessionStore } from "@/store/useSessionStore";

export default function ShareScreen() {
  const recordedBlob = useSessionStore((s) => s.recordedBlob);
  const reset = useSessionStore((s) => s.reset);
  const [playing, setPlaying] = useState(false);
  // Starts as raw WebM for immediate first-frame display; swapped to MP4 when ready.
  const [videoBlob, setVideoBlob] = useState<Blob | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  // The final MP4 blob — null while converting.
  const [mp4Blob, setMp4Blob] = useState<Blob | null>(null);
  const [converting, setConverting] = useState(false);
  const [savedFolder, setSavedFolder] = useState<string | null>(null);
  const [savedFilename, setSavedFilename] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  // Prevent double-save (React StrictMode fires effects twice in dev)
  const savedBlobRef = useRef<Blob | null>(null);

  // Show the raw WebM immediately so the first frame appears right away,
  // then convert in the background and enable Share/Download when MP4 is ready.
  useEffect(() => {
    if (!recordedBlob || savedBlobRef.current === recordedBlob) return;
    savedBlobRef.current = recordedBlob;

    setVideoBlob(recordedBlob);
    setConverting(true);

    (async () => {
      let folder: string | null = null;
      let filename: string | null = null;

      try {
        const saveResp = await fetch("/api/save-video", {
          method: "POST",
          headers: { "Content-Type": "video/webm" },
          body: recordedBlob,
        });
        const data: { folder?: string; filename?: string; conversionError?: string } =
          await saveResp.json();

        folder = data.folder ?? null;
        filename = data.filename ?? null;
        if (folder) setSavedFolder(folder);
        if (filename) setSavedFilename(filename);

        if (filename?.endsWith(".mp4")) {
          const serveResp = await fetch(
            `/api/serve-video?filename=${encodeURIComponent(filename)}`,
          );
          if (serveResp.ok) {
            const converted = await serveResp.blob();
            setMp4Blob(converted);
            // Swap video src to MP4 if not currently playing
            if (!videoRef.current || videoRef.current.paused) {
              setVideoBlob(converted);
            }
          }
        }
      } catch (e) {
        console.warn("[share] save/fetch failed:", e);
      } finally {
        setConverting(false);
      }
    })();
  }, [recordedBlob]);

  // Create and revoke the object URL whenever the playback blob changes.
  useEffect(() => {
    if (!videoBlob) return;
    const url = URL.createObjectURL(videoBlob);
    setVideoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [videoBlob]);

  // Set src as soon as URL is ready — browser decodes the first frame as the poster.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoUrl) return;
    video.src = videoUrl;
    video.load();
  }, [videoUrl]);

  function handlePlayback() {
    const video = videoRef.current;
    if (!video) return;
    video.play();
    setPlaying(true);
  }

  async function handleShare() {
    if (!mp4Blob) return;
    const name = savedFilename ?? "roastie.mp4";
    const file = new File([mp4Blob], name, { type: "video/mp4" });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: "Roastie" });
    }
  }

  function handleDownload() {
    if (!mp4Blob) return;
    const name = savedFilename ?? "roastie.mp4";
    const url = URL.createObjectURL(mp4Blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleOpenFolder() {
    fetch("/api/open-videos-folder", { method: "POST" }).catch((e) =>
      console.warn("[open-folder] failed:", e),
    );
  }

  const buttonsDisabled = converting || !mp4Blob;

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-black text-white px-6 text-center">

      {/* Video frame with folder button above top-right */}
      <div className="relative w-full max-w-sm mb-6">
        <button
          onClick={handleOpenFolder}
          title={savedFolder ?? "Open videos folder"}
          className="absolute -top-8 right-0 p-1.5 rounded-lg bg-white/10 hover:bg-white/20 transition-all text-white/60 hover:text-white/90"
        >
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
          {/* src set by effect — browser shows first frame before play is clicked */}
          <video
            ref={videoRef}
            className="w-full h-full object-cover"
            onEnded={() => setPlaying(false)}
            playsInline
            preload="auto"
          />
          {!playing && videoUrl && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/40">
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

      <div className="flex gap-3 mb-3 flex-wrap justify-center">
        {typeof navigator !== "undefined" && "share" in navigator && (
          <button
            onClick={handleShare}
            disabled={buttonsDisabled}
            className="px-6 py-3 bg-blue-600 rounded-xl font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed hover:bg-blue-500 disabled:hover:bg-blue-600"
          >
            Share
          </button>
        )}
        <button
          onClick={handleDownload}
          disabled={buttonsDisabled}
          className="px-6 py-3 bg-gray-700 rounded-xl font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-600 disabled:hover:bg-gray-700"
        >
          Download
        </button>
      </div>

      {converting && (
        <p className="text-xs text-gray-500 mb-6">Processing video…</p>
      )}
      {!converting && <div className="mb-6" />}

      <button onClick={reset} className="text-gray-500 hover:text-gray-300 text-sm">
        ← Roast again
      </button>
    </div>
  );
}
