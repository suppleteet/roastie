"use client";
import { useSessionStore } from "@/store/useSessionStore";
import type { ContentMode, RoastModelId } from "@/store/useSessionStore";

const IS_DEV = process.env.NODE_ENV !== "production";

const MODEL_OPTIONS: { id: RoastModelId; label: string }[] = [
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { id: "gpt-4o", label: "GPT-4o" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

export default function LandingScreen() {
  const setPhase = useSessionStore((s) => s.setPhase);
  const error = useSessionStore((s) => s.error);
  const setError = useSessionStore((s) => s.setError);
  const contentMode = useSessionStore((s) => s.contentMode);
  const setContentMode = useSessionStore((s) => s.setContentMode);
  const locationConsent = useSessionStore((s) => s.locationConsent);
  const setLocationConsent = useSessionStore((s) => s.setLocationConsent);
  const roastModel = useSessionStore((s) => s.roastModel);
  const setRoastModel = useSessionStore((s) => s.setRoastModel);

  function handleStart() {
    setError(null);
    setPhase("requesting-permissions", "START_CLICKED");
  }

  return (
    <div className="relative flex h-dvh flex-col items-center justify-center overflow-hidden bg-[#080301] px-4 text-center text-white">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_18%,rgba(248,113,22,0.24),transparent_30%),linear-gradient(150deg,#170604_0%,#050201_58%,#000_100%)]" />

      <div className="relative z-10 flex w-full max-w-sm flex-col items-center rounded-[2rem] border border-white/10 bg-black/45 px-6 py-8 shadow-2xl shadow-orange-950/30 backdrop-blur-xl">
        {error && (
          <div className="mb-6 rounded-xl border border-red-500/50 bg-red-950/70 px-5 py-3 text-sm text-red-100">
            {error}
          </div>
        )}

        {IS_DEV && (
          <select
            value={roastModel}
            onChange={(e) => setRoastModel(e.target.value as RoastModelId)}
            className="mb-5 w-full rounded-xl border border-orange-300/25 bg-white/10 px-3 py-2 font-mono text-sm text-orange-200 outline-none transition-colors hover:border-orange-300/50"
          >
            {MODEL_OPTIONS.map((m) => (
              <option key={m.id} value={m.id} className="bg-gray-950 text-white">
                {m.label}
              </option>
            ))}
          </select>
        )}

        <label className="mb-6 flex max-w-xs cursor-pointer select-none items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] p-4 transition-colors hover:bg-white/[0.07]">
          <input
            type="checkbox"
            checked={locationConsent}
            onChange={(e) => setLocationConsent(e.target.checked)}
            className="h-5 w-5 flex-shrink-0 cursor-pointer rounded accent-orange-500"
          />
          <span className="text-left text-sm text-white/62 transition-colors">
            Share my location (just for jokes)
          </span>
        </label>

        <div className="mb-8 grid w-full grid-cols-2 rounded-full border border-white/10 bg-white/10 p-1">
          {(["clean", "vulgar"] as ContentMode[]).map((mode) => (
            <button
              key={mode}
              onClick={() => setContentMode(mode)}
              className={`rounded-full px-5 py-2 text-sm font-bold capitalize transition-all ${
                contentMode === mode
                  ? "bg-orange-100 text-black shadow"
                  : "text-white/50 hover:text-white/85"
              }`}
            >
              {mode}
            </button>
          ))}
        </div>

        <button
          onClick={handleStart}
          className="rounded-2xl bg-orange-600 px-10 py-5 text-2xl font-black text-white shadow-lg shadow-orange-950/50 transition-all hover:-translate-y-0.5 hover:bg-orange-500 active:translate-y-0"
        >
          Roast Me
        </button>
      </div>
    </div>
  );
}
