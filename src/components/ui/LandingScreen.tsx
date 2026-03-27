"use client";
import { useSessionStore } from "@/store/useSessionStore";
import type { ContentMode } from "@/store/useSessionStore";

export default function LandingScreen() {
  const setPhase = useSessionStore((s) => s.setPhase);
  const error = useSessionStore((s) => s.error);
  const setError = useSessionStore((s) => s.setError);
  const contentMode = useSessionStore((s) => s.contentMode);
  const setContentMode = useSessionStore((s) => s.setContentMode);

  function handleStart() {
    setError(null);
    setPhase("requesting-permissions");
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-black text-white px-4 text-center">
      {error && (
        <div className="mb-6 px-5 py-3 bg-red-900/60 border border-red-500/50 rounded-xl text-red-300 text-sm max-w-sm">
          {error}
        </div>
      )}

      {/* Clean / Vulgar toggle */}
      <div className="mb-8 flex rounded-full bg-white/10 p-1">
        {(["clean", "vulgar"] as ContentMode[]).map((mode) => (
          <button
            key={mode}
            onClick={() => setContentMode(mode)}
            className={`px-5 py-2 rounded-full text-sm font-semibold transition-all capitalize ${
              contentMode === mode
                ? "bg-white text-black shadow"
                : "text-white/50 hover:text-white/80"
            }`}
          >
            {mode}
          </button>
        ))}
      </div>

      <button
        onClick={handleStart}
        className="px-10 py-5 bg-red-600 hover:bg-red-500 active:bg-red-700 rounded-2xl text-2xl font-bold transition-all transform hover:scale-105 shadow-lg shadow-red-900"
      >
        Roast Me
      </button>
    </div>
  );
}
